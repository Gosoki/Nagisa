
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

const { mountOverlay, stores } = await import('/root/nagisa/.uismoke-F12Bhm/overlay.mjs').then(m => globalThis.__nagisa ?? m);

let failures = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (ok) console.log('  \u2714 ' + name);
  else { failures++; console.log('  \u2718 ' + name); if (detail !== undefined) console.log('      ' + String(detail).slice(0, 300)); }
};

const target = dom.window.document.getElementById('app');
const text = () => dom.window.document.body.textContent || '';
const buttons = () => [...dom.window.document.querySelectorAll('button')];

console.log('\nMount');
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

console.log('\nLoading phase');
stores.appPhase.set('loading');
stores.loadProgress.set({ value: 0.4, label: 'Shaping the coastline' });
await sleep(50);
check('loader shows the current progress label', text().includes('Shaping the coastline'), text().slice(0,120));

console.log('\nEntry phase');
stores.appPhase.set('entry');
await sleep(80);
check('entry screen shows the title', text().includes('Nagisa'));
check('entry screen has a name field', !!dom.window.document.querySelector('input'));
check('entry screen has a go-ashore action', buttons().some(b => /ashore|enter|go/i.test(b.textContent)), buttons().map(b=>b.textContent).join('|'));

console.log('\nWorld phase');
stores.appPhase.set('world');
stores.self.update(s => ({ ...s, id: 'p1', name: 'Sawada', zone: 'plaza' }));
stores.currentZone.set({ id: 'plaza', name: 'Main Plaza', nameJa: '\u5e83\u5834', caption: 'The middle of the island.' });
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
check('population is shown', /\b3\b/.test(text()));
check('next-up strip shows the activity', text().includes('Lantern Walk'));

console.log('\nZone card');
stores.zoneAnnounce.set(true);
await sleep(80);
check('zone card shows the caption', text().includes('The middle of the island'));

console.log('\nAnnouncements');
stores.currentToast.set({ id:'an1', text:'The lamp is lit.', fromName:'Keeper', scope:{kind:'island'}, at: Date.now(), ttlMs: 8000, priority:'normal' });
stores.notify('Checked in', 'good');
await sleep(80);
check('announcement toast is rendered', text().includes('The lamp is lit.'));
check('local notice is rendered', text().includes('Checked in'));
check('toast region is announced to assistive tech', !!dom.window.document.querySelector('[role="status"]'));

console.log('\nPanels');
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

console.log('\nEmote wheel');
stores.emoteOpen.set(true);
await sleep(80);
check('emote wheel opens', buttons().length > 0);
stores.emoteOpen.set(false);

console.log('\nAccessibility');
await sleep(50);
const iconButtons = buttons().filter(b => !b.textContent.trim());
check('icon-only buttons carry an aria-label', iconButtons.every(b => b.getAttribute('aria-label')),
  iconButtons.map(b => b.outerHTML.slice(0,60)).join(' | '));

console.log('\nTeardown');
try { overlay.destroy(); check('overlay unmounts cleanly', true); }
catch (err) { check('overlay unmounts cleanly', false, err && err.stack); }

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed\n');
process.exit(failures === 0 ? 0 : 1);
