/**
 * Handlers — one function per `ClientMessage['t']`, dispatched from a typed map.
 * =================================================================================
 *
 * This is where client intent becomes server truth (or gets rejected). The governing
 * rule, repeated from the top-level spec because it is the single most important thing
 * about this file: **the client requests, the server decides.** Every field on every
 * incoming message is untrusted input — lengths are capped, enums are checked against
 * their actual member set, and every "can this player do this" question routes through
 * `permissions.ts` rather than being re-derived ad hoc.
 *
 * Handlers never close the socket on a rejected request — they reply with
 * `ServerError` (see `sendError`) and let the connection continue, per the protocol's
 * own framing: "a rejected activity join never costs you the world." The one exception
 * is `hello` with a mismatched protocol version, which is fatal by definition (the two
 * sides cannot agree on how to talk to each other at all) and is handled in
 * `handleHello`, before a `ConnState` even exists.
 *
 * `hello` is deliberately not part of the dispatch map: every other handler needs an
 * established `ConnState` (a room + a player) to act on, which is exactly what `hello`
 * creates. `index.ts` calls `handleHello` directly, once, before switching to
 * map-dispatch for everything after.
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
  heightAt,
  interactablePosition,
  nearestWalkable,
  spawnPoint,
  type Appearance,
  type ClientActivityJoin,
  type ClientActivityLeave,
  type ClientAdminAction,
  type ClientChat,
  type ClientCheckin,
  type ClientEmote,
  type ClientHello,
  type ClientHostAnnounce,
  type ClientHostActivityState,
  type ClientInteract,
  type ClientMessage,
  type ClientMessageType,
  type ClientPing,
  type ClientMove,
  type ClientResync,
  type ClientRoomSwitch,
  type Emote,
  type ServerMessage,
} from '@nagisa/shared';
import { Player } from './player.js';
import { Room } from './room.js';
import { RoomManager } from './rooms.js';
import { Session } from './session.js';
import { AuditLog } from './audit.js';
import { canAnnounce, canHostActivity, assertRole, PermissionError } from './permissions.js';
import { issueResumeToken, verifyResumeToken } from './resume.js';
import type { Logger } from './logger.js';
import type { Config } from './config.js';

/** Tolerance added to an interactable's declared range to absorb normal float/lag jitter. */
const INTERACT_RANGE_SLOP = 1.5;

/** Default TTL for an announcement that doesn't specify one. */
const DEFAULT_ANNOUNCEMENT_TTL_MS = 60_000;
const MIN_ANNOUNCEMENT_TTL_MS = 5_000;
const MAX_ANNOUNCEMENT_TTL_MS = 10 * 60_000;

/** Shared services every handler may need. Constructed once in `index.ts`. */
export interface HandlerDeps {
  rooms: RoomManager;
  audit: AuditLog;
  log: Logger;
  config: Config;
  /** Ask the persistence layer to save soon. Cheap to call often — `Store.save` debounces. */
  persist: () => void;
}

/**
 * Per-connection state that outlives any single message: which room the player is
 * currently in and which `Player` record they are. Both fields are reassigned in place
 * (not replaced by a new `ConnState`) so every handler holding a reference to the same
 * `ConnState` object observes a room switch or resume immediately.
 */
export class ConnState {
  constructor(
    public session: Session,
    public room: Room,
    public player: Player,
  ) {}
}

function sendError(session: Session, code: ErrorCode, message: string, fatal = false): void {
  session.send({ t: 'error', code, message, fatal } satisfies ServerMessage);
}

// ---------------------------------------------------------------------------------
// hello — establishes (or resumes) a ConnState. Called directly by index.ts, not via
// the dispatch map, because every other handler requires the ConnState this produces.
// ---------------------------------------------------------------------------------

function clampName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length === 0) return 'Visitor';
  return s.slice(0, PROTOCOL.MAX_NAME_LENGTH);
}

function sanitizeAppearance(raw: unknown): Appearance {
  const a = (raw ?? {}) as Partial<Appearance>;
  const clampIdx = (v: unknown): number => (Number.isFinite(v) && (v as number) >= 0 ? Math.floor(v as number) : 0);
  return { outfit: clampIdx(a.outfit), skin: clampIdx(a.skin), accessory: clampIdx(a.accessory) };
}

