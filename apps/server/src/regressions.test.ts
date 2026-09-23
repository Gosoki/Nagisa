/**
 * Regression tests for the server logic review.
 * =============================================
 *
 * Each test pins one bug that was found by reading the code and fixed: what a player would
 * have seen, reproduced through the same entry points the socket layer uses (`handleHello`,
 * the `HANDLERS` table, the room's own tick), so a regression shows up as the symptom and not
 * as an implementation detail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import {
  ActivityState,
  AnimState,
  PROTOCOL,
  Role,
  heightAt,
  interactablePosition,
  interactablesWith,
  type ClientHello,
  type ClientMessage,
  type ServerMessage,
} from '@nagisa/shared';
import { HANDLERS, MAX_ADHOC_ACTIVITIES, handleHello, type ConnState, type HandlerDeps } from './handlers.js';
import { RoomManager } from './rooms.js';
import { Room } from './room.js';
import { Player } from './player.js';
import { AuditLog } from './audit.js';
import { Session } from './session.js';
import { createLogger } from './logger.js';
import { issueResumeToken } from './resume.js';
import { ProfileStore, hashVisitorKey } from './games/profiles.js';

class FakeSocket {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = 1;
  bufferedAmount = 0;
  closeCode: number | undefined;
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closeCode = code;
  }
}

const log = createLogger({ level: 'error' });
const SECRET = 'test-secret-for-resume-tokens';

/** A room with no schedule, for tests that watch its deltas. */
function bareRoom(): Room {
  return new Room('r1', 'Test', 50, log, { schedule: false });
}

let nextId = 0;
function joinBare(room: Room): { player: Player; session: Session; socket: FakeSocket } {
  const socket = new FakeSocket();
  const session = new Session(socket as unknown as WebSocket, `c-${++nextId}`, log);
  const player = new Player(`p-${nextId}`, `P${nextId}`, { outfit: 0, skin: 0, accessory: 0 }, Role.Guest, { pos: [0, 0, 0], yaw: 0 });
  room.join(session, player);
  return { player, session, socket };
}

function makeDeps(initialRoomCount = 1): HandlerDeps {
  return {
    rooms: new RoomManager({ log, roomCapacity: 40, privateCapacity: 20, initialRoomCount, persist: () => {}, autostart: false }),
    audit: new AuditLog(log),
    log,
    config: { RESUME_SECRET: SECRET } as HandlerDeps['config'],
    profiles: new ProfileStore(),
    persist: () => {},
  };
}

function connect(deps: HandlerDeps, extra: Partial<ClientHello> = {}, admin = false): { conn: ConnState; socket: FakeSocket } {
  const socket = new FakeSocket();
  const session = new Session(socket as unknown as WebSocket, `conn-${Math.random()}`, log);
  const conn = handleHello(
    session,
    { t: 'hello', protocol: PROTOCOL.VERSION, name: 'Nao', appearance: { outfit: 1, skin: 2, accessory: 0 }, ...extra },
    { adminGranted: admin },
    deps,
  );
  assert.ok(conn, 'hello should be accepted');
  return { conn, socket };
}

/** Dispatch one post-handshake message the way `index.ts` does. */
function send<M extends Exclude<ClientMessage, { t: 'hello' }>>(ctx: ConnState, msg: M, deps: HandlerDeps): void {
  (HANDLERS[msg.t] as (c: ConnState, m: M, d: HandlerDeps) => void)(ctx, msg, deps);
}

function of<T extends ServerMessage['t']>(socket: FakeSocket, t: T): Array<Extract<ServerMessage, { t: T }>> {
  return socket.sent.filter((m) => m.t === t) as Array<Extract<ServerMessage, { t: T }>>;
}

function lastOf<T extends ServerMessage['t']>(socket: FakeSocket, t: T): Extract<ServerMessage, { t: T }> | undefined {
  const all = of(socket, t);
  return all[all.length - 1];
}

// ---------------------------------------------------------------------------------------------
// Reconnecting
// ---------------------------------------------------------------------------------------------

test('a resume while the old socket is still open takes the player over, and the old close changes nothing', () => {
  const deps = makeDeps();
  const first = connect(deps);
  const { player, room } = first.conn;
  const token = issueResumeToken(SECRET, { playerId: player.id, room: room.id });

  // The phone changed networks: the new socket arrives before the server has noticed the old
  // one die. It must not become a second copy of the player.
  const second = connect(deps, { resumeToken: token });
  assert.equal(second.conn.player, player, 'the same player, not a new one');
  assert.equal(first.socket.closeCode, 4002, 'the stale socket is told it was replaced');
  assert.equal(room.getSession(player.id), second.conn.session);
  assert.equal(room.population, 1);

  // Its close event arrives late. It is not the player's connection any more.
  room.disconnect(player.id, first.conn.session);
  assert.equal(player.away, false, 'the late close does not grey out the player');
  assert.equal(room.getSession(player.id), second.conn.session);
});

