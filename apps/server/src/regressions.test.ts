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
import { ISLAND_BAN_MS, RoomManager } from './rooms.js';
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
  send(guest, { t: 'room_switch', room: island.code! }, deps);
  assert.equal(guest.player.muted, true, 'and still holds on the keeper’s island when they come back');
  send(guest, { t: 'room_switch', room: shore.id }, deps);

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
  assert.equal(lastOf(socket, 'error')?.key, 'schedule_full');
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

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------

test('a game that throws in a tick costs nobody their join, and the tick sequence stays whole', (t) => {
  const room = bareRoom();
  const watcher = joinBare(room);
  room.forceTick();
  const before = of(watcher.socket, 'delta').at(-1)!.tick;

  // The failures below are logged as errors, on purpose; keep them out of the test output.
  const loud = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = loud;
  });

  // A bug in a game, in the same tick someone arrives.
  const fishing = room.fishing as unknown as { tick(now: number): void };
  const realTick = fishing.tick;
  fishing.tick = () => {
    throw new Error('boom');
  };
  const arrival = joinBare(room);
  room.forceTick();
  fishing.tick = realTick;

  const deltas = of(watcher.socket, 'delta');
  const broken = deltas.at(-1)!;
  assert.equal(broken.tick, before + 1, 'the tick still goes out');
  assert.ok(broken.join?.some((p) => p.id === arrival.player.id), 'with the arrival in it');

  // A failure while putting the delta together still spends the tick on an empty one.
  const book = room.guestbook as unknown as { drain(): unknown };
  const realDrain = book.drain;
  book.drain = () => {
    throw new Error('boom');
  };
  room.forceTick();
  book.drain = realDrain;
  room.forceTick();
  const ticks = of(watcher.socket, 'delta').map((d) => d.tick);
  assert.deepEqual(ticks.slice(-2), [before + 2, before + 3], 'the failed tick went out empty');
  const snaps = of(watcher.socket, 'snapshot');
  assert.equal(snaps.at(-1)?.tick, before + 2, 'and everyone was given the room as it stood');
  assert.ok(ticks.every((t, i) => i === 0 || t === ticks[i - 1] + 1), `no gaps: ${ticks.join(',')}`);
  assert.deepEqual(room.getDeltasSince(before + 1)?.map((d) => d.tick), [before + 2, before + 3]);
  room.stop();
});


test('a damaged saved room loses the damaged records, not the room', () => {
  const good = bareRoom();
  const quiz = good.activities.createFromTemplate('island-quiz', Date.now() + 60_000);
  const saved = good.exportState();
  good.stop();
  const damaged = {
    ...saved,
    activities: [...saved.activities, { ...saved.activities[0], id: 'broken', checkins: {} as never }],
    announcements: [null as never, { id: 'a1', text: 'hi', fromName: 'X', scope: { kind: 'island' }, at: Date.now(), ttlMs: 60_000, priority: 'normal' } as never],
  };
  const room = bareRoom();
  room.restoreState(damaged);
  assert.ok(room.activities.get(quiz.id), 'the good activity is back');
  assert.equal(room.activities.get('broken'), undefined);
  room.forceTick();
  room.stop();
});

// ---------------------------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------------------------

test('a check-in list keeps names, is shown to the host and admins only, and survives a restart', () => {
  const deps = makeDeps();
  const { conn: admin, socket: adminSocket } = connect(deps, {}, true);
  const { conn: guest, socket: guestSocket } = connect(deps);
  const activity = admin.room.activities.createFromTemplate('morning-assembly', Date.now() - 1000);
  admin.room.activities.sweep(Date.now());
  send(guest, { t: 'activity_join', activity: activity.id, mode: 'participant' }, deps);
  send(guest, { t: 'checkin', activity: activity.id }, deps);

  send(guest, { t: 'checkin_list', activity: activity.id }, deps);
  assert.equal(lastOf(guestSocket, 'error')?.key, 'forbidden', 'not for everyone');

  send(admin, { t: 'checkin_list', activity: activity.id }, deps);
  const list = lastOf(adminSocket, 'checkin_list');
  assert.equal(list?.activity, activity.id);
  assert.deepEqual(list?.list.map((r) => [r.ordinal, r.name]), [[1, 'Nao']]);

  // The name is kept with the record, so the register reads the same after a restart.
  const saved = admin.room.exportState();
  const after = bareRoom();
  after.restoreState(saved);
  assert.equal(after.activities.get(activity.id)?.checkinRecords()[0]?.name, 'Nao');
  after.stop();
});

// ---------------------------------------------------------------------------------------------
// Naming an island
// ---------------------------------------------------------------------------------------------

