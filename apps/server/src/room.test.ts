/**
 * Tests for `room.ts`: the packed-transform roster's stability, and delta-history
 * replay-on-reconnect. These are the two pieces of `Room` with subtle, easy-to-break
 * invariants — everything else (announcements, zone population) is comparatively
 * mechanical bookkeeping exercised indirectly through `handlers.ts` in practice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { unpackTransforms, type ServerMessage } from '@nagisa/shared';
import { Room } from './room.js';
import { Player } from './player.js';
import { Session } from './session.js';
import { createLogger } from './logger.js';

/** Minimal stand-in for a `ws` WebSocket, capturing every frame sent to it. */
class FakeSocket {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: ServerMessage[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.readyState = this.CLOSED;
  }
}

const log = createLogger({ level: 'error' });

function makeSession(): { session: Session; socket: FakeSocket } {
  const socket = new FakeSocket();
  const session = new Session(socket as unknown as WebSocket, `conn-${Math.random()}`, log);
  return { session, socket };
}

function makePlayer(id: string, name: string): Player {
  return new Player(id, name, { outfit: 0, skin: 0, accessory: 0 }, 0, { pos: [0, 8, 0], yaw: 0 });
}

function lastDeltaOf(socket: FakeSocket) {
  const deltas = socket.sent.filter((m) => m.t === 'delta');
  return deltas[deltas.length - 1] as Extract<ServerMessage, { t: 'delta' }> | undefined;
}

test('room population and capacity', () => {
  const room = new Room('r1', 'Test Room', 2, log);
  assert.equal(room.hasCapacity, true);
  const a = makeSession();
  room.join(a.session, makePlayer('a', 'Alice'));
  assert.equal(room.population, 1);
  assert.equal(room.hasCapacity, true);
  const b = makeSession();
  room.join(b.session, makePlayer('b', 'Bob'));
  assert.equal(room.population, 2);
  assert.equal(room.hasCapacity, false, 'room at declared capacity must report no headroom');
});

test('packed transform roster: ids are sent on join, omitted on a quiet tick, and indices stay stable', () => {
  const room = new Room('r1', 'Test Room', 10, log);
  const a = makeSession();
  const playerA = makePlayer('a', 'Alice');
  room.join(a.session, playerA);

  room.forceTick();
  const firstDelta = lastDeltaOf(a.socket);
  assert.ok(firstDelta, 'expected a delta after the first tick');
  assert.ok(firstDelta!.join, 'first tick must report the join');
  // A join already carries the full PlayerView (including position), so there is
  // nothing new to report via packed transforms on the very tick someone joins unless
  // they also moved — the roster itself, though, must already be present.
  assert.ok(firstDelta!.moves?.ids, 'roster ids must be sent on the tick membership changed');
  const rosterAfterJoin = firstDelta!.moves!.ids!;
  assert.deepEqual(rosterAfterJoin, ['a']);

  // A second player joins; A moves. The roster changed (join), so ids must be resent,
  // and A's index in the new roster must correctly resolve back to player 'a'.
  const b = makeSession();
  const playerB = makePlayer('b', 'Bob');
  room.join(b.session, playerB);
  playerA.pos = [1, 8, 0];
  playerA.yaw = 0.5;
  playerA.dirty = true;
  room.forceTick();

  const secondDelta = lastDeltaOf(a.socket);
  assert.ok(secondDelta!.moves?.ids, 'roster ids must be resent — membership changed again');
  const roster2 = secondDelta!.moves!.ids!;
  const unpacked2 = unpackTransforms(secondDelta!.moves!, roster2);
  const aMove = unpacked2.find((m) => m.id === 'a');
  assert.ok(aMove, "player a's movement must be present in the delta");
  assert.deepEqual(aMove!.pos, [1, 8, 0]);

  // Third tick: nobody joins or leaves, B moves. Roster must NOT be resent — the
  // client is expected to reuse the roster it already has — and B's index must still
  // resolve correctly against that unchanged roster.
  playerB.pos = [2, 8, 3];
  playerB.dirty = true;
  room.forceTick();
  const thirdDelta = lastDeltaOf(a.socket);
  assert.equal(thirdDelta!.moves?.ids, undefined, 'roster must be omitted on a tick with no membership change');
  assert.equal(thirdDelta!.join, undefined);
  assert.equal(thirdDelta!.leave, undefined);
  const unpacked3 = unpackTransforms(thirdDelta!.moves!, roster2); // client reuses roster2, per protocol contract
  const bMove = unpacked3.find((m) => m.id === 'b');
  assert.ok(bMove, "player b's movement must resolve against the previously-held roster");
  assert.deepEqual(bMove!.pos, [2, 8, 3]);

  // A quiet tick (nobody moved, nobody joined/left) must not even carry a `moves` frame.
  room.forceTick();
  const quietDelta = lastDeltaOf(a.socket);
  assert.equal(quietDelta!.moves, undefined);
  assert.equal(quietDelta!.join, undefined);

  // A leaves: membership changes again, forcing a fresh roster on the next tick.
  room.removePlayer('a', 'test_leave');
  room.forceTick();
  const leaveDelta = lastDeltaOf(b.socket);
  assert.deepEqual(leaveDelta!.leave, ['a']);
  assert.ok(leaveDelta!.moves?.ids, 'roster must be resent after a leave');
  assert.deepEqual(leaveDelta!.moves!.ids, ['b'], "b's should be the only id left in the roster");
});

