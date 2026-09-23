#!/usr/bin/env node
/**
 * Private-island smoke test.
 * ==========================
 *
 * The whole stack, in a real browser, doing what the product is *for*: somebody makes a
 * private island, sends the link, and a friend arrives on the same island. Then they
 * whisper, and the interface speaks the language it was asked to.
 *
 *     node tools/island-smoke.mjs
 *
 * What only this can catch: the client reflecting the island into the address bar, an
 * invite link that the entry screen and the handshake actually honour end to end, the
 * visitor key being minted and presented, and the interface's language surviving a load.
 * Exits non-zero on any failure.
 */

import { chromium } from 'playwright-core';
import { shutdown, start, waitForPortsFree } from './stack.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
}

try {
  await waitForPortsFree();
  await start('server', ['run', 'dev', '-w', '@nagisa/server'], /"event":"boot_complete"/, { cwd: root });
  const vite = await start('client', ['run', 'dev', '-w', '@nagisa/client'], /localhost:(\d+)/, { cwd: root });
  const base = `http://localhost:${Number(vite[1])}`;

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });

  /** Open a page (optionally in a language, optionally at a URL), go ashore as `name`. */
  async function enter(name, { lang, url = base } = {}) {
    const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
    if (lang) {
      await context.addInitScript((l) => {
        try {
          const raw = localStorage.getItem('nagisa.settings');
          const settings = raw ? JSON.parse(raw) : {};
          localStorage.setItem('nagisa.settings', JSON.stringify({ ...settings, lang: l }));
        } catch {
          /* storage blocked: the test will say so */
        }
      }, lang);
    }
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForSelector('input', { timeout: 240_000 });
    await page.fill('input', name);
    await page.getByRole('button', { name: /ashore|enter|go|上岸|上陸/i }).first().click();
    await page.waitForFunction(() => Boolean(window.nagisa?.sync?.selfPlayerId), null, { timeout: 60_000 });
    return { page, problems };
  }

  const alice = await enter('Alice', { lang: 'zh' });
  check('the interface speaks Chinese when asked', await alice.page.evaluate(() => document.documentElement.lang.startsWith('zh')));
  const hasVisitor = await alice.page.evaluate(() => /^[A-Za-z0-9_-]{16,64}$/.test(localStorage.getItem('nagisa.visitor') ?? ''));
  check('a visitor key is minted and kept', hasVisitor);

  // Make an island; the address bar should follow.
  await alice.page.evaluate(() => window.nagisa.commands().createIsland());
  await alice.page.waitForFunction(() => new URLSearchParams(location.search).has('island'), null, { timeout: 10_000 });
  const code = await alice.page.evaluate(() => new URLSearchParams(location.search).get('island'));
  check('making an island puts its code in the address bar', /^[2-9A-HJKMNP-Z]{5}$/.test(code ?? ''), code);

  // A friend follows the link.
  const bob = await enter('Bob', { url: `${base}/?island=${code}` });
  await bob.page.waitForTimeout(2500);
  const [aliceId, bobId] = await Promise.all([
    alice.page.evaluate(() => window.nagisa.sync.selfPlayerId),
    bob.page.evaluate(() => window.nagisa.sync.selfPlayerId),
  ]);
  const bobSeesAlice = await bob.page.evaluate((id) => window.nagisa.remote.views().some((p) => p.id === id), aliceId);
  const aliceSeesBob = await alice.page.evaluate((id) => window.nagisa.remote.views().some((p) => p.id === id), bobId);
  check('the friend lands on the same island', bobSeesAlice && aliceSeesBob, { bobSeesAlice, aliceSeesBob });
  const bobUrl = await bob.page.evaluate(() => new URLSearchParams(location.search).get('island'));
  check('…and their address bar names it too', bobUrl === code, bobUrl);

  const publicRooms = await bob.page.evaluate(async () => (await fetch('/api/rooms')).json());
  check('private islands are not in the public listing', publicRooms.rooms.every((r) => r.kind === 'public'), publicRooms);

  // A whisper, UI to UI.
  await alice.page.evaluate((id) => window.nagisa.commands().whisper(id, 'shh'), bobId);
  await bob.page.waitForTimeout(1500);
  const heard = await bob.page.evaluate(() => window.nagisa.chatLog().some((l) => l.text === 'shh' && l.whisper));
  check('a whisper arrives as a whisper', heard);

  for (const [label, p] of [['alice', alice], ['bob', bob]]) {
    check(`${label}: no page errors`, p.problems.length === 0, p.problems.slice(0, 4));
  }
  await browser.close();
} catch (err) {
  failures++;
  console.error(`  FAIL ${String(err)}`);
} finally {
  await shutdown();
}

console.log(failures === 0 ? '\nisland smoke passed' : `\nisland smoke failed (${failures})`);
process.exit(failures === 0 ? 0 : 1);
