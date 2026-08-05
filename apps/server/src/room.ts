/**
 * Room — one shard of the island: the players in it, its activities, its
 * announcements, and the fixed-rate tick that keeps everyone's view of it current.
 * =====================================================================================
 *
 * This is the busiest file in the server. Everything else exists to feed it (handlers
 * validate and translate client intent into calls on a `Room`) or to be fed by it
 * (metrics, persistence, audit). The tick loop is the one piece of real-time state
 * machinery in the whole system; the rest of the server is comparatively simple request
 * handling.
 *
 * ## The tick loop, in one paragraph
 *
 * Every 1000/`PROTOCOL.TICK_HZ` ms: advance the activity scheduler, expire stale
 * announcements, gather whatever changed into one `ServerDelta`, append it to a ring
 * buffer of recent deltas (for replay-on-reconnect), and broadcast it. A delta that
 * contains nothing but (possibly zero) player movement is marked droppable — see
 * `session.ts` — because a lost movement frame is repaired by the next one 100ms later.
 * Anything else (a join, an activity going live, an announcement) is delivered
 * best-effort-but-not-droppable, because there is no "next frame" that would repair its
 * loss.
 *
 * ## The roster and why it is stable
 *
 * `PackedTransforms.ids` is only sent when room membership changes; every other tick
 * reuses the client's already-held roster. To make that safe, `Room` keeps its own
 * `rosterIds`/`rosterIndex` (not derived from `players.keys()` on the fly — Map
 * iteration order is a coincidence of implementation, not a contract we want to depend
 * on for wire compatibility). A join appends to the end; a leave splices the entry out
 * and reindexes the tail. Either operation sets `rosterDirty`, which guarantees the very
 * next delta re-sends the full roster before any index into it is trusted. Between
 * membership changes, indices are untouched — that stability is what lets a quiet tick's
 * payload be nothing but integers.
 */

import { randomUUID } from 'node:crypto';
import {
  PROTOCOL,
  ZONES,
  packTransform,
  type ActivityId,
  type ActivityView,
  type AnnouncementView,
  type Emote,
  type PackedTransforms,
  type PlayerId,
  type PlayerView,
  type RoomId,
  type RoomView,
  type ServerDelta,
  type ServerSnapshot,
  type ZoneId,
} from '@nagisa/shared';
import { ActivityManager } from './activity.js';
import type { Player } from './player.js';
import type { Session } from './session.js';
import type { Logger } from './logger.js';
import { metrics } from './metrics.js';
import type { PersistedActivity } from './persistence.js';

/**
 * All ZoneIds, used to seed a full (all-zeros) zone population record.
 *
 * Read from `ZONES` on each call rather than captured once. `ZONES` is a live binding over
 * the active map pack, and the map is chosen at boot from `NAGISA_MAP` — snapshotting it at
 * module scope would bind whichever map happened to be active when this file was first
 * imported, which depends on module evaluation order rather than on configuration.
 */
function allZoneIds(): readonly ZoneId[] {
  return ZONES.map((z) => z.id);
}

/**
 * A delta is "quiet" — and therefore safe to drop under backpressure, see
 * `session.ts` — when it contains nothing but the tick number and player movement.
 * Anything else is a one-shot fact with no repairing successor frame.
 */
function isQuietDelta(d: ServerDelta): boolean {
  return (
    !d.join &&
    !d.leave &&
    !d.players &&
    !d.activities &&
    !d.activitiesRemoved &&
    !d.announcements &&
    !d.emotes &&
    !d.chats &&
    !d.zonePopulation
  );
}

function zonePopulationEqual(a: Record<ZoneId, number>, b: Record<ZoneId, number>): boolean {
  for (const id of allZoneIds()) if (a[id] !== b[id]) return false;
  return true;
}

export class Room {
  readonly id: RoomId;
  readonly name: string;
  readonly capacity: number;
  readonly activities = new ActivityManager();

  private readonly players = new Map<PlayerId, Player>();
  private readonly sessions = new Map<PlayerId, Session>();
  private readonly graceTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();

