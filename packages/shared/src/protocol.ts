/**
 * Nagisa wire protocol.
 * =====================
 *
 * A single WebSocket carries every realtime concern (presence, movement, activities,
 * announcements, moderation). There is no second channel and no REST round-trip in the
 * hot path — the reference product's calm feel depends on the world never "loading" once
 * you are in it.
 *
 * Design rules, in priority order:
 *
 * 1. **Server authoritative for shared truth.** Activity lifecycle, rosters, check-ins,
 *    announcements and permissions are decided by the server. Clients may *request*; only
 *    the server *decides*. Movement is the deliberate exception (see §Movement below).
 *
 * 2. **Snapshot then delta.** On joining a room a client receives one {@link Snapshot}
 *    containing the complete observable state, and afterwards only {@link Delta} frames.
 *    Any desync is repaired by asking for a fresh snapshot, never by patching blindly.
 *
 * 3. **Every frame is tagged with a monotonic `tick`.** Reconnecting clients replay from
 *    their last acknowledged tick when the server still has the history, otherwise they
 *    are re-snapshotted. Clients must tolerate both paths.
 *
 * 4. **JSON on the wire, packed arrays in the hot path.** Messages are JSON for
 *    debuggability and schema evolution. The one high-frequency payload — player
 *    transforms — is packed into flat numeric arrays ({@link PackedTransforms}) so a
 *    120-player room costs a few KB/s rather than a few hundred.
 *
 * ### Movement
 * Movement is client-predicted and server-validated. A client integrates its own
 * character locally at render rate and reports the result at
 * {@link PROTOCOL.MOVE_SEND_HZ}. The server clamps the reported transform against a
 * speed budget and the island's walkable bounds; a client that exceeds the budget is
 * snapped back with {@link ServerCorrection}. Remote players are never simulated — they
 * are interpolated between received transforms with a fixed delay buffer.
 *
 * ### Versioning
 * {@link PROTOCOL.VERSION} is sent in {@link ClientHello} and checked in
 * {@link ServerWelcome}. Additive fields are backwards compatible; any change to the
 * meaning or packing of existing fields requires a version bump. The server may serve
 * two adjacent versions during a rolling deploy.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Protocol-wide tunables. Client and server MUST agree on every value here. */
export const PROTOCOL = {
  /** Bumped on any breaking change to message shape or packing. */
  VERSION: 1,

  /** Server simulation/broadcast tick. Deltas are emitted at this rate. */
  TICK_HZ: 10,

  /** Rate at which a client reports its own transform. Below TICK_HZ on purpose. */
  MOVE_SEND_HZ: 10,

  /** Client heartbeat interval. The server replies to every ping. */
  PING_INTERVAL_MS: 5_000,

  /**
   * A connection with no inbound frame for this long is considered dead and closed.
   * Must comfortably exceed PING_INTERVAL_MS to survive a mobile radio stall.
   */
  IDLE_TIMEOUT_MS: 20_000,

  /**
   * How long a session survives disconnection before its player is removed from the
   * room. Short enough that ghosts do not accumulate, long enough that a subway tunnel
   * or a screen-lock does not cost you your place in an activity.
   */
  SESSION_GRACE_MS: 45_000,

  /** Ticks of delta history retained per room, for replay-on-reconnect. */
  DELTA_HISTORY_TICKS: 120,

  /** Interpolation delay applied to remote players, in ms. Two ticks of slack. */
  INTERPOLATION_DELAY_MS: 200,

  /** Quantisation used by {@link PackedTransforms}: positions to 1cm, yaw to ~0.35°. */
  POS_SCALE: 100,
  YAW_SCALE: 1024,

  /** Hard caps enforced by the server. */
  MAX_NAME_LENGTH: 20,
  MAX_CHAT_LENGTH: 140,
  MAX_ANNOUNCEMENT_LENGTH: 240,

  /** Per-connection rate limits (messages per second, token bucket). */
  RATE_LIMIT: {
    move: 15,
    emote: 2,
    chat: 1,
    default: 10,
  },
} as const;

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/** Opaque server-issued identifiers. Aliased for readability at call sites. */
export type PlayerId = string;
export type RoomId = string;
export type ActivityId = string;

/**
 * Zone ids are defined by the world layout, not by the protocol — the protocol carries
 * whatever places the island happens to have. Re-exported here so protocol consumers do
 * not need a second import.
 */
