/**
 * Handlers — one function per `ClientMessage['t']`, dispatched from a typed map.
 * =================================================================================
 *
 * This is where client intent becomes server truth (or gets rejected). The governing rule:
 * **the client requests, the server decides.** Every field on every incoming message is
 * untrusted input — lengths are capped, enums are checked against their actual member set,
 * and every "can this player do this" question routes through `permissions.ts` or the game
 * module that owns the answer rather than being re-derived ad hoc.
 *
 * Handlers never close the socket on a rejected request — they reply with `ServerError` and
 * let the connection continue: "a rejected activity join never costs you the world." A
 * refusal the player should understand carries a `key` the client translates (see
 * `docs/GAMES.md` §6). The one fatal case is `hello` with a mismatched protocol version.
 *
 * `hello` is deliberately not part of the dispatch map: every other handler needs an
 * established `ConnState` (a room + a player), which is exactly what `hello` creates.
 * `index.ts` calls `handleHello` directly, once, before switching to map-dispatch.
 */

import { randomUUID } from 'node:crypto';
import {
  ActivityState,
  AnimState,
  EMOTES,
  ErrorCode,
  PROTOCOL,
  Role,
  ISLAND_EXTENT,
  activeMapId,
  getInteractable,
  getTemplate,
  heightAt,
  isBadgeId,
  nearestWalkable,
  spawnPoint,
  withinReach,
  type Appearance,
  type ClientActivityJoin,
  type ClientActivityLeave,
  type ClientAdminAction,
  type ClientChat,
  type ClientCheckin,
  type ClientEmote,
  type ClientFirework,
  type ClientFish,
  type ClientGuestbookRemove,
  type ClientCheckinList,
  type ClientFriend,
  type ClientGuestbookWrite,
  type ClientHello,
  type ClientHostAnnounce,
  type ClientHostActivityState,
  type ClientHostSchedule,
  type ClientInteract,
  type ClientJanken,
  type ClientMessage,
  type ClientMessageType,
  type ClientPing,
  type ClientMove,
  type ClientResync,
  type ClientRoll,
  type ClientRoomSwitch,
  type ClientSetTitle,
  type ClientRoomTitle,
  type Emote,
  type Hand,
  type ServerMessage,
} from '@nagisa/shared';
import { Player } from './player.js';
import { Room } from './room.js';
import { RoomManager, type RoomRefusal } from './rooms.js';
import { Session } from './session.js';
import { AuditLog } from './audit.js';
import { canAnnounce, canHostActivity, assertRole, PermissionError } from './permissions.js';
import { issueResumeToken, verifyResumeToken } from './resume.js';
import { hashVisitorKey, profileView, type ProfileStore } from './games/profiles.js';
import { cleanLine, cleanName, textLength } from './text.js';
import type { Logger } from './logger.js';
import type { Config } from './config.js';

/** Tolerance added to an interactable's declared range to absorb normal float/lag jitter. */
const INTERACT_RANGE_SLOP = 1.5;

/** Default TTL for an announcement that doesn't specify one. */
const DEFAULT_ANNOUNCEMENT_TTL_MS = 60_000;
const MIN_ANNOUNCEMENT_TTL_MS = 5_000;
const MAX_ANNOUNCEMENT_TTL_MS = 10 * 60_000;

/** One private island per player this often: making islands is cheap for them, not for us. */
const ROOM_CREATE_COOLDOWN_MS = 30_000;

/** How far ahead an admin may put something on the programme, minutes. */
const MAX_SCHEDULE_AHEAD_MIN = 120;

/** Extra activities an admin may have on one room's board at once. */
export const MAX_ADHOC_ACTIVITIES = 6;

/** Shared services every handler may need. Constructed once in `index.ts`. */
export interface HandlerDeps {
  rooms: RoomManager;
  audit: AuditLog;
  log: Logger;
  config: Config;
  /** Every visitor's progress, by key hash. */
  profiles: ProfileStore;
  /** Ask the persistence layer to save soon. Cheap to call often — saves are debounced. */
  persist: () => void;
}

/**
 * Per-connection state that outlives any single message: which room the player is
 * currently in and which `Player` record they are. Both fields are reassigned in place
 * (not replaced by a new `ConnState`) so every handler holding a reference to the same
 * `ConnState` object observes a room switch or resume immediately.
 */
export class ConnState {
  /** Epoch ms of this connection's last private island creation. */
  lastRoomCreateAt = -Infinity;

  constructor(
    public session: Session,
    public room: Room,
    public player: Player,
  ) {}
}

function sendError(session: Session, code: ErrorCode, message: string, fatal = false, key?: string, params?: Record<string, string | number>): void {
  const msg: ServerMessage = { t: 'error', code, message, fatal };
  if (key) {
    msg.key = key;
    if (params) msg.params = params;
  }
  session.send(msg);
}

/** A refusal the player should understand, in their language. Never fatal. */
function refuse(ctx: ConnState, key: string, params?: Record<string, string | number>, code = ErrorCode.Forbidden): void {
  sendError(ctx.session, code, key, false, key, params);
}

// ---------------------------------------------------------------------------------
// hello — establishes (or resumes) a ConnState.
// ---------------------------------------------------------------------------------

