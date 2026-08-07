/**
 * Terrain walkability audit.
 * ==========================
 *
 * "Catching your feet" is not a rendering problem and not a physics problem — it is a
 * *terrain* problem that only shows up as a physics symptom, which is why it survives every
 * test that looks at either layer alone. This tool looks at the ground itself.
 *
 *     npm run audit:terrain
 *     NAGISA_MAP=lantern-atoll npm run audit:terrain
 *
 * ### What it measures
 *
 * The walkability contract (`isWalkable`) is a *point* test: a position is legal if the
 * ground there is not too steep. Walking, though, is a *move* — and a point test produces
 * two failure modes that a player feels immediately and that no point-wise assertion can
 * see:
 *
 * 1. **Pinholes.** A single unwalkable cell surrounded by walkable ones. Physically it is a
 *    20 cm bump; to the movement code it is a wall you bounce off in the middle of an open
 *    field. These are what "catching your feet" *is*.
 * 2. **Ledges.** A run of unwalkable cells that cuts a walkable region in two — the ground
 *    on both sides is fine, but there is no legal cell between them, so a place you can see
 *    is a place you cannot reach.
 *
 * And the converse, which matters just as much because the user asked for both halves: the
 * ground that *should* stop you has to actually stop you. So it also reports the largest
 * walkable region and whether every named place is inside it. A "fix" that smooths the
 * cliffs until the whole island is one region has not fixed anything; it has removed the
 * mountain.
 *
 * ### Method
 *
 * Sample `isWalkable` on a grid at `CELL` metres, then:
 * - count blocked cells whose 8-neighbourhood is ≥ `PINHOLE_NEIGHBOURS` walkable,
 * - flood-fill the walkable cells into regions from the spawn,
 * - report which zone anchors and path waypoints fall outside the main region.
 *
 * The grid is the honest resolution to ask at: a character is ~0.6 m wide and moves ~0.14 m
 * per physics step at full speed, so a 1 m cell is finer than the granularity at which the
 * player can act, and coarser than the noise the terrain function contains.
 */

import {
  ISLAND_EXTENT,
  LANDMARKS,
  MAX_WADE_DEPTH,
  MOVE_SPEED,
  PADS,
  PATHS,
  SPAWN_POINTS,
  ZONES,
  activeMap,
  insideStructure,
  resolveMapId,
  canEnterFrom,
  footingSlopeAt,
  heightAt,
  illegality,
  isWalkable,
  nearestPath,
  slopeAt,
} from '../packages/shared/src/index.js';

/** Grid resolution, metres. Finer than the player can act at, coarser than the noise. */
const CELL = 1;

/** A blocked cell with at least this many walkable neighbours is a pinhole, not a wall. */
const PINHOLE_NEIGHBOURS = 6;

// Which map to audit. Every number below comes from the active pack, so this is the only
// line that needs to know a map can be chosen. Without it the tool silently audited the
// default pack whatever `NAGISA_MAP` said — reporting Nagisa Island's figures under the
// atoll's name, which is worse than not running at all.
const mapArg = process.argv.indexOf('--map');
resolveMapId(mapArg >= 0 ? process.argv[mapArg + 1] : process.env.NAGISA_MAP);
const map = activeMap();
const half = Math.ceil(ISLAND_EXTENT / CELL);
const size = half * 2 + 1;
const toWorld = (i: number): number => (i - half) * CELL;
const toGrid = (w: number): number => Math.round(w / CELL) + half;

process.stdout.write(`terrain audit — ${map.name} (${map.id}), ${size}×${size} cells @ ${CELL} m\n\n`);

// --- Sample -------------------------------------------------------------------------
// 0 = sea or off-map (never walkable, never interesting), 1 = walkable, 2 = blocked land.
const grid = new Uint8Array(size * size);
let land = 0;
let walkable = 0;
/** Highest ground found. The direct answer to "is the mountain still there". */
let peak = -Infinity;
const slopes: number[] = [];