export type { ZoneId } from './world.js';
import type { ZoneId } from './world.js';

/**
 * Authority a player holds. Ordered — a numerically higher role subsumes every
 * capability of the roles below it. Compare with {@link roleAtLeast}, never with `===`.
 */
export enum Role {
  /** Can move, emote, watch. The default for everyone who walks in. */
  Guest = 0,
  /** Has joined an activity as a participant: can check in and be counted. */
  Participant = 1,
  /** Runs one specific activity: start/stop it, announce within it, mute in it. */
  Host = 2,
  /** Island-wide: any activity, island-wide announcements, kick/ban. */
  Admin = 3,
}

/** Inclusive role comparison. `roleAtLeast(Role.Host, Role.Participant) === true`. */
export function roleAtLeast(actual: Role, required: Role): boolean {
  return actual >= required;
}

/** How a player relates to an activity they are attached to. */
export type AttendanceMode = 'participant' | 'audience';

/** Lifecycle of an activity. Transitions are validated server-side. */
export enum ActivityState {
  /** Announced, visible on the island, not yet accepting the crowd. */
  Scheduled = 'scheduled',
  /** Doors open: players may join as participant or audience. */
  Open = 'open',
  /** Running. Check-in is accepted only while running. */
  Live = 'live',
  /** Finished. Roster is frozen and retained for the post-event summary. */
  Ended = 'ended',
  /** Called off. Distinguished from `ended` so the UI can say so honestly. */
  Cancelled = 'cancelled',
}

/**
 * Legal state transitions. The server rejects anything not listed here, which keeps
 * "the host double-tapped start" from producing an impossible activity.
 */
export const ACTIVITY_TRANSITIONS: Readonly<Record<ActivityState, readonly ActivityState[]>> = {
  [ActivityState.Scheduled]: [ActivityState.Open, ActivityState.Cancelled],
  [ActivityState.Open]: [ActivityState.Live, ActivityState.Cancelled, ActivityState.Scheduled],
  [ActivityState.Live]: [ActivityState.Ended],
  [ActivityState.Ended]: [],
  [ActivityState.Cancelled]: [],
} as const;

export function canTransition(from: ActivityState, to: ActivityState): boolean {
  return ACTIVITY_TRANSITIONS[from].includes(to);
}

/**
 * Character animation states. Kept as a small enum rather than free strings so the
 * value survives quantisation into {@link PackedTransforms} as a single byte.
 */
export enum AnimState {
  Idle = 0,
  Walk = 1,
  Run = 2,
  Jump = 3,
  Fall = 4,
  Sit = 5,
  Clap = 6,
  Wave = 7,
  Bow = 8,
}

/** Emotes a player can broadcast. Deliberately small — see the UI's emote wheel. */
export const EMOTES = ['wave', 'clap', 'bow', 'heart', 'laugh', 'question', 'music', 'sparkle'] as const;
export type Emote = (typeof EMOTES)[number];

// ---------------------------------------------------------------------------
// Entities as they appear on the wire
// ---------------------------------------------------------------------------

/** Cosmetic character configuration. Purely presentational; never trusted for logic. */
export interface Appearance {
  /** Index into the client's palette of haori/yukata colours. */
  outfit: number;
  /** Index into the client's palette of skin tones. */
  skin: number;
  /** Index into the client's set of head accessories (0 = none). */
  accessory: number;
}

/** A player as broadcast to everyone else in the room. */
export interface PlayerView {
  id: PlayerId;
  name: string;
  appearance: Appearance;
  role: Role;
  /** Position in world space, metres. */
  pos: Vec3;
  /** Facing, radians. Characters are upright; pitch and roll are never networked. */
  yaw: number;
  anim: AnimState;
  /** Zone the server last saw them in — drives ambience and "who's here" counts. */
  zone: ZoneId | null;
  /** Activity they are attached to, if any. */
  activity: ActivityId | null;
  mode: AttendanceMode | null;
  /** True while the session is disconnected but still inside its grace window. */
  away?: boolean;
}

export type Vec3 = [number, number, number];

