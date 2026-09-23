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
 * Requires:  npm run build   (server and shared dist; the client dist for the static-file check)
 *
 * Exits non-zero on the first failure, with the observed frames printed.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The same world the server simulates, so the test can stand players exactly at a fishing
// spot or a stamp stand (via `hello.at`) instead of walking them there.
const shared = createRequire(import.meta.url)(resolve(root, 'packages/shared/dist/index.js'));
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

const hello = (name, extra = {}) => ({
  t: 'hello',
  protocol: 2,
  name,
  appearance: { outfit: 1, skin: 2, accessory: 0 },
  ...extra,
});

/** A valid visitor key, unique per test player. */
const visitorFor = (name) => `e2e-visitor-${name.toLowerCase().padEnd(8, 'x')}`.slice(0, 40);

/** Where an interactable is, as a `hello.at` claim. */
function atInteractable(id) {
  const it = shared.getInteractable(id);
  const p = shared.interactablePosition(it);
  return { pos: [p.x, p.y, p.z], yaw: 0 };
}

/** Open a client, say hello, wait for the welcome and snapshot. */
async function arrive(name, extra = {}) {
  const c = new Client(name);
  await c.ready;
  c.send(hello(name, extra));
  c.welcome = await c.wait('welcome', () => true, 4000);
  c.snapshot = await c.wait('snapshot', () => true, 4000);
  return c;
}

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
  // The island runs its own programme, so the board is never empty — but which of its
  // activities are scheduled, open or live depends on the island's hour. The early checks
  // hold for any of them; the full lifecycle below uses one the admin puts on, so its
  // starting state is known.
  const activity = aliceSnap.activities.find((a) => a.state === 'scheduled') ?? aliceSnap.activities[0];
  check('every activity names its template', aliceSnap.activities.every((a) => typeof a.templateId === 'string'));

  // A scheduled activity is not open yet, and joining one is refused — the guard that stops
  // a crowd assembling for something that has not been announced.
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

  // Check-in without attending must be refused.
  alice.send({ t: 'checkin', activity: activity.id });
  const earlyAck = await alice.wait('checkin_ack', () => true, 3000);
  check('check-in refused when not attending a live activity', earlyAck?.ok === false, earlyAck);

  // A guest may not announce island-wide.
  alice.send({ t: 'host_announce', text: 'hello island', scope: { kind: 'island' } });
  const forbidden = await alice.wait('error', (f) => f.code === 'forbidden', 3000);
  check('guest cannot announce island-wide', !!forbidden, forbidden);

  // A guest may not drive an activity's lifecycle.
  alice.send({ t: 'host_activity_state', activity: activity.id, state: 'ended' });
  const badTransition = await alice.wait(
    'error',
    (f) => f.code === 'forbidden' || f.code === 'invalid_transition',
    3000,
  );
  check('non-host cannot drive activity lifecycle', !!badTransition, badTransition);

  // A guest may not put things on the programme.
  alice.send({ t: 'host_schedule', template: 'island-quiz', inMin: 0 });
  const scheduleForbidden = await alice.wait('error', (f) => f.code === 'forbidden' && f.message.includes('host_schedule'), 3000);
  check('guest cannot schedule', !!scheduleForbidden, scheduleForbidden);

  // -- Admin --------------------------------------------------------------
  console.log('\nAdmin');
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
  const adminSelf = adminFrames.find((f) => f.t === 'snapshot')?.players?.find((p) => p.id === adminWelcome?.self);
  check('admin token grants the admin role', adminSelf?.role === 3, adminSelf);

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
  const known = new Set(aliceSnap.activities.map((a) => a.id));

  adminSocket.send(JSON.stringify({ t: 'host_schedule', template: 'lantern-walk', inMin: 60 }));
  const scheduled = await waitDelta(alice, (f) =>
    f.activities?.some((a) => !known.has(a.id) && a.templateId === 'lantern-walk' && a.state === 'scheduled'),
  );
  check('admin can put an activity on the programme', !!scheduled, scheduled?.activities);
  const lifecycle = scheduled?.activities?.find((a) => !known.has(a.id) && a.templateId === 'lantern-walk') ?? activity;

  adminSocket.send(JSON.stringify({ t: 'host_activity_state', activity: lifecycle.id, state: 'open' }));
  const opened = await waitDelta(alice, (f) =>
    f.activities?.some((a) => a.id === lifecycle.id && a.state === 'open'),
  );
  check('admin can open a scheduled activity', !!opened, opened?.activities);

  alice.send({ t: 'activity_join', activity: lifecycle.id, mode: 'participant' });
  const joined = await waitDelta(alice, (f) =>
    f.players?.some((p) => p.id === aliceWelcome.self && p.activity === lifecycle.id),
  );
  check('joining an open activity attaches the player', !!joined, joined?.players);

  const counted = await waitDelta(alice, (f) =>
    f.activities?.some((a) => a.id === lifecycle.id && a.participantCount >= 1),
  );
  check('participant count is maintained server-side', !!counted, counted?.activities);

  adminSocket.send(JSON.stringify({ t: 'host_activity_state', activity: lifecycle.id, state: 'live' }));
  const live = await waitDelta(alice, (f) =>
    f.activities?.some((a) => a.id === lifecycle.id && a.state === 'live'),
  );
  check('admin can start the activity', !!live, live?.activities);

  const acksBefore = alice.all('checkin_ack').length;
  alice.send({ t: 'checkin', activity: lifecycle.id });
  await sleep(500);
  const liveAck = alice.all('checkin_ack')[acksBefore];
  check('check-in accepted while live', liveAck?.ok === true, liveAck);
  check('check-in returns an arrival ordinal', liveAck?.ordinal === 1, liveAck);
  const checkedInPatch = alice.all('delta').some((f) => f.players?.some((p) => p.id === aliceWelcome.self && p.checkedIn === true));
  check('the check-in is visible on the player', checkedInPatch);

  alice.send({ t: 'checkin', activity: lifecycle.id });
  await sleep(500);
  const secondAck = alice.all('checkin_ack')[acksBefore + 1];
  check('a second check-in is refused', secondAck?.ok === false, secondAck);

  adminSocket.send(JSON.stringify({ t: 'host_activity_state', activity: lifecycle.id, state: 'ended' }));
  const ended = await waitDelta(alice, (f) =>
    f.activities?.some((a) => a.id === lifecycle.id && a.state === 'ended'),
  );
  check('admin can end the activity', !!ended, ended?.activities);

  // `ended` is terminal — nothing may revive it.
  adminSocket.send(JSON.stringify({ t: 'host_activity_state', activity: lifecycle.id, state: 'live' }));
  await sleep(500);
  const revived = alice
    .all('delta')
    .some((f) => f.activities?.some((a) => a.id === lifecycle.id && a.state === 'live' && f.tick > ended.tick));
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

  // -- Private islands ----------------------------------------------------
  console.log('\nPrivate islands');
  const carol = await arrive('Carol', { visitor: visitorFor('Carol') });
  check('welcome carries a profile', !!carol.welcome?.profile && carol.welcome.profile.persistent === true, carol.welcome?.profile);
  carol.send({ t: 'room_create' });
  const made = await carol.wait('room_changed', () => true, 4000);
  const code = made?.room?.code;
  check('room_create moves you to a private island with a code', made?.room?.kind === 'private' && /^[2-9A-HJKMNP-Z]{5}$/.test(code ?? ''), made);
  check('the maker keeps it (admin there)', made?.role === 3, made?.role);
  check('room_changed carries a fresh resume token', typeof made?.resumeToken === 'string' && made.resumeToken !== carol.welcome.resumeToken);
  const carolIslandSnap = await carol.wait('snapshot', (f) => f.room === made?.room?.id, 4000);
  check('the new island has the programme on its board', (carolIslandSnap?.activities?.length ?? 0) > 0);

  const dave = await arrive('Dave', { room: code?.toLowerCase(), visitor: visitorFor('Dave') });
  check('an invite code in hello lands you on that island', dave.welcome?.room?.id === made?.room?.id, dave.welcome?.room);
  check('a guest on somebody else\'s island is a guest', dave.snapshot?.players?.find((p) => p.id === dave.welcome.self)?.role === 0);
  const daveSeesCarol = dave.snapshot?.players?.some((p) => p.id === carol.welcome.self);
  check('friends on the same island see each other', !!daveSeesCarol);
  check('your own island is listed to you, and no one else\'s', dave.welcome?.rooms?.some((r) => r.code === code));
  check('private islands are not listed to strangers', !alice.last('welcome')?.rooms?.some?.((r) => r.kind === 'private'));

  const eve = await arrive('Eve', { room: code === 'ZZZZZ' ? 'YYYYY' : 'ZZZZZ' });
  check('an unknown code falls back to a public island', eve.welcome?.room?.kind === 'public', eve.welcome?.room);
  const unknownCode = await eve.wait('error', (f) => f.key === 'room_not_found', 2000);
  check('…and says the island was not found', !!unknownCode, unknownCode);

  const metricsAfter = await (await fetch(`${BASE}/metrics`)).text();
  check('/metrics never names a private island', !!code && !metricsAfter.includes(code) && !metricsAfter.includes('isle-'), metricsAfter.split('\n').filter((l) => l.includes('room_population')));

  // -- Hostile frames -----------------------------------------------------
  console.log('\nHostile frames');
  const probe = await arrive('Probe');
  probe.send({ t: '__proto__' });
  const unknownType = await probe.wait('error', (f) => f.code === 'bad_message' && /unknown message type/.test(f.message), 2000);
  check('a message type that is not one is refused as such', !!unknownType, unknownType);
  const metricsNow = await (await fetch(`${BASE}/metrics`)).text();
  check('…and never becomes a metric label', !metricsNow.includes('__proto__'));
  let probeClosed = false;
  probe.socket.once('close', () => (probeClosed = true));
  for (let i = 0; i < 30; i++) probe.socket.send('not json at all');
  await sleep(600);
  check('a stream of garbage frames gets the connection closed', probeClosed);

  // -- Whispers and dice --------------------------------------------------
  console.log('\nWhispers and dice');
  carol.send({ t: 'chat', text: 'ab\u202ecd\u200b', to: dave.welcome.self });
  const cleaned = await dave.wait('whisper', (f) => f.text.startsWith('ab'), 3000);
  check('direction overrides and invisible marks are stripped from what people type', cleaned?.text === 'abcd', cleaned?.text);
  await sleep(1100); // the chat bucket: a burst of four, then one a second
  carol.send({ t: 'chat', text: 'psst', to: dave.welcome.self });
  const daveWhisper = await dave.wait('whisper', (f) => f.text === 'psst', 3000);
  const carolReceipt = await carol.wait('whisper', (f) => f.text === 'psst', 3000);
  check('a whisper reaches its target', daveWhisper?.from === carol.welcome.self, daveWhisper);
  check('the sender gets the receipt', !!carolReceipt);
  await sleep(300);
  check('nobody else hears it', !eve.all('whisper').length && !dave.all('delta').some((d) => d.chats?.some((c) => c.text === 'psst')));

  dave.send({ t: 'roll', sides: 6 });
  const dice = await carol.wait('delta', (f) => f.events?.some((e) => e.k === 'dice' && e.by === dave.welcome.self), 3000);
  const roll = dice?.events?.find((e) => e.k === 'dice');
  check('a die roll is seen by the island', !!roll && roll.value >= 1 && roll.value <= 6, roll);

  // -- Omikuji and stamps -------------------------------------------------
  console.log('\nOmikuji and stamps');
  const pilgrim = await arrive('Pilgrim', { at: atInteractable('omikuji'), visitor: visitorFor('Pilgrim') });
  pilgrim.send({ t: 'interact', target: 'omikuji', kind: 'use' });
  const slip = await pilgrim.wait('omikuji', () => true, 3000);
  check('drawing the omikuji gives a slip', !!slip && slip.again === false, slip);
  pilgrim.send({ t: 'interact', target: 'omikuji', kind: 'use' });
  const again = await pilgrim.wait('omikuji', (f) => f.again === true, 3000);
  check('a second draw the same day is the same slip', again?.fortune === slip?.fortune, again);

  pilgrim.send({ t: 'interact', target: 'stamp-south-harbor', kind: 'use' });
  const tooFar = await pilgrim.wait('error', (f) => f.key === 'too_far', 3000);
  check('a stamp must be taken at its stand', !!tooFar, tooFar);

  // Walk over to the shrine's stamp stand the quick way: come back there as a new player
  // with the same visitor key — which also shows the profile outliving the player.
  pilgrim.close();
  await sleep(300);
  const pilgrim2 = await arrive('Pilgrim', { at: atInteractable('stamp-shrine'), visitor: visitorFor('Pilgrim') });
  check('progress comes back with the visitor key', pilgrim2.welcome?.profile?.omikuji?.fortune === slip?.fortune, pilgrim2.welcome?.profile);
  pilgrim2.send({ t: 'interact', target: 'stamp-shrine', kind: 'use' });
  const stamped = await pilgrim2.wait('profile', (f) => f.profile.stamps.includes('shrine'), 3000);
  check('stamping puts the place on your card', !!stamped, stamped?.profile);
  pilgrim2.send({ t: 'interact', target: 'stamp-shrine', kind: 'use' });
  const twice = await pilgrim2.wait('error', (f) => f.key === 'already_stamped', 3000);
  check('the same stamp twice is refused', !!twice);
  const pilgrimAgain = pilgrim2;

  // -- Fishing ------------------------------------------------------------
  console.log('\nFishing');
  const angler = await arrive('Angler', { at: atInteractable('fish-south-main'), visitor: visitorFor('Angler') });
  angler.send({ t: 'fish', action: 'cast', spot: 'fish-south-main' });
  const waiting = await angler.wait('fish', (f) => f.phase === 'waiting', 3000);
  check('casting puts a line out', !!waiting, waiting);
  const bite = await angler.wait('fish', (f) => f.phase === 'bite', 11_000);
  check('a bite comes', !!bite, bite);
  angler.send({ t: 'fish', action: 'hook' });
  const caught = await angler.wait('fish', (f) => f.phase === 'caught', 3000);
  check('striking in time lands a fish', !!caught && typeof caught.fish === 'string' && caught.size > 0, caught);
  const catchEvent = await alice.wait('delta', (f) => f.events?.some((e) => e.k === 'catch' && e.by === angler.welcome.self), 3000);
  check('the catch is an event for the island', !!catchEvent);
  const book = await angler.wait('profile', (f) => f.profile.catches === 1, 3000);
  check('the catch goes in the book', !!book, book?.profile);

  // -- Guestbook ----------------------------------------------------------
  console.log('\nGuestbook');
  const signer = await arrive('Signer', { at: atInteractable('notice-board') });
  signer.send({ t: 'guestbook_write', text: 'was here' });
  const signed = await alice.wait('delta', (f) => f.guestbook?.some((g) => g.text === 'was here'), 3000);
  check('signing the board reaches everyone', !!signed, signed?.guestbook);
  signer.send({ t: 'guestbook_write', text: 'and again' });
  const tooSoon = await signer.wait('error', (f) => f.key === 'cooldown', 3000);
  check('one line per half minute', !!tooSoon);
  const entry = signed?.guestbook?.find((g) => g.text === 'was here');
  alice.send({ t: 'guestbook_remove', id: entry?.id });
  const notYours = await alice.wait('error', (f) => f.key === 'forbidden', 3000);
  check('nobody else can take your line down', !!notYours);
  signer.send({ t: 'guestbook_remove', id: entry?.id });
  const taken = await alice.wait('delta', (f) => f.guestbookRemoved?.includes(entry?.id), 3000);
  check('the author can', !!taken);

  // -- Janken -------------------------------------------------------------
  console.log('\nJanken');
  const plaza = shared.getZone('plaza');
  const jan = await arrive('Jan', { at: { pos: [plaza.x, 0, plaza.z], yaw: 0 } });
  const ken = await arrive('Ken', { at: { pos: [plaza.x + 2, 0, plaza.z], yaw: 0 } });
  jan.send({ t: 'janken', action: 'challenge', target: ken.welcome.self });
  const invite = await ken.wait('janken', (f) => f.kind === 'invited', 3000);
  check('a challenge reaches its target', !!invite, invite);
  ken.send({ t: 'janken', action: 'respond', duel: invite?.duel, accept: true });
  const start = await jan.wait('janken', (f) => f.kind === 'start', 3000);
  check('accepting starts a round for both', !!start && !!(await ken.wait('janken', (f) => f.kind === 'start', 3000)));
  jan.send({ t: 'janken', action: 'throw', duel: invite?.duel, hand: 'rock' });
  ken.send({ t: 'janken', action: 'throw', duel: invite?.duel, hand: 'scissors' });
  const result = await jan.wait('janken', (f) => f.kind === 'result', 3000);
  check('rock beats scissors', result?.winner === jan.welcome.self && result?.final === true, result);
  const jEvent = await alice.wait('delta', (f) => f.events?.some((e) => e.k === 'janken'), 3000);
  check('the result is an event for the island', !!jEvent);

  // -- Fireworks ----------------------------------------------------------
  console.log('\nFireworks');
  const beach = shared.getZone('beach');
  const sparky = await arrive('Sparky', { at: { pos: [beach.x, 0, beach.z], yaw: 0 } });
  sparky.send({ t: 'firework' });
  const fw = await alice.wait('delta', (f) => f.events?.some((e) => e.k === 'firework' && e.by === sparky.welcome.self), 3000);
  check('a firework from the shore goes up for everyone', !!fw);
  jan.send({ t: 'firework' });
  const notShore = await jan.wait('error', (f) => f.key === 'not_here', 3000);
  check('…but not from the plaza', !!notShore);

  // -- Quiz ---------------------------------------------------------------
  console.log('\nQuiz');
  adminSocket.send(JSON.stringify({ t: 'host_schedule', template: 'island-quiz', inMin: 0 }));
  const lobby = await jan.wait('delta', (f) => f.quiz?.phase === 'lobby', 4000);
  check('a quiz put on now opens its lobby', !!lobby, lobby?.quiz);
  check('the lobby counts down on the server clock', !!lobby && lobby.quiz.endsAt > Date.now() - 2000);

  // -- Treasure hunt ------------------------------------------------------
  console.log('\nTreasure hunt');
  jan.send({ t: 'dig' });
  check('there is nothing to dig for before a hunt', !!(await jan.wait('error', (f) => f.key === 'no_hunt', 3000)));
  adminSocket.send(JSON.stringify({ t: 'host_schedule', template: 'treasure-hunt', inMin: 0 }));
  const huntLive = await jan.wait('delta', (f) => f.activities?.some((a) => a.feature === 'treasure' && a.state === 'live'), 4000);
  const hunt = huntLive?.activities.find((a) => a.feature === 'treasure');
  check('a hunt put on now goes live with things buried', hunt?.left === shared.TREASURE_COUNT, hunt);
  ken.send({ t: 'dig' });
  const told = await ken.wait('dig', () => true, 3000);
  check('a dig is answered with how close', !!told && ['found', 'hot', 'warm', 'cool', 'cold'].includes(told.result), told);
  const seen = await jan.wait('delta', (f) => f.events?.some((e) => (e.k === 'dig' || e.k === 'treasure') && e.by === ken.welcome.self), 3000);
  check('and everyone sees the spade go in', !!seen);
  ken.send({ t: 'dig' });
  check('one dig at a time', !!(await ken.wait('error', (f) => f.key === 'cooldown', 3000)));

  // -- Friends ------------------------------------------------------------
  console.log('\nFriends');
  const hana = await arrive('Hana', { visitor: visitorFor('Hana') });
  const kou = await arrive('Kou', { visitor: visitorFor('Kou') });
  check('a keyed visitor is sent a friends list', (await hana.wait('friends', () => true, 3000))?.enabled === true);
  hana.send({ t: 'friend', action: 'request', target: kou.welcome.self });
  const ask = await kou.wait('friends', (f) => f.requests.some((r) => r.name === 'Hana'), 3000);
  check('an ask reaches them', !!ask);
  kou.send({ t: 'friend', action: 'accept', target: ask?.requests[0]?.id });
  const onHanas = await hana.wait('friends', (f) => f.friends.some((x) => x.name === 'Kou' && x.online), 3000);
  const onKous = await kou.wait('friends', (f) => f.friends.some((x) => x.name === 'Hana' && x.online), 3000);
  check('accepted, each is on the other\'s list, online', !!onHanas && !!onKous);
  kou.send({ t: 'room_create' });
  const followed = await hana.wait('friends', (f) => f.friends.some((x) => x.name === 'Kou' && x.room?.kind === 'private' && !!x.room.code), 4000);
  check('a friend who moves to a private island is seen there, code and all', !!followed, followed?.friends);
  hana.close();
  kou.close();

  for (const c of [carol, dave, eve, pilgrimAgain, angler, signer, jan, ken, sparky]) c.close();

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