test('moves are accepted again after a resume, however many the old connection sent', () => {
  const deps = makeDeps();
  const first = connect(deps);
  const { player, room } = first.conn;
  // A long session: the old page had counted its moves well past anything a new page sends first.
  player.lastMoveSeq = 5000;
  room.disconnect(player.id, first.conn.session);

  const token = issueResumeToken(SECRET, { playerId: player.id, room: room.id });
  const second = connect(deps, { resumeToken: token });
  const [x, y, z] = player.pos;
  send(second.conn, { t: 'move', seq: 1, pos: [x, y, z], yaw: 1.25, anim: AnimState.Idle }, deps);
  assert.equal(player.lastMoveSeq, 1, 'the new connection’s first move is taken');
  assert.equal(player.yaw, 1.25);
});

test('the resume token finds the player in the room they moved to', () => {
  const deps = makeDeps(2);
  const first = connect(deps);
  const { player } = first.conn;
  // Issued for the first shard; the `room_changed` carrying the new token was lost.
  const token = issueResumeToken(SECRET, { playerId: player.id, room: first.conn.room.id });
  const target = deps.rooms.list().find((r) => r !== first.conn.room)!;
  send(first.conn, { t: 'room_switch', room: target.id }, deps);
  assert.equal(first.conn.room, target);

  const second = connect(deps, { resumeToken: token });
  assert.equal(second.conn.player, player, 'resumed, not duplicated');
  assert.equal(second.conn.room, target);
});

// ---------------------------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------------------------

test('leaving and coming back within one tick does not send a leave for someone who is here', () => {
  const room = bareRoom();
  const watcher = joinBare(room);
  const walker = joinBare(room);
  room.forceTick();

  // A→B→A inside one tick: the switch removes them without closing the socket, and they are back.
  room.removePlayer(walker.player.id, 'room_switch', { closeSession: false });
  room.join(walker.session, walker.player);
  room.forceTick();

  const leaves = of(watcher.socket, 'delta').flatMap((d) => d.leave ?? []);
  assert.ok(!leaves.includes(walker.player.id), 'no leave goes out for a player still in the room');
  assert.ok(room.getPlayer(walker.player.id));
  room.stop();
});

test('a keeper’s mute stays on their island; a server admin’s goes everywhere', () => {
  const deps = makeDeps();
  const key = 'keeperkeykeeperkeykeeper';
  const island = deps.rooms.createPrivate({ hash: hashVisitorKey(key), name: 'Mio', playerId: 'p-mio' })!;
  const keeper = connect(deps, { room: island.code!, visitor: key }).conn;
  assert.equal(keeper.room, island);
  assert.equal(keeper.player.role, Role.Admin, 'the keeper is admin on their island');
  const guest = connect(deps, { room: island.code! }).conn;
  assert.equal(guest.room, island);

  send(keeper, { t: 'admin_action', action: 'mute', target: guest.player.id }, deps);
  assert.equal(guest.player.muted, true);
  const shore = deps.rooms.list().find((r) => r.kind === 'public')!;
  send(guest, { t: 'room_switch', room: shore.id }, deps);
  assert.equal(guest.room, shore);
  assert.equal(guest.player.muted, false, 'the keeper’s word does not reach the public shore');

  // The server's own admins mute on every island.
  const admin = connect(deps, {}, true).conn;
  assert.equal(admin.room, shore);
  send(admin, { t: 'admin_action', action: 'mute', target: guest.player.id }, deps);
  send(guest, { t: 'room_switch', room: island.code! }, deps);
  assert.equal(guest.room, island);
  assert.equal(guest.player.muted, true, 'a server admin’s mute follows the player');
});

test('a room restored mid-quiz ends that quiz, and a new one can run', () => {
  const before = bareRoom();
  const quiz = before.activities.createFromTemplate('island-quiz', Date.now() - 1000);
  before.activities.sweep(Date.now());
  assert.equal(quiz.state, ActivityState.Live);
  const saved = before.exportState();
  before.stop();

  const after = bareRoom();
  after.restoreState(saved);
  const restored = after.activities.get(quiz.id);
  assert.equal(restored?.state, ActivityState.Ended, 'nothing is running it any more');

  const next = after.activities.createFromTemplate('island-quiz', Date.now() - 1000);
  after.activities.sweep(Date.now());
  assert.equal(next.state, ActivityState.Live, 'the old one does not block the arena');
  after.stop();
});

