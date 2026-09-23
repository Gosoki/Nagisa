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
  /**
   * Bumped on any breaking change to message shape or packing.
   *
   * v2: private islands, visitor keys, world events, the games (○× quiz, fishing,
   * omikuji, stamps, janken, fireworks, dice), the guestbook, whispers.
   */
  VERSION: 2,

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
  /** A guestbook line is a signature, not a letter. */
  MAX_GUESTBOOK_LENGTH: 80,
  /** A private island's name, as its keeper gives it. */
  MAX_ISLAND_TITLE_LENGTH: 24,
  /** How long a visitor kicked off a private island is kept off it, minutes. */
  ISLAND_BAN_MIN: 30,

  /**
   * Per-connection rate limits: a token bucket per message type, refilled at `rate` per
   * second and holding at most `burst`. The burst is what lets someone type two short lines
   * back to back without the second silently vanishing; the rate is what stops a script.
   * Game-level cooldowns (one firework per few seconds, one guestbook line per half
   * minute) are enforced by the game modules on top of this, and say so when they refuse.
   */
  RATE_LIMIT: {
    move: { rate: 15, burst: 15 },
    emote: { rate: 2, burst: 3 },
    chat: { rate: 1, burst: 4 },
    /** Moving between islands rebuilds your whole world; nobody needs to do it twice a second. */
    room_switch: { rate: 0.2, burst: 3 },
    room_create: { rate: 0.1, burst: 2 },
    /** Renaming an island is shown to everyone on it: a few tries, then slowly. */
    room_title: { rate: 0.2, burst: 3 },
    default: { rate: 10, burst: 10 },
  },

  /**
   * A visitor key: the random string a browser keeps so that stamps, the fish book and
   * badges survive between visits without an account. Opaque; the server stores only a
   * hash of it. See {@link ClientHello.visitor}.
   */
  VISITOR_KEY_MIN: 16,
  VISITOR_KEY_MAX: 64,
} as const;

/** What a visitor key may contain. Anything else is ignored as if absent. */
export const VISITOR_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * A private island's invite code: five characters from an alphabet with no look-alikes
 * (no 0/O, 1/I/L), so it survives being read aloud or copied off a phone screen.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_PATTERN = /^[2-9A-HJKMNP-Z]{5}$/;

