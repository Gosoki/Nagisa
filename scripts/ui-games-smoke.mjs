#!/usr/bin/env node
/**
 * Game interface mount smoke test.
 * ================================
 *
 * The companion of `ui-smoke.mjs`, for the game cards and panels: the ○× quiz card, the
 * fishing line, the omikuji slip, the janken card, the player card, and the bodies of the
 * notice board, collection and island panels.
 *
 * Each is mounted **on its own**, not through the overlay, so this test does not depend on
 * how (or whether) `Overlay.svelte` and `Panels.svelte` place them — that is `ui-smoke.mjs`'s
 * business. Then the stores are driven through every state the server can put them in (each
 * quiz phase, a bite and a catch, a slip, each step of a duel, a selected player, a profile,
 * a guestbook, a private island) and each component is asserted to show its key text, to
 * call the right command when its controls are used, and not to throw.
 *
 * It also checks the words: that the three languages of `i18n/games.ts` hold exactly the same
 * keys, that every key these components ask for exists, and that a tour of every state in
 * Chinese and Japanese never shows a raw key.
 *
 * Needs `npm run build:shared` first, like every tool that loads `@nagisa/shared`.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir } from './lib/bundle-run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = scratchDir('ui-games-smoke');
const slash = (p) => p.replace(/\\/g, '/');

/** The components under test, by file name in `apps/client/src/ui/`. */
const COMPONENTS = [
  'QuizHud',
  'FishingHud',
  'OmikujiCard',
  'JankenCard',
  'PlayerCard',
  'BoardPanel',
  'CollectionPanel',
  'IslandPanel',
  'TreasureHud',
];

/**
 * Keys the components ask for with a literal `$t('…')`, read straight from their source, so
 * a typo'd key fails here rather than showing up as a raw key on somebody's screen. Keys
 * built at runtime (`rarity.${…}`, `hand.${…}`, `janken.cancel.${…}`) are covered by the
 * language tour instead.
 */