function clampName(raw: unknown): string {
  return cleanName(raw, PROTOCOL.MAX_NAME_LENGTH, 'Visitor');
}

function sanitizeAppearance(raw: unknown): Appearance {
  const a = (raw ?? {}) as Partial<Appearance>;
  const clampIdx = (v: unknown): number => (Number.isFinite(v) && (v as number) >= 0 ? Math.floor(v as number) % 64 : 0);
  return { outfit: clampIdx(a.outfit), skin: clampIdx(a.skin), accessory: clampIdx(a.accessory) };
}

/**
 * How far {@link returningSpawn} will let the walkability contract move a claimed position
 * before it stops believing the claim. A small correction is expected (you logged off
 * wading in the shallows); a large one means the claim did not come from anywhere a player
 * was actually standing, and a harbour spawn at least reads as an arrival.
 */
const RETURN_SNAP_LIMIT = 6;

/**
 * Turn a client's claimed last position into a spawn, or `null` if it cannot be believed.
 *
 * Not gated on the resume token: the case this exists for is the *server restarting*, when
 * a token names nobody the server holds (and, with a per-process secret, does not even
 * verify). What is taken on trust is only the patch of public ground; the geometry is
 * re-derived — `x`/`z` finite and inside the map, snapped through the same walkability
 * contract every step is held to, `y` from `heightAt` — so a claim can never put a player
 * inside a hill, out at sea, or hovering.
 */
function returningSpawn(at: ClientHello['at']): { pos: [number, number, number]; yaw: number } | null {
  if (!at || !Array.isArray(at.pos) || at.pos.length !== 3) return null;
  const [x, , z] = at.pos;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (Math.abs(x) > ISLAND_EXTENT || Math.abs(z) > ISLAND_EXTENT) return null;

  const [sx, sz] = nearestWalkable(x, z);
  if (Math.hypot(sx - x, sz - z) > RETURN_SNAP_LIMIT) return null;

  const yaw = Number.isFinite(at.yaw) ? Math.atan2(Math.sin(at.yaw), Math.cos(at.yaw)) : 0;
  return { pos: [sx, heightAt(sx, sz), sz], yaw };
}

/** Attach a player's profile from their visitor key (or a session-only one). */
function attachProfile(player: Player, visitor: unknown, deps: HandlerDeps): void {
  const hash = hashVisitorKey(visitor);
  player.visitorHash = hash;
  if (hash) {
    player.profile = deps.profiles.forVisitor(hash);
    player.profilePersistent = true;
  }
}

function sendWelcome(session: Session, room: Room, player: Player, resumed: boolean, deps: HandlerDeps): void {
  session.send({
    t: 'welcome',
    protocol: PROTOCOL.VERSION,
    self: player.id,
    resumeToken: issueResumeToken(deps.config.RESUME_SECRET, { playerId: player.id, room: room.id }),
    resumed,
    room: room.toView(),
    serverTime: Date.now(),
    tickHz: PROTOCOL.TICK_HZ,
    mapId: activeMapId() ?? '',
    rooms: deps.rooms.listViews(room),
    profile: profileView(player.profile, player.profilePersistent),
  });
  session.send(deps.rooms.friends.viewFor(player));
  session.send(room.buildSnapshot());
}

/** The refusal key for a room that could not be had. */
function roomRefusalKey(reason: RoomRefusal): string {
  return reason === 'full' ? 'full' : reason === 'busy' ? 'islands_busy' : reason === 'banned' ? 'island_banned' : 'room_not_found';
}

/**
 * Handle the first frame of a connection. Either restores a player still in their grace
 * window (identity, role, activity attachment, position) or mints a new one — on the island
 * they asked for, where they last stood if that can be believed, otherwise at a harbour.
 *
 * Returns `null` if the connection was rejected outright (protocol version mismatch); the
 * caller is responsible for closing the socket in that case.
 */
