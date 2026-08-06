/**
 * Building placement audit — symmetry and orientation.
 * ====================================================
 *
 *     npm run audit:placement
 *     NAGISA_MAP=lantern-atoll npm run audit:placement
 *
 * ### What "aligned" means here
 *
 * Two buildings mirrored about an axis through the place they belong to. Not one building
 * with a mirrored half — a *pair*, one either side, the way a shrine has two guardian dogs
 * and a gate has two lanterns. It is the oldest trick in built space for saying "this is the
 * front, and you are meant to walk down the middle of it", and it is most of the difference
 * between a village and a scatter of houses.
 *
 * Complete symmetry would be worse than none: real settlements are symmetric *at their
 * ceremonial heart* and loose everywhere else. So the summit court is held to a high bar and
 * the working places — harbours, the old street — only to about a third, with the rest
 * deliberately one-sided.
 *
 * ### The axis is derived, not declared
 *
 * Every zone is scored against a sweep of candidate axes through its anchor and reported at
 * its best one. That means the audit measures the composition that is *there* rather than
 * the one the author says is there, so a place that was laid out symmetrically about a
 * different line than expected reads as symmetric, and a place that was not cannot be
 * argued into passing.
 *
 * ### Orientation
 *
 * A building facing nowhere in particular reads as scenery dropped from above. The check is
 * loose on purpose — a `rot` is *coherent* if it faces the zone's anchor, faces directly
 * away from it, or is square to the symmetry axis. That admits a house facing the street, a
 * warehouse backing onto it and a row of stalls along it, and rejects a building at 37° to
 * everything around it.
 */

import {
  LANDMARKS,
  PADS,
  ZONES,
  activeMap,
  resolveMapId,
  type Landmark,
} from '../packages/shared/src/index.js';

const mapArg = process.argv.indexOf('--map');
resolveMapId(mapArg >= 0 ? process.argv[mapArg + 1] : process.env.NAGISA_MAP);

/**
 * Kinds that carry a composition. Rocks and boats are landscape — a mirrored pair of
 * boulders looks *staged*, which is the opposite of the point — so they are excluded from
 * both the numerator and the denominator rather than counted as failures.
 */
const COMPOSED = new Set([
  'warehouse', 'machiya', 'minka', 'bathhouse', 'teahouse', 'market-stall', 'keepers-house',
  'torii', 'shrine-hall', 'temizuya', 'komainu', 'bell-tower',
  'stage', 'notice-board', 'gate', 'well', 'lighthouse',
  'stone-lantern', 'post-lantern', 'bench', 'beach-hut', 'net-rack',
]);

/**
 * Massing classes. Two landmarks pair if they are the same kind *or* the same class: a bell
 * tower opposite a purification basin is the canonical way to flank a shrine approach, and a
 * rule that demanded identical kinds would read the oldest symmetry in the vocabulary as an
 * absence of one.
 */
const MASSING: Record<string, string> = {
  warehouse: 'house', machiya: 'house', minka: 'house', bathhouse: 'house',
  teahouse: 'house', 'keepers-house': 'house', 'beach-hut': 'house', boathouse: 'house',
  'bell-tower': 'outbuilding', temizuya: 'outbuilding', well: 'outbuilding',
  'notice-board': 'outbuilding', 'market-stall': 'outbuilding', 'net-rack': 'outbuilding',
  torii: 'portal', gate: 'portal',
  bench: 'seat', 'stone-lantern': 'marker', 'post-lantern': 'marker', komainu: 'marker',
};

function pairs(a: Landmark, b: Landmark): boolean {
  if (a.kind === b.kind) return true;
  const ca = MASSING[a.kind];
  return ca !== undefined && ca === MASSING[b.kind];
}

/** How close a mirrored position has to land to count as a pair, metres. */
const PAIR_TOLERANCE = 3.0;

/** How close a yaw has to be to one of the coherent directions, radians. ~17°. */
const YAW_TOLERANCE = 0.3;