/** Normalise user input ("ab c2d") into a code, or null if it cannot be one. */
export function normaliseRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

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
import type { ActivityFeature } from './map/types.js';
import type { BadgeId } from './games/badges.js';
import type { DigHeat } from './games/treasure.js';
import type { DailyTask } from './games/daily.js';

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
  // Not back to `scheduled`: doors open five minutes before the start by the clock, so an
  // activity sent back would simply be opened again on the next sweep.
  [ActivityState.Open]: [ActivityState.Live, ActivityState.Cancelled],
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
  /** Holding a rod over the water. Broadcast like any other pose, so the rod is seen. */
  Fish = 9,
  /** Arms up. Winners, and the first sight of a fish worth keeping. */
  Cheer = 10,
  /** Bon-odori at the beach concert: everyone dancing it moves on the same beat. */
  Dance = 11,
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
  /** Checked in to the activity they are attending. Cleared when the attachment changes. */
  checkedIn?: boolean;
  /** The badge they have chosen to wear under their name, if any. */
  title?: BadgeId | null;
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
  /** Template it was made from — the client's key for localised titles and venue effects. */
  templateId: string;
  /** What the island does while it runs. See {@link ActivityFeature}. */
  feature: ActivityFeature | null;
  /**
   * A small leaderboard, for activities that keep score (the derby's biggest fish, the
   * treasure hunt's finds, だるまさんがころんだ's places and the seconds each took). Top few
   * only; `score` is in the activity's own unit.
   */
  board?: Array<{ id: PlayerId; name: string; score: number }>;
  /** For a treasure hunt: how many things are still in the ground. */
  left?: number;
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
  /**
   * `public` shards are what matchmaking fills. A `private` island exists because someone
   * made it and shared its code; it is never listed to strangers.
   */
  kind: 'public' | 'private';
  /** The invite code, for private islands. */
  code?: string;
  /** Display name of whoever made it, for private islands, when known. */
  ownerName?: string | null;
  /** The name its keeper gave a private island, if they gave it one. */
  title?: string;
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
  /**
   * Where the client last stood, so a reconnection puts you back where you were rather
   * than at the harbour.
   *
   * `resumeToken` alone only covers the *short* outage — a dropped frame, a tunnel, a
   * locked screen — because it restores a player object the server is still holding in
   * its grace window. Past {@link PROTOCOL.SESSION_GRACE_MS}, or across a server
   * restart, that object is gone and there is nothing left to resume: the same person
   * with the same name comes back as a brand-new visitor and is dropped on the quay,
   * possibly halfway across the island from where they were standing.
   *
   * So the client also carries its own position, and the server honours it — after
   * re-deriving it through the walkability contract (snapped at most a few metres), so a claim
   * can never place a player somewhere they could not have walked to. It is deliberately not
   * gated on the resume token: the case it exists for is a server restart, when no token names
   * anybody the server holds. See `returningSpawn` in the server's handlers.
   */
  at?: { pos: Vec3; yaw: number };
  /**
   * Preferred room. Omit to be placed by the matchmaker.
   *
   * May also be a private island's invite code (see {@link ROOM_CODE_PATTERN}). A registered
   * code whose island the server is not currently holding re-opens it — an invite link keeps
   * working after everyone has left, and (with persistence on) after a restart. An unknown
   * code is refused with `room_not_found` and the player is matchmade instead.
   */
  room?: RoomId;
  /** Reported so the server can size deltas for weak devices. Advisory only. */
  caps?: { mobile: boolean; lowMemory: boolean };
  /**
   * This browser's visitor key, if it has one (see {@link VISITOR_KEY_PATTERN}).
   *
   * Not authentication — there is nothing on the island worth stealing — but continuity:
   * it is what lets the stamp card, the fish book and badges outlive the tab, and what
   * makes the person who created a private island its keeper when they come back. The
   * server keeps a hash, never the key. Absent or malformed means "a visitor with no
   * past": everything still works, and nothing is kept.
   */
  visitor?: string;
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

/**
 * A line of chat: to the whole island, or — with `to` — to one person only.
 *
 * A whisper is never broadcast in a delta and never raises a bubble; both ends receive a
 * {@link ServerWhisper} and nobody else learns it happened.
 */
