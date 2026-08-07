/**
 * Tests for reconnection landing.
 * ===============================
 *
 * The requirement these encode: **a dropped connection must not cost you your place on
 * the island.** Not your identity — the resume token already covered that, for as long as
 * the server is still holding your player — but the actual patch of ground you were
 * standing on when the socket died.
 *
 * There are two failure windows, and `resumeToken` only closes the first:
 *
 * 1. *Inside* the grace window: the player object still exists, `room.resume` reattaches
 *    to it, and position was never lost because the server never stopped holding it.
 * 2. *Outside* it — a long outage, or a server restart — the player object is gone. The
 *    token names someone who no longer exists. Historically this fell through to the
 *    fresh-arrival path and dropped you on the harbour quay, which is the bug: from the
 *    player's side, a bad tunnel teleported them across the island.
 *
 * So the client now also carries `at`, and the tests below pin both the behaviour (you
 * land where you were) and its limit: the claim is re-derived through the walkability
 * contract, so it can only ever name ground the claimant could have walked to. It is
 * deliberately *not* gated on the resume token — see `returningSpawn` for why a gate would
 * be shut in exactly the case the feature exists for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { PROTOCOL, isWalkable, nearestWalkable, type ClientHello, type ServerMessage, type ServerSnapshot } from '@nagisa/shared';
import { handleHello, type HandlerDeps } from './handlers.js';
import { RoomManager } from './rooms.js';
import { AuditLog } from './audit.js';
import { Session } from './session.js';
import { createLogger } from './logger.js';
import { issueResumeToken } from './resume.js';

class FakeSocket {
  readonly OPEN = 1;
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
const SECRET = 'test-secret-for-resume-tokens';

function makeDeps(): HandlerDeps {
  return {
    rooms: new RoomManager(log, 40, 1),
    audit: new AuditLog(log),
    log,
    config: { RESUME_SECRET: SECRET } as HandlerDeps['config'],
    persist: () => {},
  };
}

function makeSession(): { session: Session; socket: FakeSocket } {
  const socket = new FakeSocket();
  const session = new Session(socket as unknown as WebSocket, `conn-${Math.random()}`, log);
  return { session, socket };
}

function hello(extra: Partial<ClientHello> = {}): ClientHello {
  return {
    t: 'hello',
    protocol: PROTOCOL.VERSION,
    name: 'Nao',
    appearance: { outfit: 1, skin: 2, accessory: 0 },
    ...extra,
  };
}

/** Where the connection was actually put, read off the snapshot the server sent it. */
function spawnedAt(socket: FakeSocket, selfId: string): [number, number, number] {
  const snap = socket.sent.find((m) => m.t === 'snapshot') as ServerSnapshot | undefined;
  assert.ok(snap, 'server should send a snapshot');
  const me = snap.players.find((p) => p.id === selfId);
  assert.ok(me, 'snapshot should contain the connecting player');
  return me.pos;
}

/**
 * A position well inland that the walkability contract accepts as-is, so a test asserting
 * "you land exactly where you claimed" is testing the honouring of the claim rather than
 * the snap. Derived rather than hard-coded: map packs move, and a literal here would rot
 * into a test that passes for the wrong reason.
 */
function somewhereWalkable(): [number, number] {
  const [x, z] = nearestWalkable(20, 20);
  assert.ok(isWalkable(x, z), 'fixture position should be walkable');
  return [x, z];
}

/**
 * The whole point, stated as a test: the same person, whose player the server has already
 * forgotten, comes back to the ground they were standing on rather than to the quay.
 */
test('a reconnect past the grace window lands where the player was standing', () => {
  const deps = makeDeps();

  // First visit — wherever the matchmaker puts us.
  const first = makeSession();
  const initial = handleHello(first.session, hello(), { adminGranted: false }, deps);
  assert.ok(initial);
  const quay = spawnedAt(first.socket, initial.player.id);

  // Walk somewhere. Then the server loses us entirely — process restart, or a grace
  // window that expired — modelled by removing the player outright.
  const [wx, wz] = somewhereWalkable();
  assert.ok(Math.hypot(wx - quay[0], wz - quay[2]) > 20, 'fixture should be far from the spawn, or the test proves nothing');
  const token = issueResumeToken(SECRET, { playerId: initial.player.id, room: initial.room.id });
  initial.room.removePlayer(initial.player.id, 'grace_expired');

  const second = makeSession();
  const back = handleHello(
    second.session,
    hello({ resumeToken: token, at: { pos: [wx, 0, wz], yaw: 1.2 } }),
    { adminGranted: false },
    deps,
  );
  assert.ok(back);

  const landed = spawnedAt(second.socket, back.player.id);
  assert.ok(
    Math.hypot(landed[0] - wx, landed[2] - wz) < 0.001,
    `expected to land at (${wx.toFixed(1)}, ${wz.toFixed(1)}), got (${landed[0].toFixed(1)}, ${landed[2].toFixed(1)})`,
  );
  assert.equal(back.player.name, 'Nao', 'the name comes back with us');
  assert.deepEqual(back.player.appearance, { outfit: 1, skin: 2, accessory: 0 });
});