for (let j = 0; j < size; j++) {
  const z = toWorld(j);
  for (let i = 0; i < size; i++) {
    const x = toWorld(i);
    const h = heightAt(x, z);
    // Below the wade line is water, not blocked ground; calling it "blocked" would drown the
    // pinhole count in a coastline.
    //
    // The depth test only. `isLand` used to be here too, and it is a different question:
    // it asks the coastline mask, which knows nothing about the terraces. The harbour and
    // landing pads hold the ground well above sea level out past the natural shoreline, so
    // there is a ring of ground around every one of them that the contract calls walkable
    // and the mask calls sea — 3129 cells on Lantern Atoll, 12% of everywhere you can stand.
    // The audit was measuring a smaller island than the one the game simulates, which made
    // its reachability check report a perfectly walkable pier as cut off.
    if (h < -0.9) continue;
    land++;
    if (h > peak) peak = h;
    const ok = isWalkable(x, z);
    grid[j * size + i] = ok ? 1 : 2;
    if (ok) walkable++;
    if ((i + j) % 7 === 0) slopes.push(slopeAt(x, z));
  }
}

slopes.sort((a, b) => a - b);
const pct = (p: number): string => ((slopes[Math.floor(slopes.length * p)] ?? 0) * (180 / Math.PI)).toFixed(1);
process.stdout.write(
  `land cells        ${land}\n` +
    `walkable          ${walkable} (${((walkable / land) * 100).toFixed(1)}%)\n` +
    `slope p50/p90/p99 ${pct(0.5)}° / ${pct(0.9)}° / ${pct(0.99)}°\n\n`,
);

// --- Pinholes -----------------------------------------------------------------------
const pinholes: Array<[number, number, number]> = [];
for (let j = 1; j < size - 1; j++) {
  for (let i = 1; i < size - 1; i++) {
    if (grid[j * size + i] !== 2) continue;
    let open = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        if (grid[(j + dj) * size + (i + di)] === 1) open++;
      }
    }
    // A building wall is not a pinhole in the ground. The census samples `isWalkable`, which
    // includes the structure colliders, so without this a boathouse's 0.8 m side walls read
    // as two dozen speckles in the terrain — the same reason the stumble and snag measures
    // below exclude them. This tool is about the ground.
    if (open >= PINHOLE_NEIGHBOURS && !insideStructure(toWorld(i), toWorld(j))) {
      pinholes.push([toWorld(i), toWorld(j), open]);
    }
  }
}

process.stdout.write(
  `pinholes (blocked cell, ≥${PINHOLE_NEIGHBOURS}/8 neighbours open): ${pinholes.length}\n`,
);
for (const [x, z, open] of pinholes.slice(0, 8)) {
  process.stdout.write(
    `    (${x.toFixed(0).padStart(5)}, ${z.toFixed(0).padStart(5)})  ${open}/8 open  ` +
      `point ${((slopeAt(x, z) * 180) / Math.PI).toFixed(1)}°  footing ` +
      `${((footingSlopeAt(x, z) * 180) / Math.PI).toFixed(1)}°  h ${heightAt(x, z).toFixed(2)}\n`,
  );
}
if (pinholes.length > 8) process.stdout.write(`    … and ${pinholes.length - 8} more\n`);
process.stdout.write('\n');