export function handleHello(
  session: Session,
  msg: ClientHello,
  opts: { adminGranted: boolean },
  deps: HandlerDeps,
): ConnState | null {
  if (msg.protocol !== PROTOCOL.VERSION) {
    sendError(session, ErrorCode.VersionMismatch, `Server speaks protocol ${PROTOCOL.VERSION}, client sent ${msg.protocol}`, true);
    return null;
  }

  const name = clampName(msg.name);
  const appearance = sanitizeAppearance(msg.appearance);
  const payload = typeof msg.resumeToken === 'string' ? verifyResumeToken(deps.config.RESUME_SECRET, msg.resumeToken) : null;

  // Resume first: a valid, in-grace resume takes priority over a new arrival. Invalid or
  // expired tokens are ignored rather than rejected.
  if (payload) {
    // Look where the token says first, then everywhere: a `room_changed` lost with the socket
    // that carried it leaves the client holding the old room's token for a player who has
    // since moved.
    const room = deps.rooms.get(payload.room)?.getPlayer(payload.playerId)
      ? deps.rooms.get(payload.room)
      : deps.rooms.findRoomOf(payload.playerId);
    const player = room?.getPlayer(payload.playerId);
    if (room && player) {
      // Not only a player in their grace window: the server may not have noticed the old
      // socket die yet (a half-open connection after a network change takes up to a minute
      // to time out), and the client reconnects at once. The token proves this is the same
      // visitor; the old socket is the stale one, so it is let go and this one takes over.
      if (!player.away) {
        const stale = room.getSession(player.id);
        if (stale && stale !== session) stale.close(4002, 'replaced');
      }
      room.resume(session, player);
      // Cosmetic fields may have changed client-side while disconnected; identity is never
      // re-derived from the client, only these presentational fields are refreshed.
      player.name = name;
      player.appearance = appearance;
      if (opts.adminGranted) player.globalAdmin = true;
      // A key kept off this island is not taken on here: it would bring its owner back in,
      // badges and all, through a session that arrived without it.
      if (!player.visitorHash && !deps.rooms.isBanned(room, hashVisitorKey(msg.visitor))) {
        attachProfile(player, msg.visitor, deps);
        // Now on the friends index under the key it has just shown.
        if (player.visitorHash) deps.rooms.friends.presenceChanged(player, true);
      }
      const role = room.roleFor(player);
      if (role !== player.role) {
        player.role = role;
        room.markPlayerChanged(player.id, { role });
      }
      sendWelcome(session, room, player, true, deps);
      room.resumed(player);
      return new ConnState(session, room, player);
    }
  }

  // A new arrival — first-time, or someone whose player the server no longer holds (a long
  // outage, a restart). The second kind comes back where they stood, if that can be believed.
  const id = randomUUID();
  const preferred = typeof msg.room === 'string' ? msg.room : payload?.room;
  // The server's own admins are kept off nowhere.
  const picked = deps.rooms.pickRoom(preferred, opts.adminGranted ? null : hashVisitorKey(msg.visitor));
  const room = picked.room;
  const spawn = returningSpawn(msg.at) ?? spawnPoint(Math.floor(Math.random() * 1000));
  const player = new Player(id, name, appearance, Role.Guest, spawn);
  player.globalAdmin = opts.adminGranted;
  attachProfile(player, msg.visitor, deps);
  room.join(session, player);
  deps.rooms.touchIsland(room);

  sendWelcome(session, room, player, false, deps);
  // Asked for an island and could not have it: say so, now that they are somewhere.
  if (picked.refusal) sendError(session, ErrorCode.RoomFull, 'requested room unavailable', false, roomRefusalKey(picked.refusal));
  return new ConnState(session, room, player);
}

// ---------------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------------

function handlePing(ctx: ConnState, msg: ClientPing): void {
  ctx.session.send({ t: 'pong', t0: typeof msg.t0 === 'number' ? msg.t0 : 0, serverTime: Date.now() });
  if (typeof msg.rtt === 'number' && Number.isFinite(msg.rtt)) ctx.player.rttMs = clamp(msg.rtt, 0, 5000);
}

// ---------------------------------------------------------------------------------
// move — the hot path. Shape-validated here; speed/terrain validated in Player.applyMove.
// ---------------------------------------------------------------------------------

function isFiniteTriple(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
}

function handleMove(ctx: ConnState, msg: ClientMove): void {
  if (!isFiniteTriple(msg.pos) || typeof msg.yaw !== 'number' || typeof msg.seq !== 'number') {
    sendError(ctx.session, ErrorCode.BadMessage, 'malformed move');
    return;
  }
  const anim = typeof msg.anim === 'number' && msg.anim in AnimState ? (msg.anim as AnimState) : AnimState.Idle;

  const prevZone = ctx.player.zone;
  const correction = ctx.player.applyMove({ pos: msg.pos, yaw: msg.yaw, anim, seq: msg.seq });
  if (correction) {
    ctx.session.send(correction);
    return;
  }
  ctx.room.onMoved(ctx.player);
  if (ctx.player.zone !== prevZone) {
    ctx.room.markPlayerChanged(ctx.player.id, { zone: ctx.player.zone });
    if (ctx.player.zone) ctx.room.daily(ctx.player, 'zones', ctx.player.zone);
  }
}

// ---------------------------------------------------------------------------------
// emote / chat — small, rate-limited, muteable expressions.
// ---------------------------------------------------------------------------------

function handleEmote(ctx: ConnState, msg: ClientEmote): void {
  if (!EMOTES.includes(msg.emote as Emote)) {
    sendError(ctx.session, ErrorCode.BadMessage, 'unknown emote');
    return;
  }
  if (ctx.player.muted) return; // Silently dropped — see Player.muted.
  ctx.room.emote(ctx.player.id, msg.emote);
  ctx.room.daily(ctx.player, 'emote');
}

