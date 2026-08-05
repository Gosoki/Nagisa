#!/usr/bin/env node
/**
 * Interface mount smoke test.
 * ===========================
 *
 * Mounts the real Svelte overlay into a jsdom document, drives it through all three app
 * phases, opens every panel, and asserts that the expected content appears.
 *
 * This exists because a Svelte component can typecheck perfectly and still throw on
 * mount — a store read at module scope, a `$effect` touching `document` before it exists,
 * a child component expecting a prop that is never passed. None of that is visible to
 * `svelte-check`, and none of it is visible to the world-generation tests, because the
 * overlay is deliberately isolated from the engine.
 *
 * WebGL is not available in jsdom, so the 3D application is never booted. That is the
 * point: the interface's only dependency is `state/stores.ts`, so it must be mountable
 * with no renderer at all. If this test ever needs a canvas, that boundary has leaked.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(root, '.uismoke-'));
/** Exit status, set inside the try so the `finally` cleanup always gets to run first. */
let status = 1;

try {
  // Vite compiles `.svelte` files; esbuild alone cannot. Rather than adding a second
  // build path, we let Vite build a tiny entry that imports the overlay, then run the
  // output under jsdom.
  const { writeFileSync } = await import('node:fs');
  const entry = join(outDir, 'entry.js');
  writeFileSync(
    entry,
    `
    import { mountOverlay } from '${join(root, 'apps/client/src/ui/index.ts').replace(/\\/g, '/')}';
    import * as stores from '${join(root, 'apps/client/src/state/stores.ts').replace(/\\/g, '/')}';
    globalThis.__nagisa = { mountOverlay, stores };
    `,
  );

  // A dedicated config rather than the app's: the app config splits `three` into its own
  // chunk, which conflicts with an SSR build that treats it as external. The overlay does
  // not import `three` at all — which this build incidentally proves.
  const configPath = join(outDir, 'vite.smoke.config.mjs');
  writeFileSync(
    configPath,
    `
    import { svelte } from '${join(root, 'node_modules/@sveltejs/vite-plugin-svelte/src/index.js').replace(/\\/g, '/')}';
    export default {
      // A *client* library build, not an SSR build. Vite's build.ssr mode would compile
      // the components server-side, where Svelte 5's mount() refuses to run; lib mode
      // compiles them for the browser while still emitting a single ES module that Node
      // can import directly.
      //
      // emitCss:false matters just as much: extracted CSS would leave an import of
      // overlay.css in the bundle that Node cannot load. With it off, each
      // component injects its own styles at runtime — which is also what lets this test
      // assert that the design tokens made it into the document.
      plugins: [svelte({ emitCss: false, compilerOptions: { hmr: false } })],
      resolve: { conditions: ['browser'] },
      build: {
        outDir: '${outDir.replace(/\\/g, '/')}',
        emptyOutDir: false,
        minify: false,
        target: 'esnext',
        cssCodeSplit: false,
        lib: {
          entry: '${entry.replace(/\\/g, '/')}',
          formats: ['es'],
          fileName: () => 'overlay.mjs',
        },
      },
    };
    `,
  );

  const build = spawnSync(
    join(root, 'node_modules/.bin/vite'),
    ['build', '--config', configPath, '--logLevel', 'error'],
    { cwd: join(root, 'apps/client'), stdio: 'inherit' },
  );
  if (build.status !== 0) {
    console.error('vite build of the overlay failed');
    process.exit(build.status ?? 1);
  }

  const runner = join(outDir, 'run.mjs');
  writeFileSync(
    runner,
    `
import { JSDOM } from 'jsdom';
import { setTimeout as sleep } from 'node:timers/promises';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});

// Install the whole jsdom window as globals. Svelte's compiled output reaches for a
// long and version-dependent list of DOM constructors (Text, Comment, DocumentFragment,
// …); enumerating them by hand just produces a new ReferenceError on every upgrade.
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === 'undefined' || key in globalThis) continue;
  try {
    Object.defineProperty(globalThis, key, {
      get: () => dom.window[key],
      configurable: true,
    });
  } catch { /* some window properties are not redefinable; none of them matter here */ }
}
// window and document may already exist as undefined-valued globals in some Node
// builds, so assign them explicitly rather than relying on the loop above.
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
if (!globalThis.matchMedia) {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}

const { mountOverlay, stores } = await import('${join(outDir, 'overlay.mjs').replace(/\\/g, '/')}').then(m => globalThis.__nagisa ?? m);

let failures = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (ok) console.log('  \\u2714 ' + name);
  else { failures++; console.log('  \\u2718 ' + name); if (detail !== undefined) console.log('      ' + String(detail).slice(0, 300)); }
};

const target = dom.window.document.getElementById('app');
const text = () => dom.window.document.body.textContent || '';
const buttons = () => [...dom.window.document.querySelectorAll('button')];

console.log('\\nMount');
let overlay;
try {
  overlay = mountOverlay(target);
  check('overlay mounts without throwing', true);
} catch (err) {
  check('overlay mounts without throwing', false, err && err.stack);
  process.exit(1);
}
await sleep(50);

check('design tokens are injected as CSS variables',
  [...dom.window.document.querySelectorAll('style')].some(s => s.textContent.includes('--ui-ink')));

console.log('\\nLoading phase');
stores.appPhase.set('loading');
stores.loadProgress.set({ value: 0.4, label: 'Shaping the coastline' });
await sleep(50);
check('loader shows the current progress label', text().includes('Shaping the coastline'), text().slice(0,120));

console.log('\\nEntry phase');
stores.appPhase.set('entry');
await sleep(80);
check('entry screen shows the title', text().includes('Nagisa'));
check('entry screen has a name field', !!dom.window.document.querySelector('input'));
check('entry screen has a go-ashore action', buttons().some(b => /ashore|enter|go/i.test(b.textContent)), buttons().map(b=>b.textContent).join('|'));

console.log('\\nWorld phase');
stores.appPhase.set('world');
stores.self.update(s => ({ ...s, id: 'p1', name: 'Sawada', zone: 'plaza' }));
stores.currentZone.set({ id: 'plaza', name: 'Main Plaza', nameJa: '\\u5e83\\u5834', caption: 'The middle of the island.' });
stores.players.set([
  { id: 'p2', name: 'Keeper', appearance: {outfit:1,skin:1,accessory:0}, role: 2, pos:[0,8,0], yaw:0, anim:0, zone:'plaza', activity:null, mode:null },
  { id: 'p3', name: 'Rin', appearance: {outfit:2,skin:2,accessory:1}, role: 0, pos:[4,8,2], yaw:0, anim:0, zone:'harbor', activity:null, mode:null },
]);
stores.activities.set([{
  id: 'a1', title: 'Lantern Walk', blurb: 'Up the shrine path, one lantern each.',
  zone: 'shrine', state: 'open', startsAt: Date.now() + 600000, endsAt: null,
  hostId: 'p2', hostName: 'Keeper', participantCount: 3, audienceCount: 1,
  capacity: 60, checkinEnabled: true, checkinCount: 0,
}]);
await sleep(120);

check('hud shows the current zone', text().includes('Main Plaza'), text().slice(0,200));
check('population is shown', /\\b3\\b/.test(text()));
check('next-up strip shows the activity', text().includes('Lantern Walk'));

console.log('\\nZone card');
stores.zoneAnnounce.set(true);
await sleep(80);
check('zone card shows the caption', text().includes('The middle of the island'));

console.log('\\nAnnouncements');
stores.currentToast.set({ id:'an1', text:'The lamp is lit.', fromName:'Keeper', scope:{kind:'island'}, at: Date.now(), ttlMs: 8000, priority:'normal' });
stores.notify('Checked in', 'good');
await sleep(80);
check('announcement toast is rendered', text().includes('The lamp is lit.'));
check('local notice is rendered', text().includes('Checked in'));
check('toast region is announced to assistive tech', !!dom.window.document.querySelector('[role="status"]'));

console.log('\\nPanels');
for (const panel of ['people','activities','settings']) {
  stores.openPanel.set(panel);
  await sleep(80);
  const t = text();
  const expected = panel === 'people' ? 'Keeper' : panel === 'activities' ? 'Lantern Walk' : 'Quality';
  check(panel + ' panel renders', t.includes(expected), t.slice(-260));
}

stores.self.update(s => ({ ...s, role: 3 }));
stores.openPanel.set('host');
await sleep(80);
check('host panel renders for a privileged player', text().length > 0);
stores.openPanel.set(null);

console.log('\\nEmote wheel');
stores.emoteOpen.set(true);
await sleep(80);
check('emote wheel opens', buttons().length > 0);
stores.emoteOpen.set(false);

console.log('\\nAccessibility');
await sleep(50);
const iconButtons = buttons().filter(b => !b.textContent.trim());
check('icon-only buttons carry an aria-label', iconButtons.every(b => b.getAttribute('aria-label')),
  iconButtons.map(b => b.outerHTML.slice(0,60)).join(' | '));

console.log('\\nTeardown');
try { overlay.destroy(); check('overlay unmounts cleanly', true); }
catch (err) { check('overlay unmounts cleanly', false, err && err.stack); }

console.log('\\n' + (checks - failures) + '/' + checks + ' checks passed\\n');
process.exit(failures === 0 ? 0 : 1);
`,
  );

  const run = spawnSync('node', [runner], { cwd: root, stdio: 'inherit' });
  // Record the status rather than exiting here. `process.exit()` terminates the process
  // immediately and **skips `finally`**, so exiting from inside the try block leaked a
  // `.uismoke-*` scratch directory into the repository root on every single run.
  status = run.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

process.exit(status);