// --- Stumbles: being stopped by nothing -----------------------------------------------
//
// A pinhole is a fact about `isWalkable`. This is a fact about *walking*: two places you
// may stand, two metres apart, with the contract refusing the ground between them. There
// is no cliff there — both ends are fine — so the player walks into an obstruction they
// cannot see and cannot name, which is the whole of the "my feet get caught" complaint.
//
// It is measured through `canEnterFrom`, not `isWalkable`, because the relaxations are
// part of the rule: `isWalkable` describes where you may *stand*, and the question here is
// what you may *cross*. See `terrain.isSliverAt`.
const STUMBLE_SPAN = 2;
const DIAG = Math.SQRT1_2 * STUMBLE_SPAN;
/** Each entry: x, z, distance to the nearest lane centreline, that lane's half width. */
const stumbles: Array<[number, number, number, number]> = [];
for (let j = 0; j < size; j++) {
  const z = toWorld(j);
  for (let i = 0; i < size; i++) {
    if (grid[j * size + i] !== 1) continue;
    const x = toWorld(i);
    for (const [dx, dz] of [
      [STUMBLE_SPAN, 0],
      [0, STUMBLE_SPAN],
      [DIAG, DIAG],
      [DIAG, -DIAG],
    ]) {
      const bx = x + dx;
      const bz = z + dz;
      if (!isWalkable(bx, bz)) continue;
      const mx = x + dx / 2;
      const mz = z + dz / 2;
      if (canEnterFrom(x, z, mx, mz) && canEnterFrom(mx, mz, bx, bz)) continue;
      // A wall between two places is a wall. This tool measures the *ground*, and counting
      // a warehouse as a defect in the ground would report the collision volumes added for
      // exactly this purpose as a regression.
      if (insideStructure(mx, mz)) continue;
      const lane = nearestPath(mx, mz);
      stumbles.push([mx, mz, lane.dist, lane.path?.halfWidth ?? 0]);
    }
  }
}
// Where it matters is *on the road*, not near it. A cut bank beside a lane is steep on
// purpose — the same reason the snag walk below refuses to use proximity as a proxy — so
// "within 10 m" flags the road's own embankment and calls the road broken for having one.
// The carriageway and the flat shoulder either side of it are ground a player was routed
// onto, and a refusal there is a defect. Beyond that it is a hillside, and a hillside is
// allowed to have features.
const ROAD_MARGIN = 3;
const onRoad = stumbles.filter((s) => s[2] <= s[3] + ROAD_MARGIN);
process.stdout.write(
  `stumbles (two walkable cells ${STUMBLE_SPAN} m apart, refused between): ${stumbles.length}\n` +
    `    on a carriageway or its shoulder: ${onRoad.length}\n`,
);
for (const [x, z, d] of stumbles.slice(0, 6)) {
  const from = Number.isFinite(d) ? `${d.toFixed(0)} m from a lane` : 'open hillside';
  process.stdout.write(
    `    (${x.toFixed(0).padStart(5)}, ${z.toFixed(0).padStart(5)})  ` +
      `footing ${((footingSlopeAt(x, z) * 180) / Math.PI).toFixed(1)}°  ${from}\n`,
  );
}
if (stumbles.length > 6) process.stdout.write(`    … and ${stumbles.length - 6} more\n`);
process.stdout.write('\n');

// --- Washboard: ground that changes its mind ------------------------------------------
//
// Nothing above sees this one. A washboard is not steep — its slope statistics are ordinary
// — and it stops nobody, so it produces no pinholes and no stumbles. It is a defect of the
// *second* derivative: walk eight metres and the ground goes down, up, and down again, and
// what you see is a hillside with corrugations in it instead of even contours.
//
// Two reversals, not one. A single reversal in eight metres is a ridge crest or a hollow —
// a landform, and the whole point of a hill. Counting those reports the mountain as broken.
const WASHBOARD_SPAN = 8;
/** Ignore reversals smaller than this, metres. Below it the surface detail is the terrain. */
const WASHBOARD_FLOOR = 0.08;

function washboardAmplitude(x: number, z: number, ux: number, uz: number): number {
  const h: number[] = [];
  for (let t = 0; t <= WASHBOARD_SPAN; t++) h.push(heightAt(x + ux * t, z + uz * t));
  const turns: number[] = [];
  for (let i = 1; i < WASHBOARD_SPAN; i++) {
    const a = h[i]! - h[i - 1]!;
    const b = h[i + 1]! - h[i]!;
    if (Math.sign(a) !== Math.sign(b)) turns.push(Math.min(Math.abs(a), Math.abs(b)));
  }
  if (turns.length < 2) return 0;
  turns.sort((a, b) => b - a);
  // The second largest: both reversals have to be real for this to be a corrugation.
  return turns[1]!;
}

