/**
 * Setback solver — development tool, run once and thrown at the map file.
 * =======================================================================
 *
 *     node scripts/setback-solve.mjs           # prints a patch, changes nothing
 *
 * The lanes are surveyed and carved before anything is placed, and the ring road's
 * waypoints *are* the six terrace centres — so every zone has a road through the middle of
 * it and the buildings, which are composed around that same middle, stand in the
 * carriageway. Twenty-six of them, the plaza stage by twelve metres.
 *
 * Moving twenty-six buildings by hand-computed geometry is a good way to introduce five new
 * mistakes, so this computes the move instead: push each offender along the perpendicular to
 * its lane, away from it, until its *wall* clears the carriageway plus a kerb.
 *
 * Two rules make the result a village rather than a set of solved constraints:
 *
 * - **Mirror pairs move together.** A pair pushed by different amounts stops being a pair,
 *   and the symmetry is the thing the layout is *for*. Both members take the larger push.
 * - **A crowded zone empties to one side.** Where more than half a terrace's buildings sit
 *   on the same side of the road, the rest join them, because a road with buildings down one
 *   side and one lonely house opposite reads as a mistake, and because it is what the brief
 *   asked for.
 *
 * It does not write the map. It prints the coordinates, they get pasted in, and
 * `npm run audit:placement` is what says whether the result is actually correct — the solver
 * cannot see the terrace rims, the other buildings, or anything else the audits check.
 */

import { LANDMARKS, PADS, PATHS, resolveMapId, type Landmark } from '../packages/shared/src/index.js';

const mapArg = process.argv.indexOf('--map');
resolveMapId(mapArg >= 0 ? process.argv[mapArg + 1] : process.env.NAGISA_MAP);

/** Clear of the carriageway by this much before a building counts as off the road. */
const KERB = 1.6;

const FURNITURE = new Set([
  'bench', 'stone-lantern', 'post-lantern', 'rail', 'steps', 'banner', 'rock', 'boat',
  'komainu', 'pier', 'breakwater', 'sea-wall', 'torii', 'gate',
]);

const FOOTPRINT: Record<string, [number, number]> = {
  warehouse: [10, 8], machiya: [8, 10], minka: [10, 8], bathhouse: [13, 10],
  teahouse: [11, 8.5], 'keepers-house': [10, 7.5], boathouse: [7, 10], stage: [12, 9],
  'shrine-hall': [10, 8], lighthouse: [6, 6], 'market-stall': [3, 2.5], 'beach-hut': [6, 5],
  'net-rack': [4, 1.5], well: [2.4, 2.4], 'notice-board': [2.4, 0.8], 'bell-tower': [3.4, 3.4],
  temizuya: [3, 2.4], 'summit-marker': [1.6, 1.6],
};

function boxOf(l: Landmark): { hw: number; hd: number; rot: number } {
  const fb = FOOTPRINT[l.kind] ?? [3, 3];
  const w = typeof l.opts?.w === 'number' ? l.opts.w : fb[0];
  const d = typeof l.opts?.d === 'number' ? l.opts.d : fb[1];
  const s = l.scale ?? 1;
  return { hw: (w * s) / 2, hd: (d * s) / 2, rot: l.rot };
}

/** How far the footprint reaches along a unit direction. */
function reachAlong(l: Landmark, nx: number, nz: number): number {
  const b = boxOf(l);
  const s = Math.sin(b.rot);
  const c = Math.cos(b.rot);
  return Math.abs(b.hd * (s * nx + c * nz)) + Math.abs(b.hw * (c * nx - s * nz));
}

interface LaneHit {
  id: string;
  dist: number;
  halfWidth: number;
  px: number;
  pz: number;
}

function nearestLane(x: number, z: number): LaneHit | null {
  let best: LaneHit | null = null;
  for (const path of PATHS) {
    const pts = path.points;
    for (let k = 1; k < pts.length; k++) {
      const [ax, az] = pts[k - 1]!;
      const [bx, bz] = pts[k]!;
      const vx = bx - ax;
      const vz = bz - az;
      const len2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2));
      const px = ax + vx * t;
      const pz = az + vz * t;
      const d = Math.hypot(x - px, z - pz);
      if (!best || d < best.dist) best = { id: path.id, dist: d, halfWidth: path.halfWidth, px, pz };
    }
  }
  return best;
}

/**
 * Push needed to get a landmark's wall clear of its nearest lane, metres. Zero if clear.
 *
 * Takes the position explicitly so the caller can iterate: a single push solves the nearest
 * lane and can land the building squarely in a different one, which is exactly what happened
 * to the south quay's warehouses — shoved off the east lane and straight onto the ring road.
 */
function pushFor(l: Landmark, atX = l.x, atZ = l.z): { push: number; nx: number; nz: number; lane: LaneHit } | null {
  const lane = nearestLane(atX, atZ);
  if (!lane) return null;
  // Away from the lane. Degenerate when the building sits exactly on the centreline (the
  // lighthouse and the old street's well both do), so fall back to the terrace's own
  // outward direction, which is the only other thing that means anything there.
  let nx = atX - lane.px;
  let nz = atZ - lane.pz;
  let len = Math.hypot(nx, nz);
  if (len < 0.01) {
    const pad = PADS.find((p) => Math.hypot(atX - p.x, atZ - p.z) <= p.outer);
    const ax = pad ? atX - pad.x : 1;
    const az = pad ? atZ - pad.z : 0;
    const al = Math.hypot(ax, az) || 1;
    // Perpendicular to the lane is what is wanted; with no lane direction to hand, any
    // outward direction beats staying put.
    nx = ax / al || 1;
    nz = az / al;
    len = 1;
  } else {
    nx /= len;
    nz /= len;
  }
  const need = lane.halfWidth + KERB + reachAlong(l, -nx, -nz);
  const push = need - lane.dist;
  return { push, nx, nz, lane };
}