/** Candidate axes swept per zone. 5° steps over a half turn — an axis and its reverse are one axis. */
const AXIS_STEPS = 36;


/**
 * Kinds whose yaw is visible. A stone lantern is a square shaft on a square base and a well
 * is round: rotating either changes nothing anyone can see, so holding them to a facing rule
 * reports noise as a defect.
 */
const ORIENTED = new Set([
  'warehouse', 'machiya', 'minka', 'bathhouse', 'teahouse', 'market-stall', 'keepers-house',
  'torii', 'shrine-hall', 'temizuya', 'bell-tower', 'stage', 'notice-board', 'gate',
  'bench', 'beach-hut', 'net-rack', 'lighthouse',
]);

/**
 * How far a landmark's yaw is from the nearest direction that means something here.
 *
 * Four count as meaningful: facing the place's centre, backing onto it, lying along the
 * composition's axis, and lying square to it. Each is taken modulo a half turn, because a
 * building presented end-on and the same building turned 180° are the same composition —
 * whether its door is on this side is the model's business, not the layout's.
 */
function missAngle(l: Landmark, cx: number, cz: number, axis: number): number {
  return nearestCoherent(l, cx, cz, axis).miss;
}

/** The nearest meaningful yaw, and how far the landmark is from it. */
function nearestCoherent(l: Landmark, cx: number, cz: number, axis: number): { yaw: number; miss: number } {
  const toCentre = Math.atan2(cx - l.x, cz - l.z);
  // The axis sweep is in (x, z) space measured from +x; yaw is measured from +z. Convert.
  const axisYaw = Math.PI / 2 - axis;
  let best = Math.PI;
  let bestYaw = l.rot;
  for (const w of [toCentre, axisYaw, axisYaw + Math.PI / 2]) {
    for (const cand of [w, w + Math.PI]) {
      const d = angleDelta(l.rot, cand);
      if (d < best) {
        best = d;
        // Normalise into (-π, π] so the suggestion can be pasted straight into the map.
        bestYaw = Math.atan2(Math.sin(cand), Math.cos(cand));
      }
    }
  }
  return { yaw: bestYaw, miss: best };
}

interface ZoneReport {
  id: string;
  name: string;
  count: number;
  paired: number;
  axis: number;
  onAxis: number;
  incoherent: Landmark[];
}

function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

/**
 * Landmarks belonging to a place. Assigned to the nearest *terrace*, not by zone radius:
 * zone radii overlap and reach out over water, so a harbour's radius claims half the
 * beach's props and the composition of neither can be read.
 */
function landmarksFor(padId: string): Landmark[] {
  const pad = PADS.find((p) => p.id === padId)!;
  return LANDMARKS.filter((l) => {
    if (!COMPOSED.has(l.kind)) return false;
    let best = padId;
    let bestDist = Infinity;
    for (const p of PADS) {
      const d = Math.hypot(l.x - p.x, l.z - p.z);
      if (d < bestDist) {
        bestDist = d;
        best = p.id;
      }
    }
    return best === padId && bestDist <= pad.outer;
  });
}

/**
 * Score one axis: how many landmarks find a mirror partner of the same kind across it.
 * Returns the pairing as well, because a pair's *facing* is judged against its partner.
 */
function scoreAxis(
  items: Landmark[],
  cx: number,
  cz: number,
  angle: number,
): { paired: number; onAxis: number; partner: Map<number, number> } {
  const ax = Math.cos(angle);
  const az = Math.sin(angle);
  let paired = 0;
  let onAxis = 0;
  const used = new Set<number>();
  const partner = new Map<number, number>();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const a = items[i]!;
    // Signed distance from the axis, and the reflected position.
    const dx = a.x - cx;
    const dz = a.z - cz;
    const along = dx * ax + dz * az;
    const across = -dx * az + dz * ax;

    if (Math.abs(across) <= PAIR_TOLERANCE / 2) {
      // Sitting on the axis is its own kind of alignment — a torii or a hall on the
      // centre-line is exactly what the composition is about.
      onAxis++;
      used.add(i);
      continue;
    }

    const mx = cx + ax * along + az * across;
    const mz = cz + az * along - ax * across;
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const b = items[j]!;
      if (!pairs(a, b)) continue;
      if (Math.hypot(b.x - mx, b.z - mz) <= PAIR_TOLERANCE) {
        paired += 2;
        used.add(i);
        used.add(j);
        partner.set(i, j);
        partner.set(j, i);
        break;
      }
    }
  }
  return { paired, onAxis, partner };
}

