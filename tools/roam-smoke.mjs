#!/usr/bin/env node
/**
 * Roaming smoke test.
 * ===================
 *
 * Boots the real stack, walks a player around the island for a sustained period, and fails
 * if the server ever corrects them.
 *
 * This is the check for the bug that reads as "I get randomly teleported while running".
 * A correction is the server disagreeing with the client about where the player may be, and
 * every layer below this one can be individually correct while that still happens — the
 * unit tests validate the server's rule, `world-smoke` simulates the client's rule against
 * it, but only driving the actual client with the actual input system against the actual
 * server exercises the whole loop.
 *
 *     node tools/roam-smoke.mjs
 *     node tools/roam-smoke.mjs --seconds 90
 *
 * ### What this covers, and what it does not
 *
 * The simulation is fixed-step, and the frame loop caps how many steps one frame may run —
 * otherwise a stall would launch the character across the island. On SwiftShader a frame of
 * this scene costs the better part of a second, so that cap, not the wall clock, is what
 * limits how far the player gets: expect tens of metres, not hundreds. Shrinking the
 * viewport does not help, because the cost is geometry rather than pixels.
 *
 * So this is a **smoke test, not a coverage test**. Exhaustive coverage of the walkability
 * contract belongs to `world-smoke`, which simulates the same client rule against the same
 * server rule over 110 000 steps in milliseconds, and which reports about 4 800 violations
 * if the client's rule is reverted to the pre-fix version.
 *
 * What only this test can prove is that the *live loop* agrees with them: real key events
 * through the real input system, the real client integrator, a real socket, and the real
 * server validator, with the player leaving the flat spawn terrace. If any of those links
 * is wired to a different rule than the tests below it, the player gets corrected here.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const seconds = Number(flag('seconds', '90'));

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const children = [];
let failures = 0;

function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

function start(name, npmArgs, ready, timeoutMs = 120_000) {
  const child = spawn('npm', npmArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${name} not ready in ${timeoutMs}ms`)), timeoutMs);
    let buffer = '';
    const scan = (chunk) => {
      buffer += chunk.toString().replace(ANSI, '');
      const match = buffer.match(ready);
      if (match) {
        clearTimeout(timer);
        res(match);
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
  });
}

try {
  await start('server', ['run', 'dev', '-w', '@nagisa/server'], /"event":"boot_complete"/);
  const viteMatch = await start('client', ['run', 'dev', '-w', '@nagisa/client'], /localhost:(\d+)/);
  const port = Number(viteMatch[1]);
  console.log(`  ok   stack up on :${port}`);

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  // Small on purpose: fewer pixels means more frames, and frames are what move the player.
  const page = await browser.newPage({ viewport: { width: 420, height: 280 } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForSelector('input', { timeout: 240_000 });
  await page.fill('input', 'Roamer');
  await page.getByRole('button', { name: /ashore|enter|go/i }).first().click();
  await page.waitForTimeout(4000);

  // Move focus off the entry field before sending keys. The input system ignores key
  // events whose target is a text field — correctly, so typing a name does not walk you
  // into the sea — and Playwright's synthetic events go to whatever holds focus.
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.locator('canvas[data-engine]').click({ position: { x: 210, y: 200 } });
  await page.waitForTimeout(500);

  // Count corrections by watching the player's position for discontinuities the client's
  // own physics could not have produced. A correction snaps you; running does not.
  await page.evaluate(() => {
    window.__roam = { jumps: [], samples: 0, distance: 0, minY: Infinity, maxY: -Infinity };
    let previous = null;
    setInterval(() => {
      // Re-read the debug surface every sample. It is a getter over the app's live fields,
      // and the local player is a different object after the entry screen than before it.
      const p = window.nagisa?.local?.position;
      if (!p) return;
      const state = window.__roam;
      state.samples++;
      state.minY = Math.min(state.minY, p.y);
      state.maxY = Math.max(state.maxY, p.y);
      if (previous) {
        const step = Math.hypot(p.x - previous.x, p.z - previous.z);
        state.distance += step;
        // 100 ms of running is under a metre. Three metres in one sample is a teleport.
        if (step > 3) state.jumps.push({ from: [+previous.x.toFixed(1), +previous.z.toFixed(1)], to: [+p.x.toFixed(1), +p.z.toFixed(1)], step: +step.toFixed(1) });
      }
      previous = { x: p.x, y: p.y, z: p.z };
    }, 100);
  });

  // Hold shift (run) and steer through a long circuit of turns, so the player crosses
  // terraces, road shoulders, the shoreline and the mountain rather than one flat patch.
  // Weighted toward forward: the spawn faces the mountain, so holding W climbs inland
  // across the shelf and the road cuttings rather than circling the flat quay.
  const TURNS = ['KeyW', 'KeyW', 'KeyW', 'KeyD', 'KeyW', 'KeyW', 'KeyA', 'KeyW', 'KeyW', 'KeyD', 'KeyW', 'KeyW'];
  await page.keyboard.down('ShiftLeft');
  const deadline = Date.now() + seconds * 1000;
  let i = 0;
  while (Date.now() < deadline) {
    const key = TURNS[i++ % TURNS.length];
    await page.keyboard.down(key);
    await page.waitForTimeout(3500);
    await page.keyboard.up(key);
  }
  await page.keyboard.up('ShiftLeft');

  const roam = await page.evaluate(() => ({ ...window.__roam, jumps: window.__roam.jumps.slice(0, 6) }));

  // Thresholds are what a software rasteriser can actually reach in the time — see the
  // header. They are here to prove the player moved *and left the flat spawn terrace*, so
  // that "never corrected" means something.
  check('the player covered ground', roam.distance > 15, { metres: Math.round(roam.distance) });
  check('the player left the flat spawn terrace', roam.maxY - roam.minY > 0.8, {
    range: `${roam.minY?.toFixed?.(1)}–${roam.maxY?.toFixed?.(1)}`,
  });
  check('the server never corrected the player', roam.jumps.length === 0, roam.jumps);
  check('the player stayed above the seabed', roam.minY > -2, { minY: roam.minY?.toFixed?.(2) });
  check('no page errors while roaming', pageErrors.length === 0, pageErrors.slice(0, 3));
  console.log(`       roamed ${Math.round(roam.distance)} m over ${roam.samples} samples, y ${roam.minY?.toFixed?.(1)}–${roam.maxY?.toFixed?.(1)}`);

  await browser.close();
} catch (err) {
  failures++;
  console.error(`  FAIL ${String(err)}`);
} finally {
  for (const child of children) child.kill('SIGTERM');
}

console.log(failures === 0 ? '\nroam smoke passed' : `\nroam smoke failed (${failures})`);
process.exit(failures === 0 ? 0 : 1);
