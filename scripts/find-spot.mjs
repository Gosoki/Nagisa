#!/usr/bin/env node
/**
 * Spot finder — a development tool, run when something has to be re-sited.
 * =======================================================================
 *
 *     SPOT='{"id":"sh-office","near":[0,74],"radius":34}' node scripts/find-spot.mjs
 *
 * `scripts/layout-solve.mjs` answers "where does this go if I want it *there*". This answers
 * the other question: "where can this go at all". It sweeps a disc and reports the positions
 * where a given landmark would satisfy every rule the audits enforce at once —
 *
 * - level ground under the whole footprint (`world-smoke`'s 0.45 m),
 * - clear of every carriageway, by the built extent including eaves,
 * - clear of every other structure, by oriented rectangle,
 * - and, for anything with a modelled front, turned so its door addresses the nearest lane.
 *
 * — sorted so the ones nearest the place it belongs to come first. Re-siting one building by
 * hand means checking four things against nine other buildings and four lanes, which is where
 * the last three rounds of "fixed it, broke something else" came from.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = require(resolve(root, 'packages/shared/dist/index.js'));
shared.resolveMapId(process.env.NAGISA_MAP);
const { LANDMARKS, PATHS, heightAt } = shared;

// The built extents, kept in step with `scripts/placement-audit.ts`.
const FOOTPRINT = {
  warehouse: [10, 8], machiya: [8, 10], minka: [10, 8], bathhouse: [13, 10],
  teahouse: [11, 8.5], 'keepers-house': [10, 7.5], boathouse: [7, 10], stage: [12, 9],
  'shrine-hall': [10, 8], lighthouse: [9.3, 9.3], 'market-stall': [3.2, 2.4], 'beach-hut': [6, 5],
  'net-rack': [1.4, 5], well: [2.6, 1.6], 'notice-board': [3.2, 0.4], 'bell-tower': [2.6, 2.6],
  temizuya: [3.6, 3], torii: [5.4, 0.5], gate: [4.6, 0.34], komainu: [1.5, 1.2],
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
const FURNITURE = new Set(['bench', 'stone-lantern', 'post-lantern', 'rail', 'steps', 'banner', 'rock', 'boat', 'komainu']);
const WATERFRONT = new Set(['pier', 'breakwater', 'sea-wall']);
/** Footprints `world-smoke` uses for the flatness test — the walls, not the eaves. */
const FLAT_FOOTPRINT = {
  komainu: [1.6, 1.4], 'market-stall': [3.4, 2.6], 'net-rack': [1.6, 5], banner: [1.2, 1.2],
  'post-lantern': [0.8, 0.8], 'stone-lantern': [1.4, 1.4], bench: [2.4, 0.8],
  'summit-marker': [1.6, 1.6], 'beach-hut': [8, 6], minka: [12, 10], machiya: [9, 12],
  warehouse: [13, 9], teahouse: [12, 9], bathhouse: [15, 12], 'keepers-house': [11, 8],
  'shrine-hall': [14, 11],
};

function rectAt(l, x, z, rot) {
  const fb = FOOTPRINT[l.kind] ?? [3, 3];
  const w = typeof l.opts?.width === 'number' ? l.opts.width : typeof l.opts?.w === 'number' ? l.opts.w : fb[0];
  const d = typeof l.opts?.length === 'number' ? l.opts.length : typeof l.opts?.d === 'number' ? l.opts.d : fb[1];
  const eave = EAVES[l.kind] ?? 0;
  const scale = l.scale ?? 1;
  const front = NOSE_ANCHORED.has(l.kind) ? 0 : -(d / 2 + eave + (APRON[l.kind] ?? 0));
  const back = NOSE_ANCHORED.has(l.kind) ? d : d / 2 + eave + (REAR[l.kind] ?? 0);
  const centre = ((front + back) / 2) * scale;
  return {
    x: x + centre * Math.sin(rot), z: z + centre * Math.cos(rot),
    hw: (w / 2 + eave) * scale, hd: ((back - front) / 2) * scale, rot,
  };
}