// ---------------------------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------------------------

test('switching between taking part and watching works when the activity is full', () => {
  const deps = makeDeps();
  const a = connect(deps).conn;
  const b = connect(deps).conn;
  const activity = a.room.activities.createFromTemplate('morning-assembly', Date.now() - 1000);
  a.room.activities.sweep(Date.now());
  activity.capacity = 1;

  send(a, { t: 'activity_join', activity: activity.id, mode: 'participant' }, deps);
  assert.equal(a.player.mode, 'participant');
  send(a, { t: 'activity_join', activity: activity.id, mode: 'audience' }, deps);
  assert.equal(a.player.mode, 'audience', 'changing mode adds nobody, so a full activity allows it');
  assert.equal(activity.attendanceCount, 1);

  send(b, { t: 'activity_join', activity: activity.id, mode: 'audience' }, deps);
  assert.equal(b.player.activity, null, 'a newcomer is still refused');
});

test('checking in again after leaving and coming back restores the checked-in mark', () => {
  const deps = makeDeps();
  const { conn: a, socket } = connect(deps);
  const activity = a.room.activities.createFromTemplate('morning-assembly', Date.now() - 1000);
  a.room.activities.sweep(Date.now());
  assert.equal(activity.state, ActivityState.Live);

  send(a, { t: 'activity_join', activity: activity.id, mode: 'participant' }, deps);
  send(a, { t: 'checkin', activity: activity.id }, deps);
  assert.equal(lastOf(socket, 'checkin_ack')?.ok, true);
  assert.equal(a.player.checkedIn, true);

  send(a, { t: 'activity_leave', activity: activity.id }, deps);
  assert.equal(a.player.checkedIn, false);
  send(a, { t: 'activity_join', activity: activity.id, mode: 'participant' }, deps);
  send(a, { t: 'checkin', activity: activity.id }, deps);
  const ack = lastOf(socket, 'checkin_ack');
  assert.deepEqual([ack?.ok, ack?.ok === false ? ack.reason : null], [false, 'already']);
  assert.equal(a.player.checkedIn, true, 'the record stands, and so does the mark');
});

test('an island admin can add only a handful of extra activities', () => {
  const deps = makeDeps();
  const { conn: admin, socket } = connect(deps, {}, true);
  const adhoc = () => admin.room.activities.list().filter((a) => a.slot?.startsWith('adhoc:')).length;

  for (let i = 0; i < MAX_ADHOC_ACTIVITIES; i++) send(admin, { t: 'host_schedule', template: 'fireworks', inMin: 10 }, deps);
  assert.equal(adhoc(), MAX_ADHOC_ACTIVITIES);
  send(admin, { t: 'host_schedule', template: 'fireworks', inMin: 10 }, deps);
  assert.equal(adhoc(), MAX_ADHOC_ACTIVITIES, 'one more is refused');
  assert.equal(lastOf(socket, 'error')?.key, 'busy');
});

test('granting host tells the new host once', () => {
  const deps = makeDeps();
  const admin = connect(deps, {}, true).conn;
  const { conn: guest, socket } = connect(deps);
  const activity = admin.room.activities.createFromTemplate('morning-assembly', Date.now() + 60_000);

  send(admin, { t: 'admin_action', action: 'grant_host', target: guest.player.id, activity: activity.id }, deps);
  assert.equal(guest.player.role, Role.Host);
  assert.equal(of(socket, 'role_changed').length, 1);
});

// ---------------------------------------------------------------------------------------------
// Guestbook
// ---------------------------------------------------------------------------------------------

test('a line written and taken down in the same tick is sent as removed', () => {
  const room = bareRoom();
  const watcher = joinBare(room);
  const writer = joinBare(room);
  const board = interactablePosition(interactablesWith('read_announcements')[0]);
  writer.player.teleport([board.x, heightAt(board.x, board.z), board.z], 0);
  room.forceTick();

  // Someone arriving between the write and the removal gets a snapshot with the line in it,
  // so the removal must go out even though the addition never did.
  room.guestbook.write(writer.player, 'hello island', Date.now());
  const id = room.guestbook.view()[0]?.id;
  assert.ok(id, 'the line was written');
  room.guestbook.remove(writer.player, id);
  room.forceTick();

  const deltas = of(watcher.socket, 'delta');
  assert.ok(deltas.flatMap((d) => d.guestbookRemoved ?? []).includes(id));
  assert.ok(!deltas.flatMap((d) => d.guestbook ?? []).some((g) => g.id === id));
  room.stop();
});
