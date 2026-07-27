/**
 * RoomManager — multiple shards of the same island.
 * ====================================================
 *
 * "Nagisa" is conceptually one island, but one WebSocket-fanout room has a practical
 * population ceiling (`CONFIG.ROOM_CAPACITY`). Past that, the server opens another
 * shard — same world, same activities schedule *concept*, independent player set and
 * tick loop. `RoomManager` is where "which shard do you land in" gets decided.
 */

import type { PlayerId, RoomId, RoomView } from '@nagisa/shared';
import { Room } from './room.js';
import type { Player } from './player.js';
import type { Session } from './session.js';
import type { Logger } from './logger.js';
import { metrics } from './metrics.js';

/**
 * Fraction of a room's capacity reserved as headroom when matchmaking targets it.
 * A room within this fraction of full is excluded from "fill the fullest room" so a
 * burst of simultaneous joins (several people opening the client at once) doesn't slam
 * a room to exactly its cap while a `hello` is mid-flight.
 */
const HEADROOM_FRACTION = 0.1;

export class RoomManager {
  private readonly rooms = new Map<RoomId, Room>();
  private shardCounter = 0;

  constructor(
    private readonly log: Logger,
    private readonly roomCapacity: number,
    initialRoomCount: number,
  ) {
    for (let i = 0; i < Math.max(1, initialRoomCount); i++) this.createRoom();
  }

  /** Create, start, and register a new room shard. */
  createRoom(): Room {
    this.shardCounter++;
    const id: RoomId = `shore-${this.shardCounter}`;
    const name = `Nagisa — Shore ${this.shardCounter}`;
    const room = new Room(id, name, this.roomCapacity, this.log.child({ room: id }));
    room.start();
    this.rooms.set(id, room);
    metrics.roomsCurrent.set(this.rooms.size);
    this.log.info('room_created', { room: id, capacity: this.roomCapacity });
    return room;
  }

  get(id: RoomId): Room | undefined {
    return this.rooms.get(id);
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  listViews(): RoomView[] {
    return this.list().map((r) => r.toView());
  }

  /**
   * Matchmaking.
   *
   * Product requirement: **bias toward filling rooms, not spreading players evenly.**
   * A world where five rooms each sit at 20% population feels dead — every client sees
   * a near-empty island. The same headcount concentrated into two rooms at 50% feels
   * alive in both. So: among rooms with comfortable headroom (population below
   * `capacity * (1 - HEADROOM_FRACTION)`), pick the *fullest* one, not the emptiest.
   * Only when every existing room is either full or already at that comfortable
   * ceiling do we open a new shard — growing the island's shard count is a last
   * resort, not a load-balancing default.
   *
   * `preferredId` (from `ClientHello.room`) is honoured when it names a room with
   * capacity left, letting a friend group deliberately land together; it is ignored
   * (falling through to normal matchmaking) if that room is unknown or full, per the
   * protocol's "advisory, not a guarantee" framing of client-requested room.
   */
  pickRoom(preferredId?: RoomId): Room {
    if (preferredId) {
      const preferred = this.rooms.get(preferredId);
      if (preferred && preferred.hasCapacity) return preferred;
    }

    let best: Room | null = null;
    for (const room of this.rooms.values()) {
      if (!room.hasCapacity) continue;
      const comfortableCeiling = Math.floor(room.capacity * (1 - HEADROOM_FRACTION));
      if (room.population >= comfortableCeiling) continue;
      if (!best || room.population > best.population) best = room;
    }
    return best ?? this.createRoom();
  }

  /**
   * Move a player (and their live session) from one room to another, preserving
   * identity — same `Player` record, just re-homed. The underlying socket is never
   * closed; only the room-membership bookkeeping (roster, activity attachment, presence)
   * changes.
   */
  switchRoom(
    player: Player,
    session: Session,
    fromRoom: Room,
    toRoomId: RoomId,
  ): { ok: true; room: Room } | { ok: false; reason: 'not_found' | 'full' } {
    const target = this.rooms.get(toRoomId);
    if (!target) return { ok: false, reason: 'not_found' };
    if (target === fromRoom) return { ok: true, room: fromRoom };
    if (!target.hasCapacity) return { ok: false, reason: 'full' };

    fromRoom.removePlayer(player.id, 'room_switch', { closeSession: false });
    // A player switching rooms is, by definition, not away — clear any stale flag and
    // re-spawn-adjacent zone bookkeeping is left to the caller (handlers.ts places them
    // at a fresh spawn point in the new room, mirroring first arrival).
    player.away = false;
    target.join(session, player);
    this.log.info('player_switched_room', { from: fromRoom.id, to: target.id, playerId: player.id });
    return { ok: true, room: target };
  }

  /** Find which room currently holds `playerId`, if any. Used to resolve resume targets without a room hint. */
  findRoomOf(playerId: PlayerId): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.getPlayer(playerId)) return room;
    }
    return undefined;
  }

  /** Stop every room's tick loop and grace timers. Called during graceful shutdown. */
  stopAll(): void {
    for (const room of this.rooms.values()) room.stop();
  }
}