/** An activity: a scheduled thing happening in a place, that people attend. */
export interface ActivityView {
  id: ActivityId;
  /** Display title, e.g. "Evening Lantern Walk". */
  title: string;
  /** One line of context shown under the title. Not a description essay. */
  blurb: string;
  /** Where on the island it happens. Must be a venue zone — see world.ts. */
  zone: ZoneId;
  state: ActivityState;
  /** Wall-clock schedule, epoch ms. `startsAt` drives the "Next Up" strip. */
  startsAt: number;
  endsAt: number | null;
  /** Player who holds {@link Role.Host} for this activity. */
  hostId: PlayerId | null;
  hostName: string | null;
  /** Live counts, maintained server-side so clients never tally rosters themselves. */
  participantCount: number;
  audienceCount: number;
  /** 0 = uncapped. Enforced on join. */
  capacity: number;
  /** Whether this activity accepts check-ins while live. */
  checkinEnabled: boolean;
  /** Number of check-ins recorded so far. */
  checkinCount: number;
}

/** A message pushed to the island, a zone, or one activity's attendees. */
export interface AnnouncementView {
  id: string;
  text: string;
  /** Display name of the sender, resolved server-side. */
  fromName: string;
  /** Where it is shown. `island` reaches everyone in the room. */
  scope: { kind: 'island' } | { kind: 'zone'; zone: ZoneId } | { kind: 'activity'; activity: ActivityId };
  /** Epoch ms the announcement was issued. */
  at: number;
  /** Milliseconds the client should keep it on the notice board / toast. */
  ttlMs: number;
  /** Elevated announcements get a slower, more deliberate presentation. */
  priority: 'normal' | 'high';
}

/** Room-level summary carried in the welcome and in room listings. */
export interface RoomView {
  id: RoomId;
  /** Human name, e.g. "Nagisa — Shore 1". */
  name: string;
  population: number;
  capacity: number;
}

// ---------------------------------------------------------------------------
// Packed transform batching
// ---------------------------------------------------------------------------

/**
 * All moving players in one flat array, emitted once per tick.
 *
 * Layout, 6 numbers per player:
 * ```
 * [ idIndex, x*100, y*100, z*100, yaw*1024, anim ]
 * ```
 * `idIndex` refers to {@link PackedTransforms.ids}, which only changes when the room's
 * membership changes — so the per-tick payload is integers, and gzip/permessage-deflate
 * compresses it well.
 *
 * At 120 players this is ~720 integers per tick ≈ 3 KB/s per client after compression,
 * versus ~60 KB/s for the equivalent array of JSON objects.
 */
export interface PackedTransforms {
  /**
   * Roster the indices refer to. Sent only when it changes; when absent, the client
   * reuses the roster it already holds.
   */
  ids?: PlayerId[];
  /** Flat quantised transforms, 6 entries per moving player. */
  data: number[];
}

/** Unpack a {@link PackedTransforms} frame into per-player records. */
export function unpackTransforms(
  frame: PackedTransforms,
  roster: PlayerId[],
): Array<{ id: PlayerId; pos: Vec3; yaw: number; anim: AnimState }> {
  const out: Array<{ id: PlayerId; pos: Vec3; yaw: number; anim: AnimState }> = [];
  const { data } = frame;
  for (let i = 0; i + 5 < data.length; i += 6) {
    const id = roster[data[i]];
    if (id === undefined) continue; // Stale index: roster update is in flight.
    out.push({
      id,
      pos: [data[i + 1] / PROTOCOL.POS_SCALE, data[i + 2] / PROTOCOL.POS_SCALE, data[i + 3] / PROTOCOL.POS_SCALE],
      yaw: data[i + 4] / PROTOCOL.YAW_SCALE,
      anim: data[i + 5] as AnimState,
    });
  }
  return out;
}