test('a keeper names their island; everyone on it hears; the name outlives sleep and a restart', () => {
  const deps = makeDeps();
  const key = 'namerkeynamerkeynamerkey';
  const island = deps.rooms.createPrivate({ hash: hashVisitorKey(key), name: 'Mio', playerId: 'p-mio' })!;
  const keeper = connect(deps, { room: island.code!, visitor: key });
  const guest = connect(deps, { room: island.code! });

  send(guest.conn, { t: 'room_title', title: 'Mine now' }, deps);
  assert.equal(lastOf(guest.socket, 'error')?.key, 'forbidden', 'a guest cannot');
  const shore = deps.rooms.list().find((r) => r.kind === 'public')!;
  const admin = connect(deps, {}, true);
  send(admin.conn, { t: 'room_title', title: 'Shore' }, deps);
  assert.equal(lastOf(admin.socket, 'error')?.key, 'forbidden', 'nobody renames a public shard');
  assert.equal(shore.toView().title, undefined);

  send(keeper.conn, { t: 'room_title', title: '  Design‮ team ​ break  room, and a very long tail  ' }, deps);
  const heard = lastOf(guest.socket, 'room_info')?.room;
  assert.equal(heard?.id, island.id);
  assert.equal(heard?.title, 'Design team break room,', 'cleaned and cut to 24 characters');
  assert.equal(lastOf(keeper.socket, 'room_info')?.room.title, heard?.title);

  // Asleep, then a restart: the registry has it, and the island wakes with it.
  const saved = JSON.parse(JSON.stringify({ rooms: deps.rooms.exportRooms(), islands: deps.rooms.exportIslands() }));
  const later = new RoomManager({ log, roomCapacity: 40, privateCapacity: 20, initialRoomCount: 1, persist: () => {}, autostart: false, persisted: saved });
  const woken = later.resolve(island.code!);
  assert.ok('room' in woken);
  assert.equal(woken.room.toView().title, 'Design team break room,');

  // An empty name takes it away.
  send(keeper.conn, { t: 'room_title', title: '   ' }, deps);
  assert.equal(lastOf(guest.socket, 'room_info')?.room.title, undefined);
  assert.equal(deps.rooms.exportIslands().find((i) => i.code === island.code)?.title, undefined);
});

// ---------------------------------------------------------------------------------------------
// Keeping someone off an island
// ---------------------------------------------------------------------------------------------

test('kicked off a private island is kept off it for a while — by key, and across a restart', () => {
  const deps = makeDeps();
  const keeperKey = 'bankeeperbankeeperbankeeper';
  const guestKey = 'banguestbanguestbanguest';
  const island = deps.rooms.createPrivate({ hash: hashVisitorKey(keeperKey), name: 'Mio', playerId: 'p-mio' })!;
  const keeper = connect(deps, { room: island.code!, visitor: keeperKey });
  const guest = connect(deps, { room: island.code!, visitor: guestKey });
  const stranger = connect(deps, { room: island.code! });
  assert.equal(guest.conn.room, island);

  send(keeper.conn, { t: 'admin_action', action: 'kick', target: guest.conn.player.id }, deps);
  const told = lastOf(guest.socket, 'error');
  assert.equal(told?.key, 'kicked_banned');
  assert.equal(told?.params?.n, PROTOCOL.ISLAND_BAN_MIN);
  assert.equal(island.getPlayer(guest.conn.player.id), undefined);

  // Following the invite link again lands them on a public shore, told why.
  const back = connect(deps, { room: island.code!, visitor: guestKey });
  assert.equal(back.conn.room.kind, 'public');
  assert.equal(lastOf(back.socket, 'error')?.key, 'island_banned');
  // Nor can they walk over from the shore.
  send(back.conn, { t: 'room_switch', room: island.code! }, deps);
  assert.equal(back.conn.room.kind, 'public');
  assert.equal(lastOf(back.socket, 'error')?.key, 'island_banned');

  // Without a key there is nothing to recognise them by: a kick is all it can be.
  send(keeper.conn, { t: 'admin_action', action: 'kick', target: stranger.conn.player.id }, deps);
  assert.equal(lastOf(stranger.socket, 'error')?.key, undefined);
  assert.equal(connect(deps, { room: island.code! }).conn.room, island);

  // The registry remembers it through a restart, and forgets it when it runs out.
  const saved = JSON.parse(JSON.stringify({ rooms: deps.rooms.exportRooms(), islands: deps.rooms.exportIslands() }));
  const later = new RoomManager({ log, roomCapacity: 40, privateCapacity: 20, initialRoomCount: 1, persist: () => {}, autostart: false, persisted: saved });
  const woken = later.resolve(island.code!);
  assert.ok('room' in woken);
  const hash = hashVisitorKey(guestKey);
  assert.equal(later.isBanned(woken.room, hash), true);
  assert.equal(later.isBanned(woken.room, hash, Date.now() + ISLAND_BAN_MS + 1000), false);
});

