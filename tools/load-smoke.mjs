#!/usr/bin/env node
/**
 * Load smoke test.
 * ================
 *
 * A crowd of scripted visitors on one server, doing what people do on the island — walking
 * somewhere, stopping, walking on, saying something now and then, waving — and the numbers
 * that decide whether the island still feels live with that many people on it:
 *
 *     node tools/load-smoke.mjs                 # 150 visitors for 30 s
 *     LOAD_BOTS=300 LOAD_SECONDS=60 node tools/load-smoke.mjs
 *
 * - **tick time** (the server's own p50/p95/p99, from `/metrics`): the room loop runs at
 *   10 Hz, so it has 100 ms; anything near that and every client's world stutters;
 * - **downlink per visitor**, on the wire (after permessage-deflate) and decoded — the
 *   number that decides whether a phone on a train keeps up;
 * - **deltas per second** each visitor actually receives (should be the tick rate);
 * - **corrections**: how often the server refused a honest walker's position. A walker
 *   that follows the routing graph at walking pace should essentially never be corrected;
 *   if it is, real players on a jittery network are being rubber-banded;
 * - refusals of any kind, unexpected closes, and the server process's CPU and memory.
 *
 * It runs the built server (`npm run build` first) on its own port, so it can run beside
 * the dev stack, and walks the crowd from several threads so the harness keeps up. Exit
 * status is non-zero when a threshold below is broken.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { WebSocket } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = createRequire(import.meta.url)(resolve(root, 'packages/shared/dist/index.js'));

const PORT = Number(process.env.LOAD_PORT ?? 8898);
const BOTS = Number(process.env.LOAD_BOTS ?? 150);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 30);
const WARMUP_S = 6;
const BASE = `http://127.0.0.1:${PORT}`;

/** Thresholds. Generous: this is a smoke test, not a benchmark. */
const MAX_TICK_P99_MS = 40;
const MAX_CORRECTION_RATE = 0.01;

const LINES = ['hello!', 'anyone fishing?', 'the quiz is starting', 'nice view', 'see you at the beach', 'lol', 'which way to the shrine?'];
const EMOTES = shared.EMOTES;

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** A walkable spot somewhere on the island. */
function somewhere() {
  const r = shared.ISLAND_EXTENT * 0.9;
  for (;;) {
    const [x, z] = shared.nearestWalkable(rand(-r, r), rand(-r, r), 12);
    if (shared.isWalkable(x, z)) return [x, z];
  }
}

class Bot {
  constructor(i) {
    this.i = i;
    this.name = `Bot${String(i).padStart(3, '0')}`;
    this.seq = 0;
    this.route = [];
    this.pauseUntil = 0;
    [this.x, this.z] = somewhere();
    this.yaw = 0;
    this.stats = { moves: 0, corrections: 0, deltas: 0, bytes: 0, frames: 0, errors: {}, closed: null };
    this.wireAtStart = 0;
    this.measuring = false;
    this.nextChat = Date.now() + rand(5_000, 40_000);
    this.nextEmote = Date.now() + rand(3_000, 30_000);
    this.nextPing = Date.now() + rand(0, 5_000);
  }

  connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.welcomed = new Promise((res, rej) => {
      this.ws.once('error', rej);
      this.ws.on('message', (raw) => this.onMessage(raw, res));
    });
    this.ws.once('open', () =>
      this.send({
        t: 'hello',
        protocol: shared.PROTOCOL.VERSION,
        name: this.name,
        appearance: { outfit: this.i % 4, skin: this.i % 3, accessory: this.i % 2 },
        at: { pos: [this.x, shared.heightAt(this.x, this.z), this.z], yaw: 0 },
      }),
    );
    this.ws.once('close', (code, reason) => {
      if (!this.stopping) this.stats.closed = { code, reason: reason.toString() };
    });
    return this.welcomed;
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onMessage(raw, welcomed) {
    const size = raw.length ?? raw.byteLength ?? 0;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'welcome') {
      this.room = msg.room?.id;
      welcomed();
    }
    if (!this.measuring) return;
    this.stats.frames++;
    this.stats.bytes += size;
    if (msg.t === 'delta') this.stats.deltas++;
    else if (msg.t === 'correction') {
      this.stats.corrections++;
      // Take the server's word, as the client does, and walk on from there.
      this.x = msg.pos[0];
      this.z = msg.pos[2];
      this.route = [];
    } else if (msg.t === 'error') {
      const key = msg.key ?? msg.code;
      this.stats.errors[key] = (this.stats.errors[key] ?? 0) + 1;
    }
  }

  /** One 100 ms step: walk along the route, or stand a while, and report. */
  step(dt, now) {
    if (now >= this.pauseUntil && this.route.length === 0) {
      const [tx, tz] = somewhere();
      this.route = shared.routeTo(this.x, this.z, tx, tz);
      if (!this.route.length) this.pauseUntil = now + 1000;
    }
    let anim = shared.AnimState.Idle;
    if (this.route.length && now >= this.pauseUntil) {
      let budget = shared.MOVE_SPEED.walk * 0.9 * dt;
      while (budget > 0 && this.route.length) {
        const [wx, wz] = this.route[0];
        const dx = wx - this.x;
        const dz = wz - this.z;
        const d = Math.hypot(dx, dz);
        if (d <= budget) {
          this.x = wx;
          this.z = wz;
          budget -= d;
          this.route.shift();
          if (!this.route.length) this.pauseUntil = now + rand(1_000, 8_000);
        } else {
          this.x += (dx / d) * budget;
          this.z += (dz / d) * budget;
          this.yaw = Math.atan2(dx, dz);
          budget = 0;
        }
      }
      anim = shared.AnimState.Walk;
    }
    this.send({ t: 'move', seq: ++this.seq, pos: [this.x, shared.heightAt(this.x, this.z), this.z], yaw: this.yaw, anim });
    if (this.measuring) this.stats.moves++;

    if (now >= this.nextChat) {
      this.send({ t: 'chat', text: pick(LINES) });
      this.nextChat = now + rand(15_000, 45_000);
    }
    if (now >= this.nextEmote) {
      this.send({ t: 'emote', emote: pick(EMOTES) });
      this.nextEmote = now + rand(10_000, 30_000);
    }
    if (now >= this.nextPing) {
      this.send({ t: 'ping', t0: now });
      this.nextPing = now + shared.PROTOCOL.PING_INTERVAL_MS;
    }
  }

  get wireBytes() {
    return this.ws._socket?.bytesRead ?? 0;
  }

  close() {
    this.stopping = true;
    this.ws.close();
  }
}

