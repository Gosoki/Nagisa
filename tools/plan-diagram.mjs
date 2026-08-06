#!/usr/bin/env node
/**
 * Plan diagrams — a development tool, not part of the product.
 * ===========================================================
 *
 *     node tools/plan-diagram.mjs                    # every place, to plans/
 *     node tools/plan-diagram.mjs summit shrine      # named places only
 *     node tools/plan-diagram.mjs --out before --map lantern-atoll
 *
 * One drawing per place, straight down, at a scale where a metre is a few pixels: the
 * terrain in grey, the carriageway and its shoulder in ink, every structure as the rectangle
 * it actually occupies — **eaves and veranda included** — with an arrow out of the face its
 * door is modelled on.
 *
 * ### Why not just screenshot the world from above
 *
 * `tools/shot.mjs` can do that, and does, and it is the right tool for "does this look
 * right". It is the wrong tool for "is this house 0.4 m into the road", because at that
 * question the render is *less* informative than the data: the roof hides the wall line, the
 * shoulder is invisible because it is the same ground as everything else, and a door is four
 * pixels of recessed panel. This draws exactly the quantities the audit measures, so a
 * failure in `npm run audit:placement` has a picture and the picture and the number agree by
 * construction.
 *
 * Rendered in headless Chromium — the tool is already a dependency for the smoke tests, and
 * hand-rasterising rotated rectangles into a PNG would be a day's work for a worse drawing.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = require(resolve(root, 'packages/shared/dist/index.js'));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
shared.resolveMapId(flag('map', process.env.NAGISA_MAP));

const { LANDMARKS, PADS, PATHS, ZONES, heightAt, activeMap } = shared;

const outDir = resolve(root, flag('out', 'plans'));
mkdirSync(outDir, { recursive: true });

const FLAGS = new Set(['out', 'map', 'span', 'scale']);
const named = args.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const previous = args[i - 1];
  return !(previous?.startsWith('--') && FLAGS.has(previous.slice(2)));
});

/** Pixels per metre. 6 puts a 90 m window in a 540 px drawing — legible without scrolling. */
const SCALE = Number(flag('scale', '6'));

// --- The same built extents the audit uses -------------------------------------------
//
// Duplicated rather than imported because the audit is TypeScript bundled through esbuild
// and this is a plain script. If they drift the drawing lies, so the numbers below are the
// ones to keep in step — see `scripts/placement-audit.ts`.
const FOOTPRINT = {
  warehouse: [10, 8], machiya: [8, 10], minka: [10, 8], bathhouse: [13, 10],
  teahouse: [11, 8.5], 'keepers-house': [10, 7.5], boathouse: [7, 10], stage: [12, 9],
  'shrine-hall': [10, 8], lighthouse: [9.3, 9.3], 'market-stall': [3.2, 2.4], 'beach-hut': [6, 5],
  'net-rack': [1.4, 5], well: [2.6, 1.6], 'notice-board': [3.2, 0.4], 'bell-tower': [2.6, 2.6],
  temizuya: [3.6, 3], torii: [5.4, 0.5], gate: [4.6, 0.34], komainu: [1.5, 1.2],
  'summit-marker': [1.5, 1.5], bench: [1.8, 0.6], 'stone-lantern': [0.9, 0.9],
  'post-lantern': [0.5, 0.5], rail: [0.3, 16], 'sea-wall': [1.2, 30], breakwater: [3.6, 50],
  pier: [7, 36], banner: [0.6, 0.6], rock: [3, 3], boat: [3, 8], steps: [6, 3],
};
const EAVES = {
  machiya: 0.9, minka: 1.25, warehouse: 1.15, teahouse: 1.3, bathhouse: 1.0,
  boathouse: 0.7, 'keepers-house': 0.6, 'beach-hut': 0.7, 'shrine-hall': 1.8,
  stage: 1.2, 'market-stall': 0.35, temizuya: 0.85, 'bell-tower': 0.9,
  'notice-board': 0.6, gate: 0.8, torii: 0.6, well: 0.4, 'net-rack': 0.3,
};
const APRON = { minka: 1.15, teahouse: 0.3, bathhouse: 0.7, boathouse: 4.3, 'shrine-hall': 1.4, stage: 1.2 };
const REAR = { stage: 0.4 };
const NOSE_ANCHORED = new Set(['pier']);
const FRONTED = new Set([
  'machiya', 'minka', 'warehouse', 'bathhouse', 'teahouse', 'keepers-house', 'beach-hut',
  'boathouse', 'shrine-hall', 'stage', 'notice-board', 'market-stall', 'bell-tower', 'lighthouse',
]);
/** Drawn in outline only: landscape and furniture, which no rule here is about. */
const MINOR = new Set(['rock', 'boat', 'banner', 'post-lantern', 'stone-lantern', 'bench', 'komainu']);