export interface ClientChat {
  t: 'chat';
  text: string;
  to?: PlayerId;
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

// --- v2: games, guestbook, private islands ----------------------------------------------

/** Rock, paper, scissors. */
export type Hand = 'rock' | 'paper' | 'scissors';
export const HANDS: readonly Hand[] = ['rock', 'paper', 'scissors'];

/**
 * Fishing. `cast` at a fishing spot (an interactable whose effect is `fish`), then `hook`
 * when the float goes under. `stop` reels in. The server rolls what was caught.
 */
export type ClientFish =
  | { t: 'fish'; action: 'cast'; spot: string }
  | { t: 'fish'; action: 'hook' }
  | { t: 'fish'; action: 'stop' };

/**
 * Janken between two people standing near each other. One challenges, the other answers,
 * both throw; the server reveals. Ties replay, up to a limit.
 */
export type ClientJanken =
  | { t: 'janken'; action: 'challenge'; target: PlayerId }
  | { t: 'janken'; action: 'respond'; duel: string; accept: boolean }
  | { t: 'janken'; action: 'throw'; duel: string; hand: Hand };

/**
 * Host or admin: the check-in list of an activity — who checked in, in what order, when.
 * For the morning assembly that is the register; for a club's meet-up, the attendance.
 * Answered with {@link ServerCheckinList}; hosts may ask for their own activities only.
 */
export interface ClientCheckinList {
  t: 'checkin_list';
  activity: ActivityId;
}

/**
 * Friends. `request` asks a player in your room (`target` is their `PlayerId`); the others
 * act on a friend or a request by its opaque id (`FriendView.id`, `FriendRequestView.id`).
 * A friendship is kept against both visitor keys, so both sides need one; `remove` ends it
 * for both. The answer is a fresh {@link ServerFriends}.
 */
export interface ClientFriend {
  t: 'friend';
  action: 'request' | 'accept' | 'decline' | 'remove';
  target: string;
}

/**
 * Dig where you stand, while a treasure hunt is live. The server answers with
 * {@link ServerDig}; a find is also a `treasure` event for everyone.
 */
export interface ClientDig {
  t: 'dig';
}

/** Roll a die with `sides` faces (2–1000, default 100). Everyone sees the result. */
export interface ClientRoll {
  t: 'roll';
  sides?: number;
}

/**
 * Send a firework up from the shore you are standing on. Only zones the map lists as
 * firework shores accept it; the server picks the launch site offshore.
 */
export interface ClientFirework {
  t: 'firework';
  /** 0–1. Omitted = the server picks. */
  hue?: number;
  /** Burst shape, 0–3. Omitted = the server picks. */
  pattern?: number;
}

/** Sign the notice board. Must be standing at one. */
export interface ClientGuestbookWrite {
  t: 'guestbook_write';
  text: string;
}

/** Take a line off the board: your own, or anyone's if you are an admin. */
export interface ClientGuestbookRemove {
  t: 'guestbook_remove';
  id: string;
}

/** Wear a badge you have earned under your name, or `null` to wear none. */
export interface ClientSetTitle {
  t: 'set_title';
  badge: BadgeId | null;
}

/**
 * Make a private island and move there. The server answers with {@link ServerRoomChanged}
 * carrying the new island's code; the creator keeps it (as its admin) from then on.
 */
export interface ClientRoomCreate {
  t: 'room_create';
}

/**
 * Name the private island you are on — its keeper, or an admin, only. An empty `title`
 * takes the name away. Everyone on the island is sent {@link ServerRoomInfo}.
 */
export interface ClientRoomTitle {
  t: 'room_title';
  title: string;
}

/**
 * Admin: put something on the programme now — "a quiz in two minutes". Uses a template,
 * so there is no form to fill in.
 */
export interface ClientHostSchedule {
  t: 'host_schedule';
  template: string;
  /** Minutes from now until it starts, 0–120. */
  inMin: number;
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
  | ClientInteract
  | ClientFish
  | ClientJanken
  | ClientRoll
  | ClientFirework
  | ClientGuestbookWrite
  | ClientGuestbookRemove
  | ClientSetTitle
  | ClientRoomCreate
  | ClientRoomTitle
  | ClientHostSchedule
  | ClientDig
  | ClientFriend
  | ClientCheckinList;

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
  /**
   * Which map pack the server is simulating.
   *
   * The client refuses to enter a world it did not itself load. Both sides validate player
   * positions against `heightAt`, so on a mismatch the server's ground is somewhere else
   * entirely and every player is instantly, permanently out of bounds — a failure that
   * presents as unexplained teleporting rather than as anything resembling its cause.
   * Better to say so at the handshake.
   */
  mapId: string;
  /** Rooms the client may switch to, for the room picker. Public shards, plus your own. */
  rooms: RoomView[];
  /** Your stamps, fish book and badges. Also re-sent as {@link ServerProfile} on change. */
  profile: ProfileView;
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
  /** The notice board's signatures, oldest first. */
  guestbook: GuestbookEntry[];
  /** The ○× quiz in progress, if any. */
  quiz: QuizView | null;
  /** だるまさんがころんだ in progress, if any. */
  daruma: DarumaView | null;
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
  /** One-shot things that happened in the world this tick. See {@link WorldEvent}. */
  events?: WorldEvent[];
  /** New signatures on the notice board. */
  guestbook?: GuestbookEntry[];
  /** Signatures taken down. */
  guestbookRemoved?: string[];
  /** The quiz changed phase. `null` means it is over and gone. Absent means unchanged. */
  quiz?: QuizView | null;
  /** だるまさんがころんだ changed: a phase, a catch, a place. `null` = over; absent = unchanged. */
  daruma?: DarumaView | null;
}

/**
 * Authoritative correction of a client's own position. Sent when the client's reported
 * transform failed validation (speed budget, walkable bounds, or an activity that pins
 * players to a stage), and with `teleport` when the island itself moved the player — a game
 * sending them back to its start. The client must hard-snap, not blend; a `teleport` also
 * ends whatever the player was doing where they were (a walk under way, a seat).
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

/** The room you are in now presents itself differently — its keeper named it. */
export interface ServerRoomInfo {
  t: 'room_info';
  room: RoomView;
}

/** Room switch completed. Followed by a fresh snapshot for the new room. */
export interface ServerRoomChanged {
  t: 'room_changed';
  room: RoomView;
  /** Your role in the new room — a private island's keeper is its admin. */
  role: Role;
  /** The room list, from the new room's point of view. */
  rooms: RoomView[];
  /** A fresh resume token bound to the new room. */
  resumeToken: string;
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
  /** English, for logs and as a fallback. */
  message: string;
  fatal?: boolean;
  /**
   * A machine-readable reason the client can say in the player's own language, e.g.
   * `'cooldown'`, `'too_far'`, `'seat_taken'`. Absent on errors that are not the player's
   * business (malformed frames, internal faults).
   */
  key?: string;
  /** Values for the localised sentence, e.g. `{ seconds: 12 }`. */
  params?: Record<string, string | number>;
}

// --- v2 -----------------------------------------------------------------------------------

/**
 * One signature on the notice board. Survives restarts; the board keeps the most recent
 * few dozen per island.
 */
export interface GuestbookEntry {
  id: string;
  name: string;
  text: string;
  /** Epoch ms. */
  at: number;
  /** The player who wrote it, while they are still that player — lets them take it down. */
  authorId: PlayerId | null;
}

/** A player's progress, as they see it. Private: sent only to them. */
export interface ProfileView {
  /** Zones whose stamp is on the card. */
  stamps: ZoneId[];
  /** How many stamps the card holds on this map. */
  stampTotal: number;
  /** Per species caught: how many, and the largest, cm. */
  fish: Record<string, { count: number; best: number }>;
  /** Every fish ever landed, junk included. */
  catches: number;
  badges: BadgeId[];
  /** The badge being worn, if any. */
  title: BadgeId | null;
  /** Today's omikuji (JST day), if drawn. */
  omikuji: { day: string; fortune: number; item: number; direction: number } | null;
  jankenWins: number;
  quizWins: number;
  /** Treasures dug up, over every hunt. */
  treasures: number;
  /** Today's tasks (Japanese calendar day) and how far along each is. */
  daily: { day: string; tasks: Array<DailyTask & { progress: number }>; done: boolean };
  /** Days in a row with every task done, up to the last one done; and days done in all. */
  dailyStreak: number;
  dailyDays: number;
  /**
   * Whether any of this outlives the session. False when the client sent no usable
   * visitor key — the card still fills in, and is gone when the tab is.
   */
  persistent: boolean;
}

/**
 * The ○× quiz, as everyone sees it.
 *
 * `lobby` gathers contestants; each `question` phase shows a statement and counts down to
 * `endsAt`, at which moment the server looks at where every contestant is standing; `reveal`
 * shows the answer and who fell; `finished` names the winners and then the view goes away.
 */
export interface QuizView {
  activity: ActivityId;
  phase: 'lobby' | 'question' | 'reveal' | 'finished';
  /** 1-based; 0 in the lobby. */
  round: number;
  totalRounds: number;
  /** Id into the shared question bank. Null in the lobby. */
  questionId: string | null;
  /** The right answer (`true` = ○), present from `reveal` on. */
  answer?: boolean;
  /** Server epoch ms at which this phase ends. */
  endsAt: number;
  /** Contestants still in. */
  alive: PlayerId[];
  /** Knocked out this round, present in `reveal`. */
  fell?: PlayerId[];
  /**
   * In `reveal`: everyone still in answered wrongly, so — by the house rule — nobody went
   * out. Distinguishes "nobody fell because all were right" from "…because all were wrong".
   */
  replay?: boolean;
  /** Present in `finished`. */
  winners?: PlayerId[];
}

/**
 * だるまさんがころんだ, as everyone sees it.
 *
 * `lobby` gathers racers at the start line. Then the oni turns its back and chants (`walk`),
 * and turns round to look (`look`), over and over: a `walk` ends — the oni turns — at
 * `endsAt`, and the chant is paced across `startedAt`…`endsAt`, so a client can say the last
 * syllable and show the turn at that moment on the server's clock rather than when the next
 * view arrives. Whoever the oni sees moving in a `look` is `caught` and sent back to the start.
 * The race ends when three are home (`DARUMA_PLACES`), when nobody is left racing, or at
 * `raceEndsAt`; `finished` names the places and then the view goes away.
 */
export interface DarumaView {
  activity: ActivityId;
  phase: 'lobby' | 'walk' | 'look' | 'finished';
  /** Server epoch ms at which this phase began, and at which it ends. */
  startedAt: number;
  endsAt: number;
  /** Server epoch ms at which the race is called, however far anyone has got. Absent in the lobby. */
  raceEndsAt?: number;
  /** Still racing: set off from the start, not yet over the line, not dropped out. */
  racing: PlayerId[];
  /** Over the line, in order — first, second, third — with the names they crossed under. */
  places: Array<{ id: PlayerId; name: string }>;
  /** Sent back to the start in this phase: seen moving in a `look`. */
  caught?: PlayerId[];
}

/**
 * Something that happened, once, that everybody nearby should see or hear.
 *
 * Events ride in the tick's delta rather than having messages of their own, so they are
 * ordered with everything else that happened in that tick and replayed with it on resync.
 * They are never kept in a snapshot: a bell you did not hear ring is not a bell that is
 * ringing.
 */
export type WorldEvent =
  /** A bell was rung. `id` is the interactable. */
  | { k: 'bell'; id: string; by: PlayerId }
  /**
   * A firework went up from (x, z) and bursts at height h. `at` is server epoch ms at
   * launch, so a client that hears about it late can skip ahead rather than replay it.
   */
  | { k: 'firework'; x: number; z: number; h: number; hue: number; pattern: number; at: number; by: PlayerId | null }
  /**
   * A fish was landed. `record` = the biggest of its kind anyone has landed on this island
   * today, *and* at least 60% of the way up that kind's size range — the first small one of
   * the morning is not a record. Never set for junk.
   */
  | { k: 'catch'; by: PlayerId; fish: string; size: number; record: boolean }
  /** Somebody drew a fortune. */
  | { k: 'omikuji'; by: PlayerId; fortune: number }
  /** A stamp went on somebody's card; `complete` when it was the last one. */
  | { k: 'stamp'; by: PlayerId; zone: ZoneId; complete: boolean }
  /** A die was rolled. */
  | { k: 'dice'; by: PlayerId; value: number; sides: number }
  /** A janken round was decided. `winner` null = a draw after the tie limit. */
  | { k: 'janken'; a: PlayerId; b: PlayerId; ha: Hand; hb: Hand; winner: PlayerId | null }
  /** Somebody earned a badge. */
  | { k: 'badge'; by: PlayerId; badge: BadgeId }
  /** Somebody dug and came up empty; `heat` is what the sand told them. */
  | { k: 'dig'; by: PlayerId; heat: DigHeat }
  /** Somebody dug up a treasure at `pos`; `left` are still buried. */
  | { k: 'treasure'; by: PlayerId; pos: Vec3; left: number };

export type WorldEventKind = WorldEvent['k'];

/** An activity's check-ins, in arrival order, with the names they checked in under. */
export interface ServerCheckinList {
  t: 'checkin_list';
  activity: ActivityId;
  list: Array<{ ordinal: number; name: string; at: number }>;
}

/** One of your friends, as you see them. */
export interface FriendView {
  /** Stable and opaque: the same friend has the same id from visit to visit. Not their key. */
  id: string;
  /** Their name when last seen (their current one, while online). */
  name: string;
  online: boolean;
  /** While online: who they are in the room they are in, and which room that is. */
  player?: PlayerId;
  room?: { id: RoomId; name: string; kind: 'public' | 'private'; code?: string; title?: string };
}

/** Somebody who would like to be your friend. Accept or decline it by `id`. */
export interface FriendRequestView {
  id: string;
  name: string;
  /** Who they are right now, if they are here. */
  player?: PlayerId;
}

/**
 * Your friends and the requests waiting for you, sent whole whenever any of it changes — a
 * friend arriving, leaving or moving island included. `enabled` is false for a visitor with
 * no key, who can neither keep friends nor be kept as one.
 */
export interface ServerFriends {
  t: 'friends';
  friends: FriendView[];
  requests: FriendRequestView[];
  enabled: boolean;
}

/** How many friends one visitor may keep. */
export const FRIEND_LIMIT = 50;

/** Your progress changed. */
export interface ServerProfile {
  t: 'profile';
  profile: ProfileView;
}

/**
 * Your line, as the fishing spot sees it.
 *
 * `waiting` — the float is out. `bite` — it went under; `hook` within `window` ms.
 * `caught` — landed (`fish`, `size`, and whether it is new to your book or a record).
 * `escaped` — missed it (`reason`). `idle` — line in, for any reason.
 */
export interface ServerFish {
  t: 'fish';
  phase: 'waiting' | 'bite' | 'caught' | 'escaped' | 'idle';
  spot?: string;
  window?: number;
  fish?: string;
  size?: number;
  newSpecies?: boolean;
  /** Biggest of its kind landed on this island today, and a big one for its kind (see the `catch` event). */
  record?: boolean;
  /** Biggest of its kind you have ever landed. */
  personalBest?: boolean;
  reason?: 'early' | 'late' | 'moved';
}

/**
 * What your dig turned up: a treasure (`found`), or how close the nearest one still buried
 * is. `left` is how many remain after this dig.
 */
export interface ServerDig {
  t: 'dig';
  result: 'found' | DigHeat;
  left: number;
}

/** Your omikuji slip. `again` = you had already drawn today, and this is that slip. */
export interface ServerOmikuji {
  t: 'omikuji';
  fortune: number;
  item: number;
  direction: number;
  again: boolean;
}

/** A janken duel, from one participant's side. */
export interface ServerJanken {
  t: 'janken';
  kind: 'invited' | 'waiting' | 'start' | 'result' | 'cancelled';
  duel: string;
  opponent: PlayerId;
  opponentName: string;
  /** Epoch ms by which to answer (`invited`) or throw (`start`). */
  deadline?: number;
  /** 1-based round; ties replay. */
  round?: number;
  /** In `result`: what each side threw. */
  mine?: Hand | null;
  theirs?: Hand | null;
  /** In `result`: the winner, null for a tie (another round follows unless `final`). */
  winner?: PlayerId | null;
  /** In `result`: whether the duel is over. */
  final?: boolean;
  /** In `cancelled`. */
  reason?: 'declined' | 'timeout' | 'left' | 'busy' | 'far';
}

/** A whisper, to both its ends. */
export interface ServerWhisper {
  t: 'whisper';
  from: PlayerId;
  fromName: string;
  to: PlayerId;
  toName: string;
  text: string;
  at: number;
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
  | ServerRoomInfo
  | ServerError
  | ServerProfile
  | ServerFish
  | ServerOmikuji
  | ServerJanken
  | ServerWhisper
  | ServerDig
  | ServerFriends
  | ServerCheckinList;

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
