#!/usr/bin/env node
/**
 * Layout solver — a development tool, run when a place is being re-composed.
 * =========================================================================
 *
 *     node scripts/layout-solve.mjs              # prints map lines, changes nothing
 *     node scripts/layout-solve.mjs --map lantern-atoll
 *
 * ### Why this exists
 *
 * A building beside a road wants to be described the way a surveyor would describe it —
 * *this far along that lane, this far off the centreline, facing the traffic* — and stored
 * the way the renderer needs it, as an `x`, a `z` and a yaw. Doing that conversion by hand is
 * ten lines of trigonometry per building, and the two places it goes wrong are the two places
 * that matter: the setback (so the eaves clear the carriageway) and the sign of the yaw (so
 * the door is on the street side rather than the hillside).
 *
 * So the intent below is written in road coordinates and the numbers come out the other end.
 * `offset: 'auto'` asks for the smallest setback that clears the carriageway, the kerb and
 * whatever the building hangs over it — verandas and eaves included, which is the whole
 * reason the previous pass left nineteen buildings in the road while believing none were.
 *
 * It does not write the map: it prints, the numbers get pasted, and `npm run audit:placement`
 * is what decides whether the result is right. The solver knows about lanes and nothing else
 * — not the terrace rims, not the other buildings, not whether the composition reads.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = require(resolve(root, 'packages/shared/dist/index.js'));

const mapArg = process.argv.indexOf('--map');
shared.resolveMapId(mapArg >= 0 ? process.argv[mapArg + 1] : process.env.NAGISA_MAP);

const { LANDMARKS, PADS, PATHS, heightAt } = shared;

// The built extents, kept in step with `scripts/placement-audit.ts`.
const FOOTPRINT = {
  warehouse: [10, 8], machiya: [8, 10], minka: [10, 8], bathhouse: [13, 10],
  teahouse: [11, 8.5], 'keepers-house': [10, 7.5], boathouse: [7, 10], stage: [12, 9],
  'shrine-hall': [10, 8], lighthouse: [9.3, 9.3], 'market-stall': [3.2, 2.4], 'beach-hut': [6, 5],
  'net-rack': [1.4, 5], well: [2.6, 1.6], 'notice-board': [3.2, 0.4], 'bell-tower': [2.6, 2.6],
  temizuya: [3.6, 3], torii: [5.4, 0.5], gate: [4.6, 0.34], komainu: [1.5, 1.2],
  'summit-marker': [1.5, 1.5], bench: [1.8, 0.6], 'stone-lantern': [0.9, 0.9],
  'post-lantern': [0.5, 0.5], rail: [0.3, 16], 'sea-wall': [1.2, 30],
};
const EAVES = {
  machiya: 0.9, minka: 1.25, warehouse: 1.15, teahouse: 1.3, bathhouse: 1.0,
  boathouse: 0.7, 'keepers-house': 0.6, 'beach-hut': 0.7, 'shrine-hall': 1.8,
  stage: 1.2, 'market-stall': 0.35, temizuya: 0.85, 'bell-tower': 0.9,
  'notice-board': 0.6, gate: 0.8, torii: 0.6, well: 0.4, 'net-rack': 0.3,
};
const APRON = { minka: 1.15, teahouse: 0.3, bathhouse: 0.7, boathouse: 4.3, 'shrine-hall': 1.4, stage: 1.2 };
const REAR = { stage: 0.4 };

/** Clear the carriageway by this much. A metre of kerb, plus half a metre of daylight. */
const KERB = 1.5;

function extentOf(l) {
  const fb = FOOTPRINT[l.kind] ?? [3, 3];
  const w = typeof l.opts?.w === 'number' ? l.opts.w : fb[0];
  const d = typeof l.opts?.d === 'number' ? l.opts.d : fb[1];
  const eave = EAVES[l.kind] ?? 0;
  const s = l.scale ?? 1;
  return {
    hw: (w / 2 + eave) * s,
    front: (d / 2 + eave + (APRON[l.kind] ?? 0)) * s,
    back: (d / 2 + eave + (REAR[l.kind] ?? 0)) * s,
  };
}

/** How far the built rectangle reaches along a unit direction, given a yaw. */
function reachAlong(l, rot, nx, nz) {
  const e = extentOf(l);
  const s = Math.sin(rot);
  const c = Math.cos(rot);
  // Local −z is the front, +z the back; they differ, so take whichever the direction picks.
  const alongDepth = -(s * nx + c * nz); // component of the *front* direction on n
  const depth = alongDepth > 0 ? e.front * alongDepth : e.back * -alongDepth;
  return depth + Math.abs(e.hw * (c * nx - s * nz));
}

// --- Lane geometry --------------------------------------------------------------------