/**
 * How far {@link returningSpawn} will let the walkability contract move a claimed
 * position before it stops believing the claim.
 *
 * A small correction is expected and welcome: you logged off wading in the shallows, or
 * standing on the lip of a terrace that rounds to unwalkable, and the snap lifts you onto
 * the nearest solid ground. A large one means the claim did not come from anywhere a
 * player was actually standing — a corrupted store, a stale position from a different
 * map, or a fabricated one — and `nearestWalkable` would answer with a spiral search or
 * its plaza fallback, i.e. it would *invent* somewhere to put you. Better to admit we do
 * not know where you were and use a harbour spawn, which at least reads as an arrival.
 */
const RETURN_SNAP_LIMIT = 6;

/**
 * Turn a client's claimed last position into a spawn, or `null` if it cannot be believed.
 *
 * ### Why this is not gated on the resume token
 *
 * The obvious design is to honour a claim only from a connection holding a valid resume
 * token — proof the server issued it a session. That gate is worthless here, and not for a
 * subtle reason: the case this whole feature exists for is the *server restarting*, and a
 * restarted server has no rooms and no players, so `verifyResumeToken` succeeding tells it
 * nothing it can act on. (With the default per-process secret the token does not even
 * verify.) A gate that is always shut in the one case that matters is not a safeguard, it
 * is the bug wearing a safeguard's clothes.
 *
 * What is left is a plain trust question: may an anonymous socket name the patch of ground
 * it appears on? On this island, yes — it is public, has no accounts, no locked areas and
 * nothing to take, so a fabricated claim achieves exactly what walking there for a minute
 * would have achieved. The arrival at the harbour is preserved anyway, because a client
 * that has never been here has no pose to claim.
 *
 * What is *not* taken on trust is the geometry. `x`/`z` must be finite and inside the map,
 * the ground beneath them is re-derived through the same `isWalkable` contract the move
 * validator enforces on every subsequent step, and `y` comes from `heightAt` rather than
 * from the client — so a claim cannot put a player inside a hill, out at sea, or hovering
 * above the island.
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

/**
 * Handle the first frame of a connection. Either mints a brand-new player and drops
 * them at a harbour spawn point, or — if `resumeToken` is present, cryptographically
 * valid, and the named player is still sitting in their room's grace window — restores
 * that exact player (identity, role, activity attachment) and clears their `away` flag.
 *
 * Returns `null` if the connection was rejected outright (protocol version mismatch);
 * the caller is responsible for closing the socket in that case.
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

  // Verify the token once, up front. It does double duty: it is the key to the resume
  // path below, and — even when that path cannot be taken because the player it names is
  // already gone — it is the proof that this connection was issued a session, which is
  // what licenses us to honour a claimed position on the fresh-arrival path.
  const payload = msg.resumeToken ? verifyResumeToken(deps.config.RESUME_SECRET, msg.resumeToken) : null;

  // Attempt resume before anything else — a valid, in-grace resume takes priority over
  // treating this as a new arrival, per ClientHello's own doc: "Invalid or expired
  // tokens are ignored rather than rejected."
  if (payload) {
    const room = deps.rooms.get(payload.room);
    const player = room?.getPlayer(payload.playerId);
    if (room && player && player.away) {
      room.resume(session, player);
      // Cosmetic fields may have changed client-side (e.g. a re-picked outfit) while
      // disconnected; identity (id/role/activity attachment) is never re-derived from
      // the client, only these two presentational fields are refreshed.
      player.name = name;
      player.appearance = appearance;
      if (opts.adminGranted && player.role < Role.Admin) player.role = Role.Admin;

      const resumeToken = issueResumeToken(deps.config.RESUME_SECRET, { playerId: player.id, room: room.id });
      session.send({
        t: 'welcome',
        protocol: PROTOCOL.VERSION,
        self: player.id,
        resumeToken,
        resumed: true,
        room: room.toView(),
        serverTime: Date.now(),
        tickHz: PROTOCOL.TICK_HZ,
        mapId: activeMapId() ?? '',
        rooms: deps.rooms.listViews(),
      });
      session.send(room.buildSnapshot());
      return new ConnState(session, room, player);
    }
  }

  // Fresh arrival: matchmake into a room and mint a player.
  //
  // Two quite different people reach this line. A first-time visitor, who lands on the
  // harbour quay because arriving at the harbour is the intended way to meet the island.
  // And someone who was *already here* a moment ago but whose player the server no longer
  // holds — their grace window lapsed during a long outage, or the process restarted
  // under them. For the second, the harbour is not an arrival, it is a punishment for a
  // dropped connection: it takes the place you were standing and replaces it with a walk
  // back. So a connection that can still say where it was resumes there, and only a claim
  // we cannot believe — or none at all, which is what a genuine first visit looks like —
  // falls back to the quay. See `returningSpawn` for what "believe" means here.
  const room = deps.rooms.pickRoom(msg.room ?? payload?.room);
  const spawn = returningSpawn(msg.at) ?? spawnPoint(Math.floor(Math.random() * 1000));
  const role = opts.adminGranted ? Role.Admin : Role.Guest;
  const player = new Player(randomUUID(), name, appearance, role, spawn);
  room.join(session, player);

  const resumeToken = issueResumeToken(deps.config.RESUME_SECRET, { playerId: player.id, room: room.id });
  session.send({
    t: 'welcome',
    protocol: PROTOCOL.VERSION,
    self: player.id,
    resumeToken,
    resumed: false,
    room: room.toView(),
    serverTime: Date.now(),
    tickHz: PROTOCOL.TICK_HZ,
    mapId: activeMapId() ?? '',
    rooms: deps.rooms.listViews(),
  });
  session.send(room.buildSnapshot());
  return new ConnState(session, room, player);
}

// ---------------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------------

function handlePing(ctx: ConnState, msg: ClientPing): void {
  ctx.session.send({ t: 'pong', t0: msg.t0, serverTime: Date.now() });
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
  if (ctx.player.zone !== prevZone) {
    ctx.room.markPlayerChanged(ctx.player.id, { zone: ctx.player.zone });
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
}

function handleChat(ctx: ConnState, msg: ClientChat): void {
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (text.length === 0 || text.length > PROTOCOL.MAX_CHAT_LENGTH) {
    sendError(ctx.session, ErrorCode.BadMessage, `chat must be 1-${PROTOCOL.MAX_CHAT_LENGTH} characters`);
    return;
  }
  if (ctx.player.muted) return; // Silently dropped — see Player.muted.
  ctx.room.chat(ctx.player.id, text);
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
    sendError(ctx.session, ErrorCode.NotFound, 'unknown activity');
    return;
  }

  // A player attends at most one activity at a time; joining a new one releases the old.
  if (ctx.player.activity && ctx.player.activity !== activity.id) {
    const old = ctx.room.activities.get(ctx.player.activity);
    old?.leave(ctx.player.id);
    if (old) ctx.room.activities.notifyChanged(old);
  }

  const result = activity.join(ctx.player.id, msg.mode);
  if (!result.ok) {
    const code = result.reason === 'full' ? ErrorCode.ActivityFull : ErrorCode.InvalidTransition;
    sendError(ctx.session, code, `cannot join: ${result.reason}`);
    return;
  }

  ctx.player.activity = activity.id;
  ctx.player.mode = msg.mode;
  ctx.room.markPlayerChanged(ctx.player.id, { activity: activity.id, mode: msg.mode });
  ctx.room.activities.notifyChanged(activity);
  deps.persist();
}

function handleActivityLeave(ctx: ConnState, msg: ClientActivityLeave, deps: HandlerDeps): void {
  if (ctx.player.activity !== msg.activity) {
    sendError(ctx.session, ErrorCode.NotFound, 'not attending that activity');
    return;
  }
  const activity = ctx.room.activities.get(msg.activity);
  activity?.leave(ctx.player.id);
  ctx.player.activity = null;
  ctx.player.mode = null;
  ctx.room.markPlayerChanged(ctx.player.id, { activity: null, mode: null });
  if (activity) ctx.room.activities.notifyChanged(activity);
  deps.persist();
}

function handleCheckin(ctx: ConnState, msg: ClientCheckin, deps: HandlerDeps): void {
  const activity = ctx.room.activities.get(msg.activity);
  if (!activity) {
    ctx.session.send({ t: 'checkin_ack', activity: msg.activity, ok: false, reason: 'not_found' });
    return;
  }
  const result = activity.checkin(ctx.player.id, Date.now());
  ctx.session.send(
    result.ok
      ? { t: 'checkin_ack', activity: activity.id, ok: true, ordinal: result.ordinal }
      : { t: 'checkin_ack', activity: activity.id, ok: false, reason: result.reason },
  );
  if (result.ok) {
    ctx.room.activities.notifyChanged(activity);
    deps.persist();
  }
}

// ---------------------------------------------------------------------------------
// room switch / resync
// ---------------------------------------------------------------------------------

function handleRoomSwitch(ctx: ConnState, msg: ClientRoomSwitch, deps: HandlerDeps): void {
  const result = deps.rooms.switchRoom(ctx.player, ctx.session, ctx.room, msg.room);
  if (!result.ok) {
    const code = result.reason === 'full' ? ErrorCode.RoomFull : ErrorCode.NotFound;
    sendError(ctx.session, code, `cannot switch room: ${result.reason}`);
    return;
  }
  ctx.room = result.room;
  // A new shard is a fresh arrival, so re-spawn on that shard's harbour rather than
  // carrying over a position that may not even be walkable ground in the new instance
  // (all shards share the same terrain, so it would be walkable, but a fresh spawn keeps
  // the "arriving somewhere" feeling consistent with first join).
  const spawn = spawnPoint(Math.floor(Math.random() * 1000));
  ctx.player.teleport(spawn.pos, spawn.yaw);
  ctx.session.send({ t: 'room_changed', room: result.room.toView() });
  ctx.session.send(result.room.buildSnapshot());
}

function handleResync(ctx: ConnState, msg: ClientResync): void {
  const deltas = ctx.room.getDeltasSince(msg.haveTick);
  if (deltas === null) {
    ctx.session.send(ctx.room.buildSnapshot());
    return;
  }
  // Explicit repair: never dropped, even under backpressure — this is the client
  // deliberately asking to catch up, so silently discarding part of the answer would
  // defeat the entire point of resync.
  for (const delta of deltas) ctx.session.send(delta, { droppable: false });
}

// ---------------------------------------------------------------------------------
// host actions
// ---------------------------------------------------------------------------------

function handleHostActivityState(ctx: ConnState, msg: ClientHostActivityState, deps: HandlerDeps): void {
  const activity = ctx.room.activities.get(msg.activity);
  if (!activity) {
    sendError(ctx.session, ErrorCode.NotFound, 'unknown activity');
    return;
  }
  if (!canHostActivity(ctx.player, activity)) {
    throw new PermissionError(ErrorCode.Forbidden, 'not host of this activity');
  }
  if (!Object.values(ActivityState).includes(msg.state)) {
    sendError(ctx.session, ErrorCode.BadMessage, 'unknown activity state');
    return;
  }
  if (!activity.transitionTo(msg.state)) {
    sendError(ctx.session, ErrorCode.InvalidTransition, `cannot go from ${activity.state} to ${msg.state}`);
    return;
  }
  ctx.room.activities.notifyChanged(activity);
  deps.persist();
}

function handleHostAnnounce(ctx: ConnState, msg: ClientHostAnnounce, deps: HandlerDeps): void {
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (text.length === 0 || text.length > PROTOCOL.MAX_ANNOUNCEMENT_LENGTH) {
    sendError(ctx.session, ErrorCode.BadMessage, `announcement must be 1-${PROTOCOL.MAX_ANNOUNCEMENT_LENGTH} characters`);
    return;
  }
  const hostedActivity = ctx.player.hostOf ? (ctx.room.activities.get(ctx.player.hostOf) ?? null) : null;
  if (!canAnnounce(ctx.player, msg.scope, hostedActivity)) {
    throw new PermissionError(ErrorCode.Forbidden, 'not allowed to announce at this scope');
  }
  if (msg.scope.kind === 'activity' && !ctx.room.activities.get(msg.scope.activity)) {
    sendError(ctx.session, ErrorCode.NotFound, 'unknown activity in announcement scope');
    return;
  }
  const ttlMs = clamp(msg.ttlMs ?? DEFAULT_ANNOUNCEMENT_TTL_MS, MIN_ANNOUNCEMENT_TTL_MS, MAX_ANNOUNCEMENT_TTL_MS);
  ctx.room.announce({ text, fromName: ctx.player.name, scope: msg.scope, ttlMs, priority: msg.priority ?? 'normal' });
  deps.persist();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------------
// admin actions
// ---------------------------------------------------------------------------------

const ADMIN_ACTIONS = new Set(['kick', 'mute', 'unmute', 'grant_host', 'revoke_host']);

function handleAdminAction(ctx: ConnState, msg: ClientAdminAction, deps: HandlerDeps): void {
  assertRole(ctx.player, Role.Admin, 'admin_action');

  if (!ADMIN_ACTIONS.has(msg.action)) {
    sendError(ctx.session, ErrorCode.BadMessage, 'unknown admin action');
    return;
  }
  const target = ctx.room.getPlayer(msg.target);
  if (!target) {
    sendError(ctx.session, ErrorCode.NotFound, 'unknown target player');
    return;
  }

  switch (msg.action) {
    case 'kick': {
      const targetSession = ctx.room.getSession(target.id);
      targetSession?.send({ t: 'error', code: ErrorCode.Kicked, message: msg.reason ?? 'Kicked by admin', fatal: true });
      ctx.room.removePlayer(target.id, 'kicked_by_admin');
      break;
    }
    case 'mute':
      target.muted = true;
      break;
    case 'unmute':
      target.muted = false;
      break;
    case 'grant_host': {
      if (!msg.activity) {
        sendError(ctx.session, ErrorCode.BadMessage, 'grant_host requires activity');
        return;
      }
      const activity = ctx.room.activities.get(msg.activity);
      if (!activity) {
        sendError(ctx.session, ErrorCode.NotFound, 'unknown activity');
        return;
      }
      activity.setHost(target.id, target.name);
      target.hostOf = activity.id;
      if (target.role < Role.Host) target.role = Role.Host;
      ctx.room.markPlayerChanged(target.id, { role: target.role });
      ctx.room.activities.notifyChanged(activity);
      ctx.room.getSession(target.id)?.send({ t: 'role_changed', role: target.role, activity: activity.id });
      break;
    }
    case 'revoke_host': {
      if (!msg.activity) {
        sendError(ctx.session, ErrorCode.BadMessage, 'revoke_host requires activity');
        return;
      }
      const activity = ctx.room.activities.get(msg.activity);
      if (activity && activity.hostId === target.id) {
        activity.setHost(null, null);
        ctx.room.activities.notifyChanged(activity);
      }
      if (target.hostOf === msg.activity) target.hostOf = null;
      if (target.role === Role.Host && target.hostOf === null) target.role = Role.Guest;
      ctx.room.markPlayerChanged(target.id, { role: target.role });
      ctx.room.getSession(target.id)?.send({ t: 'role_changed', role: target.role });
      break;
    }
  }

  deps.audit.record({
    actorId: ctx.player.id,
    actorName: ctx.player.name,
    action: msg.action,
    targetId: target.id,
    reason: msg.reason ?? null,
  });
  deps.persist();
}

// ---------------------------------------------------------------------------------
// interact
// ---------------------------------------------------------------------------------

function handleInteract(ctx: ConnState, msg: ClientInteract, deps: HandlerDeps): void {
  const interactable = getInteractable(msg.target);
  if (!interactable) {
    sendError(ctx.session, ErrorCode.NotFound, 'unknown interactable');
    return;
  }
  const pos = interactablePosition(interactable);
  const dist = Math.hypot(ctx.player.pos[0] - pos.x, ctx.player.pos[2] - pos.z);
  if (dist > interactable.range + INTERACT_RANGE_SLOP) {
    sendError(ctx.session, ErrorCode.Forbidden, 'too far from interactable');
    return;
  }

  // Sit/stand is broadcast for free through the normal packed-transform channel: an
  // anim change marks the player dirty, and the next tick's move frame carries it to
  // everyone else. No dedicated wire message is needed.
  if (msg.kind === 'sit' && interactable.kind === 'sit') {
    ctx.player.anim = AnimState.Sit;
    ctx.player.dirty = true;
  } else if (msg.kind === 'stand') {
    ctx.player.anim = AnimState.Idle;
    ctx.player.dirty = true;
  }

  if (interactable.effect === 'checkin_nearby') {
    const activity = ctx.room.activities
      .list()
      .find((a) => a.zone === interactable.zone && a.state === ActivityState.Live && a.checkinEnabled);
    if (activity) {
      const result = activity.checkin(ctx.player.id, Date.now());
      ctx.session.send(
        result.ok
          ? { t: 'checkin_ack', activity: activity.id, ok: true, ordinal: result.ordinal }
          : { t: 'checkin_ack', activity: activity.id, ok: false, reason: result.reason },
      );
      if (result.ok) {
        ctx.room.activities.notifyChanged(activity);
        deps.persist();
      }
    }
  }
  // 'read_announcements' and 'none' need no further server action: the client already
  // holds the current board from its snapshot/delta stream.
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
  resync: handleResync,
  host_activity_state: handleHostActivityState,
  host_announce: handleHostAnnounce,
  admin_action: handleAdminAction,
  interact: handleInteract,
};
