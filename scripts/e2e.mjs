#!/usr/bin/env node
/**
 * End-to-end smoke test.
 * ======================
 *
 * Boots the real server, connects several real WebSocket clients, and drives the flows
 * that matter through the actual protocol. This is the test that would have caught every
 * integration bug the unit tests cannot see: a client that never receives another's
 * movement, an activity that accepts a check-in before it is live, a resume token that
 * does not resume.
 *
 * Run with:  node scripts/e2e.mjs
 * Requires:  npm run build   (server dist + shared dist; client dist is optional)
 *
 * Exits non-zero on the first failure, with the observed frames printed.
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8899);
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.log(`  ✘ ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

/**
 * A test client: opens a socket, records every inbound frame, and exposes small helpers
 * for waiting on a particular message type.
 */
class Client {
  constructor(name) {
    this.name = name;
    this.frames = [];
    this.socket = new WebSocket(WS);
    this.ready = new Promise((res, rej) => {
      this.socket.once('open', res);
      this.socket.once('error', rej);
    });
    this.socket.on('message', (raw) => {
      try {
        this.frames.push(JSON.parse(raw.toString()));
      } catch {
        /* ignore non-JSON */
      }
    });
  }

  send(msg) {
    this.socket.send(JSON.stringify(msg));
  }

  /** All frames of a type received so far. */
  all(type) {
    return this.frames.filter((f) => f.t === type);
  }

  last(type) {
    const list = this.all(type);
    return list[list.length - 1];
  }

