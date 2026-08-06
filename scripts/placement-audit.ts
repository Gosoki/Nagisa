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
 * loose on purpose — a `rot` is *coherent* if it faces the nearest lane, faces the zone's
 * anchor, faces directly away from either, or is square to the symmetry axis. That admits a
 * house facing the street, a warehouse backing onto it and a row of stalls along it, and
 * rejects a building at 37° to everything around it.
 *
 * ### And four things that are not about composition at all
 *
 * The checks above are aesthetic. These are not — each one is a defect you can walk into:
 *
 * - **Nothing stands inside anything else.** Oriented rectangles, by separating axis, using
 *   the extents the geometry actually occupies rather than the walls it encloses.
 * - **Nothing stands in a carriageway.** Same rectangles, against the lane's `halfWidth`
 *   plus a metre of kerb. Eaves count: a roof over the road is a roof over the road.
 * - **No door turns its back on the road.** Every builder models its entrance on the local
 *   −z face, so a yaw is a statement about which way a building is turned. Facing the lane
 *   or standing side-on to it are both fine; facing away is not, unless the frontage opens
 *   onto water instead.
 * - **Every wall and railing holds something back.** A sea wall on the flat of a quay and a
 *   clifftop railing on level grass are the same defect: a long thin object that means
 *   *there is a drop here*, placed where there is not one.
 */