function rectOf(l) {
  const fb = FOOTPRINT[l.kind] ?? [3, 3];
  const w = typeof l.opts?.width === 'number' ? l.opts.width : typeof l.opts?.w === 'number' ? l.opts.w : fb[0];
  const d = typeof l.opts?.length === 'number' ? l.opts.length : typeof l.opts?.d === 'number' ? l.opts.d : fb[1];
  const eave = EAVES[l.kind] ?? 0;
  const scale = l.scale ?? 1;
  const front = NOSE_ANCHORED.has(l.kind) ? 0 : -(d / 2 + eave + (APRON[l.kind] ?? 0));
  const back = NOSE_ANCHORED.has(l.kind) ? d : d / 2 + eave + (REAR[l.kind] ?? 0);
  const centre = ((front + back) / 2) * scale;
  return {
    id: l.id,
    kind: l.kind,
    x: l.x + centre * Math.sin(l.rot),
    z: l.z + centre * Math.cos(l.rot),
    hw: (w / 2 + eave) * scale,
    hd: ((back - front) / 2) * scale,
    // The walls, drawn inside the eaves so both lines are visible.
    wallHw: (w / 2) * scale,
    wallHd: (d / 2) * scale,
    wallX: NOSE_ANCHORED.has(l.kind) ? l.x + ((d / 2) * scale) * Math.sin(l.rot) : l.x,
    wallZ: NOSE_ANCHORED.has(l.kind) ? l.z + ((d / 2) * scale) * Math.cos(l.rot) : l.z,
    rot: l.rot,
    front: FRONTED.has(l.kind),
    minor: MINOR.has(l.kind),
    // Where the door is, in world space, so the arrow starts on the building rather than
    // at its centre.
    doorX: l.x - (d / 2) * scale * Math.sin(l.rot),
    doorZ: l.z - (d / 2) * scale * Math.cos(l.rot),
  };
}

/** Places worth a drawing: every terrace, plus the whole island. */
const PLACES = [
  { id: 'island', name: 'the whole island', x: 0, z: 0, span: 300 },
  ...PADS.map((p) => ({
    id: p.id,
    name: ZONES.find((z) => z.id === p.id)?.name ?? p.id,
    x: p.x,
    z: p.z,
    span: Math.max(70, p.outer * 2.4),
  })),
];
const targets = named.length ? PLACES.filter((p) => named.includes(p.id)) : PLACES;

/** Sample the ground over a window, one tap per metre, for the shaded backdrop. */
function sampleTerrain(cx, cz, span) {
  const n = Math.min(220, Math.round(span));
  const step = span / n;
  const grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      grid[j * n + i] = heightAt(cx - span / 2 + (i + 0.5) * step, cz - span / 2 + (j + 0.5) * step);
    }
  }
  return { n, step, grid: Array.from(grid) };
}

const panels = targets.map((place) => {
  const half = place.span / 2;
  const inWindow = (x, z) => Math.abs(x - place.x) < half + 30 && Math.abs(z - place.z) < half + 30;
  return {
    ...place,
    terrain: sampleTerrain(place.x, place.z, place.span),
    pads: PADS.filter((p) => inWindow(p.x, p.z)).map((p) => ({ x: p.x, z: p.z, inner: p.inner, outer: p.outer, id: p.id })),
    lanes: PATHS.map((p) => ({ id: p.id, halfWidth: p.halfWidth, shoulder: p.shoulder, points: p.points.map(([x, z]) => [x, z]) })),
    props: LANDMARKS.filter((l) => inWindow(l.x, l.z)).map(rectOf),
  };
});

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #fffdf8; font: 11px/1.3 ui-monospace, monospace; color: #26221e; }
  figure { margin: 0; padding: 10px; width: max-content; }
  figcaption { padding: 0 0 6px; font-size: 13px; font-weight: 600; }
</style>
<body></body>
<script>
const PANELS = ${JSON.stringify(panels)};
const SCALE = ${SCALE};

