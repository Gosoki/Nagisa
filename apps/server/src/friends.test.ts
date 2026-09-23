/**
 * Tests for friends: asking, accepting, presence across islands, and ending it.
 *
 * Driven through `handleHello` and the `HANDLERS` table like a socket would, with the
 * friends list read off the `friends` frames each side is sent — what a player would see.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { PROTOCOL, type ClientHello, type ClientMessage, type ServerFriends, type ServerMessage } from '@nagisa/shared';
import { HANDLERS, handleHello, type ConnState, type HandlerDeps } from './handlers.js';
import { RoomManager } from './rooms.js';
import { AuditLog } from './audit.js';
import { Session } from './session.js';
import { createLogger } from './logger.js';
import { ProfileStore } from './games/profiles.js';
import { FRIEND_REQUEST_COOLDOWN_MS, friendId } from './friends.js';

class FakeSocket {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.readyState = 3;
  }
}

const log = createLogger({ level: 'error' });

function makeDeps(): HandlerDeps {
  const profiles = new ProfileStore();
  return {
    rooms: new RoomManager({ log, roomCapacity: 40, privateCapacity: 20, initialRoomCount: 2, persist: () => {}, autostart: false, profiles }),
    audit: new AuditLog(log),
    log,
    config: { RESUME_SECRET: 'secret' } as HandlerDeps['config'],
    profiles,
    persist: () => {},
  };
}

interface Visitor {
  conn: ConnState;
  socket: FakeSocket;
}

function arrive(deps: HandlerDeps, name: string, visitor?: string): Visitor {
  const socket = new FakeSocket();
  const session = new Session(socket as unknown as WebSocket, `c-${name}`, log);
  const hello: ClientHello = { t: 'hello', protocol: PROTOCOL.VERSION, name, appearance: { outfit: 0, skin: 0, accessory: 0 }, visitor, room: 'shore-1' };
  const conn = handleHello(session, hello, { adminGranted: false }, deps);
  assert.ok(conn);
  return { conn, socket };
}

function send(v: Visitor, msg: Exclude<ClientMessage, { t: 'hello' }>, deps: HandlerDeps): void {
  (HANDLERS[msg.t] as (c: ConnState, m: typeof msg, d: HandlerDeps) => void)(v.conn, msg, deps);
}

/** The friends list as this visitor last saw it. */
function list(v: Visitor): ServerFriends {
  const all = v.socket.sent.filter((m): m is ServerFriends => m.t === 'friends');
  assert.ok(all.length, 'a friends list was sent');
  return all[all.length - 1];
}

const lastError = (v: Visitor) => v.socket.sent.filter((m) => m.t === 'error').at(-1) as Extract<ServerMessage, { t: 'error' }> | undefined;

/** Let the gathered re-sends go out. */
const settle = () => new Promise<void>((r) => queueMicrotask(r));

const KEY_A = 'friend-test-key-aaaaaaaaaa';
const KEY_B = 'friend-test-key-bbbbbbbbbb';