  private tick = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Ring buffer of recent deltas, newest last, capped at `PROTOCOL.DELTA_HISTORY_TICKS`. */
  private readonly history: ServerDelta[] = [];

  private rosterIds: PlayerId[] = [];
  private rosterIndex = new Map<PlayerId, number>();
  /** True when `rosterIds` changed since the last delta — forces the next delta to resend it. */
  private rosterDirty = false;

  private announcements: AnnouncementView[] = [];
  private lastZonePopulation: Record<ZoneId, number> | null = null;

  // --- per-tick accumulators, cleared after every broadcast --------------------------
  private pendingJoins: PlayerView[] = [];
  private pendingLeaves: PlayerId[] = [];
  private pendingPlayerChanges = new Map<PlayerId, Partial<PlayerView> & { id: PlayerId }>();
  private pendingActivityChanges = new Map<ActivityId, ActivityView>();
  private pendingAnnouncements: AnnouncementView[] = [];
  private pendingEmotes: Array<{ id: PlayerId; emote: Emote }> = [];
  private pendingChats: Array<{ id: PlayerId; text: string }> = [];

  constructor(
    id: RoomId,
    name: string,
    capacity: number,
    private readonly log: Logger,
  ) {
    this.id = id;
    this.name = name;
    this.capacity = capacity;
    // Any activity mutation (create, transition, join/leave, checkin, host change)
    // funnels through this one event, so callers of ActivityManager never need to
    // remember to also tell the room — the event is the single source of truth for
    // "something about this activity needs to reach clients."
    this.activities.on('changed', (activity) => {
      this.pendingActivityChanges.set(activity.id, activity.toView());
    });
  }

  // ---------------------------------------------------------------------------------
  // Population / capacity
  // ---------------------------------------------------------------------------------

  /** Current occupancy, including players in their reconnect grace window (their spot is still theirs). */
  get population(): number {
    return this.players.size;
  }

  get hasCapacity(): boolean {
    return this.players.size < this.capacity;
  }

  toView(): RoomView {
    return { id: this.id, name: this.name, population: this.population, capacity: this.capacity };
  }

  getPlayer(id: PlayerId): Player | undefined {
    return this.players.get(id);
  }

  getSession(id: PlayerId): Session | undefined {
    return this.sessions.get(id);
  }

  allPlayers(): IterableIterator<Player> {
    return this.players.values();
  }

  // ---------------------------------------------------------------------------------
  // Join / leave / resume
  // ---------------------------------------------------------------------------------

  /** Add a brand-new (or freshly-resumed-from-nothing) player and their live session to the room. */
  join(session: Session, player: Player): void {
    this.players.set(player.id, player);
    this.sessions.set(player.id, session);
    this.rosterIds.push(player.id);
    this.rosterIndex.set(player.id, this.rosterIds.length - 1);
    this.rosterDirty = true;
    this.pendingJoins.push(player.toView());
    metrics.roomPopulation.set(this.population, { room: this.id });
    this.log.info('player_joined', { room: this.id, playerId: player.id, name: player.name });
  }

  /**
   * Reattach a live session to a player who is currently in their grace window
   * (`away === true`, no live session). Cancels the pending removal timer and clears
   * the away flag, broadcast as a `players` delta patch so everyone else's roster
   * un-greys them.
   */
  resume(session: Session, player: Player): void {
    this.sessions.set(player.id, session);
    this.cancelGraceTimer(player.id);
    if (player.away) {
      player.away = false;
      this.markPlayerChanged(player.id, { away: false });
    }
    this.log.info('player_resumed', { room: this.id, playerId: player.id });
  }