function handleChat(ctx: ConnState, msg: ClientChat): void {
  const text = cleanLine(msg.text);
  if (text.length === 0 || textLength(text) > PROTOCOL.MAX_CHAT_LENGTH) {
    sendError(ctx.session, ErrorCode.BadMessage, `chat must be 1-${PROTOCOL.MAX_CHAT_LENGTH} characters`);
    return;
  }

  if (msg.to !== undefined) {
    // A whisper. The sender is told when it cannot go (unlike island chat, whose mute is
    // silent): a whisper has no optimistic echo, so silence would read as a lost message.
    if (ctx.player.muted) {
      refuse(ctx, 'muted');
      return;
    }
    const target = typeof msg.to === 'string' ? ctx.room.getPlayer(msg.to) : undefined;
    // Someone in their grace window has no socket to hear it; a receipt would be a lie.
    if (!target || target.id === ctx.player.id || target.away) {
      refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
      return;
    }
    const whisper = {
      t: 'whisper' as const,
      from: ctx.player.id,
      fromName: ctx.player.name,
      to: target.id,
      toName: target.name,
      text,
      at: Date.now(),
    };
    ctx.room.sendTo(target.id, whisper);
    ctx.session.send(whisper);
    ctx.room.daily(ctx.player, 'chat');
    return;
  }

  if (ctx.player.muted) return; // Silently dropped — see Player.muted.
  ctx.room.chat(ctx.player.id, text);
  ctx.room.daily(ctx.player, 'chat');
}

// ---------------------------------------------------------------------------------
// activity join / leave / checkin
// ---------------------------------------------------------------------------------

function handleActivityJoin(ctx: ConnState, msg: ClientActivityJoin, deps: HandlerDeps): void {
  if (msg.mode !== 'participant' && msg.mode !== 'audience') {
    sendError(ctx.session, ErrorCode.BadMessage, 'mode must be participant or audience');
    return;
  }
  const activity = ctx.room.activities.get(msg.activity);
  if (!activity) {
    refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
    return;
  }

  const result = activity.join(ctx.player.id, msg.mode);
  if (!result.ok) {
    if (result.reason === 'full') refuse(ctx, 'full', undefined, ErrorCode.ActivityFull);
    else refuse(ctx, 'not_open', undefined, ErrorCode.InvalidTransition);
    return;
  }

  // A player attends at most one activity at a time; joining a new one releases the old —
  // only once the new one has accepted them, so a refused join costs nothing.
  if (ctx.player.activity && ctx.player.activity !== activity.id) {
    const old = ctx.room.activities.get(ctx.player.activity);
    if (old) {
      old.leave(ctx.player.id);
      ctx.room.activities.notifyChanged(old);
    }
  }

  const changedActivity = ctx.player.activity !== activity.id;
  ctx.player.activity = activity.id;
  ctx.player.mode = msg.mode;
  if (changedActivity) ctx.player.checkedIn = false;
  ctx.room.markPlayerChanged(ctx.player.id, { activity: activity.id, mode: msg.mode, checkedIn: ctx.player.checkedIn });
  ctx.room.activities.notifyChanged(activity);
  deps.persist();
}

function handleActivityLeave(ctx: ConnState, msg: ClientActivityLeave, deps: HandlerDeps): void {
  if (ctx.player.activity !== msg.activity) {
    refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
    return;
  }
  const activity = ctx.room.activities.get(msg.activity);
  activity?.leave(ctx.player.id);
  ctx.player.activity = null;
  ctx.player.mode = null;
  ctx.player.checkedIn = false;
  ctx.room.markPlayerChanged(ctx.player.id, { activity: null, mode: null, checkedIn: false });
  if (activity) ctx.room.activities.notifyChanged(activity);
  deps.persist();
}

/** Record a check-in and tell the player how it went. Shared by `checkin` and the check-in post. */
function checkIn(ctx: ConnState, activityId: string, deps: HandlerDeps): void {
  const activity = ctx.room.activities.get(activityId);
  if (!activity) {
    ctx.session.send({ t: 'checkin_ack', activity: activityId, ok: false, reason: 'not_found' });
    return;
  }
  const result = activity.checkin(ctx.player.id, Date.now(), ctx.player.name, ctx.player.visitorHash ?? undefined);
  ctx.session.send(
    result.ok
      ? { t: 'checkin_ack', activity: activity.id, ok: true, ordinal: result.ordinal }
      : { t: 'checkin_ack', activity: activity.id, ok: false, reason: result.reason },
  );
  if (result.ok) {
    ctx.player.checkedIn = true;
    ctx.room.markPlayerChanged(ctx.player.id, { checkedIn: true });
    ctx.room.activities.notifyChanged(activity);
    ctx.room.daily(ctx.player, 'checkin');
    deps.persist();
  } else if (result.reason === 'already' && !ctx.player.checkedIn) {
    // Checked in, left, and came back: the record stands, and so should the mark.
    ctx.player.checkedIn = true;
    ctx.room.markPlayerChanged(ctx.player.id, { checkedIn: true });
  }
}

function handleCheckin(ctx: ConnState, msg: ClientCheckin, deps: HandlerDeps): void {
  checkIn(ctx, msg.activity, deps);
}

// ---------------------------------------------------------------------------------
// rooms: switch / create / resync
// ---------------------------------------------------------------------------------

/** Put the connection on `room`: place them at its harbour, tell them, snapshot. */
function arrive(ctx: ConnState, room: Room, deps: HandlerDeps): void {
  // A new island is a fresh arrival: the harbour, facing inland. Placed before joining so the
  // join everyone else receives already shows where they are.
  const spawn = spawnPoint(Math.floor(Math.random() * 1000));
  ctx.player.teleport(spawn.pos, spawn.yaw);
  ctx.player.anim = AnimState.Idle;
  ctx.room = room;
  room.join(ctx.session, ctx.player);
  deps.rooms.touchIsland(room);
  ctx.session.send({
    t: 'room_changed',
    room: room.toView(),
    role: ctx.player.role,
    rooms: deps.rooms.listViews(room),
    resumeToken: issueResumeToken(deps.config.RESUME_SECRET, { playerId: ctx.player.id, room: room.id }),
  });
  ctx.session.send(room.buildSnapshot());
}