test('asking, accepting, and seeing each other across islands', async () => {
  const deps = makeDeps();
  const aki = arrive(deps, 'Aki', KEY_A);
  const ben = arrive(deps, 'Ben', KEY_B);
  await settle();
  assert.equal(list(aki).enabled, true);
  assert.deepEqual(list(aki).friends, []);

  send(aki, { t: 'friend', action: 'request', target: ben.conn.player.id }, deps);
  await settle();
  const asked = list(ben).requests;
  assert.equal(asked.length, 1);
  assert.equal(asked[0].name, 'Aki');
  assert.equal(asked[0].player, aki.conn.player.id);

  send(ben, { t: 'friend', action: 'accept', target: asked[0].id }, deps);
  await settle();
  const benSees = list(ben).friends;
  const akiSees = list(aki).friends;
  assert.deepEqual([benSees.length, akiSees.length], [1, 1]);
  assert.equal(benSees[0].name, 'Aki');
  assert.equal(benSees[0].online, true);
  assert.equal(benSees[0].player, aki.conn.player.id);
  assert.equal(benSees[0].room?.id, 'shore-1');
  assert.deepEqual(list(ben).requests, [], 'the ask is answered');

  // Aki goes to the other shard: Ben sees them move, never leave.
  const sentBefore = ben.socket.sent.length;
  send(aki, { t: 'room_switch', room: 'shore-2' }, deps);
  await settle();
  const updates = ben.socket.sent.slice(sentBefore).filter((m): m is ServerFriends => m.t === 'friends');
  assert.ok(updates.length >= 1);
  assert.ok(updates.every((u) => u.friends[0].online), 'moving island is not going offline');
  assert.equal(list(ben).friends[0].room?.id, 'shore-2');

  // Aki's session ends for good: offline, name kept.
  deps.rooms.get('shore-2')!.removePlayer(aki.conn.player.id, 'grace_expired');
  await settle();
  assert.deepEqual(list(ben).friends[0], { id: friendId(aki.conn.player.visitorHash!), name: 'Aki', online: false });

  // Ending it ends it for both, including the one who is not here.
  send(ben, { t: 'friend', action: 'remove', target: list(ben).friends[0].id }, deps);
  await settle();
  assert.deepEqual(list(ben).friends, []);
  assert.deepEqual(deps.profiles.peek(aki.conn.player.visitorHash!)?.friends, []);
});

test('asking back is accepting; asks are paced; no key, no friends', async () => {
  const deps = makeDeps();
  const aki = arrive(deps, 'Aki', KEY_A);
  const ben = arrive(deps, 'Ben', KEY_B);
  const cat = arrive(deps, 'Cat');
  await settle();

  send(aki, { t: 'friend', action: 'request', target: ben.conn.player.id }, deps);
  send(aki, { t: 'friend', action: 'request', target: ben.conn.player.id }, deps);
  assert.equal(lastError(aki)?.key, 'cooldown', 'one ask at a time');
  send(ben, { t: 'friend', action: 'request', target: aki.conn.player.id }, deps);
  await settle();
  assert.equal(list(aki).friends.length, 1, 'asking someone who asked you is saying yes');
  assert.equal(list(ben).friends.length, 1);

  // Already friends.
  const later = Date.now() + FRIEND_REQUEST_COOLDOWN_MS;
  deps.rooms.friends.handle(aki.conn.player, 'request', ben.conn.player.id, later);
  assert.equal(lastError(aki)?.key, 'already_friends');

  // A visitor with no key can be neither.
  await settle();
  assert.equal(list(cat).enabled, false);
  send(cat, { t: 'friend', action: 'request', target: aki.conn.player.id }, deps);
  assert.equal(lastError(cat)?.key, 'friend_needs_key');
  deps.rooms.friends.handle(aki.conn.player, 'request', cat.conn.player.id, later + FRIEND_REQUEST_COOLDOWN_MS);
  assert.equal(lastError(aki)?.key, 'friend_unavailable');

  // Declining forgets the ask.
  const dan = arrive(deps, 'Dan', 'friend-test-key-dddddddddd');
  deps.rooms.friends.handle(dan.conn.player, 'request', aki.conn.player.id, later);
  await settle();
  const ask = list(aki).requests[0];
  assert.equal(ask?.name, 'Dan');
  send(aki, { t: 'friend', action: 'decline', target: ask.id }, deps);
  await settle();
  assert.deepEqual(list(aki).requests, []);
  assert.equal(list(aki).friends.length, 1, 'and makes nobody a friend');
});

test('friends are kept with the profile across a restart', async () => {
  const deps = makeDeps();
  const aki = arrive(deps, 'Aki', KEY_A);
  const ben = arrive(deps, 'Ben', KEY_B);
  send(aki, { t: 'friend', action: 'request', target: ben.conn.player.id }, deps);
  await settle();
  send(ben, { t: 'friend', action: 'accept', target: list(ben).requests[0].id }, deps);
  await settle();

  const reloaded = new ProfileStore(JSON.parse(JSON.stringify(deps.profiles.export())));
  const rec = reloaded.peek(aki.conn.player.visitorHash!);
  assert.equal(rec?.friends.length, 1);
  assert.equal(rec?.friends[0].name, 'Ben');
});