for (const panel of PANELS) {
  const size = Math.round(panel.span * SCALE);
  const fig = document.createElement('figure');
  fig.id = 'p-' + panel.id;
  const cap = document.createElement('figcaption');
  cap.textContent = panel.name + '  ·  ' + panel.span + ' m across  ·  north is up';
  fig.append(cap);
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  fig.append(canvas);
  document.body.append(fig);

  const ctx = canvas.getContext('2d');
  // World → canvas. +x right, +z down, which is the same convention the minimap uses.
  const px = (x) => (x - panel.x + panel.span / 2) * SCALE;
  const pz = (z) => (z - panel.z + panel.span / 2) * SCALE;

  // --- Ground -----------------------------------------------------------------
  const { n, step, grid } = panel.terrain;
  const img = ctx.createImageData(n, n);
  let lo = Infinity, hi = -Infinity;
  for (const h of grid) { if (h > 0) { lo = Math.min(lo, h); hi = Math.max(hi, h); } }
  const range = Math.max(1, hi - lo);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const h = grid[j * n + i];
    const o = (j * n + i) * 4;
    if (h <= 0) { img.data[o] = 168; img.data[o+1] = 196; img.data[o+2] = 200; img.data[o+3] = 255; continue; }
    // Height as tone, plus a hillshade so a terrace rim draws itself as a line.
    const t = (h - lo) / range;
    const gx = (grid[j * n + Math.min(n-1, i+1)] - h) / step;
    const gz = (grid[Math.min(n-1, j+1) * n + i] - h) / step;
    const shade = Math.max(-0.35, Math.min(0.25, (-gx - gz) * 0.9));
    const v = Math.round(Math.max(0, Math.min(255, (206 - t * 46) * (1 + shade))));
    img.data[o] = v; img.data[o+1] = Math.round(v * 0.99); img.data[o+2] = Math.round(v * 0.93); img.data[o+3] = 255;
  }
  const tmp = document.createElement('canvas');
  tmp.width = n; tmp.height = n;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, size, size);

  // --- Terraces ---------------------------------------------------------------
  for (const pad of panel.pads) {
    ctx.strokeStyle = 'rgba(60,52,44,0.32)';
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px(pad.x), pz(pad.z), pad.outer * SCALE, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(60,52,44,0.5)';
    ctx.beginPath(); ctx.arc(px(pad.x), pz(pad.z), pad.inner * SCALE, 0, Math.PI * 2); ctx.stroke();
  }

  // --- Lanes ------------------------------------------------------------------
  for (const lane of panel.lanes) {
    const draw = (width, style) => {
      ctx.strokeStyle = style; ctx.lineWidth = width * 2 * SCALE;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      lane.points.forEach(([x, z], k) => k ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z)));
      ctx.stroke();
    };
    draw(lane.halfWidth + lane.shoulder, 'rgba(120,104,86,0.16)');   // shoulder
    draw(lane.halfWidth + 1, 'rgba(196,80,58,0.30)');                 // carriageway + kerb
    draw(lane.halfWidth, 'rgba(120,104,86,0.55)');                    // carriageway
  }

  // --- Structures -------------------------------------------------------------
  for (const p of panel.props) {
    const drawRect = (cx, cz, hw, hd, rot, stroke, fill, dash) => {
      ctx.save();
      ctx.translate(px(cx), pz(cz));
      // World yaw is measured from +z toward +x; canvas y runs down, so it is a plain
      // clockwise rotation once +z is down.
      ctx.rotate(-rot);
      ctx.beginPath();
      ctx.rect(-hw * SCALE, -hd * SCALE, hw * 2 * SCALE, hd * 2 * SCALE);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
    };
    if (p.minor) {
      drawRect(p.x, p.z, p.hw, p.hd, p.rot, 'rgba(60,52,44,0.35)', 'rgba(60,52,44,0.06)');
      continue;
    }
    drawRect(p.x, p.z, p.hw, p.hd, p.rot, 'rgba(60,52,44,0.55)', 'rgba(232,226,212,0.55)', [3, 3]);
    drawRect(p.wallX, p.wallZ, p.wallHw, p.wallHd, p.rot, 'rgba(38,34,30,0.9)', 'rgba(216,206,186,0.85)');

    if (p.front) {
      // The door, and which way it looks: local −z, rotated.
      const fx = -Math.sin(p.rot), fz = -Math.cos(p.rot);
      ctx.strokeStyle = '#C4503A'; ctx.fillStyle = '#C4503A'; ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px(p.doorX), pz(p.doorZ));
      ctx.lineTo(px(p.doorX + fx * 4), pz(p.doorZ + fz * 4));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px(p.doorX + fx * 4), pz(p.doorZ + fz * 4), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(38,34,30,0.85)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(p.id, px(p.x), pz(p.z) + 3);
  }
}
window.__plansReady = true;
</script>`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForFunction(() => window.__plansReady === true, null, { timeout: 60_000 });

for (const panel of panels) {
  const element = page.locator(`#p-${panel.id}`);
  await element.screenshot({ path: resolve(outDir, `${panel.id}.png`) });
  console.log(`  - ${panel.id.padEnd(14)} ${panel.span} m`);
}
await browser.close();
console.log(`\n${panels.length} plans for ${activeMap().name} in ${outDir}`);
process.exit(0);