import {
  LANDMARKS,
  PADS,
  PATHS,
  ZONES,
  activeMap,
  heightAt,
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
  // Facing the road counts, and counts *first*. A building addressing the lane it stands on is
  // the most legible thing a yaw can say, and it is what the frontage rule below requires — so
  // a composition whose axis happens to run 19° off the road must not be able to report the
  // buildings that obey it as adrift. The two rules disagreed for exactly as long as this
  // direction was missing from the list.
  const lane = nearestLane(l.x, l.z);
  let best = Math.PI;
  let bestYaw = l.rot;
  const roadward = lane.id === null ? [] : [Math.atan2(l.x - lane.px, l.z - lane.pz)];
  for (const w of [...roadward, toCentre, axisYaw, axisYaw + Math.PI / 2]) {
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
  'shrine-hall': [10, 8], lighthouse: [9.3, 9.3], 'market-stall': [3.2, 2.4], 'beach-hut': [6, 5],
  'net-rack': [1.4, 5], well: [2.6, 1.6], 'notice-board': [3.2, 0.4], 'bell-tower': [2.6, 2.6],
  temizuya: [3.6, 3], torii: [5.4, 0.5], gate: [4.6, 0.34], komainu: [1.5, 1.2],
};

/**
 * What the *built* geometry adds to the authored `w × d`, per side, in metres.
 *
 * `w` and `d` describe the walls. Every roof here overhangs them by 0.6–1.5 m and several
 * buildings put a veranda, a porch or a flight of steps in front of that — a machiya's eaves
 * reach 0.85 m past its plaster and a shrine hall's roof, veranda, steps and offering box
 * together reach 3.2 m past the front wall. Judging clearance from the walls alone therefore
 * passes a building whose *roof* is over the carriageway, which is exactly the complaint this
 * audit exists to answer: from the ground you do not see the wall line, you see the eave.
 *
 * The numbers are read off the builders in `apps/client/src/world/props/`, not estimated —
 * each is the largest local offset any part of that builder reaches beyond the nominal box.
 */
const EAVES: Record<string, number> = {
  machiya: 0.9, minka: 1.25, warehouse: 1.15, teahouse: 1.3, bathhouse: 1.0,
  boathouse: 0.7, 'keepers-house': 0.6, 'beach-hut': 0.7, 'shrine-hall': 1.8,
  stage: 1.2, 'market-stall': 0.35, temizuya: 0.85, 'bell-tower': 0.9,
  'notice-board': 0.6, gate: 0.8, torii: 0.6, well: 0.4, 'net-rack': 0.3,
};

/** Extra reach past the **front** (local −z) face: veranda, porch, steps, slipway. */
const APRON: Record<string, number> = {
  minka: 1.15, teahouse: 0.3, bathhouse: 0.7, boathouse: 4.3, 'shrine-hall': 1.4,
  stage: 1.2,
};

/** Extra reach past the **back** (local +z) face. Only the stage, whose steps are at the rear. */
const REAR: Record<string, number> = { stage: 0.4 };

/**
 * Kinds built from the origin *outward* along local +z rather than centred on it — a pier's
 * deck starts at the shore and runs `length` metres into the water. Centring one puts half of
 * it inland, which is both the wrong answer and a spectacular false positive.
 */
const NOSE_ANCHORED = new Set(['pier']);

interface Rect { x: number; z: number; hw: number; hd: number; rot: number }

function boxOf(l: Landmark): Rect {
  const fallback = FOOTPRINT[l.kind] ?? [3, 3];
  // Piers, breakwaters and sea walls are long thin things and say so with `length`/`width`
  // rather than `w`/`d`. Read as a 3 m box, a forty-metre breakwater is invisible to this
  // test along thirty-seven of those metres.
  const w = typeof l.opts?.width === 'number' ? l.opts.width
    : typeof l.opts?.w === 'number' ? l.opts.w : fallback[0];
  const d = typeof l.opts?.length === 'number' ? l.opts.length
    : typeof l.opts?.d === 'number' ? l.opts.d : fallback[1];
  const eave = EAVES[l.kind] ?? 0;
  const scale = l.scale ?? 1;

  // Local span along z, front (−) to back (+), including everything the builder hangs off it.
  const front = NOSE_ANCHORED.has(l.kind) ? 0 : -(d / 2 + eave + (APRON[l.kind] ?? 0));
  const back = NOSE_ANCHORED.has(l.kind) ? d : d / 2 + eave + (REAR[l.kind] ?? 0);
  const centre = ((front + back) / 2) * scale;

  return {
    // The rectangle's centre, which for anything with a veranda is not the authored origin.
    x: l.x + centre * Math.sin(l.rot),
    z: l.z + centre * Math.cos(l.rot),
    hw: (w / 2 + eave) * scale,
    hd: ((back - front) / 2) * scale,
    rot: l.rot,
  };
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
 * the composition working, not a defect.
 *
 * 0.6 m, not 2.5. A terrace shares walls; it does not share *roofs*, and 2.5 m of tolerance
 * on a 9.8 m frontage let the Old Street's rows sit close enough that their eaves grew
 * through each other — which is exactly what a row of townhouses is not supposed to look
 * like. This is now the width of an eave meeting an eave, and no more.
 */
const PARTY_WALL_KINDS = new Set(['machiya']);
const PARTY_WALL_TOLERANCE = 0.6;

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

// --- On the road ----------------------------------------------------------------------
//
// The lanes are surveyed and carved before anything is placed on the terrace, so a building
// authored at a plausible-looking coordinate can end up standing in the middle of the road.
// Nothing in the data objects: the lane is a height profile and the building is a prop, and
// neither knows the other exists. What you see is a road that runs straight at a wall.
//
// A lane's *carriageway* is `halfWidth` either side of the centreline. The shoulder beyond
// it is the embankment blending back to the terrain, and a building may legitimately sit on
// that — a house at the roadside stands on the verge, not in the gutter. So the test is
// against the carriageway plus a metre of kerb.
const KERB = 1.0;

/** Distance from a point to a lane's centreline, which lane, and the closest point on it. */
function nearestLane(x: number, z: number): { id: string | null; dist: number; halfWidth: number; px: number; pz: number } {
  let best: { id: string | null; dist: number; halfWidth: number; px: number; pz: number } =
    { id: null, dist: Infinity, halfWidth: 0, px: 0, pz: 0 };
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
      if (d < best.dist) best = { id: path.id, dist: d, halfWidth: path.halfWidth, px, pz };
    }
  }
  return best;
}

/**
 * How far a rectangle reaches toward a point, along the line to it.
 * The oriented box again — a deep house turned side-on to the road is not in it.
 */
function reachToward(b: Rect, tx: number, tz: number): number {
  const dx = tx - b.x;
  const dz = tz - b.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len;
  const nz = dz / len;
  const s = Math.sin(b.rot);
  const c = Math.cos(b.rot);
  return Math.abs(b.hd * (s * nx + c * nz)) + Math.abs(b.hw * (c * nx - s * nz));
}

