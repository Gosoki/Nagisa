#!/usr/bin/env node
/**
 * Screenshot tool — development only.
 * ===================================
 *
 * Starts the Vite dev server, drives `apps/client/probe.html` in headless Chromium and
 * writes a PNG per viewpoint. This is how the art direction gets reviewed on a machine
 * with no display: the renderer's failure modes are pictures, so the feedback loop has to
 * produce pictures.
 *
 *     node tools/shot.mjs                       # every viewpoint, default time of day
 *     node tools/shot.mjs plaza street          # named viewpoints only
 *     node tools/shot.mjs --time 0.78 --out dusk
 *
 * Chromium runs on SwiftShader, so this is a *correctness* check, not a performance one —
 * the draw-call and triangle counts it prints are real, the frame rate is not.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { shutdown, start, waitForPortsFree } from './stack.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const FLAGS = new Set(['time', 'tier', 'ink', 'out', 'width', 'height', 'debug', 'inkdebug']);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = resolve(root, flag('out', 'shots'));
const time = flag('time', '0.42');
const tier = flag('tier', 'high');
const ink = flag('ink', '1');
const debug = flag('debug', '');
const inkDebug = flag('inkdebug', '');
// Which map pack to render. The probe passes it straight through to the client, which
// activates it before building anything — see \`main.ts\`.
const map = flag('map', '');
const width = Number(flag('width', '1280'));
const height = Number(flag('height', '760'));

// Positional arguments are viewpoint names: anything that is neither a --flag nor the
// value immediately following one.
const views = args.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const previous = args[i - 1];
  return !(previous?.startsWith('--') && FLAGS.has(previous.slice(2)));
});

const ALL_VIEWS = ['island', 'arrival', 'gameplay', 'quay', 'plaza', 'street', 'shrine', 'summit', 'lighthouse', 'teahouse', 'north', 'beach', 'slopes', 'figure'];
// Plan views are not in the default sweep — they are slow (one island build each) and
// they answer a layout question rather than an art-direction one. Ask for them by name:
//   node tools/shot.mjs plan-street plan-summit
const PLAN_VIEWS = ['plan-island', 'plan-summit', 'plan-shrine', 'plan-street', 'plan-plaza', 'plan-south', 'plan-north', 'plan-lighthouse', 'plan-beach'];
const targets = views.length === 0 ? ALL_VIEWS : views.flatMap((v) => (v === 'plans' ? PLAN_VIEWS : [v]));

mkdirSync(outDir, { recursive: true });

// --- Vite ---------------------------------------------------------------------------
//
// Started and stopped through `tools/stack.mjs`, like every other browser tool. Its own
// copy used to kill the npm wrapper and leave the Vite process behind, which held :5173 and
// made whichever smoke test ran next fail for a reason that had nothing to do with it.

await waitForPortsFree([5173]);
const viteMatch = await start('vite', ['run', 'dev', '-w', '@nagisa/client'], /localhost:(\d+)/, {
  cwd: root,
  timeoutMs: 60_000,
});
const port = Number(viteMatch[1]);

console.log(`vite on :${port}`);

// --- Browser ------------------------------------------------------------------------

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
});

let failures = 0;

try {
  const page = await browser.newPage({ viewport: { width, height } });
  const problems = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning' || process.env.SHOT_VERBOSE) {
      problems.push(`[${type}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`[pageerror] ${err.message}`));

  for (const view of targets) {
    problems.length = 0;
    const url = `http://localhost:${port}/probe.html?view=${view}&time=${time}&tier=${tier}&ink=${ink}&debug=${debug}&inkdebug=${inkDebug}&map=${map}`;
    await page.goto(url, { waitUntil: 'load' });
    try {
      // SwiftShader builds the island slowly — the terrain mesh alone is 160k height
      // evaluations — so the budget here is generous on purpose.
      await page.waitForFunction(() => window.__probeReady === true, null, { timeout: 240_000 });
    } catch {
      failures++;
      console.error(`  x ${view}: never became ready`);
    }
    // Stop the loop unconditionally: a view that never reported ready is usually still
    // rendering, and Playwright will not capture a page whose compositor is busy.
    await page.evaluate(() => window.__probeStop?.()).catch(() => {});
    const info = await page.evaluate(() => window.__probeInfo ?? null).catch(() => null);
    try {
      await page.screenshot({ path: resolve(outDir, `${view}.png`), timeout: 120_000, animations: 'disabled' });
    } catch (err) {
      failures++;
      console.log(`  x ${view.padEnd(11)} screenshot failed: ${String(err).split('\n')[0]}`);
      continue;
    }
    console.log(`  - ${view.padEnd(11)} ${info ? `draws ${info.drawCalls} tris ${info.triangles} ink ${info.ink}` : 'no info'}`);
    for (const problem of problems.slice(0, Number(process.env.SHOT_PROBLEMS ?? 6))) {
      failures++;
      console.log(`      ${problem.slice(0, 400)}`);
    }
  }
} finally {
  await browser.close();
  await shutdown();
}

console.log(failures === 0 ? `\nwrote ${targets.length} shots to ${outDir}` : `\n${failures} problem(s); shots in ${outDir}`);
process.exit(0);