const washboard: Array<[number, number, number]> = [];
for (let j = 0; j < size; j++) {
  const z = toWorld(j);
  for (let i = 0; i < size; i++) {
    if (grid[j * size + i] !== 1) continue;
    const x = toWorld(i);
    if (heightAt(x, z) < 0.4) continue; // The shoreline's own kink is not a corrugation.
    let amp = 0;
    for (const [ux, uz] of [
      [1, 0],
      [0, 1],
      [Math.SQRT1_2, Math.SQRT1_2],
      [Math.SQRT1_2, -Math.SQRT1_2],
    ]) {
      amp = Math.max(amp, washboardAmplitude(x, z, ux!, uz!));
    }
    if (amp > WASHBOARD_FLOOR) washboard.push([x, z, amp]);
  }
}
washboard.sort((a, b) => b[2] - a[2]);
const worstWashboard = washboard[0]?.[2] ?? 0;
process.stdout.write(
  `washboard (an ${WASHBOARD_SPAN} m walk that reverses twice): ${washboard.length} cells, ` +
    `worst ${worstWashboard.toFixed(2)} m\n`,
);
for (const [x, z, amp] of washboard.slice(0, 5)) {
  process.stdout.write(
    `    (${x.toFixed(0).padStart(5)}, ${z.toFixed(0).padStart(5)})  ` +
      `${amp.toFixed(2)} m  h ${heightAt(x, z).toFixed(1)}\n`,
  );
}
process.stdout.write('\n');

// --- Snags: walk the routes and count what stops you ---------------------------------
//
// A pinhole census says how speckled the *island* is. It does not say whether a player
// meets any of it, and proximity to a lane is a bad proxy — the cutting beside a carved
// path is steep by design, and counting it says the road is broken because it has verges.
//
// So: walk. Same step length as the client's integrator at a run, same `canOccupy` rule,
// along every lane centreline and out along sixteen spokes inside every zone. A **snag** is
// a step where the straight-ahead move was refused. On a surface built for walking that
// number should be zero, and unlike a proximity heuristic it means exactly what it says.
const STEP = MOVE_SPEED.run / 60;

// `canEnterFrom` first, exactly as `local-player.canOccupy` does — the audit walking a
// different rule than the client walks would report snags the player never meets, and miss
// the ones they do.
const canOccupy = (fromX: number, fromZ: number, x: number, z: number): boolean => {
  if (canEnterFrom(fromX, fromZ, x, z)) return true;
  const here = illegality(fromX, fromZ);
  return here > 0 && illegality(x, z) < here;
};

const snags: Array<[string, number, number]> = [];

function walkLine(label: string, ax: number, az: number, bx: number, bz: number): void {
  const span = Math.hypot(bx - ax, bz - az);
  const steps = Math.ceil(span / STEP);
  if (!steps) return;
  const ux = (bx - ax) / span;
  const uz = (bz - az) / span;
  let x = ax;
  let z = az;
  for (let i = 0; i < steps; i++) {
    const nx = x + ux * STEP;
    const nz = z + uz * STEP;
    // A refusal is only a snag if *slope* caused it. Deep water, the map edge and the wall
    // of a building are all supposed to stop you, and counting them reports the sea, the
    // horizon and the old street's houses as terrain defects.
    if (!canOccupy(x, z, nx, nz) && heightAt(nx, nz) >= -MAX_WADE_DEPTH && !insideStructure(nx, nz)) {
      snags.push([label, nx, nz]);
      // Keep going from the refused position, so one obstacle is one snag rather than a
      // run of them, and the rest of the line still gets walked.
    }
    x = nx;
    z = nz;
  }
}

for (const path of PATHS) {
  const pts = path.points;
  for (let k = 1; k < pts.length; k++) {
    walkLine(`lane ${path.id}`, pts[k - 1]![0], pts[k - 1]![1], pts[k]![0], pts[k]![1]);
  }
}
// Terraces, not zones. A zone's radius is how far its *name* reaches — south-harbor's
// covers the sea it looks out over and the hillside behind it — so spokes drawn at that
// radius walk off the quay and up a 55° cliff, and report the sea for blocking them. The
// terrace is the built ground — and `inner`, not `outer`: `outer` is where the terrace has
// finished blending back into the hillside, so south-harbor's reaches from the quay edge at
// z=102 to the slope behind it at z=50, neither of which is the harbour floor.
for (const pad of PADS) {
  for (let a = 0; a < 16; a++) {
    const angle = (a / 16) * Math.PI * 2;
    walkLine(
      `pad ${pad.id}`,
      pad.x,
      pad.z,
      pad.x + Math.cos(angle) * pad.inner,
      pad.z + Math.sin(angle) * pad.inner,
    );
  }
}