function penetration(A, B) {
  let least = Infinity;
  for (const box of [A, B]) {
    const s = Math.sin(box.rot);
    const c = Math.cos(box.rot);
    for (const [nx, nz] of [[s, c], [c, -s]]) {
      const project = (o) => {
        const centre = o.x * nx + o.z * nz;
        const os = Math.sin(o.rot);
        const oc = Math.cos(o.rot);
        const radius = Math.abs(o.hd * (os * nx + oc * nz)) + Math.abs(o.hw * (oc * nx - os * nz));
        return [centre - radius, centre + radius];
      };
      const [a0, a1] = project(A);
      const [b0, b1] = project(B);
      const gap = Math.min(a1, b1) - Math.max(a0, b0);
      if (gap <= 0) return 0;
      least = Math.min(least, gap);
    }
  }
  return least;
}

function nearestLane(x, z) {
  let best = { dist: Infinity, halfWidth: 0, px: 0, pz: 0 };
  for (const path of PATHS) {
    const pts = path.points;
    for (let k = 1; k < pts.length; k++) {
      const [ax, az] = pts[k - 1];
      const [bx, bz] = pts[k];
      const vx = bx - ax;
      const vz = bz - az;
      const len2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2));
      const px = ax + vx * t;
      const pz = az + vz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.dist) best = { dist: d, halfWidth: path.halfWidth, px, pz };
    }
  }
  return best;
}

function reachToward(b, tx, tz) {
  const dx = tx - b.x;
  const dz = tz - b.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len;
  const nz = dz / len;
  const s = Math.sin(b.rot);
  const c = Math.cos(b.rot);
  return Math.abs(b.hd * (s * nx + c * nz)) + Math.abs(b.hw * (c * nx - s * nz));
}

function flatDrop(l, x, z, rot) {
  const [dw, dd] = FLAT_FOOTPRINT[l.kind] ?? [3, 3];
  const scale = l.scale ?? 1;
  const w = (Number(l.opts?.w ?? dw) * scale) / 2;
  const d = (Number(l.opts?.d ?? dd) * scale) / 2;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  let min = Infinity;
  let max = -Infinity;
  for (const [ox, oz] of [[-w, -d], [w, -d], [-w, d], [w, d], [0, 0]]) {
    const h = heightAt(x + ox * cos - oz * sin, z + ox * sin + oz * cos);
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return max - min;
}

const wish = JSON.parse(process.env.SPOT);
const l = LANDMARKS.find((k) => k.id === wish.id);
if (!l) throw new Error(`no landmark ${wish.id}`);
const [cx, cz] = wish.near;
const radius = wish.radius ?? 30;
const others = LANDMARKS.filter((o) => o.id !== l.id && !FURNITURE.has(o.kind) && !WATERFRONT.has(o.kind) && o.opts?.inWater !== true)
  .map((o) => ({ o, rect: rectAt(o, o.x, o.z, o.rot) }));

const hits = [];
for (let x = cx - radius; x <= cx + radius; x += 1) {
  for (let z = cz - radius; z <= cz + radius; z += 1) {
    if (Math.hypot(x - cx, z - cz) > radius) continue;
    const lane = nearestLane(x, z);
    // Face the road, which is what the audit requires of anything with a modelled front.
    const rot = wish.rot !== undefined ? wish.rot : Math.atan2(x - lane.px, z - lane.pz);
    const drop = flatDrop(l, x, z, rot);
    if (drop > (wish.maxDrop ?? 0.3)) continue;
    const rect = rectAt(l, x, z, rot);
    const near = nearestLane(rect.x, rect.z);
    const clear = near.dist - reachToward(rect, near.px, near.pz) - (near.halfWidth + 1.0);
    if (clear < (wish.clear ?? 0.5)) continue;
    let clash = false;
    for (const { rect: r } of others) if (penetration(rect, r) > 0) { clash = true; break; }
    if (clash) continue;
    hits.push({ x, z, rot, drop, clear, d: Math.hypot(x - cx, z - cz) });
  }
}
hits.sort((a, b) => a.d - b.d);
if (!hits.length) console.log('no spot found');
for (const h of hits.slice(0, wish.show ?? 6)) {
  console.log(
    `  x: ${h.x}, z: ${h.z}, rot: ${h.rot.toFixed(3)}   drop ${h.drop.toFixed(2)} m, ` +
      `road clearance +${h.clear.toFixed(1)} m, ${h.d.toFixed(0)} m from the anchor`,
  );
}