const lanes = new Map();
for (const path of PATHS) {
  const pts = path.points.map(([x, z]) => ({ x, z }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  lanes.set(path.id, { path, pts, cum, length: cum[cum.length - 1] });
}

/** Point and unit tangent at arc length `s` along a lane. */
function at(laneId, s) {
  const lane = lanes.get(laneId);
  const t = Math.max(0, Math.min(lane.length, s));
  let i = 1;
  while (i < lane.cum.length - 1 && lane.cum[i] < t) i++;
  const a = lane.pts[i - 1];
  const b = lane.pts[i];
  const seg = lane.cum[i] - lane.cum[i - 1] || 1;
  const f = (t - lane.cum[i - 1]) / seg;
  const tx = (b.x - a.x) / seg;
  const tz = (b.z - a.z) / seg;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, tx, tz, halfWidth: lane.path.halfWidth };
}

/** Distance from a point to the nearest lane centreline, and the point on it. */
function nearestLane(x, z) {
  let best = { id: null, dist: Infinity, px: 0, pz: 0, halfWidth: 0 };
  for (const [id, lane] of lanes) {
    for (let k = 1; k < lane.pts.length; k++) {
      const a = lane.pts[k - 1];
      const b = lane.pts[k];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const len2 = vx * vx + vz * vz || 1;
      const f = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / len2));
      const px = a.x + vx * f;
      const pz = a.z + vz * f;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.dist) best = { id, dist: d, px, pz, halfWidth: lane.path.halfWidth };
    }
  }
  return best;
}

// --- The intent -----------------------------------------------------------------------
//
// One entry per landmark being placed. `side` is +1 to the left of the direction of travel
// and −1 to the right; `offset: 'auto'` solves for the tightest legal setback.
//
//   face: 'road'   turn the door toward the nearest point on the lane
//   face: 'along'  turn the door along the lane, in the direction of travel
//   face: 'back'   turn the door along the lane, against it
//   face: <number> an explicit yaw, in radians
const intentArg = process.argv.indexOf('--intent');
const INTENT = JSON.parse(
  intentArg >= 0 ? require('node:fs').readFileSync(process.argv[intentArg + 1], 'utf8') : (process.env.LAYOUT_INTENT ?? '[]'),
);

const byId = new Map(LANDMARKS.map((l) => [l.id, l]));
const out = [];

for (const wish of INTENT) {
  const l = byId.get(wish.id);
  if (!l) {
    out.push(`  // ${wish.id} — not in this map`);
    continue;
  }
  const station = at(wish.lane, wish.s);
  // Left of travel: rotate the tangent a quarter turn.
  const nx = -station.tz * wish.side;
  const nz = station.tx * wish.side;

  // The yaw first, because the setback depends on which face is toward the road.
  let rot;
  if (typeof wish.face === 'number') rot = wish.face;
  else if (wish.face === 'along') rot = Math.atan2(-station.tx, -station.tz);
  else if (wish.face === 'back') rot = Math.atan2(station.tx, station.tz);
  else if (wish.face === 'away') rot = Math.atan2(-nx, -nz); // turn the back on the lane
  else if (wish.face === 'across') rot = Math.atan2(station.tx, station.tz); // a portal, spanning it
  else rot = Math.atan2(nx, nz); // 'road': the front points back at the centreline

  let offset = wish.offset;
  if (offset === 'auto' || offset === undefined) {
    offset = station.halfWidth + KERB + reachAlong(l, rot, -nx, -nz) + (wish.clear ?? 0);
  }

  const x = station.x + nx * offset;
  const z = station.z + nz * offset;
  const check = nearestLane(x, z);
  const slack = check.dist - check.halfWidth - reachAlong(l, rot, (check.px - x) / (check.dist || 1), (check.pz - z) / (check.dist || 1));
  const pad = PADS.map((p) => ({ id: p.id, d: Math.hypot(x - p.x, z - p.z), inner: p.inner })).sort((a, b) => a.d - b.d)[0];

  out.push(
    `  { id: '${l.id}', kind: '${l.kind}', x: ${x.toFixed(1)}, z: ${z.toFixed(1)}, rot: ${rot.toFixed(3)}` +
      `${l.scale !== undefined ? `, scale: ${l.scale}` : ''}` +
      `${l.opts ? `, opts: ${JSON.stringify(l.opts).replace(/"/g, '').replace(/:/g, ': ').replace(/,/g, ', ')}` : ''} },` +
      `   // ${check.id} ${slack >= 0 ? `+${slack.toFixed(1)}` : slack.toFixed(1)} m clear` +
      `, ${pad.id} r=${pad.d.toFixed(0)}/${pad.inner}, ground ${heightAt(x, z).toFixed(1)}`,
  );
}

process.stdout.write(out.join('\n') + '\n');