const onRoad = [];
for (const l of LANDMARKS) {
  if (FURNITURE.has(l.kind) || WATERFRONT.has(l.kind) || l.opts?.inWater === true) continue;
  // Measured from the built rectangle's centre, not the authored origin: a building whose
  // veranda is the thing hanging over the kerb has its mass a metre in front of its `x, z`.
  const b = boxOf(l);
  const lane = nearestLane(b.x, b.z);
  if (lane.id === null) continue;
  // Portals are supposed to stand across a road — that is what a gate is for.
  if (MASSING[l.kind] === 'portal') continue;
  // How close the *building* gets to the centreline, not how close its origin does.
  const nearestFace = lane.dist - reachToward(b, lane.px, lane.pz);
  const intrusion = lane.halfWidth + KERB - nearestFace;
  if (intrusion > 0) onRoad.push([l, lane, intrusion, nearestFace]);
}
onRoad.sort((a, b) => b[2] - a[2]);

process.stdout.write(`\nbuildings standing in a carriageway: ${onRoad.length}\n`);
for (const [l, lane, intrusion, face] of onRoad) {
  process.stdout.write(
    `    ${l.id.padEnd(20)} (${l.kind.padEnd(13)}) on ${String(lane.id).padEnd(15)} ` +
      `wall ${face.toFixed(1)} m from centreline, needs ${(lane.halfWidth + KERB).toFixed(1)} — ` +
      `${intrusion.toFixed(1)} m into the road\n`,
  );
}

// --- Which way the door faces ----------------------------------------------------------
//
// Every builder in `props/buildings.ts` models its entrance on the **local −z face**: the
// machiya's kōshi grille and noren, the minka's veranda and steps, the kura's heavy door, the
// bathhouse's porch, the shrine hall's offering box. So a landmark's frontage points along
// `(−sin rot, −cos rot)`, and that direction is data the layout is responsible for.
//
// The symmetry check above deliberately reads yaw *modulo a half turn*, on the grounds that a
// building presented end-on and the same building turned 180° are the same composition. That
// is true of the composition and false of the experience: walking a street where half the
// houses have turned their backs on you is the difference between a village and a stage set
// seen from the wings.
//
// The rule is loose in the one way that matters — **a frontage may face the road or stand
// side-on to it, but never away**. A row of houses along a lane is side-on and correct; a
// house addressing the lane is correct; a house whose door opens onto the hillside behind it
// is not. 100° admits the whole of "side-on" plus ten degrees of slack for a row that follows
// a curving road.
const FRONTAGE_LIMIT = (100 * Math.PI) / 180;

/** How far away a lane can be and still be the thing a building is expected to address. */
const FRONTAGE_REACH = 42;

/** Kinds whose local −z face is a modelled entrance. */
const FRONTED = new Set([
  'machiya', 'minka', 'warehouse', 'bathhouse', 'teahouse', 'keepers-house', 'beach-hut',
  'boathouse', 'shrine-hall', 'stage', 'notice-board', 'market-stall', 'bell-tower', 'lighthouse',
]);

/**
 * Does this frontage open onto water?
 *
 * The one legitimate reason to turn your back on the road. A funaya's ground floor is open so
 * a boat can be pulled straight in off a slipway; a beach hut opens onto the sand; a quay
 * stage plays to a crowd sitting between it and the sea. All three are *addressing* something,
 * and it is not the lane behind them.
 *
 * Tested against the terrain rather than declared per kind, because the same kind is right
 * both ways round on the same island — the plaza stage faces its road and the beach stage
 * faces its water, and a list of exempt kinds could not tell them apart. Walk out along the
 * facing direction; if the ground is below sea level within `WATER_REACH`, this is a
 * waterfront and the rule does not apply.
 */
const WATER_REACH = 46;

function facesWater(l: Landmark): boolean {
  const fx = -Math.sin(l.rot);
  const fz = -Math.cos(l.rot);
  for (let t = 4; t <= WATER_REACH; t += 2) {
    if (heightAt(l.x + fx * t, l.z + fz * t) < 0) return true;
  }
  return false;
}

/** The yaw that would make a landmark face a point. */
function yawToward(l: Landmark, tx: number, tz: number): number {
  return Math.atan2(l.x - tx, l.z - tz);
}