test('a kick on a public shore keeps nobody off it', () => {
  const deps = makeDeps();
  const admin = connect(deps, {}, true);
  const guest = connect(deps, { visitor: 'shoreguestshoreguestshore' });
  const shore = guest.conn.room;
  send(admin.conn, { t: 'admin_action', action: 'kick', target: guest.conn.player.id }, deps);
  assert.equal(lastOf(guest.socket, 'error')?.key, undefined);
  assert.equal(connect(deps, { room: shore.id, visitor: 'shoreguestshoreguestshore' }).conn.room, shore);
});

test('a ban takes every tab of the visitor, keeps a banned key from being taken on, and spares keepers and admins', () => {
  const deps = makeDeps();
  const keeperKey = 'tabkeepertabkeepertabkeeper';
  const guestKey = 'tabguesttabguesttabguest';
  const island = deps.rooms.createPrivate({ hash: hashVisitorKey(keeperKey), name: 'Mio', playerId: 'p-mio' })!;
  const keeper = connect(deps, { room: island.code!, visitor: keeperKey });
  const tabA = connect(deps, { room: island.code!, visitor: guestKey });
  const tabB = connect(deps, { room: island.code!, visitor: guestKey });

  send(keeper.conn, { t: 'admin_action', action: 'kick', target: tabA.conn.player.id }, deps);
  assert.equal(island.getPlayer(tabB.conn.player.id), undefined, 'the other tab goes too');
  assert.equal(lastOf(tabB.socket, 'error')?.key, 'kicked_banned');
  const token = issueResumeToken(SECRET, { playerId: tabB.conn.player.id, room: island.id });
  assert.notEqual(connect(deps, { resumeToken: token, room: island.code!, visitor: guestKey }).conn.room, island, 'and cannot resume its way back');

  // Arriving keyless and showing the banned key on a resume does not bring the key in.
  const keyless = connect(deps, { room: island.code! });
  assert.equal(keyless.conn.room, island);
  const resumed = connect(deps, { resumeToken: issueResumeToken(SECRET, { playerId: keyless.conn.player.id, room: island.id }), visitor: guestKey });
  assert.equal(resumed.conn.player.id, keyless.conn.player.id);
  assert.equal(resumed.conn.player.visitorHash, null, 'the banned key is not taken on here');

  // An admin with the server's token is kept off nowhere, even under a key that was kicked.
  const admin = connect(deps, { room: island.code!, visitor: guestKey }, true);
  assert.equal(admin.conn.room, island);

  // Nor is a keeper kept off their own island, whoever kicks them.
  assert.equal(deps.rooms.banFromIsland(island, hashVisitorKey(keeperKey)), false);
  assert.equal(deps.rooms.isBanned(island, hashVisitorKey(keeperKey)), false);
});

test('one visitor is one line on the register, whatever tab or player id they check in from', () => {
  const deps = makeDeps();
  const key = 'registerkeyregisterkeyregister';
  const { conn: first, socket: firstSocket } = connect(deps, { visitor: key });
  const { conn: second, socket: secondSocket } = connect(deps, { visitor: key, room: first.room.id });
  const { conn: admin, socket: adminSocket } = connect(deps, { room: first.room.id }, true);
  const activity = first.room.activities.createFromTemplate('morning-assembly', Date.now() - 1000);
  first.room.activities.sweep(Date.now());
  for (const c of [first, second]) send(c, { t: 'activity_join', activity: activity.id, mode: 'participant' }, deps);

  send(first, { t: 'checkin', activity: activity.id }, deps);
  assert.equal(lastOf(firstSocket, 'checkin_ack')?.ok, true);
  send(second, { t: 'checkin', activity: activity.id }, deps);
  const again = lastOf(secondSocket, 'checkin_ack');
  assert.equal(again?.ok, false);
  assert.equal(again?.reason, 'already', 'the same visitor, in another tab');
  assert.equal(second.player.checkedIn, true, 'and marked as checked in there too');

  send(admin, { t: 'checkin_list', activity: activity.id }, deps);
  assert.equal(lastOf(adminSocket, 'checkin_list')?.list.length, 1, 'one line on the register');
  assert.equal(activity.toView().checkinCount, 1);

  // The key is kept with the record, so a restart does not forget who it was.
  const after = bareRoom();
  after.restoreState(first.room.exportState());
  assert.equal(after.activities.get(activity.id)?.checkinRecords()[0]?.visitor, hashVisitorKey(key));
  after.stop();
});