/**
 * A first visit still arrives at the harbour, because a client that has never been here
 * has no pose to offer. That — not a token check — is what separates an arrival from a
 * return: see `returningSpawn` in handlers.ts for why gating on the resume token would
 * have been shut in exactly the case the feature exists for.
 */
test('a connection with no claim still arrives at a spawn point', () => {
  const deps = makeDeps();
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const { session, socket } = makeSession();
    const conn = handleHello(session, hello(), { adminGranted: false }, deps);
    assert.ok(conn);
    const landed = spawnedAt(socket, conn.player.id);
    assert.ok(isWalkable(landed[0], landed[2]), 'a spawn point must be walkable');
    seen.add(`${landed[0].toFixed(2)},${landed[2].toFixed(2)}`);
  }
  // Spawns are drawn from a set of quay positions rather than one fixed point, so a run of
  // arrivals does not stack every visitor on the same paving stone.
  assert.ok(seen.size > 1, 'arrivals should not all land on the same spot');
});

/**
 * A claim is honoured on its geometry, not on who is making it — but the geometry is
 * re-derived, so the claim can only ever name ground the claimant could have walked to.
 */
test('a claim is accepted with or without a token, and always lands on walkable ground', () => {
  const deps = makeDeps();
  const [wx, wz] = somewhereWalkable();

  for (const resumeToken of [undefined, 'not-a-real-token', 'a.b.c']) {
    const { session, socket } = makeSession();
    const conn = handleHello(session, hello({ resumeToken, at: { pos: [wx, 0, wz], yaw: 0 } }), { adminGranted: false }, deps);
    assert.ok(conn);
    const landed = spawnedAt(socket, conn.player.id);
    assert.ok(Math.hypot(landed[0] - wx, landed[2] - wz) < 0.001, `token ${String(resumeToken)} should land at the claim`);
    assert.ok(isWalkable(landed[0], landed[2]));
  }
});

/**
 * Even with a valid token, the claim is re-derived through the walkability contract. A
 * position that is not near ground a player could stand on did not come from a player
 * standing there, so it is refused rather than snapped to whatever happens to be nearest
 * — the fallback should read as an arrival, not as being deposited somewhere arbitrary.
 */
test('an unbelievable position falls back to a spawn point', () => {
  const deps = makeDeps();
  const claims: Array<ClientHello['at']> = [
    { pos: [1e9, 0, 1e9], yaw: 0 }, // far outside the map
    { pos: [Number.NaN, 0, 0], yaw: 0 }, // not a number
    { pos: [0, 0, Number.POSITIVE_INFINITY], yaw: 0 },
    { pos: [0, 0] as unknown as [number, number, number], yaw: 0 }, // wrong shape
    undefined,
  ];

  for (const at of claims) {
    const { session, socket } = makeSession();
    const conn = handleHello(session, hello({ at }), { adminGranted: false }, deps);
    assert.ok(conn);
    const landed = spawnedAt(socket, conn.player.id);
    assert.ok(Number.isFinite(landed[0]) && Number.isFinite(landed[1]) && Number.isFinite(landed[2]));
    assert.ok(isWalkable(landed[0], landed[2]), `claim ${JSON.stringify(at)} should have produced a walkable spawn`);
  }
});

/**
 * A yaw is cosmetic but still untrusted; a NaN one would propagate into the packed
 * transform and arrive at every other client as a character facing nowhere.
 */
test('a non-finite yaw is replaced rather than propagated', () => {
  const deps = makeDeps();
  const [wx, wz] = somewhereWalkable();
  const { session } = makeSession();
  const conn = handleHello(session, hello({ at: { pos: [wx, 0, wz], yaw: Number.NaN } }), { adminGranted: false }, deps);
  assert.ok(conn);
  assert.ok(Number.isFinite(conn.player.yaw), 'yaw should be finite');
});

/**
 * The short outage must keep working exactly as before: inside the grace window the
 * player object is still there, and reattaching to it — same id, same role, same activity
 * — beats minting a new player at a claimed position.
 */
test('an in-grace resume still reattaches to the same player', () => {
  const deps = makeDeps();
  const first = makeSession();
  const initial = handleHello(first.session, hello(), { adminGranted: false }, deps);
  assert.ok(initial);
  const token = issueResumeToken(SECRET, { playerId: initial.player.id, room: initial.room.id });

  // Drop the socket without letting the grace window lapse.
  initial.room.disconnect(initial.player.id);

  const [wx, wz] = somewhereWalkable();
  const second = makeSession();
  const back = handleHello(
    second.session,
    hello({ resumeToken: token, at: { pos: [wx, 0, wz], yaw: 0 } }),
    { adminGranted: false },
    deps,
  );
  assert.ok(back);
  assert.equal(back.player.id, initial.player.id, 'same player, not a new one');
  const welcome = second.socket.sent.find((m) => m.t === 'welcome');
  assert.ok(welcome && welcome.t === 'welcome' && welcome.resumed, 'welcome should be marked as a resume');
});