const backToRoad: Array<[Landmark, number, number, number]> = [];
for (const l of LANDMARKS) {
  if (!FRONTED.has(l.kind) || l.opts?.inWater === true) continue;
  const lane = nearestLane(l.x, l.z);
  if (lane.id === null || lane.dist > FRONTAGE_REACH) continue;
  const want = yawToward(l, lane.px, lane.pz);
  const miss = angleDelta(l.rot, want);
  if (miss > FRONTAGE_LIMIT && !facesWater(l)) backToRoad.push([l, miss, want, lane.dist]);
}
backToRoad.sort((a, b) => b[1] - a[1]);

process.stdout.write(`\nfrontages turned away from the road: ${backToRoad.length}\n`);
for (const [l, miss, want, dist] of backToRoad) {
  process.stdout.write(
    `    ${l.id.padEnd(20)} (${l.kind.padEnd(13)}) rot ${((l.rot * 180) / Math.PI).toFixed(0).padStart(5)}°  ` +
      `door ${((miss * 180) / Math.PI).toFixed(0)}° off the road ${dist.toFixed(0)} m away  ` +
      `→ face it with rot ${want.toFixed(3)} (${((want * 180) / Math.PI).toFixed(0)}°)\n`,
  );
}

// --- Long walls and railings ------------------------------------------------------------
//
// A sea wall, a quay parapet and a clifftop railing are all the same object to the data: a
// long thin thing with a `length` and a yaw, built along its local z axis. And all three mean
// the same thing on the ground — *there is a drop here, and this is the line of it*. A wall
// standing in the middle of a flat terrace is not a wall, it is a bench nobody can sit on; a
// railing across the fall line instead of along the edge reads as a gate into thin air.
//
// So they are checked against the ground rather than against each other: sample the terrain a
// few metres either side, along the whole run, and require that one side is consistently
// lower than the other. That is a direct statement of "this holds something back", and it is
// indifferent to which way round the yaw is authored.
const LINEAR = new Set(['sea-wall', 'rail']);

/** How far either side of the run to sample, and the drop that counts as an edge. */
const WALL_PROBE = 4;
const WALL_DROP = 1.2;

const idleWalls: Array<[Landmark, number, number]> = [];
for (const l of LANDMARKS) {
  if (!LINEAR.has(l.kind)) continue;
  const length = typeof l.opts?.length === 'number' ? l.opts.length : 16;
  const s = Math.sin(l.rot);
  const c = Math.cos(l.rot);
  // Along the run, and square to it.
  const ax = s;
  const az = c;
  const nx = c;
  const nz = -s;

  let sum = 0;
  let worst = Infinity;
  const taps = 5;
  for (let i = 0; i < taps; i++) {
    const t = (i / (taps - 1) - 0.5) * length;
    const px = l.x + ax * t;
    const pz = l.z + az * t;
    const drop = heightAt(px + nx * WALL_PROBE, pz + nz * WALL_PROBE) - heightAt(px - nx * WALL_PROBE, pz - nz * WALL_PROBE);
    sum += drop;
    worst = Math.min(worst, Math.abs(drop));
  }
  const mean = Math.abs(sum / taps);
  // Both: a mean drop, so there is genuinely a step here, and a floor under every tap, so it
  // is a step along the *whole* run rather than one end catching the shore.
  if (mean < WALL_DROP || worst < WALL_DROP * 0.4) idleWalls.push([l, mean, worst]);
}

process.stdout.write(`\nwalls and railings with nothing to hold back: ${idleWalls.length}\n`);
for (const [l, mean, worst] of idleWalls) {
  process.stdout.write(
    `    ${l.id.padEnd(20)} (${l.kind.padEnd(13)}) rot ${((l.rot * 180) / Math.PI).toFixed(0).padStart(5)}°  ` +
      `mean step across it ${mean.toFixed(1)} m, weakest tap ${worst.toFixed(1)} m — needs ${WALL_DROP} m\n`,
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
  ['no building stands in a carriageway', onRoad.length === 0, `${onRoad.length} on a road`],
  ['no door turns its back on the road', backToRoad.length === 0, `${backToRoad.length} facing away`],
  ['every wall and railing holds something back', idleWalls.length === 0, `${idleWalls.length} idle`],
];

let bad = 0;
for (const [name, ok, detail] of verdicts) {
  if (!ok) bad++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}\n`);
}
process.stdout.write(bad === 0 ? '\nplacement audit passed\n' : `\nplacement audit failed (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