const laneSnags = snags.filter(([label]) => label.startsWith('lane'));
process.stdout.write(
  `snags — straight-ahead steps the contract refused, walking the routes\n` +
    `  on lane centrelines  ${laneSnags.length}\n` +
    `  inside terraces      ${snags.length - laneSnags.length}\n`,
);
const shown = new Set<string>();
for (const [label, x, z] of snags) {
  const key = `${label}@${Math.round(x / 4)},${Math.round(z / 4)}`;
  if (shown.has(key)) continue;
  shown.add(key);
  if (shown.size > 12) break;
  process.stdout.write(
    `    ${label.padEnd(22)} (${x.toFixed(0).padStart(5)}, ${z.toFixed(0).padStart(5)})  ` +
      `footing ${((footingSlopeAt(x, z) * 180) / Math.PI).toFixed(1)}°  h ${heightAt(x, z).toFixed(2)}\n`,
  );
}
process.stdout.write('\n');

// --- Regions ------------------------------------------------------------------------
// Flood-fill from the first spawn point. Everything reachable on foot is one region; the
// question the audit answers is what is *not* in it.
const region = new Int32Array(size * size).fill(-1);
const [spawnX, spawnZ] = SPAWN_POINTS[0]!;
const start = toGrid(spawnZ) * size + toGrid(spawnX);
if (grid[start] !== 1) throw new Error(`spawn (${spawnX}, ${spawnZ}) is not on a walkable cell`);
const stack = [start];
region[start] = 0;
let mainRegion = 0;

while (stack.length) {
  const at = stack.pop()!;
  const i = at % size;
  const j = (at - i) / size;
  mainRegion++;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= size || nj >= size) continue;
      const n = nj * size + ni;
      if (region[n] !== -1 || grid[n] !== 1) continue;
      region[n] = 0;
      stack.push(n);
    }
  }
}

const stranded = walkable - mainRegion;
process.stdout.write(
  `main region       ${mainRegion} cells (${((mainRegion / walkable) * 100).toFixed(1)}% of walkable)\n` +
    `stranded          ${stranded} cells in pockets you cannot walk to\n\n`,
);

const reachable = (x: number, z: number): boolean => {
  const i = toGrid(x);
  const j = toGrid(z);
  if (i < 0 || j < 0 || i >= size || j >= size) return false;
  return region[j * size + i] === 0;
};

// --- What is cut off ----------------------------------------------------------------
let problems = 0;
for (const zone of ZONES) {
  if (zone.radius > 500) continue;
  if (!reachable(zone.x, zone.z)) {
    problems++;
    process.stdout.write(`  UNREACHABLE zone   ${zone.id} (${zone.x}, ${zone.z})\n`);
  }
}
for (const path of PATHS) {
  for (const [x, z] of path.points) {
    if (!reachable(x, z)) {
      problems++;
      process.stdout.write(`  UNREACHABLE lane   ${path.id} waypoint (${x}, ${z})\n`);
    }
  }
}
/**
 * Landmarks that float rather than being walked up to.
 *
 * A moored boat is not a destination, and once the boats were moved off the quay and into
 * the water where they belong, the reachability check reported all four as defects. Piers
 * and breakwaters stay in the census on purpose: you *do* walk onto those, and one you
 * cannot get to is a real fault.
 */
const AFLOAT: ReadonlySet<string> = new Set(['boat']);

