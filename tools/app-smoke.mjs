#!/usr/bin/env node
/**
 * Whole-app smoke test.
 * =====================
 *
 * Boots the **real** stack — the realtime server, the Vite dev server and a browser — walks
 * two players through the entry screen into the world, and checks that each one can see the
 * other. Then screenshots what they see.
 *
 * This is the check that the unit, world and protocol suites structurally cannot make. Each
 * of those exercises one layer against a stub of its neighbour; this one is the only thing
 * that fails if the pieces are individually correct and jointly wrong — a store default
 * naming a zone that no longer exists, a WebSocket proxy path that changed, an entry screen
 * whose button stopped calling `enterWorld`, a scene that throws on the first frame *after*
 * the loader hands over.
 *
 *     node tools/app-smoke.mjs
 *     node tools/app-smoke.mjs --out shots/app --keep
 *
 * Exits non-zero on any failure, so it can gate a release.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { shutdown, start, waitForPortsFree } from './stack.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = resolve(root, flag('out', 'shots/app'));
mkdirSync(outDir, { recursive: true });

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
}

/** Spawn a workspace process and resolve when its output matches `ready`. */
try {
  // A run against a stack this process did not start proves nothing about this working
  // tree — and Vite would quietly take :5174 and let every check pass on a stale bundle.
  await waitForPortsFree();
  // The realtime server first: the client proxies /ws to it, and a client that opens its
  // socket before the server is listening spends the whole run in backoff.
  await start('server', ['run', 'dev', '-w', '@nagisa/server'], /"event":"boot_complete"/, { cwd: root });
  console.log('  ok   realtime server booted');
  const viteMatch = await start('client', ['run', 'dev', '-w', '@nagisa/client'], /localhost:(\d+)/, { cwd: root });
  const port = Number(viteMatch[1]);
  console.log(`  ok   vite on :${port}`);

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });

  /** Take one player from a blank tab to standing in the world. */
  async function enter(name) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });

    // `domcontentloaded`, not `load`: on a cold Vite server the first request transforms
    // the whole module graph, and waiting for every asset can exceed the default 30 s.
    // What actually matters is the entry card, which the selector wait below covers.
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    // The island builds before the entry card appears — that ordering is the product's,
    // not an accident, so waiting on the card also proves the world built.
    await page.waitForSelector('input', { timeout: 240_000 });
    await page.fill('input', name);
    await page.getByRole('button', { name: /ashore|enter|go/i }).first().click();
    return { page, problems };
  }

  const alice = await enter('Alice');
  const bob = await enter('Bob');

  // Both sockets need a moment to hello, receive a snapshot and start ticking.
  await alice.page.waitForTimeout(6000);

  for (const [label, player] of [
    ['alice', alice],
    ['bob', bob],
  ]) {
    const state = await player.page.evaluate(() => {
      const text = document.body.innerText;
      return { text, hasCanvas: !!document.querySelector('canvas') };
    });
    check(`${label}: canvas present`, state.hasCanvas);
    // Population is rendered in the HUD; two connected players must show as two.
    check(`${label}: sees a population of 2`, /\b2\b/.test(state.text), state.text.slice(0, 200));
    check(`${label}: no page errors`, player.problems.length === 0, player.problems.slice(0, 4));
  }

  // The server is the authority on who is present; ask it directly too.
  const rooms = await alice.page.evaluate(async () => (await fetch('/api/rooms')).json());
  const total = rooms.rooms.reduce((sum, r) => sum + r.population, 0);
  check('server reports 2 players in a room', total === 2, rooms);

  // Screenshots are a convenience, not a check — and unlike the render probe, the real app
  // never stops requesting animation frames, so Playwright's "wait for the compositor to go
  // idle" can time out on a software rasteriser even though the page is perfectly healthy.
  // Capture one page at a time, and never fail the run over it.
  await bob.page.close();
  for (const [label, page] of [['alice', alice.page]]) {
    try {
      await page.screenshot({ path: resolve(outDir, `${label}.png`), timeout: 60_000 });
      console.log(`  ok   screenshot: ${label}.png`);
    } catch {
      console.log(`  note screenshot skipped for ${label} (compositor busy — not a failure)`);
    }
  }

  await browser.close();
} catch (err) {
  failures++;
  console.error(`  FAIL ${String(err)}`);
} finally {
  await shutdown();
}

console.log(failures === 0 ? '\napp smoke passed' : `\napp smoke failed (${failures})`);
process.exit(failures === 0 ? 0 : 1);
