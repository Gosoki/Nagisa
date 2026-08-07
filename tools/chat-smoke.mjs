#!/usr/bin/env node
/**
 * Social smoke test.
 * ==================
 *
 * Two real browsers, one real server, and the four things that make this a chat room rather
 * than a scene with people in it:
 *
 * 1. **Chat crosses the wire.** Alice types; Bob's log has the line, attributed to Alice.
 * 2. **A bubble goes up.** The line appears over the speaker's head — and over Alice's own
 *    head too, raised by the server's echo rather than optimistically.
 * 3. **Bubbles expire.** They are not a permanent label.
 * 4. **Follow walks you there.** Bob follows Alice, Alice runs away, Bob closes the gap and
 *    stops at conversational distance rather than inside her.
 *
 *     node tools/chat-smoke.mjs
 *
 * ### Why this cannot be a unit test
 *
 * Every layer is individually testable and none of the failures live in one layer. A chat
 * line has to survive the composer's key handling, the input layer's text-field guard, the
 * socket, the server's rate limiter, the delta packer, and the client's delta handler — and
 * the interesting bugs are all at the seams. The one that motivated this file: `Enter` was
 * bound to *interact* as well as to the composer, so opening the chat box also sat you down
 * on the nearest bench.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { shutdown, start, waitForPortsFree } from './stack.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

  async function enter(name) {
    // Small viewport: fewer pixels means more frames, and follow needs frames to walk.
    const page = await browser.newPage({ viewport: { width: 520, height: 340 } });
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForSelector('input', { timeout: 240_000 });
    await page.fill('input', name);
    await page.getByRole('button', { name: /ashore|enter|go/i }).first().click();
    return { page, problems, name };
  }

  const alice = await enter('Alice');
  const bob = await enter('Bob');
  await alice.page.waitForTimeout(7000);

  // Focus must leave the entry field before any key reaches the world or the composer.
  // `canvas[data-engine]` rather than `canvas`: the minimap is a canvas as well, and a bare
  // selector resolves to two elements and fails Playwright's strict mode.
  //
  // A small *drag*, not a click. A click on the world is now a movement command — it starts
  // autorun — so clicking here to move focus off the entry screen set both characters
  // walking, and Bob spent the follow test strolling away from Alice. A drag is a look
  // gesture, which is what this ever wanted from the canvas.
  for (const p of [alice, bob]) {
    await p.page.evaluate(() => document.activeElement?.blur?.());
    const canvas = p.page.locator('canvas[data-engine]');
    const box = await canvas.boundingBox();
    await p.page.mouse.move(box.x + 260, box.y + 250);
    await p.page.mouse.down();
    await p.page.mouse.move(box.x + 285, box.y + 250, { steps: 5 });
    await p.page.mouse.up();
  }
  await alice.page.waitForTimeout(500);

  // --- 1. Chat crosses the wire -------------------------------------------------------
  // Deliberately contains w, a, s and d: if the composer's focus does not suppress the
  // movement keys, typing this walks Alice into the sea.
  const LINE = 'the tide is out, come and look';
  const beforeTyping = await alice.page.evaluate(() => {
    const p = window.nagisa?.local?.position;
    return p ? { x: p.x, z: p.z } : null;
  });
  await alice.page.keyboard.press('Enter');
  await alice.page.waitForTimeout(300);
  const composerFocused = await alice.page.evaluate(
    () => document.activeElement?.getAttribute('aria-label') === 'Chat message',
  );
  check('Enter opens the composer and focuses it', composerFocused);

  await alice.page.keyboard.type(LINE, { delay: 12 });
  await alice.page.keyboard.press('Enter');

  const aliceId = await alice.page.evaluate(() => window.nagisa?.connection?.welcome?.self ?? null);
  // Assert this before using it. Every check that takes the id as an argument passes
  // vacuously when it is null — `textFor(null)` is null, `positionOf(null)` is undefined,
  // and `following()?.id === null` is true. A test that cannot fail is worse than no test.
  check('Alice has a server-assigned player id', typeof aliceId === 'string' && aliceId.length > 0, {
    aliceId,
    keys: await alice.page.evaluate(() => Object.keys(window.nagisa ?? {})),
  });

  // --- 2. Bubbles go up, checked first because they expire -----------------------------
  //
  // A bubble lives about five seconds. Two SwiftShader browsers on a loaded machine can
  // spend that long on a handful of `evaluate` round trips, so reading it after the log
  // assertions made this check fail for reasons that had nothing to do with bubbles.
  // Poll for it instead, starting immediately, with a deadline well inside the lifetime.
  async function pollBubble(page, id, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = await page.evaluate((pid) => window.nagisa?.speech?.textFor?.(pid) ?? null, id);
      if (text || Date.now() > deadline) return text;
      await page.waitForTimeout(150);
    }
  }
  const bubbleOnBob = await pollBubble(bob.page, aliceId);
  check('Bob sees a bubble over Alice', !!bubbleOnBob, { bubble: bubbleOnBob });
  const bubbleOnAlice = await pollBubble(alice.page, aliceId, 1500);
  check('Alice sees her own bubble (raised by the echo)', !!bubbleOnAlice);

  const bobSeesAlice = await bob.page.evaluate((id) => !!window.nagisa?.remote?.positionOf?.(id), aliceId);
  check('Bob has Alice in his remote players', bobSeesAlice, {
    known: await bob.page.evaluate(() => (window.nagisa?.remote?.views?.() ?? []).map((v) => v.id)),
  });

  const bobLog = await bob.page.evaluate(() => window.nagisa?.chatLog?.() ?? []);
  const received = bobLog.find((l) => l.text === LINE);
  check("Bob's log has Alice's line", !!received, { tail: bobLog.slice(-3) });
  check('the line is attributed to Alice', received?.name === 'Alice', { name: received?.name });
  check('it is not marked as Bob’s own', received?.self === false);

  const aliceLog = await alice.page.evaluate(() => window.nagisa?.chatLog?.() ?? []);
  const mine = aliceLog.find((l) => l.text === LINE);
  check('Alice sees her own line, marked as hers', mine?.self === true);
  check(
    'the line is not duplicated by the server echo',
    aliceLog.filter((l) => l.text === LINE).length === 1,
    { count: aliceLog.filter((l) => l.text === LINE).length },
  );

  const afterTyping = await alice.page.evaluate(() => {
    const p = window.nagisa?.local?.position;
    return p ? { x: p.x, z: p.z } : null;
  });
  const drift =
    beforeTyping && afterTyping
      ? Math.hypot(afterTyping.x - beforeTyping.x, afterTyping.z - beforeTyping.z)
      : null;
  // Half a metre of slack for the settle of whatever the drag on the canvas started.
  check('typing did not move Alice', drift !== null && drift < 0.5, {
    drift: drift?.toFixed?.(2),
    from: beforeTyping,
    to: afterTyping,
  });

  // --- 3. Bubbles expire --------------------------------------------------------------
  await alice.page.waitForTimeout(9500);
  const expired = await bob.page.evaluate((id) => window.nagisa?.speech?.textFor?.(id) ?? null, aliceId);
  check('the bubble expires', expired === null, { still: expired });

  // --- 4. Follow ----------------------------------------------------------------------
  await alice.page.keyboard.press('Escape'); // close the composer
  await bob.page.evaluate((id) => window.nagisa?.commands?.()?.follow?.(id) ?? null, aliceId);
  // The command surface is a store, not on `nagisa`; drive it through the panel instead if
  // the direct call was unavailable.
  const followingVia = await bob.page.evaluate(() => window.nagisa?.following?.()?.id ?? null);
  if (!followingVia) {
    await bob.page.getByRole('button', { name: /people|who/i }).first().click().catch(() => {});
    await bob.page.waitForTimeout(400);
    await bob.page.getByRole('button', { name: /^Follow$/ }).first().click().catch(() => {});
    await bob.page.waitForTimeout(400);
  }
  check('Bob is following Alice', (await bob.page.evaluate(() => window.nagisa?.following?.()?.id ?? null)) === aliceId);

  const gapBefore = await bob.page.evaluate((id) => {
    const me = window.nagisa?.local?.position;
    const them = window.nagisa?.remote?.positionOf?.(id);
    return me && them ? Math.hypot(me.x - them.x, me.z - them.z) : null;
  }, aliceId);

  // Alice runs away for a few seconds.
  await alice.page.keyboard.down('ShiftLeft');
  await alice.page.keyboard.down('KeyW');
  await alice.page.waitForTimeout(4000);
  await alice.page.keyboard.up('KeyW');
  await alice.page.keyboard.up('ShiftLeft');

  /**
   * Bob walks; wait until he has arrived, or until we give up.
   *
   * Not a fixed sleep. Following is done in frames, and the number of frames inside a wall
   * clock second is not a constant on SwiftShader — run this immediately after two other
   * browser tools and the machine delivers a fraction of them. A fixed twelve seconds
   * therefore passed alone and failed in a batch, which is the worst possible behaviour for
   * a test: it fails for a reason that is not in the code, on the runs where you are least
   * able to tell.
   *
   * Polling the thing actually being asserted removes the whole class. The deadline is
   * generous because it is a backstop, not the expectation.
   */
  const measureGap = () =>
    bob.page.evaluate((id) => {
      const me = window.nagisa?.local?.position;
      const them = window.nagisa?.remote?.positionOf?.(id);
      return me && them ? Math.hypot(me.x - them.x, me.z - them.z) : null;
    }, aliceId);

  let gapAfter = await measureGap();
  const followDeadline = Date.now() + 40_000;
  while (Date.now() < followDeadline) {
    // Arrived: inside conversational distance and no longer closing.
    if (gapAfter !== null && gapBefore !== null && gapAfter <= gapBefore + 1 && gapAfter < 4) break;
    await bob.page.waitForTimeout(500);
    gapAfter = await measureGap();
  }
  const bobMoved = await bob.page.evaluate(() => {
    const p = window.nagisa?.local?.position;
    return p ? { x: +p.x.toFixed(1), z: +p.z.toFixed(1) } : null;
  });

  check('the gap was measurable at both ends', gapBefore !== null && gapAfter !== null, { gapBefore, gapAfter });
  check('Bob closed the distance to Alice', gapAfter !== null && gapBefore !== null && gapAfter <= gapBefore + 1, {
    before: gapBefore?.toFixed?.(1),
    after: gapAfter?.toFixed?.(1),
    bob: bobMoved,
  });
  check('Bob did not walk into Alice', gapAfter !== null && gapAfter > 0.6, { after: gapAfter?.toFixed?.(2) });

  check('no page errors on either client', alice.problems.length === 0 && bob.problems.length === 0, {
    alice: alice.problems.slice(0, 2),
    bob: bob.problems.slice(0, 2),
  });

  await browser.close();
} catch (err) {
  failures++;
  console.error(`  FAIL ${String(err)}`);
} finally {
  await shutdown();
}

console.log(failures === 0 ? '\nchat smoke passed' : `\nchat smoke failed (${failures})`);
process.exit(failures === 0 ? 0 : 1);
