#!/usr/bin/env node
/**
 * Reconnection smoke test.
 * ========================
 *
 * One browser, one server, and one question: **when the server dies under you and comes
 * back, do you come back where you were standing?**
 *
 *     node tools/reconnect-smoke.mjs
 *
 * ### Why this cannot be a unit test
 *
 * The server-side half is unit-tested in `apps/server/src/reconnect.test.ts`, and those
 * tests pass while the feature is entirely broken end-to-end — because they call
 * `handleHello` with an `at` that the test itself supplies. The parts that actually decide
 * whether a player keeps their place are all outside that function:
 *
 * - the client has to *record* where it is, continuously, including while the socket is
 *   down (the world keeps simulating; a pose from before the outage is its own teleport);
 * - it has to survive the process that recorded it — a real restart is not a graceful
 *   handshake, it is a socket that stops answering;
 * - the reconnect loop has to present the pose on the retry `hello`, not only the first;
 * - and the client has to *accept* the server's answer without its own snapshot-adoption
 *   logic yanking the character somewhere else.
 *
 * Every one of those is a seam between two files, which is exactly what a real browser
 * against a real server is for. The specific regression this guards: the resume token
 * covers a short outage beautifully and hides the bug completely, so the failure only ever
 * appears when the outage is long enough that the server has forgotten you — which is the
 * case a mock will never reproduce by accident.
 *
 * ### The two cases, and why both are here
 *
 * 1. **Server restart.** The player object is gone; only the client remembers. This is the
 *    case the feature was built for.
 * 2. **A socket drop inside the grace window.** The old path, which must keep working —
 *    same player id, same activity attachment, `resumed: true`. A "fix" that reconnects
 *    you to the right coordinates as a *different player* every time has broken more than
 *    it repaired.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { shutdown, start, stopOne, waitForPortsFree } from './stack.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Close code for the deliberate blip. In the 4000–4999 application range, so it cannot be
 * confused with the codes the platform emits on its own — 1001 for the server going away
 * and 1006 for a refused connect, both of which appear several times in a normal run.
 */
const DROP_CODE = 4321;

/** Where the character is, as the client sees it. */
const posOf = (page) =>
  page.evaluate(() => {
    const p = window.nagisa?.local?.position;
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  });

const connState = (page) => page.evaluate(() => window.nagisa?.connection?.currentState ?? null);
const selfId = (page) => page.evaluate(() => window.nagisa?.connection?.welcome?.self ?? null);

/** Poll until `fn` returns truthy, or give up. Returns the value, or null on timeout. */
async function until(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await delay(stepMs);
  }
}

/**
 * Walk forward until the character is `metres` from where it started, so the test is not
 * asserting about the spawn point itself.
 *
 * Bounded by **distance**, never by duration. Under SwiftShader the page runs at a small
 * fraction of real time — a measured 2.5 m from 3.5 s of held `W`, against the ~31 m that
 * `MOVE_SPEED.walk` would give in real time — so a fixed press interval makes the
 * separation between "where we spawned" and "where we were" depend on how loaded the
 * machine is, and every later assertion becomes a coin toss. Returns the distance actually
 * covered so the caller can say so when it gives up.
 */