for (const lm of LANDMARKS) {
  // Sea torii and the like are *meant* to be out of reach — that is the whole image.
  if (lm.opts?.inWater === true || AFLOAT.has(lm.kind)) continue;
  // You walk *up to* a building, not into its footprint, so ask whether anywhere within a
  // few metres is reachable. Asking about the centre point alone reports every solid
  // structure on the island as a problem.
  let approachable = reachable(lm.x, lm.z);
  for (let r = 2; r <= 6 && !approachable; r += 2) {
    for (let i = 0; i < 12 && !approachable; i++) {
      const a = (i / 12) * Math.PI * 2;
      approachable = reachable(lm.x + Math.cos(a) * r, lm.z + Math.sin(a) * r);
    }
  }
  if (!approachable) {
    problems++;
    process.stdout.write(
      `  UNREACHABLE mark   ${lm.id} (${lm.kind}) at (${lm.x.toFixed(0)}, ${lm.z.toFixed(0)})\n`,
    );
  }
}

process.stdout.write(
  problems === 0
    ? '  every zone, lane waypoint and landmark is reachable on foot\n'
    : `\n  ${problems} unreachable\n`,
);

// --- Verdict ------------------------------------------------------------------------
process.stdout.write('\n');
const verdicts: Array<[string, boolean, string]> = [
  ['lane centrelines are snag-free', laneSnags.length === 0, `${laneSnags.length} refused steps`],
  ['terraces are snag-free', snags.length - laneSnags.length === 0, `${snags.length - laneSnags.length} refused steps`],
  ['pinholes are rare overall', pinholes.length <= land * 0.001, `${pinholes.length} over ${land} land cells`],
  // Zero, not "rare". A stumble on the road is ground a player was routed onto and then
  // stopped by, which is the one form of this that is never a feature of the hillside.
  ['no stumbles on a road', onRoad.length === 0, `${onRoad.length} on a carriageway or shoulder`],
  ['stumbles are rare overall', stumbles.length <= land * 0.001, `${stumbles.length} over ${land} land cells`],
  // Bounded rather than zero: fbm surface detail legitimately reverses, and a floor that
  // forbade it would forbid the texture that stops the island reading as a CAD model. The
  // numbers are the measured state after the terrace rings were smoothed — 564 cells and a
  // 53 cm worst case before, 158 and 20 cm after — set close enough to catch a regression.
  ['hillsides are not corrugated', washboard.length <= land * 0.006, `${washboard.length} cells over ${land}`],
  // Step-sized, and a step is a step on any island — so this one number is absolute rather
  // than scaled to the pack. Nagisa Island sits at 0.20 m and Lantern Atoll at 0.32 m, the
  // latter because a 3.5 m-high sand island is *made* of gentle dunes and the metric reads a
  // dune's turn as a reversal. Both are below what a walker feels underfoot, which is what
  // this is asking. It caught the atoll's 4.7 m shore spike when that number was 0.3.
  ['no corrugation is step-sized', worstWashboard < 0.4, `worst is ${worstWashboard.toFixed(2)} m`],
  ['nothing important is cut off', problems === 0, `${problems} unreachable`],
  ['stranded pockets are small', stranded <= walkable * 0.02, `${stranded} of ${walkable}`],
  // "The smoothing did not eat the terrain" — asked of the *terrain*, not of the walkable
  // fraction. `walkable < 98%` was Nagisa Island's shape written into a map-agnostic tool,
  // the same mistake as auditing the default pack whatever NAGISA_MAP said: Lantern Atoll
  // declares a 3.5 m summit and 2 m cliffs, so it is *supposed* to be 100% walkable, and
  // demanding otherwise demands it grow a mountain it was never meant to have.
  ['the massif still stands', peak >= map.terrain.summit.height * 0.9, `peak ${peak.toFixed(1)} m of ${map.terrain.summit.height} m declared`],
  ...(map.terrain.relief.cliff >= 8
    ? ([['a cliffed coast still has cliffs', walkable < land * 0.98, `${((walkable / land) * 100).toFixed(1)}% walkable`]] as Array<[string, boolean, string]>)
    : []),
];
let bad = 0;
for (const [name, ok, detail] of verdicts) {
  if (!ok) bad++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}\n`);
}
process.stdout.write(bad === 0 ? '\nterrain audit passed\n' : `\nterrain audit failed (${bad})\n`);
process.exit(bad === 0 ? 0 : 1);
