/**
 * RoomManager — the public shards, and everybody's private islands.
 * =================================================================
 *
 * "Nagisa" is conceptually one island, but one WebSocket-fanout room has a practical
 * population ceiling (`CONFIG.ROOM_CAPACITY`). Past that, the server opens another **public
 * shard** — same world, same programme, independent players and tick. Matchmaking decides
 * which shard you land in.
 *
 * A **private island** is a room somebody made (`room_create`) and shares by its five-letter
 * code. It is never offered to strangers by matchmaking and never listed to them. Its maker
 * is its keeper — admin there, and only there — and stays so across visits by their visitor
 * key. The registry of codes and keepers is persisted, so an invite link keeps working after
 * everybody has left and after a restart: a registered code the server is not holding simply
 * re-opens the island, restoring its schedule and guestbook. A code nobody registered opens
 * nothing — otherwise a script trying random codes would fill the server with empty islands.
 *
 * Rooms nobody is in are put to sleep after {@link IDLE_MS}: their state is set aside for
 * persistence and they stop ticking. The first public shards (`ROOM_COUNT`) are never put to
 * sleep, so there is always somewhere to arrive.
 */

import { randomInt } from 'node:crypto';
import {
  ActivityState,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  normaliseRoomCode,
  type PlayerId,
  type RoomId,
  type RoomView,
} from '@nagisa/shared';
import { Room, type RoomOwner } from './room.js';
import type { Player } from './player.js';
import type { Session } from './session.js';
import type { Logger } from './logger.js';
import type { PersistedIsland, PersistedRoom } from './persistence.js';
import { metrics } from './metrics.js';

/**
 * Fraction of a room's capacity reserved as headroom when matchmaking targets it. A room
 * within this fraction of full is excluded from "fill the fullest room" so a burst of
 * simultaneous joins doesn't slam a room to exactly its cap while a `hello` is mid-flight.
 */
const HEADROOM_FRACTION = 0.1;

/** How long a room may stand empty before it is put to sleep. */
export const IDLE_MS = 10 * 60 * 1000;

/** How many sleeping rooms' state is kept on disk; the least recently used go first. */
const DORMANT_LIMIT = 500;
/** How many private islands the registry remembers. */
const ISLAND_LIMIT = 2000;
/** How many private islands may be awake at once — a bound on memory, not on friendship. */
export const MAX_LIVE_ISLANDS = 200;

export interface RoomManagerOptions {
  log: Logger;
  roomCapacity: number;
  privateCapacity: number;
  initialRoomCount: number;
  /** Ask for a save soon. */
  persist: () => void;
  /** State from the last run. */
  persisted?: { rooms?: Record<RoomId, PersistedRoom>; islands?: PersistedIsland[] };
  random?: () => number;
  /** Start rooms' tick loops (off in tests that drive ticks by hand). */
  autostart?: boolean;
}

/** Why a requested room could not be had. */
export type RoomRefusal = 'not_found' | 'full' | 'busy';

export class RoomManager {
  private readonly rooms = new Map<RoomId, Room>();
  /** Persisted state of rooms that are not awake. */
  private readonly dormant = new Map<RoomId, PersistedRoom>();
  /** The private island registry, by code. */
  private readonly islands = new Map<string, PersistedIsland>();
  private readonly log: Logger;

  constructor(private readonly opts: RoomManagerOptions) {
    this.log = opts.log;
    for (const [id, state] of Object.entries(opts.persisted?.rooms ?? {})) this.dormant.set(id, state);
    for (const island of opts.persisted?.islands ?? []) {
      if (island && typeof island.code === 'string' && normaliseRoomCode(island.code) === island.code) {
        this.islands.set(island.code, island);
      }
    }
    for (let i = 0; i < Math.max(1, opts.initialRoomCount); i++) this.createRoom();
  }

  // ---------------------------------------------------------------------------------------
  // Creating rooms
  // ---------------------------------------------------------------------------------------

  /**
   * Create, restore, start and register a public shard. Takes the lowest shard number not
   * in use, so a shard that went to sleep is the one that wakes when another is needed —
   * with its guestbook and board — rather than its state waiting forever under a number
   * that is never issued again.
   */
  createRoom(): Room {
    let n = 1;
    while (this.rooms.has(`shore-${n}`)) n++;
    const id: RoomId = `shore-${n}`;
    const room = new Room(id, `Nagisa — Shore ${n}`, this.opts.roomCapacity, this.log.child({ room: id }), {
      kind: 'public',
      persist: this.opts.persist,
      random: this.opts.random,
      onPopulation: () => this.publishPopulation(),
    });
    return this.wake(room);
  }

  /**
   * Make a new private island kept by `owner`. Returns null when too many islands are awake
   * (the caller says so; nothing is lost by trying again later).
   */
  createPrivate(owner: RoomOwner): Room | null {
    if (this.liveIslandCount() >= MAX_LIVE_ISLANDS) return null;
    let code = '';
    do code = mintCode();
    while (this.islands.has(code) || this.rooms.has(islandRoomId(code)));
    const now = Date.now();
    this.islands.set(code, { code, ownerHash: owner.hash, ownerName: owner.name, createdAt: now, lastActiveAt: now });
    this.log.info('island_created', { code, keeper: owner.hash ? 'visitor' : 'session' });
    const room = this.openIsland(code, owner);
    this.opts.persist();
    return room;
  }