/** Terrace by id — used when reporting, where only the zone name is to hand. */
const pd = (id: string): Landmark => PADS.find((p) => p.id === id)! as unknown as Landmark;

const reports: ZoneReport[] = [];

for (const pad of PADS) {
  const items = landmarksFor(pad.id);
  if (items.length < 3) continue;
  const zone = ZONES.find((z) => z.id === pad.id);

  let best = { paired: 0, onAxis: 0, angle: 0, partner: new Map<number, number>() };
  for (let k = 0; k < AXIS_STEPS; k++) {
    const angle = (k / AXIS_STEPS) * Math.PI;
    const s = scoreAxis(items, pad.x, pad.z, angle);
    if (s.paired + s.onAxis > best.paired + best.onAxis) best = { ...s, angle };
  }

  // Orientation, judged against the best axis — or, for a mirrored pair, against each
  // other. Two benches turned inward at equal and opposite angles face neither the centre
  // nor the axis, and are the single clearest statement of symmetry on the terrace; a rule
  // that called them adrift would be measuring its own narrowness.
  const axisYaw = Math.PI / 2 - best.angle;
  const incoherent = items.filter((l, i) => {
    if (!ORIENTED.has(l.kind)) return false;
    if (missAngle(l, pad.x, pad.z, best.angle) <= YAW_TOLERANCE) return false;
    const j = best.partner.get(i);
    if (j !== undefined && angleDelta(items[j]!.rot, 2 * axisYaw - l.rot) <= YAW_TOLERANCE) return false;
    return true;
  });

  reports.push({
    id: pad.id,
    name: zone?.name ?? pad.id,
    count: items.length,
    paired: best.paired,
    axis: best.angle,
    onAxis: best.onAxis,
    incoherent,
  });
}

process.stdout.write(`placement audit — ${activeMap().name} (${activeMap().id})\n\n`);
process.stdout.write(
  `${'place'.padEnd(16)} ${'props'.padStart(5)} ${'paired'.padStart(6)} ${'on axis'.padStart(7)} ` +
    `${'aligned'.padStart(7)}  ${'axis'.padStart(5)}  facing\n`,
);

for (const r of reports) {
  const aligned = (r.paired + r.onAxis) / r.count;
  process.stdout.write(
    `${r.name.padEnd(16)} ${String(r.count).padStart(5)} ${String(r.paired).padStart(6)} ` +
      `${String(r.onAxis).padStart(7)} ${(aligned * 100).toFixed(0).padStart(6)}%  ` +
      `${((r.axis * 180) / Math.PI).toFixed(0).padStart(4)}°  ` +
      `${r.incoherent.length === 0 ? 'all coherent' : `${r.incoherent.length} adrift`}\n`,
  );
}


