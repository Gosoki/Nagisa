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
const seconds = Number(flag('seconds', '90'));

let failures = 0;

function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

try {
  // A run against a stack this process did not start proves nothing about this working
  // tree — and Vite would quietly take :5174 and let every check pass on a stale bundle.
  await waitForPortsFree();
  await start('server', ['run', 'dev', '-w', '@nagisa/server'], /"event":"boot_complete"/, { cwd: root });
  const viteMatch = await start('client', ['run', 'dev', '-w', '@nagisa/client'], /localhost:(\d+)/, { cwd: root });
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
  const where = () =>
    page.evaluate(() => {
      const p = window.nagisa?.local?.position;
      return p ? { x: p.x, z: p.z } : null;
    });
  await page.keyboard.down('ShiftLeft');
  // Bounded by ground covered, not by wall-clock seconds.
  //
  // The physics is driven by the frame loop, and under software WebGL this page runs at a
  // small fraction of real time — so a fixed number of seconds bought anywhere between 40 m
  // and 200 m of walking depending on how busy the machine was, and "the player left the flat
  // spawn terrace" passed or failed on that. The harbour's flat is 28 m across; asking for a
  // distance is asking the question the check actually depends on. The clock stays as a
  // backstop so a wedged run still ends.
  const TARGET_METRES = 150;
  const deadline = Date.now() + seconds * 4000;
  let i = 0;
  let last = await where();
  while (Date.now() < deadline) {
    const covered = await page.evaluate(() => window.__roam?.distance ?? 0);
    if (covered > TARGET_METRES) break;
    // Turn away from whatever is in the way rather than leaning on it.
    //
    // The route was a fixed key sequence, so whether the run covered the island or spent
    // twenty seconds pressed against one wall came down to luck — and the suite's verdict
    // came with it. A stage at the south harbour, twenty metres due north of the spawn, was
    // enough to wedge it. Steering on "did I move" is what the test always meant.
    const now = await where();
    const stuck = last && now && Math.hypot(now.x - last.x, now.z - last.z) < 1;
    last = now;
    const key = stuck ? (i % 2 === 0 ? 'KeyD' : 'KeyA') : TURNS[i % TURNS.length];
    i++;
    await page.keyboard.down(key);
    await page.waitForTimeout(stuck ? 1200 : 3500);
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

  // --- Autorun: click the world to walk forward, click again to stop ------------------
  //
  // Driven through the real canvas, because every bug this control had was in the wiring
  // rather than in the logic: clicking "Go ashore" set the character autorunning, because
  // the overlay's buttons are inside the element the world listens on; and a duration-based
  // click test read a 40 ms click as 2441 ms, because event handlers run late on a loaded
  // main thread. Neither is visible from anywhere but a browser.
  {
    const box = await (await page.$('canvas')).boundingBox();
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.62;
    const isOn = () => page.evaluate(() => document.body.innerText.includes('click to stop'));
    const pose = () =>
      page.evaluate(() => {
        const p = window.nagisa?.local?.position;
        return p ? { x: p.x, z: p.z } : null;
      });
    const travel = async (ms) => {
      const before = await pose();
      await page.waitForTimeout(ms);
      const after = await pose();
      return before && after ? Math.hypot(after.x - before.x, after.z - before.z) : 0;
    };

    // Turn until forward is open. Whichever way the roam happened to leave the character
    // pointing, at least one quarter turn has somewhere to walk; testing the bearing it
    // stopped on tests the scenery.
    const faceOpenGround = async () => {
      for (let turn = 0; turn < 4; turn++) {
        await page.keyboard.down('KeyW');
        const probe = await travel(700);
        await page.keyboard.up('KeyW');
        await page.waitForTimeout(200);
        if (probe > 0.05) return true;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 490, cy, { steps: 14 });
        await page.mouse.up();
      }
      return false;
    };

    // A drag orbits the camera and must not be mistaken for a click.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    check('a drag orbits and does not start autorun', !(await isOn()));

    // The forward key first, as the baseline. Measuring autorun first walked the character
    // into whatever was ahead, and then W had nowhere to go and the comparison read zero.
    await faceOpenGround();
    await page.keyboard.down('KeyW');
    const byKey = await travel(2500);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(400);

    await faceOpenGround();
    await page.mouse.click(cx, cy, { delay: 40 });
    await page.waitForTimeout(400);
    check('a click starts autorun', await isOn());
    const byClick = await travel(2500);

    // Compared against W rather than against a distance in metres. Absolute thresholds do
    // not survive this harness: the physics is driven by the frame loop and under software
    // WebGL the page runs at a fraction of real time, so "walked 2 m in 2 s" fails a control
    // that works perfectly. Loosely, though — the two windows are timed separately and the
    // frame rate wanders between them, so the ratio carries noise that says nothing about
    // the control. The regression worth catching is "a click does nothing".
    check(
      'autorun walks the character as far as the forward key does',
      byClick > 0.2 && byKey > 0.15 && byClick > byKey * 0.4,
      `click ${byClick.toFixed(2)} m vs W ${byKey.toFixed(2)} m`,
    );

    // Taking the controls back cancels it.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(300);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(400);
    check('taking the controls back cancels autorun', !(await isOn()));

    // And clicking again stops it.
    await page.mouse.click(cx, cy, { delay: 40 });
    await page.waitForTimeout(400);
    const restarted = await isOn();
    await page.mouse.click(cx, cy, { delay: 40 });
    await page.waitForTimeout(400);
    check('a second click stops autorun', restarted && !(await isOn()));
  }

  await browser.close();
} catch (err) {
  failures++;
  console.error(`  FAIL ${String(err)}`);
} finally {
  await shutdown();
}

console.log(failures === 0 ? '\nroam smoke passed' : `\nroam smoke failed (${failures})`);
process.exit(failures === 0 ? 0 : 1);