  /**
   * The registered island with `code`, woken if asleep; null if no island has that code or
   * too many are awake. `maker` is only consulted for an island being opened for the first
   * time by the person who just made it, when its keeper has no visitor key.
   */
  private openIsland(code: string, maker: RoomOwner | null = null): Room | null {
    const id = islandRoomId(code);
    const live = this.rooms.get(id);
    if (live) return live;
    const entry = this.islands.get(code);
    if (!entry) return null;
    if (this.liveIslandCount() >= MAX_LIVE_ISLANDS) return null;

    const owner: RoomOwner = {
      hash: entry.ownerHash,
      name: entry.ownerName,
      // A keeper without a visitor key keeps their island for the session that made it.
      playerId: entry.ownerHash === null ? (maker?.playerId ?? null) : null,
    };
    const room = new Room(id, `渚 ${code}`, this.opts.privateCapacity, this.log.child({ room: id }), {
      kind: 'private',
      code,
      owner,
      persist: this.opts.persist,
      random: this.opts.random,
      onPopulation: () => this.publishPopulation(),
    });
    this.log.info('island_opened', { code });
    return this.wake(room);
  }

  /** Restore a room's sleeping state if it has any, start it, and register it. */
  private wake(room: Room): Room {
    const state = this.dormant.get(room.id);
    if (state) {
      room.restoreState(state);
      this.dormant.delete(room.id);
    }
    room.prime();
    if (this.opts.autostart !== false) room.start();
    this.rooms.set(room.id, room);
    metrics.roomsCurrent.set(this.rooms.size);
    this.log.info('room_awake', { room: room.id, kind: room.kind, restored: Boolean(state) });
    return room;
  }

  /**
   * Population metrics: each public shard by id, and every private island summed under
   * `room="private"`. A private island's id contains its invite code, and `/metrics` is
   * readable by anyone who can reach the port — labelling by id would publish every code.
   */
  private publishPopulation(): void {
    let islands = 0;
    for (const room of this.rooms.values()) {
      if (room.kind === 'public') metrics.roomPopulation.set(room.population, { room: room.id });
      else islands += room.population;
    }
    metrics.roomPopulation.set(islands, { room: 'private' });
  }

  private liveIslandCount(): number {
    let n = 0;
    for (const room of this.rooms.values()) if (room.kind === 'private') n++;
    return n;
  }

  // ---------------------------------------------------------------------------------------
  // Finding rooms
  // ---------------------------------------------------------------------------------------

  get(id: RoomId): Room | undefined {
    return this.rooms.get(id);
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  /**
   * The rooms a client may be shown: every public shard, and the room they are in if it is
   * private. Somebody else's island is never listed.
   */
  listViews(current?: Room): RoomView[] {
    const views = this.list()
      .filter((r) => r.kind === 'public')
      .map((r) => r.toView());
    if (current && current.kind === 'private') views.push(current.toView());
    return views;
  }

  /**
   * Resolve a room id or an invite code to a room, waking a sleeping island as needed.
   * `refusal` says why not: no such island, or too many islands awake to wake another.
   */
  resolve(target: string): { room: Room } | { refusal: RoomRefusal } {
    const live = this.rooms.get(target);
    if (live) return { room: live };
    const code = normaliseRoomCode(target);
    if (!code) return { refusal: 'not_found' };
    if (!this.islands.has(code)) return { refusal: 'not_found' };
    const room = this.openIsland(code);
    return room ? { room } : { refusal: 'busy' };
  }

  /**
   * Matchmaking.
   *
   * Product requirement: **bias toward filling rooms, not spreading players evenly.** A world
   * where five rooms each sit at 20% population feels dead — every client sees a near-empty
   * island. So: among public shards with comfortable headroom, pick the *fullest* one. Only
   * when every shard is at that ceiling is a new one opened.
   *
   * `preferred` (from `ClientHello.room`) — a room id or an invite code — is honoured when it
   * resolves to a room with capacity left. When an island cannot be had (unknown code, full,
   * too many awake) the player is matchmade instead and `refusal` says why, so the handshake
   * can tell them.
   */
  pickRoom(preferred?: string): { room: Room; refusal?: RoomRefusal } {
    let refusal: RoomRefusal | undefined;
    if (preferred) {
      const wanted = this.resolve(preferred);
      if ('room' in wanted && wanted.room.hasCapacity) return { room: wanted.room };
      // A public shard id from before a restart is not worth mentioning: any shard will do.
      if ('room' in wanted) refusal = 'full';
      else if (normaliseRoomCode(preferred)) refusal = wanted.refusal;
    }

    let best: Room | null = null;
    for (const room of this.rooms.values()) {
      if (room.kind !== 'public' || !room.hasCapacity) continue;
      const comfortableCeiling = Math.floor(room.capacity * (1 - HEADROOM_FRACTION));
      if (room.population >= comfortableCeiling) continue;
      if (!best || room.population > best.population) best = room;
    }
    return { room: best ?? this.createRoom(), refusal };
  }

  /**
   * Move a player (and their live session) from one room to another, preserving identity —
   * the same `Player` record, re-homed. The socket is never closed. Everything that belonged
   * to the old room is let go of first: the activity and its check-in, hosting, the seat, the
   * line, any duel (the old room's `removePlayer` does the games). The caller places them.
   */
  switchRoom(
    player: Player,
    session: Session,
    fromRoom: Room,
    target: string,
  ): { ok: true; room: Room } | { ok: false; reason: RoomRefusal } {
    const resolved = this.resolve(target);
    if (!('room' in resolved)) return { ok: false, reason: resolved.refusal };
    const room = resolved.room;
    if (room === fromRoom) return { ok: true, room: fromRoom };
    if (!room.hasCapacity) return { ok: false, reason: 'full' };

    fromRoom.removePlayer(player.id, 'room_switch', { closeSession: false });
    player.away = false;
    player.activity = null;
    player.mode = null;
    player.hostOf = null;
    player.checkedIn = false;
    player.seat = null;
    return { ok: true, room };
  }

  /** Find which room currently holds `playerId`, if any. */
  findRoomOf(playerId: PlayerId): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.getPlayer(playerId)) return room;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------
  // Sleep
  // ---------------------------------------------------------------------------------------