function handleRoomSwitch(ctx: ConnState, msg: ClientRoomSwitch, deps: HandlerDeps): void {
  if (typeof msg.room !== 'string' || msg.room.length === 0 || msg.room.length > 64) {
    sendError(ctx.session, ErrorCode.BadMessage, 'room must be an id or a code');
    return;
  }
  const result = deps.rooms.switchRoom(ctx.player, ctx.session, ctx.room, msg.room);
  if (!result.ok) {
    refuse(ctx, roomRefusalKey(result.reason), undefined, result.reason === 'full' ? ErrorCode.RoomFull : ErrorCode.NotFound);
    return;
  }
  if (result.room === ctx.room) return;
  arrive(ctx, result.room, deps);
}

function handleRoomCreate(ctx: ConnState, _msg: unknown, deps: HandlerDeps): void {
  const now = Date.now();
  if (now - ctx.lastRoomCreateAt < ROOM_CREATE_COOLDOWN_MS) {
    refuse(ctx, 'cooldown', { seconds: Math.ceil((ROOM_CREATE_COOLDOWN_MS - (now - ctx.lastRoomCreateAt)) / 1000) }, ErrorCode.RateLimited);
    return;
  }
  const island = deps.rooms.createPrivate({ hash: ctx.player.visitorHash, name: ctx.player.name, playerId: ctx.player.id });
  if (!island) {
    refuse(ctx, 'islands_busy', undefined, ErrorCode.RoomFull);
    return;
  }
  ctx.lastRoomCreateAt = now;
  const result = deps.rooms.switchRoom(ctx.player, ctx.session, ctx.room, island.id);
  if (!result.ok) {
    refuse(ctx, roomRefusalKey(result.reason));
    return;
  }
  arrive(ctx, result.room, deps);
}

/**
 * Name a private island. Its keeper may, and an admin may (to take a name away that should
 * not be there); nobody else, and nowhere public — a shard's name is the island's own.
 */
function handleRoomTitle(ctx: ConnState, msg: ClientRoomTitle, deps: HandlerDeps): void {
  if (ctx.room.kind !== 'private' || !(ctx.room.isKeeper(ctx.player) || ctx.player.globalAdmin)) {
    refuse(ctx, 'forbidden', undefined, ErrorCode.Forbidden);
    return;
  }
  if (ctx.player.muted) {
    refuse(ctx, 'muted');
    return;
  }
  const title = cleanName(msg.title, PROTOCOL.MAX_ISLAND_TITLE_LENGTH, '') || null;
  if (title === ctx.room.title) return;
  deps.rooms.setIslandTitle(ctx.room, title);
  deps.audit.record({
    actorId: ctx.player.id,
    actorName: ctx.player.name,
    action: 'room_title',
    targetId: null,
    reason: title ?? '(none)',
    room: ctx.room.id,
  });
}

function handleResync(ctx: ConnState, msg: ClientResync): void {
  const deltas = typeof msg.haveTick === 'number' ? ctx.room.getDeltasSince(msg.haveTick) : null;
  if (deltas === null) {
    ctx.session.send(ctx.room.buildSnapshot());
    return;
  }
  // Explicit repair: never dropped, even under backpressure — this is the client
  // deliberately asking to catch up.
  for (const delta of deltas) ctx.session.send(delta, { droppable: false });
}

// ---------------------------------------------------------------------------------
// host actions
// ---------------------------------------------------------------------------------

function handleHostActivityState(ctx: ConnState, msg: ClientHostActivityState, deps: HandlerDeps): void {
  const activity = ctx.room.activities.get(msg.activity);
  if (!activity) {
    refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
    return;
  }
  if (!canHostActivity(ctx.player, activity)) {
    throw new PermissionError(ErrorCode.Forbidden, 'not host of this activity');
  }
  if (!Object.values(ActivityState).includes(msg.state)) {
    sendError(ctx.session, ErrorCode.BadMessage, 'unknown activity state');
    return;
  }
  if (!ctx.room.activities.transition(activity, msg.state)) {
    sendError(ctx.session, ErrorCode.InvalidTransition, `cannot go from ${activity.state} to ${msg.state}`, false, 'invalid');
    return;
  }
  deps.persist();
}