// --- Overlap: buildings standing inside each other ------------------------------------
//
// The cheapest placement mistake to make and the most expensive to look at. Two structures
// authored a few metres apart, each several metres wide, interpenetrate — and because every
// prop is generated rather than placed by hand in a viewport, nothing in the data says so.
//
// Tested as **oriented rectangles**, by separating axis. The data already carries `w`, `d`
// and `rot`, so the exact answer costs four axis projections; a bounding-circle version was
// tried first and spent its whole output on false positives, because the two rows of the old
// street are deep, narrow houses turned side-on and their diagonals overlap while the houses
// do not.
const FOOTPRINT: Record<string, [number, number]> = {
  warehouse: [10, 8], machiya: [8, 10], minka: [10, 8], bathhouse: [13, 10],
  teahouse: [11, 8.5], 'keepers-house': [10, 7.5], boathouse: [7, 10], stage: [12, 9],
  'shrine-hall': [10, 8], lighthouse: [6, 6], 'market-stall': [3, 2.5], 'beach-hut': [6, 5],
  'net-rack': [4, 1.5], well: [2.4, 2.4], 'notice-board': [2.4, 0.8], 'bell-tower': [3.4, 3.4],
  temizuya: [3, 2.4], torii: [5.4, 1], gate: [5.4, 1.2], komainu: [1, 1],
};

function boxOf(l: Landmark): { x: number; z: number; hw: number; hd: number; rot: number } {
  const fallback = FOOTPRINT[l.kind] ?? [3, 3];
  // Piers, breakwaters and sea walls are long thin things and say so with `length`/`width`
  // rather than `w`/`d`. Read as a 3 m box, a forty-metre breakwater is invisible to this
  // test along thirty-seven of those metres.
  const w = typeof l.opts?.width === 'number' ? l.opts.width
    : typeof l.opts?.w === 'number' ? l.opts.w : fallback[0];
  const d = typeof l.opts?.length === 'number' ? l.opts.length
    : typeof l.opts?.d === 'number' ? l.opts.d : fallback[1];
  const scale = l.scale ?? 1;
  return { x: l.x, z: l.z, hw: (w * scale) / 2, hd: (d * scale) / 2, rot: l.rot };
}

/** Separating-axis overlap of two rotated rectangles; returns the penetration depth, or 0. */
function penetration(a: Landmark, b: Landmark): number {
  const A = boxOf(a);
  const B = boxOf(b);
  let least = Infinity;
  for (const box of [A, B]) {
    // A rectangle's own two edge normals. `rot` is a yaw about +z, so the local axes are
    // (sin, cos) and (cos, -sin).
    const s = Math.sin(box.rot);
    const c = Math.cos(box.rot);
    for (const [nx, nz] of [
      [s, c],
      [c, -s],
    ] as const) {
      const project = (o: typeof A): [number, number] => {
        const centre = o.x * nx + o.z * nz;
        const os = Math.sin(o.rot);
        const oc = Math.cos(o.rot);
        const radius = Math.abs(o.hd * (os * nx + oc * nz)) + Math.abs(o.hw * (oc * nx - os * nz));
        return [centre - radius, centre + radius];
      };
      const [a0, a1] = project(A);
      const [b0, b1] = project(B);
      const gap = Math.min(a1, b1) - Math.max(a0, b0);
      if (gap <= 0) return 0; // a separating axis exists — they do not touch
      least = Math.min(least, gap);
    }
  }
  return least;
}

/** Kinds allowed to sit inside another's footprint — furniture belongs against buildings. */
const FURNITURE = new Set(['bench', 'stone-lantern', 'post-lantern', 'rail', 'steps', 'banner', 'rock', 'boat', 'komainu']);

/**
 * Structures that run from the water onto the land, and are therefore *meant* to meet what
 * is at the top of the beach. A mole whose landward end floated clear of the shore would be
 * the defect. They are checked against each other and exempted against everything else.
 */
const WATERFRONT = new Set(['pier', 'breakwater', 'sea-wall']);

/**
 * Row houses share party walls — that is what a 町屋 terrace *is*. Two of them touching is
 * the composition working, not a defect, so only a real burial counts.
 */
const PARTY_WALL_KINDS = new Set(['machiya']);
const PARTY_WALL_TOLERANCE = 2.5;