/** Mirror partners, by id, so a pair moves as a pair. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['sh-warehouse-1', 'sh-warehouse-2'],
  ['nh-shed', 'nh-minka'],
  ['nh-netrack-1', 'nh-netrack-2'],
  ['bh-hut-1', 'bh-hut-2'],
  ['su-bell', 'su-temizuya'],
  ['lh-keepers', 'lh-store'],
  ['sr-bell', 'sr-temizuya'],
  ['ov-machiya-1', 'ov-machiya-4'],
  ['ov-machiya-2', 'ov-machiya-5'],
  ['ov-machiya-3', 'ov-machiya-6'],
];

const partner = new Map<string, string>();
for (const [a, b] of PAIRS) {
  partner.set(a, b);
  partner.set(b, a);
}

const byId = new Map(LANDMARKS.map((l) => [l.id, l]));
const pushes = new Map<string, number>();

/**
 * Final position per landmark, after pairing.
 *
 * Equalising the *magnitude* of a pair's push is not enough, and the first version that did
 * only that pulled two pairs apart: the south quay's warehouses were pushed by different
 * lanes — one off the east lane going north-east, the other off the ring road going south —
 * and came out on opposite sides of the square. A pair is a pair because its two members are
 * reflections, so the reflection is what has to be preserved: solve one member, then place
 * the other at the mirror image of the result.
 */
const placed = new Map<string, [number, number]>();


/**
 * Where a landmark ends up after being pushed clear of *every* lane, not just the nearest.
 *
 * Iterated rather than solved: each push is against whichever lane is closest now, and
 * clearing one can move a building into another. Eight rounds is far more than the two the
 * worst case needs, and if a position is genuinely boxed in the loop leaves it where it is
 * and the audit reports it, which is the right outcome — that is a layout problem, not an
 * arithmetic one.
 */
function solve(l: Landmark): { x: number; z: number; moved: number } {
  let x = l.x;
  let z = l.z;
  for (let round = 0; round < 8; round++) {
    const r = pushFor(l, x, z);
    if (!r || r.push <= 0.01) break;
    x += r.nx * r.push;
    z += r.nz * r.push;
  }
  return { x, z, moved: Math.hypot(x - l.x, z - l.z) };
}

for (const l of LANDMARKS) {
  if (FURNITURE.has(l.kind) || l.opts?.inWater === true) continue;
  const solved = solve(l);
  if (solved.moved <= 0.05) continue;
  pushes.set(l.id, solved.moved);
  placed.set(l.id, [solved.x, solved.z]);
}


/** The mirror through a terrace that maps `a`'s position onto `b`'s: 'x', 'z', or null. */
function mirrorAxis(a: Landmark, b: Landmark): { cx: number; cz: number; axis: 'x' | 'z' } | null {
  const pad = PADS.find((p) => Math.hypot(a.x - p.x, a.z - p.z) <= p.outer);
  if (!pad) return null;
  const overX = Math.hypot(2 * pad.x - a.x - b.x, a.z - b.z);
  const overZ = Math.hypot(a.x - b.x, 2 * pad.z - a.z - b.z);
  if (Math.min(overX, overZ) > 4) return null; // not actually a reflection about this pad
  return { cx: pad.x, cz: pad.z, axis: overX <= overZ ? 'x' : 'z' };
}

// Solve the leader of each pair, then reflect it onto the follower.
for (const [a, b] of PAIRS) {
  const la = byId.get(a);
  const lb = byId.get(b);
  if (!la || !lb) continue;
  const pa = pushes.get(a) ?? 0;
  const pb = pushes.get(b) ?? 0;
  const push = Math.max(pa, pb);
  if (push <= 0) continue;

  const leader = pa >= pb ? la : lb;
  const follower = pa >= pb ? lb : la;
  const solved = placed.get(leader.id) ?? [leader.x, leader.z];
  const [lx, lz] = solved;

  const m = mirrorAxis(leader, follower);
  placed.set(
    follower.id,
    m === null
      ? [follower.x + (lx - leader.x), follower.z + (lz - leader.z)]
      : m.axis === 'x'
        ? [2 * m.cx - lx, lz]
        : [lx, 2 * m.cz - lz],
  );
  pushes.set(leader.id, push);
  pushes.set(follower.id, push);
}

process.stdout.write('// setback patch — paste into the map, then run `npm run audit:placement`\n');
const moved: string[] = [];
for (const [id, push] of [...pushes].sort((x, y) => y[1] - x[1])) {
  const l = byId.get(id)!;
  const to = placed.get(id);
  if (!to) continue;
  const mate = partner.get(id);
  moved.push(
    `  ${id.padEnd(20)} (${String(l.x).padStart(5)},${String(l.z).padStart(5)}) -> ` +
      `(${to[0].toFixed(1).padStart(6)},${to[1].toFixed(1).padStart(6)})  push ${push.toFixed(1)} m` +
      `${mate ? `  [pair with ${mate}]` : ''}`,
  );
}
process.stdout.write(moved.join('\n') + '\n');
process.stdout.write(`\n${placed.size} buildings to move\n`);