function handleHostAnnounce(ctx: ConnState, msg: ClientHostAnnounce, deps: HandlerDeps): void {
  const text = cleanLine(msg.text);
  if (text.length === 0 || textLength(text) > PROTOCOL.MAX_ANNOUNCEMENT_LENGTH) {
    sendError(ctx.session, ErrorCode.BadMessage, `announcement must be 1-${PROTOCOL.MAX_ANNOUNCEMENT_LENGTH} characters`);
    return;
  }
  const scope = msg.scope;
  if (
    !scope ||
    (scope.kind !== 'island' && scope.kind !== 'zone' && scope.kind !== 'activity') ||
    (scope.kind === 'zone' && typeof scope.zone !== 'string') ||
    (scope.kind === 'activity' && typeof scope.activity !== 'string')
  ) {
    sendError(ctx.session, ErrorCode.BadMessage, 'unknown announcement scope');
    return;
  }
  const hostedActivity = ctx.player.hostOf ? (ctx.room.activities.get(ctx.player.hostOf) ?? null) : null;
  if (!canAnnounce(ctx.player, scope, hostedActivity)) {
    throw new PermissionError(ErrorCode.Forbidden, 'not allowed to announce at this scope');
  }
  if (scope.kind === 'activity' && !ctx.room.activities.get(scope.activity)) {
    refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
    return;
  }
  const ttlMs = clamp(Number.isFinite(msg.ttlMs) ? (msg.ttlMs as number) : DEFAULT_ANNOUNCEMENT_TTL_MS, MIN_ANNOUNCEMENT_TTL_MS, MAX_ANNOUNCEMENT_TTL_MS);
  const priority = msg.priority === 'high' ? 'high' : 'normal';
  ctx.room.announce({ text, fromName: ctx.player.name, scope, ttlMs, priority });
  deps.persist();
}