  /** Wait until a frame matching `predicate` arrives, or time out. */
  async wait(type, predicate = () => true, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frames.find((f) => f.t === type && predicate(f));
      if (hit) return hit;
      await sleep(30);
    }
    return null;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

const hello = (name) => ({
  t: 'hello',
  protocol: 1,
  name,
  appearance: { outfit: 1, skin: 2, accessory: 0 },
});

// ---------------------------------------------------------------------------

let server;

async function boot() {
  server = spawn('node', ['apps/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      ROOM_COUNT: '1',
      ADMIN_TOKEN: 'e2e-admin',
      SESSION_SECRET: 'e2e-secret',
      STATIC_DIR: resolve(root, 'apps/client/dist'),
      // No PERSIST_PATH: this run must not touch a real state file.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[srv] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`[srv:err] ${d}`));

  // Wait for readiness rather than sleeping a fixed amount.
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}

async function main() {
  console.log(`\nNagisa end-to-end — port ${PORT}\n`);
  await boot();

  // -- HTTP surface -------------------------------------------------------
  console.log('HTTP');
  const health = await fetch(`${BASE}/healthz`);
  check('GET /healthz is 200', health.status === 200);

  const ready = await fetch(`${BASE}/readyz`);
  check('GET /readyz is 200', ready.status === 200);

  const metrics = await fetch(`${BASE}/metrics`);
  const metricsText = await metrics.text();
  check('GET /metrics returns Prometheus text', metrics.ok && metricsText.includes('#'));

  const roomsRes = await fetch(`${BASE}/api/rooms`);
  const roomsJson = await roomsRes.json();
  check('GET /api/rooms lists a room', Array.isArray(roomsJson.rooms) && roomsJson.rooms.length > 0, roomsJson);

  const index = await fetch(`${BASE}/`);
  check('static client is served at /', index.ok && (await index.text()).includes('<div id="app">'));

  // -- Handshake ----------------------------------------------------------
  console.log('\nHandshake');
  const alice = new Client('Alice');
  const bob = new Client('Bob');
  await Promise.all([alice.ready, bob.ready]);

  alice.send(hello('Alice'));
  bob.send(hello('Bob'));

  const aliceWelcome = await alice.wait('welcome');
  const bobWelcome = await bob.wait('welcome');
  check('Alice receives welcome', !!aliceWelcome, aliceWelcome);
  check('Bob receives welcome', !!bobWelcome, bobWelcome);
  check('welcome carries a resume token', !!aliceWelcome?.resumeToken);
  check('players get distinct ids', aliceWelcome?.self !== bobWelcome?.self);

  const aliceSnap = await alice.wait('snapshot');
  check('snapshot follows welcome', !!aliceSnap);
  check('snapshot has activities seeded', (aliceSnap?.activities?.length ?? 0) > 0, aliceSnap?.activities?.length);
  check('snapshot has zonePopulation', !!aliceSnap?.zonePopulation);

  // Bob should learn about Alice.
  const bobSeesAlice = await bob.wait(
    'snapshot',
    (f) => f.players?.some((p) => p.name === 'Alice'),
    3000,
  ) ?? await bob.wait('delta', (f) => f.join?.some((p) => p.name === 'Alice'), 3000);
  check('Bob learns about Alice (snapshot or join delta)', !!bobSeesAlice);

  // -- Movement sync ------------------------------------------------------
  console.log('\nMovement');
  const selfView = aliceSnap?.players?.find((p) => p.id === aliceWelcome.self);
  check('snapshot contains the connecting player', !!selfView, {
    self: aliceWelcome.self,
    ids: aliceSnap?.players?.map((p) => p.id),
  });

  // Start from the server's authoritative spawn — a client that invents its own start
  // position is exactly the bug this check exists to catch.
  const spawnPos = selfView?.pos ?? [-92, 2.2, 96];

  // One tick of walking. 0.25 m per 100 ms report is 2.5 m/s, comfortably inside the
  // server's ~7 m/s budget with room for the timing jitter of a first report.
  const moved = [spawnPos[0] + 0.25, spawnPos[1], spawnPos[2] + 0.25];
  alice.send({ t: 'move', pos: moved, yaw: 1.0, anim: 1, seq: 1 });

  const bobDelta = await bob.wait('delta', (f) => Array.isArray(f.moves?.data) && f.moves.data.length > 0, 3000);
  check('Bob receives a packed movement delta', !!bobDelta, bobDelta?.moves);
  check(
    'packed frame is 6 integers per player',
    !!bobDelta && bobDelta.moves.data.length % 6 === 0,
    bobDelta?.moves?.data,
  );
  check('Alice gets no correction for a legal move', alice.all('correction').length === 0, {
    spawnPos,
    moved,
    corrections: alice.all('correction'),
  });

  // Jitter regression: two reports sent 100 ms apart can arrive back-to-back after a
  // radio stall drains. The server judges the gap between *arrivals*, so without slack a
  // legitimately running player would be corrected here. Three running-speed steps in
  // immediate succession must all be accepted.
  const correctionsBeforeBurst = alice.all('correction').length;
  let bx = moved[0];
  let bz = moved[2];
  for (let i = 0; i < 3; i++) {
    bx += 0.62; // one report's worth of running at 6.2 m/s
    bz += 0.2;
    alice.send({ t: 'move', pos: [bx, spawnPos[1], bz], yaw: 1.0, anim: 2, seq: 10 + i });
  }
  await sleep(600);
  check(
    'burst of running-speed reports is not corrected (jitter tolerance)',
    alice.all('correction').length === correctionsBeforeBurst,
    alice.all('correction').slice(correctionsBeforeBurst),
  );

  // Illegal teleport across the island must be corrected.
  // `seq` must exceed the burst above: the server drops out-of-order sequence numbers,
  // so a stale seq here would be silently ignored rather than validated.
  alice.send({ t: 'move', pos: [140, 20, -140], yaw: 0, anim: 1, seq: 20 });
  const correction = await alice.wait('correction', () => true, 3000);
  check('illegal teleport produces a correction', !!correction, correction);

  // -- Activities ---------------------------------------------------------
  console.log('\nActivities');
  const activity = aliceSnap.activities[0];

  // A freshly seeded activity is `scheduled`, and joining one is legitimately refused —
  // the doors are not open yet. Assert that first, because it is the guard that stops a
  // crowd assembling for something that has not been announced.
  alice.send({ t: 'activity_join', activity: activity.id, mode: 'participant' });
  const earlyJoinRefused = await alice.wait(
    'error',
    (f) => f.code === 'invalid_transition' || f.code === 'forbidden',
    3000,
  );
  check(
    'joining a scheduled activity is refused',
    activity.state !== 'scheduled' || !!earlyJoinRefused,
    { state: activity.state, error: earlyJoinRefused },
  );

  // Check-in before the activity is live must also be refused.
  alice.send({ t: 'checkin', activity: activity.id });
  const earlyAck = await alice.wait('checkin_ack', () => true, 3000);
  check('check-in refused before the activity is live', earlyAck?.ok === false, earlyAck);

  // A guest may not announce island-wide.
  alice.send({ t: 'host_announce', text: 'hello island', scope: { kind: 'island' } });
  const forbidden = await alice.wait('error', (f) => f.code === 'forbidden', 3000);
  check('guest cannot announce island-wide', !!forbidden, forbidden);

  // An illegal lifecycle transition must be refused.
  alice.send({ t: 'host_activity_state', activity: activity.id, state: 'ended' });
  const badTransition = await alice.wait(
    'error',
    (f) => f.code === 'forbidden' || f.code === 'invalid_transition',
    3000,
  );
  check('non-host cannot drive activity lifecycle', !!badTransition, badTransition);

  // -- Admin --------------------------------------------------------------
  console.log('\nAdmin');
  const admin = new Client('Keeper');
  await admin.ready;
  admin.socket.close();
  const adminSocket = new WebSocket(`${WS}?admin=e2e-admin`);
  await new Promise((res, rej) => {
    adminSocket.once('open', res);
    adminSocket.once('error', rej);
  });
  const adminFrames = [];
  adminSocket.on('message', (raw) => adminFrames.push(JSON.parse(raw.toString())));
  adminSocket.send(JSON.stringify(hello('Keeper')));
  await sleep(600);
  const adminWelcome = adminFrames.find((f) => f.t === 'welcome');
  check('admin token connects', !!adminWelcome, adminWelcome);

  adminSocket.send(
    JSON.stringify({ t: 'host_announce', text: 'The lamp is lit.', scope: { kind: 'island' } }),
  );
  const announced = await bob.wait(
    'delta',
    (f) => f.announcements?.some((a) => a.text === 'The lamp is lit.'),
    4000,
  );
  check('admin island announcement reaches other players', !!announced, announced?.announcements);

  // -- Full activity lifecycle, driven by the admin ------------------------
  console.log('\nActivity lifecycle');
  const waitDelta = (client, predicate, ms = 4000) => client.wait('delta', predicate, ms);

  adminSocket.send(JSON.stringify({ t: 'host_activity_state', activity: activity.id, state: 'open' }));
  const opened = await waitDelta(alice, (f) =>
    f.activities?.some((a) => a.id === activity.id && a.state === 'open'),
  );
  check('admin can open a scheduled activity', !!opened, opened?.activities);

  alice.send({ t: 'activity_join', activity: activity.id, mode: 'participant' });
  const joined = await waitDelta(alice, (f) =>
    f.players?.some((p) => p.id === aliceWelcome.self && p.activity === activity.id),
  );
  check('joining an open activity attaches the player', !!joined, joined?.players);

  const counted = await waitDelta(alice, (f) =>
    f.activities?.some((a) => a.id === activity.id && a.participantCount >= 1),
  );
  check('participant count is maintained server-side', !!counted, counted?.activities);

  adminSocket.send(JSON.stringify({ t: 'host_activity_state', activity: activity.id, state: 'live' }));
  const live = await waitDelta(alice, (f) =>
    f.activities?.some((a) => a.id === activity.id && a.state === 'live'),
  );
  check('admin can start the activity', !!live, live?.activities);

  const acksBefore = alice.all('checkin_ack').length;
  alice.send({ t: 'checkin', activity: activity.id });
  await sleep(500);
  const liveAck = alice.all('checkin_ack')[acksBefore];
  check('check-in accepted while live', liveAck?.ok === true, liveAck);
  check('check-in returns an arrival ordinal', liveAck?.ordinal === 1, liveAck);

  alice.send({ t: 'checkin', activity: activity.id });
  await sleep(500);
  const secondAck = alice.all('checkin_ack')[acksBefore + 1];
  check('a second check-in is refused', secondAck?.ok === false, secondAck);

  adminSocket.send(JSON.stringify({ t: 'host_activity_state', activity: activity.id, state: 'ended' }));
  const ended = await waitDelta(alice, (f) =>
    f.activities?.some((a) => a.id === activity.id && a.state === 'ended'),
  );
  check('admin can end the activity', !!ended, ended?.activities);

  // `ended` is terminal — nothing may revive it.
  adminSocket.send(JSON.stringify({ t: 'host_activity_state', activity: activity.id, state: 'live' }));
  await sleep(500);
  const revived = alice
    .all('delta')
    .some((f) => f.activities?.some((a) => a.id === activity.id && a.state === 'live' && f.tick > ended.tick));
  check('an ended activity cannot be restarted', !revived);

  // -- Emotes -------------------------------------------------------------
  console.log('\nEmotes');
  bob.send({ t: 'emote', emote: 'wave' });
  const emoteDelta = await alice.wait('delta', (f) => f.emotes?.some((e) => e.emote === 'wave'), 3000);
  check('emote is broadcast to others', !!emoteDelta, emoteDelta?.emotes);

  // -- Reconnect and resume ----------------------------------------------
  console.log('\nReconnect');
  const resumeToken = bobWelcome.resumeToken;
  bob.close();
  await sleep(700);

  const bobAgain = new Client('Bob');
  await bobAgain.ready;
  bobAgain.send({ ...hello('Bob'), resumeToken });
  const resumedWelcome = await bobAgain.wait('welcome', () => true, 4000);
  check('reconnect with a resume token succeeds', !!resumedWelcome, resumedWelcome);
  check('session is resumed, not recreated', resumedWelcome?.resumed === true, {
    resumed: resumedWelcome?.resumed,
  });
  check('resumed player keeps the same id', resumedWelcome?.self === bobWelcome.self, {
    before: bobWelcome.self,
    after: resumedWelcome?.self,
  });

  // -- Resync -------------------------------------------------------------
  //
  // There are two legitimate answers to a resync, and which one you get depends on
  // whether the requested tick is still inside the room's delta history:
  //   * inside  → the missed deltas are replayed (cheaper, and preserves ordering);
  //   * outside → a fresh snapshot (the only safe option once history has rolled off).
  // Both are correct; asserting only one of them would be asserting an implementation
  // detail rather than the contract.
  console.log('\nResync');

  const snapsBefore = alice.all('snapshot').length;
  const deltasBefore = alice.all('delta').length;
  const currentTick = alice.last('delta')?.tick ?? 0;

  // A tick well inside history: expect replayed deltas.
  alice.send({ t: 'resync', haveTick: Math.max(0, currentTick - 3) });
  await sleep(600);
  check(
    'resync from a recent tick replays deltas',
    alice.all('delta').length > deltasBefore,
    { before: deltasBefore, after: alice.all('delta').length },
  );

  // A tick far outside history: expect a fresh snapshot instead.
  const snapsBeforeFar = alice.all('snapshot').length;
  alice.send({ t: 'resync', haveTick: currentTick - 100_000 });
  await sleep(600);
  check(
    'resync from beyond history produces a fresh snapshot',
    alice.all('snapshot').length > snapsBeforeFar,
    { before: snapsBeforeFar, after: alice.all('snapshot').length, snapsAtStart: snapsBefore },
  );

  // -- Protocol version ---------------------------------------------------
  console.log('\nVersioning');
  const oldClient = new Client('Ancient');
  await oldClient.ready;
  oldClient.send({ ...hello('Ancient'), protocol: 999 });
  const mismatch = await oldClient.wait('error', (f) => f.code === 'version_mismatch', 3000);
  check('wrong protocol version is rejected', !!mismatch, mismatch);
  oldClient.close();

  // -- Teardown -----------------------------------------------------------
  alice.close();
  bobAgain.close();
  adminSocket.close();
  await sleep(200);

  console.log(`\n${checks - failures}/${checks} checks passed\n`);
  return failures === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error('\ne2e failed with an exception:', err);
  exitCode = 1;
} finally {
  server?.kill('SIGTERM');
  await sleep(500);
  server?.kill('SIGKILL');
}
process.exit(exitCode);