  /**
   * Mark a player as disconnected without removing them yet. They keep their room slot,
   * their activity attachment, and their position for `PROTOCOL.SESSION_GRACE_MS` — long
   * enough to survive a subway tunnel or a screen lock without losing your place at an
   * activity. If no session reattaches within the grace window, `removePlayer` runs.
   */
  disconnect(playerId: PlayerId): void {
    this.sessions.delete(playerId);
    const player = this.players.get(playerId);
    if (!player) return;
    player.away = true;
    this.markPlayerChanged(playerId, { away: true });
    const timer = setTimeout(() => {
      this.removePlayer(playerId, 'grace_expired');
    }, PROTOCOL.SESSION_GRACE_MS);
    timer.unref?.();
    this.graceTimers.set(playerId, timer);
    this.log.info('player_disconnected', { room: this.id, playerId, graceMs: PROTOCOL.SESSION_GRACE_MS });
  }

  private cancelGraceTimer(playerId: PlayerId): void {
    const timer = this.graceTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(playerId);
    }
  }

  /**
   * Permanently remove a player from the room: detaches them from any activity, drops
   * them from the roster, and queues a `leave` for the next delta. Used for explicit
   * kicks, grace-window expiry, and (with `closeSession: false`) room switching, where
   * the same live socket is about to be re-attached to a different room and must not be
   * torn down. Returns the removed `Player` record so a room switch can re-insert the
   * same record elsewhere without losing identity/appearance/role.
   */
  removePlayer(playerId: PlayerId, reason: string, opts: { closeSession?: boolean } = {}): Player | undefined {
    this.cancelGraceTimer(playerId);
    const player = this.players.get(playerId);
    if (!player) return undefined;

    if (player.activity) {
      const activity = this.activities.get(player.activity);
      activity?.leave(playerId);
      if (activity) this.activities.notifyChanged(activity);
    }

    this.players.delete(playerId);
    const session = this.sessions.get(playerId);
    if (opts.closeSession !== false) session?.close(1000, reason);
    this.sessions.delete(playerId);

    const idx = this.rosterIds.indexOf(playerId);
    if (idx >= 0) {
      this.rosterIds.splice(idx, 1);
      this.rosterIndex.delete(playerId);
      // Re-index the tail. This is an O(n) reshuffle of the id→index map, but it only
      // happens on membership change, which forces a full roster resend anyway — the
      // indices produced here are exactly the ones that resend will carry.
      for (let i = idx; i < this.rosterIds.length; i++) this.rosterIndex.set(this.rosterIds[i], i);
      this.rosterDirty = true;
    }

    this.pendingLeaves.push(playerId);
    metrics.roomPopulation.set(this.population, { room: this.id });
    this.log.info('player_removed', { room: this.id, playerId, reason });
    return player;
  }

  // ---------------------------------------------------------------------------------
  // Player field changes (zone crossing, activity attach, role grant, away flag, ...)
  // ---------------------------------------------------------------------------------

  /**
   * Queue a non-transform field change (zone, activity/mode, role, away) to go out in
   * the `players` array of the next delta. Movement (`pos`/`yaw`/`anim`) never goes
   * through here — that is `PackedTransforms`' job, gathered separately every tick from
   * `player.dirty`.
   */
  markPlayerChanged(id: PlayerId, patch: Partial<PlayerView>): void {
    const existing = this.pendingPlayerChanges.get(id) ?? { id };
    this.pendingPlayerChanges.set(id, { ...existing, ...patch });
  }

  // ---------------------------------------------------------------------------------
  // Emotes / chat
  // ---------------------------------------------------------------------------------

  emote(id: PlayerId, emote: Emote): void {
    this.pendingEmotes.push({ id, emote });
  }

  chat(id: PlayerId, text: string): void {
    this.pendingChats.push({ id, text });
  }

  // ---------------------------------------------------------------------------------
  // Announcements
  // ---------------------------------------------------------------------------------

  /**
   * Publish an announcement. Delivery is unfiltered — every session in the room
   * receives every announcement's *existence* in the next delta, exactly as every
   * session's snapshot includes every currently-active announcement regardless of
   * scope. `scope` is about who was *allowed to create* it (see `permissions.ts`) and
   * how the client chooses to *present* it (a toast vs. the notice board), not about
   * server-side delivery filtering — the room has no per-client view of "which zone are
   * you in right now" that would make partial delivery meaningfully cheaper, and
   * unfiltered delivery is what lets a player who walks into a zone moments after an
   * announcement still see it appear on the notice board rather than having missed a
   * targeted send.
   */
  announce(input: Omit<AnnouncementView, 'id' | 'at'>): AnnouncementView {
    const full: AnnouncementView = { ...input, id: randomUUID(), at: Date.now() };
    this.announcements.push(full);
    this.pendingAnnouncements.push(full);
    return full;
  }

  /**
   * Restore an announcement from persisted state verbatim (same id, same original `at`)
   * without treating it as newly-created — it must not be re-queued into the next
   * delta (every currently-connected client, if any survived the restart's grace
   * window, already knows about it) and its TTL must be measured from its original
   * issue time, not from the moment the server happened to reboot.
   */
  restoreAnnouncement(view: AnnouncementView): void {
    this.announcements.push(view);
  }

  private expireAnnouncements(nowMs: number): void {
    this.announcements = this.announcements.filter((a) => nowMs - a.at < a.ttlMs);
  }

  private activeAnnouncements(): AnnouncementView[] {
    return [...this.announcements].sort((a, b) => a.at - b.at);
  }

  // ---------------------------------------------------------------------------------
  // Zone population
  // ---------------------------------------------------------------------------------

  private computeZonePopulation(): Record<ZoneId, number> {
    const counts = Object.fromEntries(allZoneIds().map((z) => [z, 0])) as Record<ZoneId, number>;
    for (const player of this.players.values()) {
      // Away players are disconnected — they still occupy a room slot (see `disconnect`)
      // but should not inflate "how many people are physically in this zone right now."
      if (player.zone && !player.away) counts[player.zone]++;
    }
    return counts;
  }

  // ---------------------------------------------------------------------------------
  // Snapshot / delta / replay
  // ---------------------------------------------------------------------------------

  /** The complete observable state of the room. Idempotent — a client may apply this any number of times. */
  buildSnapshot(): ServerSnapshot {
    return {
      t: 'snapshot',
      room: this.id,
      tick: this.tick,
      serverTime: Date.now(),
      players: [...this.players.values()].map((p) => p.toView()),
      activities: this.activities.list().map((a) => a.toView()),
      announcements: this.activeAnnouncements(),
      zonePopulation: this.computeZonePopulation(),
    };
  }

  /**
   * Deltas the caller should replay to catch up from `haveTick` to the present, or
   * `null` if the gap is too large for the retained history (`PROTOCOL.DELTA_HISTORY_TICKS`
   * ticks) — in which case the caller must fall back to a fresh `buildSnapshot()`.
   */
  getDeltasSince(haveTick: number): ServerDelta[] | null {
    if (haveTick >= this.tick) return [];
    if (this.history.length === 0) return null;
    const oldestTick = this.history[0].tick;
    if (haveTick < oldestTick - 1) return null; // gap predates our retained history
    return this.history.filter((d) => d.tick > haveTick);
  }

  private pushHistory(delta: ServerDelta): void {
    this.history.push(delta);
    if (this.history.length > PROTOCOL.DELTA_HISTORY_TICKS) this.history.shift();
  }

  /** Gather every moving player into one `PackedTransforms` frame, or `undefined` if nothing to send. */
  private gatherMoves(): PackedTransforms | undefined {
    const data: number[] = [];
    for (const player of this.players.values()) {
      if (!player.dirty) continue;
      const idx = this.rosterIndex.get(player.id);
      if (idx === undefined) continue; // Shouldn't happen — every player has a roster slot.
      data.push(...packTransform(idx, player.pos, player.yaw, player.anim));
      player.dirty = false;
    }
    const includeIds = this.rosterDirty;
    if (includeIds) this.rosterDirty = false;
    if (data.length === 0 && !includeIds) return undefined;
    const frame: PackedTransforms = { data };
    if (includeIds) frame.ids = [...this.rosterIds];
    return frame;
  }

  private buildDelta(): ServerDelta {
    const delta: ServerDelta = { t: 'delta', tick: this.tick };
    if (this.pendingJoins.length) delta.join = this.pendingJoins;
    if (this.pendingLeaves.length) delta.leave = this.pendingLeaves;
    if (this.pendingPlayerChanges.size) delta.players = [...this.pendingPlayerChanges.values()];
    if (this.pendingActivityChanges.size) delta.activities = [...this.pendingActivityChanges.values()];
    if (this.pendingAnnouncements.length) delta.announcements = this.pendingAnnouncements;
    if (this.pendingEmotes.length) delta.emotes = this.pendingEmotes;
    if (this.pendingChats.length) delta.chats = this.pendingChats;

    const zonePopulation = this.computeZonePopulation();
    if (!this.lastZonePopulation || !zonePopulationEqual(zonePopulation, this.lastZonePopulation)) {
      delta.zonePopulation = zonePopulation;
      this.lastZonePopulation = zonePopulation;
    }

    const moves = this.gatherMoves();
    if (moves) delta.moves = moves;

    return delta;
  }

  private clearPending(): void {
    this.pendingJoins = [];
    this.pendingLeaves = [];
    this.pendingPlayerChanges.clear();
    this.pendingActivityChanges.clear();
    this.pendingAnnouncements = [];
    this.pendingEmotes = [];
    this.pendingChats = [];
  }

  private broadcast(delta: ServerDelta): void {
    const droppable = isQuietDelta(delta);
    for (const session of this.sessions.values()) {
      session.send(delta, { droppable });
    }
  }

  /** Run one tick: advance schedulers, gather changes, broadcast, record history. Never throws. */
  private runTick(): void {
    const startedAt = performance.now();
    try {
      this.tick++;
      const now = Date.now();
      this.activities.sweep(now);
      this.expireAnnouncements(now);
      const delta = this.buildDelta();
      this.pushHistory(delta);
      this.broadcast(delta);
      this.clearPending();
    } catch (err) {
      // A bug in one tick must never take the room down — the next tick gets a clean
      // slate. Losing one tick's worth of updates is far cheaper than losing the room.
      this.log.error('room_tick_error', { room: this.id, err });
      metrics.errorsTotal.inc({ kind: 'room_tick' });
    } finally {
      metrics.tickDurationMs.observe(performance.now() - startedAt);
    }
  }

  /**
   * Run exactly one tick synchronously, right now, bypassing the interval timer.
   * Production code never calls this directly — `start()` drives the real cadence via
   * `setInterval`. It exists so tests can advance room state deterministically without
   * sleeping for real wall-clock ticks (see `room.test.ts`).
   */
  forceTick(): void {
    this.runTick();
  }

  /** Start the fixed-rate tick loop. Idempotent. */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.runTick(), 1000 / PROTOCOL.TICK_HZ);
    this.tickTimer.unref?.();
  }

  /** Stop the tick loop and cancel every pending grace timer. Used on room teardown / process shutdown. */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
  }

  /** Every live session in the room, for cross-cutting operations like shutdown broadcast. */
  allSessions(): IterableIterator<Session> {
    return this.sessions.values();
  }

  // ---------------------------------------------------------------------------------
  // Persistence interop (see persistence.ts) — pure data projection, no I/O here.
  // ---------------------------------------------------------------------------------

  /** Project current activities into the shape `Store` persists. */
  exportActivities(): PersistedActivity[] {
    return this.activities.list().map((a) => ({
      id: a.id,
      templateId: a.templateId,
      title: a.title,
      blurb: a.blurb,
      zone: a.zone,
      state: a.state,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      hostId: a.hostId,
      hostName: a.hostName,
      capacity: a.capacity,
      checkinEnabled: a.checkinEnabled,
      participants: [...a.participants],
      audience: [...a.audience],
      checkins: a.checkinRecords(),
    }));
  }

  exportAnnouncements(): AnnouncementView[] {
    return this.activeAnnouncements();
  }
}