const overlaps: Array<[Landmark, Landmark, number]> = [];
for (let i = 0; i < LANDMARKS.length; i++) {
  const a = LANDMARKS[i]!;
  if (FURNITURE.has(a.kind) || a.opts?.inWater === true) continue;
  for (let j = i + 1; j < LANDMARKS.length; j++) {
    const b = LANDMARKS[j]!;
    if (FURNITURE.has(b.kind) || b.opts?.inWater === true) continue;
    if (WATERFRONT.has(a.kind) !== WATERFRONT.has(b.kind)) continue;
    const depth = penetration(a, b);
    if (depth <= 0) continue;
    if (PARTY_WALL_KINDS.has(a.kind) && PARTY_WALL_KINDS.has(b.kind) && depth <= PARTY_WALL_TOLERANCE) continue;
    overlaps.push([a, b, depth]);
  }
}
overlaps.sort((p, q) => q[2] - p[2]);

process.stdout.write(`\noverlapping structures: ${overlaps.length}\n`);
for (const [a, b, depth] of overlaps) {
  process.stdout.write(
    `    ${a.id.padEnd(20)} (${a.kind.padEnd(13)}) × ${b.id.padEnd(20)} (${b.kind.padEnd(13)})  ` +
      `${depth.toFixed(1)} m deep\n`,
  );
}

process.stdout.write('\n');
for (const r of reports) {
  if (!r.incoherent.length) continue;
  process.stdout.write(`  ${r.name} — yaw facing nothing in particular:\n`);
  for (const l of r.incoherent) {
    process.stdout.write(
      `    ${l.id.padEnd(22)} ${l.kind.padEnd(14)} rot ${((l.rot * 180) / Math.PI).toFixed(0).padStart(5)}°  ` +
        `off by ${((missAngle(pd(r.id), 0, 0, 0) * 0) + (nearestCoherent(l, pd(r.id).x, pd(r.id).z, r.axis).miss * 180) / Math.PI).toFixed(0)}°` +
        `  → suggest rot ${(nearestCoherent(l, pd(r.id).x, pd(r.id).z, r.axis).yaw).toFixed(3)}` +
        ` (${((nearestCoherent(l, pd(r.id).x, pd(r.id).z, r.axis).yaw * 180) / Math.PI).toFixed(0)}°)\n`,
    );
  }
}

// --- Verdict --------------------------------------------------------------------------
const summit = reports.find((r) => r.id === 'summit');
const others = reports.filter((r) => r.id !== 'summit');
const overall = others.length
  ? others.reduce((acc, r) => acc + (r.paired + r.onAxis) / r.count, 0) / others.length
  : 1;
const adrift = reports.reduce((acc, r) => acc + r.incoherent.length, 0);

process.stdout.write('\n');
const verdicts: Array<[string, boolean, string]> = [
  [
    'the summit court is composed',
    !summit || (summit.paired + summit.onAxis) / summit.count >= 0.8,
    summit ? `${(((summit.paired + summit.onAxis) / summit.count) * 100).toFixed(0)}% aligned` : 'no summit',
  ],
  ['elsewhere is about a third aligned', overall >= 0.3, `${(overall * 100).toFixed(0)}% mean`],
  [
    // Only asked of maps big enough for the answer to mean anything. On a place with four
    // composed props, one item is twenty-five percentage points and "deliberately loose" is
    // indistinguishable from "one prop short of a pair".
    'somewhere is deliberately one-sided',
    !others.some((r) => r.count >= 8) || others.some((r) => (r.paired + r.onAxis) / r.count <= 0.55),
    others.length
      ? `loosest is ${Math.min(...others.map((r) => Math.round(((r.paired + r.onAxis) / r.count) * 100)))}% — a village, not a barracks`
      : 'nothing to say',
  ],
  ['every building faces something', adrift === 0, `${adrift} adrift`],
  ['no structure stands inside another', overlaps.length === 0, `${overlaps.length} overlapping`],
];

let bad = 0;
for (const [name, ok, detail] of verdicts) {
  if (!ok) bad++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}\n`);
}
process.stdout.write(bad === 0 ? '\nplacement audit passed\n' : `\nplacement audit failed (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