/** A quantile of a numeric series. */
function q(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

async function metric(name) {
  const text = await (await fetch(`${BASE}/metrics`)).text();
  const out = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const m = line.match(/quantile="([\d.]+)"\}\s+([\d.e+-]+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function sampleProcess(pid) {
  try {
    const [cpu, rss] = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', String(pid)]).toString().trim().split(/\s+/).map(Number);
    return { cpu, rssMb: rss / 1024 };
  } catch {
    return null;
  }
}

/**
 * One crowd: a share of the visitors, run on its own thread. A single event loop cannot
 * keep a few hundred sockets walking at 10 Hz *and* parse everything they receive — past
 * ~150 it falls behind, sends in bursts, and the test ends up measuring itself.
 */
async function runCrowd({ from, count }) {
  const bots = [];
  for (let i = from; i < from + count; i++) {
    const bot = new Bot(i);
    bots.push(bot);
    bot.connect().catch(() => {});
    // Arrive in small waves, as a crowd does — a thousand hellos in one millisecond is a
    // different test (see the connection caps in index.ts).
    if (i % 10 === 9) await sleep(50);
  }
  const welcomed = await Promise.race([
    Promise.allSettled(bots.map((b) => b.welcomed)).then((r) => r.filter((x) => x.status === 'fulfilled').length),
    sleep(15_000).then(() => -1),
  ]);
  parentPort.postMessage({ t: 'welcomed', welcomed, rooms: bots.map((b) => b.room) });

  // One timer drives the whole crowd: a timer per bot would measure the harness's own
  // scheduling as much as the server.
  let last = Date.now();
  const walker = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    for (const b of bots) b.step(dt, now);
  }, 1000 / shared.PROTOCOL.MOVE_SEND_HZ);

  let started = 0;
  parentPort.on('message', (m) => {
    if (m === 'measure') {
      started = Date.now();
      for (const b of bots) {
        b.measuring = true;
        b.wireAtStart = b.wireBytes;
      }
    } else if (m === 'stop') {
      const elapsed = (Date.now() - started) / 1000;
      clearInterval(walker);
      const stats = bots.map((b) => ({
        name: b.name,
        wire: (b.wireBytes - b.wireAtStart) / elapsed / 1024,
        decoded: b.stats.bytes / elapsed / 1024,
        deltaRate: b.stats.deltas / elapsed,
        moves: b.stats.moves,
        corrections: b.stats.corrections,
        errors: b.stats.errors,
        closed: b.stats.closed,
      }));
      for (const b of bots) b.close();
      parentPort.postMessage({ t: 'stats', stats });
    }
  });
}

/** How many visitors one thread walks. */
const PER_CROWD = 75;

async function main() {
  let server;
  const crowds = [];
  try {
    server = spawn('node', ['apps/server/dist/index.js'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        ROOM_COUNT: '1',
        MAX_CONNECTIONS: String(BOTS + 50),
        SESSION_SECRET: 'load-secret',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr.on('data', (d) => process.stdout.write(`[srv:err] ${d}`));
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${BASE}/healthz`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (i > 100) throw new Error('server did not come up');
      await sleep(100);
    }
    console.log(`  ok   server up on :${PORT}`);

    const replies = [];
    for (let from = 0; from < BOTS; from += PER_CROWD) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { from, count: Math.min(PER_CROWD, BOTS - from) } });
      const inbox = [];
      const waiters = [];
      worker.on('message', (m) => (waiters.length ? waiters.shift()(m) : inbox.push(m)));
      worker.on('error', (err) => console.log(`[crowd] ${err?.stack ?? err}`));
      crowds.push(worker);
      replies.push(() => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r))));
    }
    const arrived = await Promise.all(replies.map((next) => next()));
    const welcomed = arrived.reduce((n, a) => n + Math.max(0, a.welcomed), 0);
    check(`all ${BOTS} visitors are welcomed`, welcomed === BOTS && arrived.every((a) => a.welcomed >= 0), { welcomed });
    const rooms = {};
    for (const a of arrived) for (const r of a.rooms) rooms[r] = (rooms[r] ?? 0) + 1;
    console.log(`  ...  rooms: ${JSON.stringify(rooms)}  (${crowds.length} crowd threads)`);

    await sleep(WARMUP_S * 1000);
    for (const w of crowds) w.postMessage('measure');
    const cpu = [];
    const started = Date.now();
    while (Date.now() - started < SECONDS * 1000) {
      await sleep(2000);
      const sample = sampleProcess(server.pid);
      if (sample) cpu.push(sample);
    }
    for (const w of crowds) w.postMessage('stop');
    const bots = (await Promise.all(replies.map((next) => next()))).flatMap((m) => m.stats);

    const tick = await metric('nagisa_tick_duration_ms');
    const wire = bots.map((b) => b.wire);
    const decoded = bots.map((b) => b.decoded);
    const deltaRate = bots.map((b) => b.deltaRate);
    const moves = bots.reduce((n, b) => n + b.moves, 0);
    const corrections = bots.reduce((n, b) => n + b.corrections, 0);
    const moveRate = moves / bots.length / SECONDS;
    const errors = {};
    for (const b of bots) for (const [k, v] of Object.entries(b.errors)) errors[k] = (errors[k] ?? 0) + v;
    const closed = bots.filter((b) => b.closed).map((b) => ({ bot: b.name, ...b.closed }));

    console.log('');
    console.log(`  tick ms          p50 ${tick['0.5']?.toFixed(2)}  p95 ${tick['0.95']?.toFixed(2)}  p99 ${tick['0.99']?.toFixed(2)}`);
    console.log(`  downlink KB/s    wire p50 ${q(wire, 0.5).toFixed(1)}  max ${q(wire, 1).toFixed(1)}   decoded p50 ${q(decoded, 0.5).toFixed(1)}  max ${q(decoded, 1).toFixed(1)}`);
    console.log(`  deltas/s         p5 ${q(deltaRate, 0.05).toFixed(1)}  p50 ${q(deltaRate, 0.5).toFixed(1)}`);
    console.log(`  moves/s/visitor  ${moveRate.toFixed(1)} (the harness keeping up: should be ${shared.PROTOCOL.MOVE_SEND_HZ})`);
    console.log(`  corrections      ${corrections} of ${moves} moves (${((corrections / Math.max(1, moves)) * 100).toFixed(2)}%)`);
    console.log(`  server           cpu avg ${(cpu.reduce((n, s) => n + s.cpu, 0) / Math.max(1, cpu.length)).toFixed(0)}%  rss max ${Math.max(0, ...cpu.map((s) => s.rssMb)).toFixed(0)} MB`);
    console.log('');

    check('the harness keeps up (otherwise the numbers below measure it, not the server)', moveRate >= shared.PROTOCOL.MOVE_SEND_HZ * 0.9, { moveRate });
    check(`tick p99 under ${MAX_TICK_P99_MS} ms`, (tick['0.99'] ?? Infinity) < MAX_TICK_P99_MS, tick);
    check('every visitor receives the tick rate', q(deltaRate, 0.05) >= shared.PROTOCOL.TICK_HZ * 0.8, { p5: q(deltaRate, 0.05) });
    check(`honest walkers are corrected under ${MAX_CORRECTION_RATE * 100}% of the time`, corrections / Math.max(1, moves) < MAX_CORRECTION_RATE, { corrections, moves });
    check('nobody is refused anything', Object.keys(errors).length === 0, errors);
    check('nobody is disconnected', closed.length === 0, closed.slice(0, 5));
  } catch (err) {
    failures++;
    console.log(`  FAIL harness — ${err?.stack ?? err}`);
  } finally {
    for (const w of crowds) await w.terminate().catch(() => {});
    server?.kill('SIGTERM');
  }

  console.log(failures === 0 ? '\nload-smoke: PASS' : `\nload-smoke: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

if (isMainThread) await main();
else await runCrowd(workerData);