/** Admin: put a template on the programme now. */
function handleHostSchedule(ctx: ConnState, msg: ClientHostSchedule, deps: HandlerDeps): void {
  assertRole(ctx.player, Role.Admin, 'host_schedule');
  const template = typeof msg.template === 'string' ? getTemplate(msg.template) : undefined;
  if (!template) {
    refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
    return;
  }
  const inMin = Number.isFinite(msg.inMin) ? clamp(Math.round(msg.inMin), 0, MAX_SCHEDULE_AHEAD_MIN) : 0;
  // Anyone who makes an island is its admin, so this is bounded per room: a handful of extra
  // things on the board is a party; thousands is a snapshot nobody can download.
  const pendingAdhoc = ctx.room.activities.list().filter((a) => a.slot?.startsWith('adhoc:') && !a.closed).length;
  if (pendingAdhoc >= MAX_ADHOC_ACTIVITIES) {
    refuse(ctx, 'schedule_full');
    return;
  }
  // One quiz runs at a time (there is one arena), one treasure hunt (one set of spots) and
  // one race (one course). Asking for another while one is running would put up an activity
  // that could never do its thing, so it is refused; a scheduled one that goes live during
  // this one is called off by the room instead (see `Room.onTransition`).
  if (template.feature === 'quiz' || template.feature === 'treasure' || template.feature === 'daruma') {
    const running = ctx.room.activities.list().some((a) => a.feature === template.feature && a.state === ActivityState.Live);
    if (running) {
      refuse(ctx, 'already_running');
      return;
    }
  }
  const activity = ctx.room.activities.createFromTemplate(template.id, Date.now() + inMin * 60_000, `adhoc:${randomUUID()}`);
  deps.audit.record({
    actorId: ctx.player.id,
    actorName: ctx.player.name,
    action: `schedule:${template.id}`,
    targetId: null,
    reason: `in ${inMin} min (${activity.id})`,
    room: ctx.room.id,
  });
  deps.persist();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------------
// admin actions
// ---------------------------------------------------------------------------------

const ADMIN_ACTIONS = new Set(['kick', 'mute', 'unmute', 'grant_host', 'revoke_host']);

/** Recompute a player's role in their room and tell everyone who needs to know. Returns whether it changed. */
function refreshRole(room: Room, player: Player): boolean {
  const role = room.roleFor(player);
  if (role === player.role) return false;
  player.role = role;
  room.markPlayerChanged(player.id, { role });
  room.sendTo(player.id, { t: 'role_changed', role, activity: player.hostOf ?? undefined });
  return true;
}

function handleAdminAction(ctx: ConnState, msg: ClientAdminAction, deps: HandlerDeps): void {
  assertRole(ctx.player, Role.Admin, 'admin_action');

  if (!ADMIN_ACTIONS.has(msg.action)) {
    sendError(ctx.session, ErrorCode.BadMessage, 'unknown admin action');
    return;
  }
  const target = typeof msg.target === 'string' ? ctx.room.getPlayer(msg.target) : undefined;
  if (!target) {
    refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
    return;
  }
  // Nobody moderates themselves, and an island's keeper cannot moderate the server's own
  // admins — or another admin at all, unless they are one of the server's.
  if (target.id === ctx.player.id || (target.role >= Role.Admin && !(ctx.player.globalAdmin && !target.globalAdmin))) {
    refuse(ctx, 'forbidden');
    return;
  }

  switch (msg.action) {
    case 'kick': {
      // Off a private island for a while, not just out of the door: the invite link would
      // bring them straight back otherwise.
      const banned = ctx.room.kind === 'private' && deps.rooms.banFromIsland(ctx.room, target.visitorHash);
      // A ban is on the visitor, not the tab: their other tabs here go with them — away ones
      // too, or one would resume its way back in.
      const leaving = banned
        ? [...ctx.room.allPlayers()].filter((p) => p.visitorHash === target.visitorHash && !p.globalAdmin)
        : [target];
      for (const p of leaving) {
        ctx.room.sendTo(p.id, {
          t: 'error',
          code: ErrorCode.Kicked,
          message: 'Kicked by admin',
          fatal: true,
          ...(banned ? { key: 'kicked_banned', params: { n: PROTOCOL.ISLAND_BAN_MIN } } : {}),
        });
        ctx.room.removePlayer(p.id, 'kicked_by_admin');
      }
      break;
    }
    case 'mute':
      target.muted = true;
      // A keeper's mute holds on their island; the server's admins' holds everywhere.
      target.mutedIn = ctx.player.globalAdmin ? null : ctx.room.id;
      break;
    case 'unmute':
      target.muted = false;
      target.mutedIn = null;
      break;
    case 'grant_host': {
      const activity = typeof msg.activity === 'string' ? ctx.room.activities.get(msg.activity) : undefined;
      if (!activity) {
        refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
        return;
      }
      // One host per activity and one hosted activity per player: whoever held either end
      // before lets go of it, so no activity is left pointing at a host who hosts elsewhere.
      if (target.hostOf && target.hostOf !== activity.id) {
        const previous = ctx.room.activities.get(target.hostOf);
        if (previous && previous.hostId === target.id) {
          previous.setHost(null, null);
          ctx.room.activities.notifyChanged(previous);
        }
      }
      if (activity.hostId && activity.hostId !== target.id) {
        const previousHost = ctx.room.getPlayer(activity.hostId);
        if (previousHost && previousHost.hostOf === activity.id) {
          previousHost.hostOf = null;
          refreshRole(ctx.room, previousHost);
        }
      }
      activity.setHost(target.id, target.name);
      target.hostOf = activity.id;
      ctx.room.activities.notifyChanged(activity);
      // Told once: by `refreshRole` when the role moved, directly when it did not (an admin
      // made host of something is still an admin, and still wants to know).
      if (!refreshRole(ctx.room, target)) {
        ctx.room.sendTo(target.id, { t: 'role_changed', role: target.role, activity: activity.id });
      }
      break;
    }
    case 'revoke_host': {
      const activityId = typeof msg.activity === 'string' ? msg.activity : target.hostOf;
      const activity = activityId ? ctx.room.activities.get(activityId) : undefined;
      if (activity && activity.hostId === target.id) {
        activity.setHost(null, null);
        ctx.room.activities.notifyChanged(activity);
      }
      if (target.hostOf === activityId) target.hostOf = null;
      refreshRole(ctx.room, target);
      break;
    }
  }

  deps.audit.record({
    actorId: ctx.player.id,
    actorName: ctx.player.name,
    action: msg.action,
    targetId: target.id,
    reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : null,
    room: ctx.room.id,
  });
  deps.persist();
}

// ---------------------------------------------------------------------------------
// interact — what using a thing in the world does
// ---------------------------------------------------------------------------------

function handleInteract(ctx: ConnState, msg: ClientInteract, deps: HandlerDeps): void {
  const interactable = typeof msg.target === 'string' ? getInteractable(msg.target) : undefined;
  if (!interactable) {
    refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
    return;
  }
  if (msg.kind !== 'use' && msg.kind !== 'sit' && msg.kind !== 'stand') {
    sendError(ctx.session, ErrorCode.BadMessage, 'kind must be use, sit or stand');
    return;
  }

  // Standing up needs no reach: you are getting up from wherever you are.
  if (msg.kind === 'stand') {
    ctx.room.releaseSeat(ctx.player);
    if (ctx.player.anim === AnimState.Sit) {
      ctx.player.anim = AnimState.Idle;
      ctx.player.dirty = true;
    }
    return;
  }

  if (!withinReach(interactable, ctx.player.pos[0], ctx.player.pos[2], INTERACT_RANGE_SLOP)) {
    refuse(ctx, 'too_far');
    return;
  }

  // Sitting is broadcast for free through the packed-transform channel: an anim change marks
  // the player dirty, and the next tick carries it. The seat itself is reserved here.
  if (msg.kind === 'sit') {
    if (interactable.kind !== 'sit') {
      sendError(ctx.session, ErrorCode.BadMessage, 'not a seat');
      return;
    }
    if (ctx.room.sit(ctx.player, interactable.id)) {
      ctx.player.anim = AnimState.Sit;
      ctx.player.dirty = true;
    }
    return;
  }

  const now = Date.now();
  switch (interactable.effect) {
    case 'checkin_nearby': {
      const activity = ctx.room.activities
        .list()
        .find((a) => a.zone === interactable.zone && a.state === ActivityState.Live && a.checkinEnabled);
      if (activity) checkIn(ctx, activity.id, deps);
      else ctx.session.send({ t: 'checkin_ack', activity: '', ok: false, reason: 'not_live' });
      return;
    }
    case 'ring_bell':
      ctx.room.interactions.ringBell(ctx.player, interactable, now);
      return;
    case 'omikuji':
      ctx.room.interactions.drawOmikuji(ctx.player, now);
      return;
    case 'stamp':
      ctx.room.interactions.stamp(ctx.player, interactable);
      return;
    case 'fish':
      ctx.room.fishing.cast(ctx.player, interactable.id, now);
      return;
    default:
      // 'read_announcements', 'look' and 'none' need no server action: the client holds the
      // board from its snapshot, and a view is the camera's business.
      return;
  }
}

// ---------------------------------------------------------------------------------
// games
// ---------------------------------------------------------------------------------

function handleFish(ctx: ConnState, msg: ClientFish): void {
  const now = Date.now();
  switch (msg.action) {
    case 'cast':
      if (typeof msg.spot !== 'string') {
        sendError(ctx.session, ErrorCode.BadMessage, 'cast needs a spot');
        return;
      }
      ctx.room.fishing.cast(ctx.player, msg.spot, now);
      return;
    case 'hook':
      ctx.room.fishing.hook(ctx.player, now);
      return;
    case 'stop':
      ctx.room.fishing.stop(ctx.player);
      return;
    default:
      sendError(ctx.session, ErrorCode.BadMessage, 'unknown fishing action');
  }
}

function handleJanken(ctx: ConnState, msg: ClientJanken): void {
  const now = Date.now();
  switch (msg.action) {
    case 'challenge':
      ctx.room.janken.challenge(ctx.player, String(msg.target), now);
      return;
    case 'respond':
      ctx.room.janken.respond(ctx.player, String(msg.duel), msg.accept === true, now);
      return;
    case 'throw':
      ctx.room.janken.throwHand(ctx.player, String(msg.duel), msg.hand as Hand, now);
      return;
    default:
      sendError(ctx.session, ErrorCode.BadMessage, 'unknown janken action');
  }
}

function handleRoll(ctx: ConnState, msg: ClientRoll): void {
  if (ctx.player.muted) return;
  ctx.room.interactions.roll(ctx.player, msg.sides, Date.now());
}

function handleFirework(ctx: ConnState, msg: ClientFirework): void {
  if (ctx.player.muted) {
    refuse(ctx, 'muted');
    return;
  }
  ctx.room.fireworks.launch(ctx.player, Date.now(), msg.hue, msg.pattern);
}

/** An activity's check-in list, for its host or an admin. */
function handleCheckinList(ctx: ConnState, msg: ClientCheckinList): void {
  const activity = typeof msg.activity === 'string' ? ctx.room.activities.get(msg.activity) : undefined;
  if (!activity) {
    refuse(ctx, 'not_found', undefined, ErrorCode.NotFound);
    return;
  }
  if (ctx.player.role < Role.Admin && activity.hostId !== ctx.player.id) {
    refuse(ctx, 'forbidden', undefined, ErrorCode.Forbidden);
    return;
  }
  ctx.session.send({
    t: 'checkin_list',
    activity: activity.id,
    list: activity.checkinRecords().map((r) => ({ ordinal: r.ordinal, name: r.name ?? '…', at: r.at })),
  });
}

function handleFriend(ctx: ConnState, msg: ClientFriend, deps: HandlerDeps): void {
  deps.rooms.friends.handle(ctx.player, msg.action, msg.target);
}

function handleDig(ctx: ConnState): void {
  ctx.room.treasure.dig(ctx.player, Date.now());
}

function handleGuestbookWrite(ctx: ConnState, msg: ClientGuestbookWrite): void {
  ctx.room.guestbook.write(ctx.player, msg.text, Date.now());
}

function handleGuestbookRemove(ctx: ConnState, msg: ClientGuestbookRemove): void {
  ctx.room.guestbook.remove(ctx.player, msg.id);
}

function handleSetTitle(ctx: ConnState, msg: ClientSetTitle, deps: HandlerDeps): void {
  const badge = msg.badge === null ? null : isBadgeId(msg.badge) ? msg.badge : undefined;
  if (badge === undefined || (badge !== null && !ctx.player.profile.badges.includes(badge))) {
    refuse(ctx, 'invalid');
    return;
  }
  ctx.player.profile.title = badge;
  ctx.room.markPlayerChanged(ctx.player.id, { title: badge });
  ctx.room.pushProfile(ctx.player);
  deps.persist();
}

// ---------------------------------------------------------------------------------
// Dispatch map
// ---------------------------------------------------------------------------------

/** Every post-handshake message type, mapped to its handler. `index.ts` looks up `msg.t` here. */
export const HANDLERS: {
  [K in Exclude<ClientMessageType, 'hello'>]: (
    ctx: ConnState,
    msg: Extract<ClientMessage, { t: K }>,
    deps: HandlerDeps,
  ) => void;
} = {
  ping: handlePing,
  move: handleMove,
  emote: handleEmote,
  chat: handleChat,
  activity_join: handleActivityJoin,
  activity_leave: handleActivityLeave,
  checkin: handleCheckin,
  room_switch: handleRoomSwitch,
  room_create: handleRoomCreate,
  room_title: handleRoomTitle,
  resync: handleResync,
  host_activity_state: handleHostActivityState,
  host_announce: handleHostAnnounce,
  host_schedule: handleHostSchedule,
  admin_action: handleAdminAction,
  interact: handleInteract,
  fish: handleFish,
  janken: handleJanken,
  roll: handleRoll,
  dig: handleDig,
  friend: handleFriend,
  checkin_list: handleCheckinList,
  firework: handleFirework,
  guestbook_write: handleGuestbookWrite,
  guestbook_remove: handleGuestbookRemove,
  set_title: handleSetTitle,
};