const usedKeys = new Set();
for (const name of COMPONENTS) {
  const src = readFileSync(join(root, 'apps/client/src/ui', `${name}.svelte`), 'utf8');
  for (const m of src.matchAll(/\$t\(\s*'([a-zA-Z0-9_.]+)'/g)) usedKeys.add(m[1]);
  for (const m of src.matchAll(/'((?:quiz|fish|omikuji|janken|player|board|collection|island|ago|game)\.[a-zA-Z0-9_.]+)'/g)) {
    usedKeys.add(m[1]);
  }
}

let status = 1;

try {
  const entry = join(outDir, 'entry.js');
  writeFileSync(
    entry,
    `
    import { mount, unmount, flushSync } from 'svelte';
    import * as stores from '${slash(join(root, 'apps/client/src/state/stores.ts'))}';
    import { GAMES } from '${slash(join(root, 'apps/client/src/i18n/games.ts'))}';
    import * as shared from '@nagisa/shared';
    ${COMPONENTS.map((c) => `import ${c} from '${slash(join(root, 'apps/client/src/ui', `${c}.svelte`))}';`).join('\n    ')}
    globalThis.__games = {
      mount, unmount, flushSync, stores, GAMES, shared,
      components: { ${COMPONENTS.join(', ')} },
    };
    `,
  );

  // The same build as ui-smoke.mjs, and for the same reasons: a browser-flavoured library
  // build (Svelte 5's mount() refuses to run from an SSR build) with CSS left in the
  // components so Node never has to load a stylesheet.
  const configPath = join(outDir, 'vite.games.config.mjs');
  writeFileSync(
    configPath,
    `
    import { svelte } from '${slash(join(root, 'node_modules/@sveltejs/vite-plugin-svelte/src/index.js'))}';
    export default {
      plugins: [svelte({ emitCss: false, compilerOptions: { hmr: false } })],
      resolve: { conditions: ['browser'] },
      build: {
        outDir: '${slash(outDir)}',
        emptyOutDir: false,
        minify: false,
        target: 'esnext',
        cssCodeSplit: false,
        lib: { entry: '${slash(entry)}', formats: ['es'], fileName: () => 'games.mjs' },
      },
    };
    `,
  );

  const build = spawnSync(join(root, 'node_modules/.bin/vite'), ['build', '--config', configPath, '--logLevel', 'error'], {
    cwd: join(root, 'apps/client'),
    stdio: 'inherit',
  });
  if (build.status !== 0) throw new Error('vite build of the game components failed');

  const runner = join(outDir, 'run.mjs');
  writeFileSync(
    runner,
    `
import { JSDOM } from 'jsdom';
import { setTimeout as sleep } from 'node:timers/promises';

const USED_KEYS = ${JSON.stringify([...usedKeys].sort())};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === 'undefined' || key in globalThis) continue;
  try { Object.defineProperty(globalThis, key, { get: () => dom.window[key], configurable: true }); } catch {}
}
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
if (!globalThis.matchMedia) globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

await import('${slash(join(outDir, 'games.mjs'))}');
const { mount, unmount, flushSync, stores, GAMES, shared, components } = globalThis.__games;
const doc = dom.window.document;

let failures = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (ok) console.log('  \\u2714 ' + name);
  else { failures++; console.log('  \\u2718 ' + name); if (detail !== undefined) console.log('      ' + String(detail).slice(0, 400)); }
};
const settle = async (ms = 30) => { flushSync(); await sleep(ms); flushSync(); };
const box = (name) => doc.getElementById('host-' + name);
const text = (name) => (box(name)?.textContent ?? '').replace(/\\s+/g, ' ');
const buttonsIn = (name) => [...box(name).querySelectorAll('button')];
const button = (name, re) => buttonsIn(name).find((b) => re.test(b.textContent.trim()));
const key = (k, target = dom.window) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
async function type(input, value) {
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await settle();
}

// ---------------------------------------------------------------------------------------
console.log('\\nDictionary');
const keysOf = (l) => new Set(Object.keys(GAMES[l]));
for (const l of ['zh', 'ja']) {
  const missing = [...keysOf('en')].filter((k) => !keysOf(l).has(k));
  const extra = [...keysOf(l)].filter((k) => !keysOf('en').has(k));
  check(l + ' has every English key and no others', missing.length === 0 && extra.length === 0, 'missing ' + missing.join(', ') + ' / extra ' + extra.join(', '));
}
const placeholders = (s) => [...s.matchAll(/\\{(\\w+)\\}/g)].map((m) => m[1]).sort().join(',');
const badPlaceholders = [];
for (const k of Object.keys(GAMES.en)) {
  for (const l of ['zh', 'ja']) if (GAMES[l][k] !== undefined && placeholders(GAMES[l][k]) !== placeholders(GAMES.en[k])) badPlaceholders.push(l + ':' + k);
}
check('every translation keeps the same placeholders', badPlaceholders.length === 0, badPlaceholders.join(', '));
const unknown = USED_KEYS.filter((k) => !(k in GAMES.en));
check('every key the components ask for exists', unknown.length === 0, unknown.join(', '));
const dynamic = [
  ...['common', 'uncommon', 'rare', 'epic', 'legendary', 'junk'].map((r) => 'rarity.' + r),
  ...shared.HANDS.map((h) => 'hand.' + h),
  ...['declined', 'timeout', 'left', 'busy', 'far', 'other'].map((r) => 'janken.cancel.' + r),
  ...['hot', 'warm', 'cool', 'cold'].map((h) => 'treasure.heat.' + h),
  ...shared.DAILY_KINDS.map((k) => 'daily.task.' + k),
];
check('every key built at runtime exists', dynamic.every((k) => k in GAMES.en), dynamic.filter((k) => !(k in GAMES.en)).join(', '));

// ---------------------------------------------------------------------------------------
console.log('\\nMount');
stores.settings.update((s) => ({ ...s, lang: 'en' }));
const sent = [];
const spy = (name) => (...args) => sent.push([name, ...args]);
const called = (name, ...args) => sent.some((c) => c[0] === name && args.every((a, i) => c[i + 1] === a));
stores.commands.update((c) => ({
  ...c,
  ...Object.fromEntries(
    ['fishHook', 'fishStop', 'jankenRespond', 'jankenThrow', 'jankenChallenge', 'whisper', 'follow', 'admin',
     'guestbookWrite', 'guestbookRemove', 'setTitle', 'createIsland', 'joinIsland', 'dig', 'friend'].map((n) => [n, spy(n)]),
  ),
}));

const arena = shared.QUIZ_ARENA;
const plazaName = shared.getZone('plaza')?.name;
stores.self.update((s) => ({ ...s, id: 'p1', name: 'Sawada', zone: 'plaza', role: 0, activity: null, mode: null }));
const KEEPER = { id: 'p2', name: 'Keeper', appearance: { outfit: 1, skin: 1, accessory: 0 }, role: 0, pos: [0, 8, 0], yaw: 0, anim: 0, zone: 'plaza', activity: 'a1', mode: 'participant', title: 'angler' };
const RIN = { id: 'p3', name: 'Rin', appearance: { outfit: 2, skin: 2, accessory: 1 }, role: 0, pos: [4, 8, 2], yaw: 0, anim: 0, zone: 'shrine', activity: null, mode: null };
stores.players.set([KEEPER, RIN]);
const activity = (id, title, state, extra = {}) => ({
  id, title, blurb: '', zone: 'plaza', state, startsAt: Date.now(), endsAt: null, hostId: null, hostName: null,
  participantCount: 0, audienceCount: 0, capacity: 0, checkinEnabled: false, checkinCount: 0, templateId: 'custom', feature: null, ...extra,
});
stores.activities.set([
  activity('a1', 'Lantern Walk', 'open'),
  activity('q1', 'Plaza Quiz', 'live', { feature: 'quiz' }),
  activity('old', 'Yesterday', 'ended'),
]);

const mounted = {};
for (const name of ${JSON.stringify(COMPONENTS)}) {
  const host = doc.createElement('div');
  host.id = 'host-' + name;
  doc.body.appendChild(host);
  try {
    mounted[name] = mount(components[name], { target: host });
    check(name + ' mounts', true);
  } catch (err) {
    check(name + ' mounts', false, err && err.stack);
  }
}
await settle();
check('the cards stay out of sight while nothing is happening',
  ['QuizHud', 'FishingHud', 'OmikujiCard', 'JankenCard', 'PlayerCard', 'TreasureHud'].every((n) => text(n).trim() === ''),
  ['QuizHud', 'FishingHud', 'OmikujiCard', 'JankenCard', 'PlayerCard', 'TreasureHud'].map((n) => n + ':' + text(n).slice(0, 40)).join(' | '));

// ---------------------------------------------------------------------------------------
console.log('\\n○× quiz');
const Q = shared.QUIZ_BANK[0];
const quizBase = { activity: 'q1', round: 0, totalRounds: 8, questionId: null, alive: [] };
stores.quiz.set({ ...quizBase, phase: 'lobby', endsAt: Date.now() + 20_000 });
await settle();
check('the lobby calls people to the plaza', text('QuizHud').includes('Starting soon') && text('QuizHud').includes(plazaName), text('QuizHud'));
check('the lobby counts down in whole seconds', /\\b(19|20)s\\b/.test(text('QuizHud')), text('QuizHud'));
check('the card is a status region', !!box('QuizHud').querySelector('[role="status"]'));

stores.selfPose.x = 0; stores.selfPose.z = 0;
stores.quiz.set({ ...quizBase, phase: 'question', round: 1, questionId: Q.id, endsAt: Date.now() + 15_000, alive: ['p1', 'p2'] });
await settle(60);
check('a question shows its statement', text('QuizHud').includes(Q.en), text('QuizHud'));
check('and which round of how many', text('QuizHud').includes('Question 1 of 8'));
check('and how many are still in', text('QuizHud').includes('2 still in'));
check('and says you are not in a circle', text('QuizHud').includes('Not inside a circle'), text('QuizHud'));
check('the countdown is a timer, not a live announcement', box('QuizHud').querySelector('[role="timer"]')?.getAttribute('aria-live') === 'off');
if (arena) {
  stores.selfPose.x = arena.o.x; stores.selfPose.z = arena.o.z;
  await settle(260);
  check('walking into ○ is noticed', text('QuizHud').includes('You are standing in ○'), text('QuizHud'));
  stores.selfPose.x = arena.x.x; stores.selfPose.z = arena.x.z;
  await settle(260);
  check('and into ×', text('QuizHud').includes('You are standing in ×'), text('QuizHud'));
}

stores.quiz.set({ ...quizBase, phase: 'reveal', round: 1, questionId: Q.id, endsAt: Date.now() + 6000, answer: Q.answer, alive: ['p1'], fell: ['p2'] });
await settle();
check('the reveal shows the answer', text('QuizHud').includes(Q.answer ? 'True' : 'False') && text('QuizHud').includes(Q.answer ? '○' : '×'), text('QuizHud'));
check('and the explanation', text('QuizHud').includes(Q.explain.en));
check('and who went out', text('QuizHud').includes('1 went out'));
check('and your verdict', text('QuizHud').includes('You are still in'));
check('and no countdown', !box('QuizHud').querySelector('[role="timer"]'));

stores.quiz.set({ ...quizBase, phase: 'question', round: 2, questionId: shared.QUIZ_BANK[1].id, endsAt: Date.now() + 15_000, alive: ['p2'] });
await settle();
check('a contestant who fell keeps the card, as a spectator', text('QuizHud').includes('You are out — watching now'), text('QuizHud'));

stores.quiz.set({ ...quizBase, phase: 'finished', round: 3, endsAt: Date.now() + 8000, alive: ['p1', 'p2'], winners: ['p2', 'p1'] });
await settle();
check('the finish names the winners, you first', /Winners.*Sawada \\(you\\), Keeper/.test(text('QuizHud')), text('QuizHud'));

stores.quiz.set({ ...quizBase, activity: 'q2', phase: 'question', round: 1, questionId: Q.id, endsAt: Date.now() + 15_000, alive: ['p2'] });
await settle();
check('someone on the plaza who is not playing is watching', text('QuizHud').includes('Watching') && !text('QuizHud').includes('You are out'), text('QuizHud'));

stores.self.update((s) => ({ ...s, zone: 'beach' }));
stores.quiz.set({ ...quizBase, activity: 'q3', phase: 'lobby', endsAt: Date.now() + 20_000 });
await settle();
check('nobody away from the plaza is shown a quiz they are not in', text('QuizHud').trim() === '', text('QuizHud'));
stores.self.update((s) => ({ ...s, activity: 'q3' }));
await settle();
check('unless they joined it', text('QuizHud').includes('Starting soon'));
stores.self.update((s) => ({ ...s, zone: 'plaza', activity: null }));
stores.quiz.set(null);
await settle();
check('and it is gone with the quiz', text('QuizHud').trim() === '');

// ---------------------------------------------------------------------------------------
console.log('\\nFishing');
const line = (phase, extra = {}) => ({ phase, spot: 'fish-beach', biteAt: 0, window: 0, caught: null, reason: null, byMe: false, ...extra });
stores.fishing.set(line('waiting'));
await settle();
check('waiting says so', text('FishingHud').includes('Waiting for a bite'));
button('FishingHud', /^Reel in$/)?.click();
check('reel in stops', called('fishStop'), JSON.stringify(sent));

stores.fishing.set(line('bite', { biteAt: performance.now() - 300, window: 1200 }));
await settle();
const strike = button('FishingHud', /Strike!/);
check('a bite offers the strike', !!strike, buttonsIn('FishingHud').map((b) => b.textContent.trim()).join('|'));
const bar = box('FishingHud').querySelector('.window');
check('the strike window runs for the window, from when the bite came',
  bar && bar.style.animationDuration === '1200ms' && /^-\\d+(\\.\\d+)?ms$/.test(bar.style.animationDelay) && parseFloat(bar.style.animationDelay) <= -300,
  bar && bar.getAttribute('style'));
strike?.click();
check('striking hooks', called('fishHook'));

stores.fishing.set(line('caught', { spot: null, caught: { fish: 'madai', size: 62.5, newSpecies: true, record: true, personalBest: true } }));
await settle();
for (const want of ['Caught!', 'Red sea bream', '62.5 cm', 'Epic', 'New to your book', 'Personal best', 'Biggest on the island today']) {
  check('the catch card shows ' + JSON.stringify(want), text('FishingHud').includes(want), text('FishingHud'));
}
stores.fishing.set(line('caught', { spot: null, caught: { fish: 'aji', size: 18, newSpecies: false, record: false, personalBest: false } }));
await settle();
check('an ordinary catch carries no news tags', !text('FishingHud').includes('Personal best') && text('FishingHud').includes('Common'));
stores.fishing.set(line('escaped', { reason: 'late' }));
await settle();
check('an escape adds nothing here', text('FishingHud').trim() === '', text('FishingHud'));
stores.fishing.set(line('idle', { spot: null }));

// ---------------------------------------------------------------------------------------
console.log('\\nTreasure hunt');
let listNow = [];
stores.activities.subscribe((v) => (listNow = v))();
stores.activities.set([...listNow, activity('t1', 'Treasure Hunt', 'live', { feature: 'treasure', left: 2, board: [{ id: 'p2', name: 'Keeper', score: 1 }, { id: 'p1', name: 'Sawada', score: 0 }] })]);
await settle();
for (const want of ['Treasure hunt', '2 still buried', 'Dig anywhere', 'Keeper', '×1']) {
  check('the hunt card shows ' + JSON.stringify(want), text('TreasureHud').includes(want), text('TreasureHud'));
}
check('you are marked on the board', box('TreasureHud').querySelector('li.me')?.textContent.includes('Sawada'));
button('TreasureHud', /^Dig/)?.click();
await settle();
check('the button digs', called('dig'));
check('and rests, so a second press is not a refusal', button('TreasureHud', /^Dig/)?.disabled === true);
stores.lastDig.set({ result: 'warm', at: performance.now() });
await settle();
check('what the sand said replaces the how-to', text('TreasureHud').includes('Warm — not far now') && !text('TreasureHud').includes('Dig anywhere'), text('TreasureHud'));
stores.lastDig.set({ result: 'found', at: performance.now() });
await settle();
check('a find says so', text('TreasureHud').includes('You dug up a treasure'));
stores.activities.set(listNow);
stores.lastDig.set(null);
await settle();
check('and the card goes when the hunt does', text('TreasureHud').trim() === '');

console.log('\\nOmikuji');
stores.omikujiSlip.set({ fortune: 0, item: 2, direction: 3, again: true });
await settle();
for (const want of ['大吉', 'だいきち', 'Great blessing', 'A paper lantern', 'South-east', 'one draw a day']) {
  check('the slip shows ' + JSON.stringify(want), text('OmikujiCard').includes(want), text('OmikujiCard'));
}
key('Escape');
await settle();
let slip = 'x';
stores.omikujiSlip.subscribe((v) => (slip = v))();
check('Escape puts it away', slip === null);
stores.omikujiSlip.set({ fortune: 5, item: 0, direction: 0, again: false });
await settle();
check('a first draw has no "again" line', !text('OmikujiCard').includes('one draw a day') && text('OmikujiCard').includes('凶'));
button('OmikujiCard', /Put it away/)?.click();
await settle();
check('so does its button', text('OmikujiCard').trim() === '');

// ---------------------------------------------------------------------------------------
console.log('\\nJanken');
const duel = (phase, extra = {}) => ({ duel: 'd1', opponent: 'p2', opponentName: 'Keeper', phase, deadline: Date.now() + 8000, round: 1, mine: null, theirs: null, winner: null, final: false, reason: null, ...extra });
stores.janken.set(duel('invited', { deadline: Date.now() + 15_000 }));
await settle();
check('an invitation names the challenger', text('JankenCard').includes('Keeper challenges you to janken'), text('JankenCard'));
check('with the seconds left to answer', /\\b1[45]s\\b/.test(text('JankenCard')), text('JankenCard'));
button('JankenCard', /^Accept$/)?.click();
await settle();
check('accepting answers', called('jankenRespond', 'd1', true));
check('and cannot answer twice', button('JankenCard', /^Accept$/)?.disabled === true && button('JankenCard', /^Decline$/)?.disabled === true);

stores.janken.set(duel('waiting'));
await settle();
check('a challenger waits', text('JankenCard').includes('Waiting for Keeper to answer'));

stores.janken.set(duel('choose'));
await settle();
check('choosing offers three hands', ['Rock', 'Paper', 'Scissors'].every((h) => !!button('JankenCard', new RegExp(h))), buttonsIn('JankenCard').map((b) => b.textContent.trim()).join('|'));
key('2');
check('the 2 key throws paper', called('jankenThrow', 'd1', 'paper'), JSON.stringify(sent));
button('JankenCard', /Scissors/)?.click();
check('a hand can be tapped', called('jankenThrow', 'd1', 'scissors'));
const typing = doc.createElement('input');
doc.body.appendChild(typing);
const before = sent.length;
key('1', typing);
check('typing a 1 into a field throws nothing', sent.length === before);
typing.remove();

stores.janken.set(duel('choose', { mine: 'rock' }));
await settle();
check('after throwing, your hand and a wait', text('JankenCard').includes('Rock') && text('JankenCard').includes('Waiting for Keeper'), text('JankenCard'));

stores.janken.set(duel('result', { mine: 'rock', theirs: 'scissors', winner: 'p1', final: true }));
await settle();
check('a win shows both hands and says so', text('JankenCard').includes('You win!') && text('JankenCard').includes('Scissors'), text('JankenCard'));
stores.janken.set(duel('result', { mine: 'rock', theirs: 'rock', winner: null, final: false, round: 2 }));
await settle();
check('a tie goes again', text('JankenCard').includes('Draw — again!') && text('JankenCard').includes('Round 2'), text('JankenCard'));
stores.janken.set(duel('result', { mine: null, theirs: 'paper', winner: 'p2', final: true }));
await settle();
check('a forfeit loses, and says nothing was thrown', text('JankenCard').includes('You lose') && text('JankenCard').includes('No throw'), text('JankenCard'));
stores.janken.set(duel('cancelled', { reason: 'far' }));
await settle();
check('a cancelled duel says why', text('JankenCard').includes('Too far apart'), text('JankenCard'));
stores.janken.set(duel('cancelled', { reason: 'declined', byMe: false }));
await settle();
check('a declined challenge reads as declined to the challenger', /declined/i.test(text('JankenCard')) && !/You declined/.test(text('JankenCard')), text('JankenCard'));
stores.janken.set(duel('cancelled', { reason: 'declined', byMe: true }));
await settle();
check('…and as "you declined" to the one who declined', text('JankenCard').includes('You declined Keeper'), text('JankenCard'));
stores.janken.set(null);
await settle();

// ---------------------------------------------------------------------------------------
console.log('\\nPlayer card');
stores.selectedPlayer.set('p2');
await settle();
for (const want of ['Keeper', 'Angler', 'At ' + plazaName, 'Joined Lantern Walk']) {
  check('the card shows ' + JSON.stringify(want), text('PlayerCard').includes(want), text('PlayerCard'));
}
check('with follow, janken, whisper and mute', ['Follow', 'Janken', 'Whisper', 'Mute'].every((w) => !!button('PlayerCard', new RegExp('^' + w + '$'))),
  buttonsIn('PlayerCard').map((b) => b.textContent.trim()).join('|'));
check('and no keeper tools for a guest', !text('PlayerCard').includes('Moderation'));
button('PlayerCard', /^Follow$/)?.click();
check('follow follows', called('follow', 'p2'));
button('PlayerCard', /^Whisper$/)?.click();
await settle();
const whisperInput = box('PlayerCard').querySelector('input');
check('whisper opens a field', !!whisperInput);
if (whisperInput) {
  await type(whisperInput, 'meet at the pier');
  key('Enter', whisperInput);
  await settle();
  check('Enter whispers to them', called('whisper', 'p2', 'meet at the pier'), JSON.stringify(sent));
  check('and clears the field', whisperInput.value === '');
  key('Escape', whisperInput);
  await settle();
  check('Escape in the field closes only the field', !box('PlayerCard').querySelector('input') && text('PlayerCard').includes('Keeper'));
}
button('PlayerCard', /^Mute$/)?.click();
await settle();
check('mute mutes, and the button turns into unmute', stores.isMuted('p2') && !!button('PlayerCard', /^Unmute$/));
button('PlayerCard', /^Unmute$/)?.click();
await settle();

// Friends, from the card: nothing to offer without a visitor key; an ask; their ask; a friend.
check('no friend button without a visitor key', !button('PlayerCard', /^Add friend$/));
stores.friends.set({ friends: [], requests: [], enabled: true });
await settle();
button('PlayerCard', /^Add friend$/)?.click();
await settle();
check('add friend asks them', called('friend', 'request', 'p2'), JSON.stringify(sent));
check('and rests', button('PlayerCard', /^Add friend$/)?.disabled === true);
stores.friends.set({ friends: [], requests: [{ id: 'fr-keeper', name: 'Keeper', player: 'p2' }], enabled: true });
await settle();
button('PlayerCard', /^Accept request$/)?.click();
check('their ask can be accepted from their card', called('friend', 'accept', 'fr-keeper'));
stores.friends.set({ friends: [{ id: 'fr-keeper', name: 'Keeper', online: true, player: 'p2', room: { id: 'shore-1', name: 'Nagisa — Shore 1', kind: 'public' } }], requests: [], enabled: true });
await settle();
check('a friend is marked as one', text('PlayerCard').includes('Friend') && !button('PlayerCard', /^Add friend$/));
stores.friends.set({ friends: [], requests: [], enabled: false });
await settle();

stores.self.update((s) => ({ ...s, role: 3 }));
await settle();
check('a keeper gets the moderation row', text('PlayerCard').includes('Moderation') && !!button('PlayerCard', /^Kick$/));
check('hosting offers only activities still to come', [...box('PlayerCard').querySelectorAll('option')].map((o) => o.value).join(',') === 'a1,q1',
  [...box('PlayerCard').querySelectorAll('option')].map((o) => o.value).join(','));
button('PlayerCard', /^Make host$/)?.click();
check('make host grants the chosen activity', called('admin', 'grant_host', 'p2', 'a1'), JSON.stringify(sent));
button('PlayerCard', /^Mute on the island$/)?.click();
check('server mute', called('admin', 'mute', 'p2'));
button('PlayerCard', /^Kick$/)?.click();
await settle();
check('kick asks first', text('PlayerCard').includes('Kick Keeper off the island?') && !called('admin', 'kick', 'p2'), text('PlayerCard'));
button('PlayerCard', /^Kick$/)?.click();
await settle();
check('and then kicks, and closes', called('admin', 'kick', 'p2') && text('PlayerCard').trim() === '');

stores.selectedPlayer.set('p2');
await settle(40);
button('PlayerCard', /^Janken$/)?.click();
await settle();
check('janken challenges and hands over to the duel card', called('jankenChallenge', 'p2') && text('PlayerCard').trim() === '');

stores.selectedPlayer.set('p3');
await settle(40);
key('Escape');
await settle();
check('Escape closes the card', text('PlayerCard').trim() === '');
stores.selectedPlayer.set('p3');
await settle(40);
doc.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
await settle();
check('so does a press outside it', text('PlayerCard').trim() === '');
stores.selectedPlayer.set('p3');
await settle(40);
box('PlayerCard').querySelector('.card').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
await settle();
check('but not a press inside it', text('PlayerCard').includes('Rin'));
stores.players.set([KEEPER]);
await settle();
let selected = 'x';
stores.selectedPlayer.subscribe((v) => (selected = v))();
check('and it closes when they leave', selected === null && text('PlayerCard').trim() === '');
stores.players.set([KEEPER, RIN]);
stores.self.update((s) => ({ ...s, role: 0 }));

// ---------------------------------------------------------------------------------------
console.log('\\nNotice board');
const now = Date.now();
stores.announcements.set([
  { id: 'an2', text: 'Quiz on the plaza soon', fromName: 'Keeper', scope: { kind: 'island' }, at: now - 10_000, ttlMs: 600000, priority: 'high' },
  { id: 'an1', text: 'Lanterns at dusk', fromName: 'Keeper', scope: { kind: 'zone', zone: 'shrine' }, at: now - 5 * 60_000, ttlMs: 600000, priority: 'normal' },
]);
stores.guestbook.set([
  { id: 'g1', name: 'Sawada', text: 'Lovely island', at: now - 2 * 3600_000, authorId: 'p1' },
  { id: 'g2', name: 'Rin', text: 'hi all', at: now - 3 * 86400_000, authorId: 'p3' },
]);
stores.atBoard.set(false);
await settle();
for (const want of ['Announcements', 'Quiz on the plaza soon', 'just now', 'Lanterns at dusk', 'Shrine', '5 min ago', 'Guestbook', 'Lovely island', '2 h ago', '3 d ago', 'Walk up to a notice board']) {
  check('the board shows ' + JSON.stringify(want), text('BoardPanel').includes(want), text('BoardPanel'));
}
check('newest announcement first', text('BoardPanel').indexOf('Quiz on the plaza soon') < text('BoardPanel').indexOf('Lanterns at dusk'));
check('no write box away from a board', !box('BoardPanel').querySelector('input'));
const removes = () => buttonsIn('BoardPanel').filter((b) => /Remove/.test(b.textContent));
check('you can take down only your own line', removes().length === 1 && removes()[0].getAttribute('aria-label').includes('Sawada'));
removes()[0]?.click();
check('which removes it', called('guestbookRemove', 'g1'));
stores.self.update((s) => ({ ...s, role: 3 }));
await settle();
check('a keeper can take down any line', removes().length === 2);
stores.self.update((s) => ({ ...s, role: 0 }));
stores.atBoard.set(true);
await settle();
const gb = box('BoardPanel').querySelector('input');
check('at a board there is a write box', !!gb);
if (gb) {
  check('capped at the protocol length', gb.maxLength === shared.PROTOCOL.MAX_GUESTBOOK_LENGTH);
  check('the sign button waits for words', button('BoardPanel', /^Sign$/)?.disabled === true);
  await type(gb, 'Hello from the pier');
  check('the counter counts', text('BoardPanel').includes('19/' + shared.PROTOCOL.MAX_GUESTBOOK_LENGTH), text('BoardPanel'));
  key('Enter', gb);
  await settle();
  check('Enter signs', called('guestbookWrite', 'Hello from the pier'));
  check('but keeps the words until the line is up (a refusal must not lose them)', gb.value === 'Hello from the pier');
  let board = [];
  stores.guestbook.subscribe((v) => (board = v))();
  stores.guestbook.set([{ id: 'g-new', authorId: 'p1', name: 'Sawada', text: 'Hello from the pier', at: Date.now() }, ...board]);
  await settle();
  check('and clears them once it is', gb.value === '');
}
stores.announcements.set([]);
stores.guestbook.set([]);
await settle();
check('an empty board says so', text('BoardPanel').includes('No announcements right now') && text('BoardPanel').includes('Nobody has signed yet'));

// ---------------------------------------------------------------------------------------
console.log('\\nCollection');
stores.profile.set(null);
await settle();
check('no profile yet says so', text('CollectionPanel').includes('Your collection appears once'));
const total = shared.STAMP_ZONES.length;
const profile = {
  stamps: ['plaza', 'shrine'], stampTotal: total,
  fish: { aji: { count: 3, best: 24.5 }, boot: { count: 1, best: 26 } }, catches: 4,
  badges: ['angler'], title: null, omikuji: null, jankenWins: 0, quizWins: 0, persistent: true,
};
stores.profile.set(profile);
await settle();
check('the stamp card counts', text('CollectionPanel').includes('2 of ' + total + ' stamps'), text('CollectionPanel'));
check('with a circle per place, two of them stamped', box('CollectionPanel').querySelectorAll('.stamp').length === total && box('CollectionPanel').querySelectorAll('.stamp.got').length === 2);
check('stamped at a slant', !!box('CollectionPanel').querySelector('.stamp.got .seal')?.style.rotate);
check('and says it is kept', text('CollectionPanel').includes('kept in this browser'));
const tab = (re) => [...box('CollectionPanel').querySelectorAll('[role="tab"]')].find((b) => re.test(b.textContent));
tab(/Fish book/)?.click();
await settle();
for (const want of ['1 of ' + shared.COLLECTIBLE_FISH.length + ' species', 'Horse mackerel', '×3', 'best 24.5 cm', '???', 'Old boot']) {
  check('the fish book shows ' + JSON.stringify(want), text('CollectionPanel').includes(want), text('CollectionPanel').slice(0, 300));
}
check('junk comes last', text('CollectionPanel').trim().lastIndexOf('Old boot') > text('CollectionPanel').lastIndexOf('???'));
key('ArrowRight', tab(/Fish book/));
await settle();
check('arrow keys move between tabs', tab(/Badges/)?.getAttribute('aria-selected') === 'true');
check('earned badges can be worn', text('CollectionPanel').includes('Angler') && !!button('CollectionPanel', /^Wear$/));
check('unearned ones say how', text('CollectionPanel').includes('Collect every stamp on the island'));
button('CollectionPanel', /^Wear$/)?.click();
check('wear puts it on', called('setTitle', 'angler'));
stores.profile.set({ ...profile, title: 'angler', persistent: false });
await settle();
button('CollectionPanel', /^Wearing$/)?.click();
check('wearing it again takes it off', called('setTitle', null));
check('a profile that will not last says so', text('CollectionPanel').includes('forgotten when the tab closes'));
tab(/Stamps/)?.click();
stores.profile.set({ ...profile, stamps: [...shared.STAMP_ZONES] });
await settle();
check('a full card is an Island Walker', text('CollectionPanel').includes('Island Walker'));
const daily = (progress, done, streak) => ({
  ...profile,
  daily: { day: '2026-09-25', done, tasks: [{ kind: 'bell', goal: 1, progress: progress[0] }, { kind: 'zones', goal: 4, progress: progress[1] }, { kind: 'chat', goal: 3, progress: progress[2] }] },
  dailyStreak: streak,
  dailyDays: streak,
});
// The card is for 25 September in Japan; hold the clock there so it is today's.
stores.setServerClock(() => Date.parse('2026-09-25T03:00:00Z'));
stores.profile.set(daily([1, 2, 0], false, 0));
await settle();
for (const want of ['Today', 'Ring a bell', '1/1', 'Walk into 4 different places', '2/4', 'Say 3 things in chat', '0/3', 'the same tasks today']) {
  check('today’s tasks show ' + JSON.stringify(want), text('CollectionPanel').includes(want), text('CollectionPanel').slice(0, 300));
}
check('a full task is ticked', box('CollectionPanel').querySelectorAll('.task.full').length === 1);
stores.profile.set(daily([1, 4, 3], true, 3));
await settle();
check('a day done counts the streak', text('CollectionPanel').includes('3 days in a row'));
// The next morning, before anything is done: the server has not sent a new card, but the
// book shows the new day's tasks, none of them done.
stores.setServerClock(() => Date.parse('2026-09-26T03:00:00Z'));
stores.profile.set(daily([1, 4, 3], true, 3));
await settle();
const tomorrow = shared.dailyTasks('2026-09-26');
check('past midnight the book shows the new day, nothing done', box('CollectionPanel').querySelectorAll('.task.full').length === 0 && box('CollectionPanel').querySelectorAll('.task').length === tomorrow.length, text('CollectionPanel').slice(0, 200));
stores.setServerClock(() => Date.now());

// ---------------------------------------------------------------------------------------
console.log('\\nIsland');
const shore1 = { id: 'shore-1', name: 'Nagisa — Shore 1', population: 12, capacity: 60, kind: 'public' };
const shore2 = { id: 'shore-2', name: 'Nagisa — Shore 2', population: 60, capacity: 60, kind: 'public' };
const mine = { id: 'r-k7m2q', name: 'Sawada’s island', population: 2, capacity: 40, kind: 'private', code: 'K7M2Q', ownerName: 'Sawada' };
stores.room.set(mine);
stores.rooms.set([shore1, shore2, mine]);
await settle();
// The count is who is here now (two others and you), not the list's number from the last fetch.
for (const want of ['Private island', 'K7M2Q', 'Made by Sawada', '3 of 40 here', 'Copy invite link', 'Send this to friends']) {
  check('a private island shows ' + JSON.stringify(want), text('IslandPanel').includes(want), text('IslandPanel'));
}
button('IslandPanel', /^Copy invite link$/)?.click();
await settle(60);
const manual = box('IslandPanel').querySelector('input[readonly]');
check('without a clipboard, the link is handed over to copy by hand', !!manual && manual.value.includes('island=K7M2Q'), manual && manual.value);
check('a private island is not in the public list', !text('IslandPanel').includes('Sawada’s island'));
const codeField = box('IslandPanel').querySelector('#island-code');
const joinButton = () => buttonsIn('IslandPanel').find((b) => b.previousElementSibling === codeField);
await type(codeField, 'hello');
check('a code with look-alike letters is refused', joinButton()?.disabled === true);
await type(codeField, 'ab c2d');
check('spaces and case are forgiven', joinButton()?.disabled === false);
joinButton()?.click();
check('go joins by the normalised code', called('joinIsland', 'ABC2D'), JSON.stringify(sent));
button('IslandPanel', /^Make a private island$/)?.click();
check('make a private island', called('createIsland'));
check('the public list has populations', text('IslandPanel').includes('Nagisa — Shore 1') && text('IslandPanel').includes('12 of 60 here'));
check('and a full shard cannot be chosen', text('IslandPanel').includes('Full'));
buttonsIn('IslandPanel').filter((b) => /^Go$/.test(b.textContent.trim())).find((b) => b.closest('.room'))?.click();
check('go to another shard', called('joinIsland', 'shore-1'));
stores.room.set(shore1);
await settle();
check('on a public island: its name and that you are here', text('IslandPanel').includes('Public island') && text('IslandPanel').includes('You’re here') && !text('IslandPanel').includes('Copy invite link'), text('IslandPanel'));

// ---------------------------------------------------------------------------------------
console.log('\\nLanguages');
const RAW_KEY = /\\b(quiz|fish|omikuji|janken|player|board|collection|island|rarity|ago|game|hand)\\.[a-zA-Z]+/;
async function tour(lang) {
  stores.settings.update((s) => ({ ...s, lang }));
  const seen = [];
  const look = async (label) => { await settle(); seen.push([label, doc.body.textContent]); };
  stores.self.update((s) => ({ ...s, zone: 'plaza', role: 3 }));
  stores.quiz.set({ ...quizBase, activity: 'qt-' + lang, phase: 'lobby', endsAt: Date.now() + 20_000 });
  await look('quiz lobby');
  stores.quiz.set({ ...quizBase, activity: 'qt-' + lang, phase: 'question', round: 1, questionId: Q.id, endsAt: Date.now() + 15_000, alive: ['p1'] });
  await look('quiz question');
  stores.quiz.set({ ...quizBase, activity: 'qt-' + lang, phase: 'reveal', round: 1, questionId: Q.id, endsAt: Date.now() + 6000, answer: Q.answer, alive: [], fell: ['p1'] });
  await look('quiz reveal');
  stores.quiz.set({ ...quizBase, activity: 'qt-' + lang, phase: 'finished', round: 1, endsAt: Date.now() + 8000, alive: [], winners: ['p1', 'p2'] });
  await look('quiz finished');
  stores.quiz.set(null);
  stores.fishing.set(line('waiting')); await look('fish waiting');
  stores.fishing.set(line('bite', { biteAt: performance.now(), window: 1200 })); await look('fish bite');
  stores.fishing.set(line('caught', { caught: { fish: 'maguro', size: 180, newSpecies: true, record: true, personalBest: true } })); await look('fish caught');
  stores.fishing.set(line('idle'));
  stores.omikujiSlip.set({ fortune: 2, item: 4, direction: 6, again: true }); await look('omikuji');
  stores.omikujiSlip.set(null);
  for (const [phase, extra] of [['invited', {}], ['waiting', {}], ['choose', {}], ['choose', { mine: 'paper' }],
    ['result', { mine: 'rock', theirs: 'paper', winner: 'p2', final: true }], ['result', { mine: 'rock', theirs: 'rock', final: false }],
    ...['declined', 'timeout', 'left', 'busy', 'far', null].map((reason) => ['cancelled', { reason }])]) {
    stores.janken.set(duel(phase, extra)); await look('janken ' + phase);
  }
  stores.janken.set(null);
  stores.selectedPlayer.set('p2'); await look('player card');
  stores.selectedPlayer.set(null);
  stores.announcements.set([{ id: 'x', text: 'hi', fromName: 'Keeper', scope: { kind: 'activity', activity: 'a1' }, at: Date.now() - 7200_000, ttlMs: 1, priority: 'normal' }]);
  stores.guestbook.set([{ id: 'y', name: 'Rin', text: 'yo', at: Date.now() - 90_000, authorId: 'p3' }]);
  await look('board');
  for (const t of [...box('CollectionPanel').querySelectorAll('[role="tab"]')]) { t.click(); await look('collection ' + t.textContent.trim()); }
  stores.room.set(mine); await look('island private');
  stores.room.set(shore1); await look('island public');
  stores.self.update((s) => ({ ...s, role: 0 }));
  const leaks = seen.filter(([, t]) => RAW_KEY.test(t)).map(([label, t]) => label + ': ' + t.match(RAW_KEY)[0]);
  check(lang + ': no raw key anywhere on the tour', leaks.length === 0, leaks.join(' | '));
  return seen.map(([, t]) => t).join('\\n');
}
const zh = await tour('zh');
for (const want of ['○×问答', '快提竿！', '金枪鱼', '中吉', '猜拳', '接受', '留言簿', '鱼类图鉴', '复制邀请链接', '公共岛屿', '禁言']) {
  check('zh says ' + want, zh.includes(want));
}
const ja = await tour('ja');
for (const want of ['○×クイズ', '釣り上げる！', 'マグロ', '中吉', 'じゃんけん', '受ける', '寄せ書き', '魚図鑑', '招待リンクをコピー', 'みんなの島', '発言を止める']) {
  check('ja says ' + want, ja.includes(want));
}
check('en shows the English reading of a fortune, zh and ja do not', !zh.includes('ちゅうきち') && !ja.includes('Middle blessing'));
stores.settings.update((s) => ({ ...s, lang: 'en' }));

// ---------------------------------------------------------------------------------------
console.log('\\nAccessibility');
stores.fishing.set(line('bite', { biteAt: performance.now(), window: 1200 }));
stores.janken.set(duel('choose'));
stores.selectedPlayer.set('p2');
stores.omikujiSlip.set({ fortune: 1, item: 1, direction: 1, again: false });
await settle();
const unlabelled = [...doc.querySelectorAll('button')].filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label'));
check('every button has a name', unlabelled.length === 0, unlabelled.map((b) => b.outerHTML.slice(0, 80)).join(' | '));
const fields = [...doc.querySelectorAll('input, select')].filter((f) => !f.getAttribute('aria-label') && !(f.id && doc.querySelector('label[for="' + f.id + '"]')) && !f.closest('label'));
check('every field has a label', fields.length === 0, fields.map((f) => f.outerHTML.slice(0, 80)).join(' | '));

// ---------------------------------------------------------------------------------------
console.log('\\nTeardown');
for (const [name, instance] of Object.entries(mounted)) {
  try { unmount(instance); check(name + ' unmounts cleanly', true); }
  catch (err) { check(name + ' unmounts cleanly', false, err && err.stack); }
}

console.log('\\n' + (checks - failures) + '/' + checks + ' checks passed\\n');
process.exit(failures === 0 ? 0 : 1);
`,
  );

  const run = spawnSync('node', [runner], { cwd: root, stdio: 'inherit' });
  status = run.status ?? 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  status = 1;
} finally {
  // Never `process.exit` inside the try: it would skip this and leave the scratch behind.
  rmSync(outDir, { recursive: true, force: true });
}

process.exit(status);