  /**
   * Put to sleep every room that has stood empty for {@link IDLE_MS}, except the first
   * `initialRoomCount` public shards. Returns how many went to sleep. Called periodically.
   */
  sweepIdle(now = Date.now()): number {
    let slept = 0;
    const keep = new Set(
      this.list()
        .filter((r) => r.kind === 'public')
        .slice(0, Math.max(1, this.opts.initialRoomCount))
        .map((r) => r.id),
    );
    for (const room of this.list()) {
      if (keep.has(room.id)) continue;
      if (room.population > 0 || room.emptySince === null || now - room.emptySince < IDLE_MS) continue;
      room.stop();
      this.dormant.set(room.id, room.exportState());
      this.rooms.delete(room.id);
      if (room.kind === 'public') metrics.roomPopulation.remove({ room: room.id });
      if (room.code) {
        const entry = this.islands.get(room.code);
        if (entry) entry.lastActiveAt = now;
      }
      slept++;
      this.log.info('room_asleep', { room: room.id });
    }
    if (slept) {
      metrics.roomsCurrent.set(this.rooms.size);
      this.opts.persist();
    }
    return slept;
  }

  /** Mark an island visited (called on join), so the registry keeps the ones people use. */
  touchIsland(room: Room, now = Date.now()): void {
    if (!room.code) return;
    const entry = this.islands.get(room.code);
    if (!entry) return;
    entry.lastActiveAt = now;
    if (room.owner?.name) entry.ownerName = room.owner.name;
  }

  // ---------------------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------------------

  /** Every room's state worth keeping: awake rooms freshly, sleeping ones as they were. */
  exportRooms(): Record<RoomId, PersistedRoom> {
    const out: Record<RoomId, PersistedRoom> = {};
    // Newest sleepers first, capped; awake rooms always kept.
    const sleeping = [...this.dormant.entries()].sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, DORMANT_LIMIT);
    for (const [id, state] of sleeping) out[id] = state;
    if (this.dormant.size > DORMANT_LIMIT) {
      for (const [id] of [...this.dormant.entries()].sort((a, b) => b[1].savedAt - a[1].savedAt).slice(DORMANT_LIMIT)) {
        this.dormant.delete(id);
      }
    }
    for (const room of this.rooms.values()) out[room.id] = room.exportState();
    return out;
  }

  exportIslands(): PersistedIsland[] {
    const all = [...this.islands.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    for (const gone of all.slice(ISLAND_LIMIT)) this.islands.delete(gone.code);
    return all.slice(0, ISLAND_LIMIT);
  }

  /** Rooms whose tick loop has stopped while it should be running. See `Room.isStalled`. */
  stalled(now = Date.now()): Room[] {
    return this.list().filter((r) => r.isStalled(now));
  }

  /** Bring the metrics that are cheaper to count than to maintain up to date; called on scrape. */
  publishMetrics(): void {
    const byState: Record<string, number> = {};
    for (const state of Object.values(ActivityState)) byState[state] = 0;
    for (const room of this.rooms.values()) for (const a of room.activities.list()) byState[a.state]++;
    for (const [state, n] of Object.entries(byState)) metrics.activitiesCurrent.set(n, { state });
  }

  /** Stop every room's tick loop and grace timers. Called during graceful shutdown. */
  stopAll(): void {
    for (const room of this.rooms.values()) room.stop();
  }
}

/**
 * A fresh invite code. From the system's CSPRNG rather than `Math.random`: a private island
 * is protected by nothing but its code being hard to guess.
 */
function mintCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

/** The room id of the island with `code`. */
export function islandRoomId(code: string): RoomId {
  return `isle-${code}`;
}