test('quiet (movement-only) deltas are marked droppable; structural deltas are not', () => {
  const room = new Room('r1', 'Test Room', 10, log);
  const a = makeSession();
  room.join(a.session, makePlayer('a', 'Alice'));
  room.forceTick(); // Consume the join itself (a structural, non-droppable delta) first.

  // Saturate the fake socket's reported bufferedAmount so backpressure kicks in.
  a.socket.bufferedAmount = 10 * 1024 * 1024;
  const before = a.socket.sent.length;
  room.forceTick(); // Nothing moved/joined/left since the last tick: this delta is quiet.
  const deltasAfter = a.socket.sent.slice(before).filter((m) => m.t === 'delta');
  assert.equal(deltasAfter.length, 0, 'quiet deltas must be dropped once the socket is backed up');

  // Now force a structural change (an announcement) under the same backpressure: it
  // must still be delivered, because it carries a one-shot fact with no repairing
  // successor frame.
  room.announce({ text: 'hello island', fromName: 'Admin', scope: { kind: 'island' }, ttlMs: 30_000, priority: 'normal' });
  const beforeAnnounce = a.socket.sent.length;
  room.forceTick();
  const deltasAfterAnnounce = a.socket.sent.slice(beforeAnnounce).filter((m) => m.t === 'delta');
  assert.equal(deltasAfterAnnounce.length, 1, 'a delta carrying an announcement must be delivered despite backpressure');
});

test('delta history replay: getDeltasSince returns exactly the ticks after haveTick', () => {
  const room = new Room('r1', 'Test Room', 10, log);
  const a = makeSession();
  room.join(a.session, makePlayer('a', 'Alice'));

  for (let i = 0; i < 5; i++) room.forceTick();
  // We've now ticked 5 times: ticks 1..5 exist in history.
  const replay = room.getDeltasSince(2);
  assert.ok(replay, 'expected a replayable delta list within retained history');
  assert.deepEqual(
    replay!.map((d) => d.tick),
    [3, 4, 5],
  );

  // Asking for a tick we're already past (>= current tick) yields nothing to replay.
  const nothing = room.getDeltasSince(5);
  assert.deepEqual(nothing, []);

  // Asking for a tick from before retained history returns null, telling the caller to
  // fall back to a full snapshot instead.
  const tooOld = room.getDeltasSince(-1000);
  assert.equal(tooOld, null);
});

test('buildSnapshot reflects current players, and is safe to call repeatedly (idempotent)', () => {
  const room = new Room('r1', 'Test Room', 10, log);
  const a = makeSession();
  room.join(a.session, makePlayer('a', 'Alice'));
  const snap1 = room.buildSnapshot();
  const snap2 = room.buildSnapshot();
  assert.equal(snap1.players.length, 1);
  assert.equal(snap2.players.length, 1);
  assert.equal(snap1.players[0].id, 'a');
});