async function walkAway(page, metres, maxMs = 60_000) {
  const from = await posOf(page);
  const deadline = Date.now() + maxMs;
  let best = 0;
  await page.keyboard.down('KeyW');
  try {
    for (;;) {
      await delay(500);
      const now = await posOf(page);
      best = now && from ? Math.hypot(now.x - from.x, now.z - from.z) : 0;
      if (best >= metres || Date.now() > deadline) break;
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
  await delay(600);
  return best;
}

let browser;
try {
  await waitForPortsFree();
  await start('server', ['run', 'dev', '-w', '@nagisa/server'], /"event":"boot_complete"/, { cwd: root });
  const viteMatch = await start('client', ['run', 'dev', '-w', '@nagisa/client'], /localhost:(\d+)/, { cwd: root });
  const port = Number(viteMatch[1]);
  console.log(`  ok   stack up on :${port}`);

  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 520, height: 340 } });
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

  // Record every welcome and every state change, with timestamps. A reconnect bug is a
  // *sequence* bug — the final state alone cannot tell you whether you reconnected once or
  // three times — and a failure that only reports the end state costs an entire re-run to
  // diagnose.
  await page.addInitScript(() => {
    window.__log = [];
    const t0 = Date.now();
    const push = (kind, detail) => window.__log.push({ at: Date.now() - t0, kind, ...detail });
    const origOpen = WebSocket.prototype.close;
    window.WebSocket = new Proxy(WebSocket, {
      construct(target, argv) {
        const ws = new target(...argv);
        push('socket_open', {});
        ws.addEventListener('close', (e) => push('socket_close', { code: e.code, reason: e.reason }));
        ws.addEventListener('message', (e) => {
          try {
            const m = JSON.parse(e.data);
            if (m.t === 'welcome') push('welcome', { self: m.self, resumed: m.resumed, room: m.room?.id });
          } catch {
            /* binary or malformed: not a welcome */
          }
        });
        return ws;
      },
    });
    void origOpen;
  });

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForSelector('input', { timeout: 240_000 });
  await page.fill('input', 'Kaede');
  await page.getByRole('button', { name: /ashore|enter|go/i }).first().click();
  await delay(7000);
  await page.evaluate(() => document.activeElement?.blur?.());

  const id0 = await selfId(page);
  check('entered the world with a player id', typeof id0 === 'string' && id0.length > 0, { id0 });

  const spawn = await posOf(page);
  // Comfortably past the tolerances below, so "came back to where I was" and "was sent to
  // the harbour" are two different answers rather than the same one within noise.
  const walked = await walkAway(page, 25);
  const before = await posOf(page);
  check('walked away from the spawn point', walked > 20, { spawn, before, walked: Number(walked.toFixed(2)) });

  // --- 1. The server restarts underneath us -------------------------------------------
  //
  // Not a graceful goodbye — the process is killed. From the browser's side the socket
  // simply stops answering, which is what a crash, a deploy, or a dropped uplink looks
  // like. The player object and its position die with it; the only surviving record of
  // where this character stood is in the browser.
  console.log('  ...  killing the server');
  await stopOne('server', { port: 8787 });
  const dropped = await until(async () => ['reconnecting', 'connecting'].includes(await connState(page)), 20_000);
  check('the client notices the server is gone', dropped !== null, { state: await connState(page) });

  // Long enough to outlive the grace window, so resuming the old player is off the table
  // and the position is the only thing left to reconnect with. This is the whole point of
  // the test: a shorter outage would be answered by the resume token and prove nothing.
  await delay(4000);
  console.log('  ...  bringing the server back');
  await start('server', ['run', 'dev', '-w', '@nagisa/server'], /"event":"boot_complete"/, { cwd: root });

  const reconnected = await until(async () => (await connState(page)) === 'connected', 90_000);
  check('the client reconnects on its own', reconnected !== null, { state: await connState(page) });

  // Give the first snapshot time to arrive and be adopted — the client's own reconciliation
  // is part of what is under test, and asserting before it has run would measure prediction
  // rather than the landing.
  await delay(4000);
  const after = await posOf(page);
  const moved = after && before ? Math.hypot(after.x - before.x, after.z - before.z) : Infinity;
  const toSpawn = after && spawn ? Math.hypot(after.x - spawn.x, after.z - spawn.z) : 0;

  // The tolerance covers the walkability snap (up to RETURN_SNAP_LIMIT) plus whatever the
  // character drifted between the last move report and the socket dying.
  check('resumes where it was standing, not at the spawn', moved < 8, { before, after, moved: Number(moved.toFixed(2)) });
  check('is not back at the harbour', toSpawn > 15, { spawn, after, toSpawn: Number(toSpawn.toFixed(2)) });

  const id1 = await selfId(page);
  check('has a player id again after the restart', typeof id1 === 'string' && id1.length > 0, { id1 });

  // --- 2. A short drop still resumes the same player ----------------------------------
  //
  // The old path, unchanged and still load-bearing. `resumed: true` and an identical player
  // id are what distinguish "the server was holding your place" from "a new visitor who
  // happens to be standing where you were".
  await walkAway(page, 6, 30_000);
  const beforeBlip = await posOf(page);
  await page.evaluate((code) => window.nagisa?.connection?.dropForTest?.(code, 'smoke'), DROP_CODE);
  await until(async () => ['reconnecting', 'connecting'].includes(await connState(page)), 10_000);
  const backAgain = await until(async () => (await connState(page)) === 'connected', 45_000);
  check('reconnects after a brief socket drop', backAgain !== null, { state: await connState(page) });
  await delay(2500);

  // Read the two ids **off the timeline**, bracketing our own close, rather than sampling
  // `welcome.self` before and after and hoping nothing else happened in between.
  //
  // It does. The dev server restarts itself a couple of times right after boot as the
  // shared package finishes rebuilding, and each restart legitimately mints a new player —
  // so a sampled "before" id can be two identities stale by the time the blip happens, and
  // the check fails while the behaviour it is testing is perfectly correct. Bracketing is
  // immune to that no matter how many restarts intervene.
  const timeline = await page.evaluate(() => window.__log);
  const dropIndex = timeline.findIndex((e) => e.kind === 'socket_close' && e.code === 4321);
  const idBeforeBlip = [...timeline.slice(0, dropIndex)].reverse().find((e) => e.kind === 'welcome');
  const idAfterBlip = timeline.slice(dropIndex).find((e) => e.kind === 'welcome');
  check('the blip is visible in the timeline', dropIndex >= 0 && idBeforeBlip && idAfterBlip, {
    dropIndex,
    idBeforeBlip,
    idAfterBlip,
  });
  check('a within-grace reconnect keeps the same player id', idAfterBlip?.self === idBeforeBlip?.self, {
    before: idBeforeBlip,
    after: idAfterBlip,
  });
  check('the server marks it as a resume', idAfterBlip?.resumed === true, { after: idAfterBlip });
  if (failures) {
    console.log('  ---  socket timeline');
    for (const e of timeline) console.log(`       ${JSON.stringify(e)}`);
  }

  const afterBlip = await posOf(page);
  const blipMoved = afterBlip && beforeBlip ? Math.hypot(afterBlip.x - beforeBlip.x, afterBlip.z - beforeBlip.z) : Infinity;
  check('a brief drop does not move the character', blipMoved < 8, {
    beforeBlip,
    afterBlip,
    blipMoved: Number(blipMoved.toFixed(2)),
  });

  check('no page errors', problems.length === 0, problems);
} catch (err) {
  failures++;
  console.log(`  FAIL harness — ${err?.stack ?? err}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await shutdown();
}

console.log(failures === 0 ? '\nreconnect-smoke: PASS' : `\nreconnect-smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