/** Pack one player's transform into the six integers {@link unpackTransforms} expects. */
export function packTransform(index: number, pos: Vec3, yaw: number, anim: AnimState): number[] {
  return [
    index,
    Math.round(pos[0] * PROTOCOL.POS_SCALE),
    Math.round(pos[1] * PROTOCOL.POS_SCALE),
    Math.round(pos[2] * PROTOCOL.POS_SCALE),
    Math.round(yaw * PROTOCOL.YAW_SCALE),
    anim,
  ];
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

/**
 * First frame on every connection. The server replies with {@link ServerWelcome} or
 * closes with {@link ErrorCode.VersionMismatch}.
 */
export interface ClientHello {
  t: 'hello';
  protocol: number;
  name: string;
  appearance: Appearance;
  /**
   * Presented to resume a prior session (same player id, same activity attachment).
   * Issued by {@link ServerWelcome.resumeToken}. Invalid or expired tokens are ignored
   * rather than rejected — the client silently becomes a new visitor.
   */
  resumeToken?: string;
  /** Preferred room. Omit to be placed by the matchmaker. */
  room?: RoomId;
  /** Reported so the server can size deltas for weak devices. Advisory only. */
  caps?: { mobile: boolean; lowMemory: boolean };
}

/** Heartbeat. `t0` is echoed back so the client can measure RTT without a clock sync. */
export interface ClientPing {
  t: 'ping';
  t0: number;
}

/** Self transform report. Sent at {@link PROTOCOL.MOVE_SEND_HZ}, coalesced if late. */
export interface ClientMove {
  t: 'move';
  pos: Vec3;
  yaw: number;
  anim: AnimState;
  /** Monotonic per-connection sequence, used to drop out-of-order UDP-ish arrivals. */
  seq: number;
}

/** Broadcast an emote above the character's head. */
export interface ClientEmote {
  t: 'emote';
  emote: Emote;
}

/** Short speech bubble. Rate limited hard; this is not a chat app. */
export interface ClientChat {
  t: 'chat';
  text: string;
}

/** Attach to an activity as participant or audience. */
export interface ClientActivityJoin {
  t: 'activity_join';
  activity: ActivityId;
  mode: AttendanceMode;
}

/** Detach from the current activity. */
export interface ClientActivityLeave {
  t: 'activity_leave';
  activity: ActivityId;
}

/** Record attendance. Only accepted while the activity is {@link ActivityState.Live}. */
export interface ClientCheckin {
  t: 'checkin';
  activity: ActivityId;
}

/** Move to a different room (shard) of the same island. */
export interface ClientRoomSwitch {
  t: 'room_switch';
  room: RoomId;
}

/** Ask for a fresh {@link ServerSnapshot}, e.g. after detecting a gap in ticks. */
export interface ClientResync {
  t: 'resync';
  /** Last tick the client successfully applied. */
  haveTick: number;
}

/** Host/admin: drive an activity's lifecycle. Requires {@link Role.Host} on it. */
export interface ClientHostActivityState {
  t: 'host_activity_state';
  activity: ActivityId;
  state: ActivityState;
}

/** Host/admin: push an announcement. Scope is validated against the caller's role. */
export interface ClientHostAnnounce {
  t: 'host_announce';
  text: string;
  scope: AnnouncementView['scope'];
  priority?: AnnouncementView['priority'];
  ttlMs?: number;
}

/** Admin: moderation. Requires {@link Role.Admin}. */
export interface ClientAdminAction {
  t: 'admin_action';
  action: 'kick' | 'mute' | 'unmute' | 'grant_host' | 'revoke_host';
  target: PlayerId;
  /** Required for grant_host / revoke_host. */
  activity?: ActivityId;
  /** Free-text, written to the audit log. */
  reason?: string;
}

/** Lightweight world interaction: read the notice board, ring the bell, sit down. */
export interface ClientInteract {
  t: 'interact';
  /** Interactable id declared in the world layout. */
  target: string;
  kind: 'use' | 'sit' | 'stand';
}

export type ClientMessage =
  | ClientHello
  | ClientPing
  | ClientMove
  | ClientEmote
  | ClientChat
  | ClientActivityJoin
  | ClientActivityLeave
  | ClientCheckin
  | ClientRoomSwitch
  | ClientResync
  | ClientHostActivityState
  | ClientHostAnnounce
  | ClientAdminAction
  | ClientInteract;

export type ClientMessageType = ClientMessage['t'];

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

/** Accepted the connection. Always followed immediately by a {@link ServerSnapshot}. */
export interface ServerWelcome {
  t: 'welcome';
  protocol: number;
  /** The connecting player's own id — needed to filter self out of deltas. */
  self: PlayerId;
  /** Present this in a later {@link ClientHello} to resume. Rotates on each welcome. */
  resumeToken: string;
  /** True when a prior session was restored rather than a new player created. */
  resumed: boolean;
  room: RoomView;
  /** Server epoch ms at send time; the client offsets its clock from this. */
  serverTime: number;
  tickHz: number;
  /** Rooms the client may switch to, for the room picker. */
  rooms: RoomView[];
}

export interface ServerPong {
  t: 'pong';
  t0: number;
  serverTime: number;
}

/** Complete observable state of a room. Idempotent: applying it twice is safe. */
export interface ServerSnapshot {
  t: 'snapshot';
  room: RoomId;
  tick: number;
  serverTime: number;
  players: PlayerView[];
  activities: ActivityView[];
  /** Announcements still within their TTL, oldest first. */
  announcements: AnnouncementView[];
  /** Per-zone occupancy, for the map/zone labels. */
  zonePopulation: Record<ZoneId, number>;
}

/**
 * Per-tick incremental update. Every field is optional; a quiet tick carries only
 * `tick` and the packed transforms of whoever moved.
 */
export interface ServerDelta {
  t: 'delta';
  tick: number;
  /** Players who entered the room this tick. */
  join?: PlayerView[];
  /** Ids of players who left. */
  leave?: PlayerId[];
  /** Movement for everyone who moved this tick. */
  moves?: PackedTransforms;
  /** Non-transform player changes: zone, activity attachment, role, away flag. */
  players?: Array<Partial<PlayerView> & { id: PlayerId }>;
  /** Activities created or changed. Full objects — activities are small and rare. */
  activities?: ActivityView[];
  /** Ids of activities removed from the board entirely. */
  activitiesRemoved?: ActivityId[];
  /** New announcements issued this tick. */
  announcements?: AnnouncementView[];
  /** Fire-and-forget expressions. Never retained in snapshots. */
  emotes?: Array<{ id: PlayerId; emote: Emote }>;
  chats?: Array<{ id: PlayerId; text: string }>;
  zonePopulation?: Record<ZoneId, number>;
}

/**
 * Authoritative correction of a client's own position. Sent when the client's reported
 * transform failed validation (speed budget, walkable bounds, or an activity that pins
 * players to a stage). The client must hard-snap, not blend.
 */
export interface ServerCorrection {
  t: 'correction';
  pos: Vec3;
  yaw: number;
  reason: 'speed' | 'bounds' | 'teleport' | 'stage';
}

/** Result of a check-in attempt. */
export interface ServerCheckinAck {
  t: 'checkin_ack';
  activity: ActivityId;
  ok: boolean;
  /** Position in the check-in order, 1-based. Present only when `ok`. */
  ordinal?: number;
  reason?: string;
}

/** The client's own role changed — e.g. it was granted host of an activity. */
export interface ServerRoleChanged {
  t: 'role_changed';
  role: Role;
  /** Activity the host role applies to, if role === Host. */
  activity?: ActivityId;
}

/** Room switch completed. Followed by a fresh snapshot for the new room. */
export interface ServerRoomChanged {
  t: 'room_changed';
  room: RoomView;
}

export enum ErrorCode {
  VersionMismatch = 'version_mismatch',
  BadMessage = 'bad_message',
  RateLimited = 'rate_limited',
  Forbidden = 'forbidden',
  NotFound = 'not_found',
  RoomFull = 'room_full',
  ActivityFull = 'activity_full',
  InvalidTransition = 'invalid_transition',
  Kicked = 'kicked',
  ServerShutdown = 'server_shutdown',
  Internal = 'internal',
}

/**
 * A problem with the *last request*, not with the connection. The connection stays open
 * unless `fatal` is set, so a rejected activity join never costs you the world.
 */
export interface ServerError {
  t: 'error';
  code: ErrorCode;
  message: string;
  fatal?: boolean;
}

export type ServerMessage =
  | ServerWelcome
  | ServerPong
  | ServerSnapshot
  | ServerDelta
  | ServerCorrection
  | ServerCheckinAck
  | ServerRoleChanged
  | ServerRoomChanged
  | ServerError;

export type ServerMessageType = ServerMessage['t'];

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/**
 * Serialise a message for the socket. Centralised so a future switch to a binary codec
 * (MessagePack, CBOR) is a two-function change rather than a codebase-wide one.
 */
export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse an inbound frame. Returns `null` rather than throwing for malformed input —
 * a hostile client should cost one dropped message, not an exception in the read loop.
 */
export function decode<T extends ClientMessage | ServerMessage>(raw: string | Buffer): T | null {
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.t !== 'string') return null;
    return parsed as T;
  } catch {
    return null;
  }
}
