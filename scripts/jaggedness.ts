/**
 * Where the contours go ragged.
 * =============================
 *
 *     npm run audit:jagged
 *     NAGISA_MAP=lantern-atoll npm run audit:jagged
 *
 * A player marked seven places on the island as "锯齿" — sawtoothed, uneven ground — and one
 * place, the lighthouse mountain, as the way a hillside is supposed to read: *"这座山是过渡
 * 很自然的"*. That last one is the important half of the report. It turns a vague complaint
 * into a measurement with a known-good answer on the same map, made of the same functions,
 * so a fix can be checked against something other than taste.
 *
 * ### What "jagged" is, as a number
 *
 * Not steepness. Every one of the marked places is walkable and none of them stops anybody;
 * `terrain-audit` gives them a clean bill of health because it asks about slope, and slope
 * is the *first* derivative. Raggedness lives in the second: the ground rises, flattens,
 * rises harder, flattens again — so contour lines that should march in even bands bunch and
 * splay, and the hillside looks stamped rather than grown.
 *
 * So the metric is **curvature along the fall line**. Walk downhill from the sample point in
 * the direction the terrain itself is falling, at a fixed step, and record the change in
 * gradient per metre. Two summaries come out of it:
 *
 * - `rms` — the root-mean-square curvature. How corrugated the surface is overall.
 * - `flips` — how many times the curvature changes sign over the walk. A natural slope has
 *   very few: convex at the crest, concave at the foot, and one inflection between them. A
 *   stamped one alternates, and that alternation is exactly what the eye reads as sawtooth.
 *
 * ### Why the fall line and not a fixed compass direction
 *
 * A contour is a level set. Sampling along +x measures the hillside's aspect as much as its
 * shape — the same slope reads as smooth or ragged depending only on which way it happens
 * to face, which makes two locations incomparable. The fall line is defined by the surface,
 * so a north-facing slope and a south-facing one are asked the same question. It is also
 * the direction a player actually walks when they walk *down*, which is when the steps get
 * felt underfoot rather than merely seen.
 *
 * ### Reading the output
 *
 * Everything is reported relative to the reference mountain. A location scoring at or below
 * it is, by the only definition available, as natural as the part of the island the player
 * pointed at and called natural.
 */

import { ISLAND_EXTENT, PADS, heightAt, isWalkable, nearestPath, setActiveMap } from '../packages/shared/src/index.js';
import { DEFAULT_MAP_ID, resolveMapId } from '../packages/shared/src/maps/index.js';

const mapId = resolveMapId(process.env.NAGISA_MAP ?? DEFAULT_MAP_ID);
setActiveMap(mapId);

/** Step along the fall line, metres. About two character strides. */
const STEP = 1.0;

/** How far the walk goes, metres. Long enough for a landform, short enough to stay local. */
const WALK = 16;

/**
 * Curvature below this is surface texture, not a step, and its sign is noise — counting its
 * flips would report the fbm detail that makes the ground look like ground.
 */
const FLIP_FLOOR = 0.012;

/** Central-difference gradient of the height field. */
function gradient(x: number, z: number, h = 0.5): [number, number] {
  return [(heightAt(x + h, z) - heightAt(x - h, z)) / (2 * h), (heightAt(x, z + h) - heightAt(x, z - h)) / (2 * h)];
}

export interface Ruggedness {
  /** RMS curvature along the fall line, 1/m. */
  rms: number;
  /** Sign changes in curvature over the walk. */
  flips: number;
  /** Largest single curvature spike, 1/m — the one the foot catches on. */
  peak: number;
}

/**
 * Walk downhill from `(x, z)` and describe how evenly the ground falls away.
 *
 * Re-derives the fall line at every step rather than following the initial one: a corrugated
 * slope bends, and a straight line drawn down a bending surface leaves the fall line and
 * starts measuring the traverse instead.
 */
export function ruggedness(x: number, z: number): Ruggedness {
  const slopes: number[] = [];
  let px = x;
  let pz = z;
  for (let i = 0; i <= WALK / STEP; i++) {
    const [gx, gz] = gradient(px, pz);
    const mag = Math.hypot(gx, gz);
    slopes.push(mag);
    if (mag < 1e-4) break; // Flat: no fall line to follow.
    px -= (gx / mag) * STEP;
    pz -= (gz / mag) * STEP;
  }

  const curvature: number[] = [];
  for (let i = 1; i < slopes.length; i++) curvature.push((slopes[i]! - slopes[i - 1]!) / STEP);
  if (curvature.length < 3) return { rms: 0, flips: 0, peak: 0 };

  let sumSq = 0;
  let peak = 0;
  for (const c of curvature) {
    sumSq += c * c;
    peak = Math.max(peak, Math.abs(c));
  }

  let flips = 0;
  let last = 0;
  for (const c of curvature) {
    if (Math.abs(c) < FLIP_FLOOR) continue;
    const sign = Math.sign(c);
    if (last !== 0 && sign !== last) flips++;
    last = sign;
  }

  return { rms: Math.sqrt(sumSq / curvature.length), flips, peak };
}

/**
 * The places the player marked, by where they were *looking* rather than where they stood.
 *
 * The note records both. The camera target is the right one: a note is written about the
 * hillside in front of you, and the standing position can be ten metres and a whole landform
 * away from the thing being complained about.
 */
const MARKED: Array<[string, number, number]> = [
  ['note 5  beach', 60.0, 76.0],
  ['note 6  coast NW', -35.3, 50.3],
  ['note 7  coast E', 18.5, 32.9],
  ['note 8  coast E', 20.2, 17.6],
  ['note 9  coast E', 21.2, -15.8],
  ['note 10 coast SW', -21.5, -37.4],
  ['note 11 coast SW (worst)', -34.2, -50.4],
];

const REFERENCE: [string, number, number] = ['note 12 lighthouse mountain', -103.0, -61.6];

/**
 * The map the notes were written on. Coordinates are not portable between packs — the same
 * (x, z) is a mountainside on one island and open sea on another — so run against anything
 * else and the reference samples nothing, every ratio divides by zero, and the report reads
 * as a clean bill of health for a map it never looked at.
 */
const NOTES_MAP = 'nagisa-island';

/** Sample a small disc, so a single lucky point cannot speak for a hillside. */
function around(x: number, z: number): Ruggedness {
  const samples: Ruggedness[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    for (const r of [0, 2, 4]) {
      const sx = x + Math.cos(a) * r;
      const sz = z + Math.sin(a) * r;
      if (!isWalkable(sx, sz)) continue;
      samples.push(ruggedness(sx, sz));
    }
  }
  if (!samples.length) return { rms: 0, flips: 0, peak: 0 };
  const mean = (pick: (s: Ruggedness) => number): number => samples.reduce((a, s) => a + pick(s), 0) / samples.length;
  return { rms: mean((s) => s.rms), flips: mean((s) => s.flips), peak: mean((s) => s.peak) };
}

process.stdout.write(`\njaggedness — ${mapId} (extent ${ISLAND_EXTENT} m)\n`);
process.stdout.write(`  metric: curvature along the fall line, ${WALK} m walk at ${STEP} m steps\n\n`);

const ref = around(REFERENCE[1], REFERENCE[2]);
if (mapId !== NOTES_MAP) {
  process.stdout.write(
    `  the marked locations and the reference belong to "${NOTES_MAP}"; on this pack they are\n` +
      `  somewhere else, so they are skipped and the sweep uses this map's own median instead\n\n`,
  );
}
process.stdout.write(
  `  REFERENCE  ${REFERENCE[0].padEnd(30)} (${REFERENCE[1].toFixed(0).padStart(5)}, ${REFERENCE[2].toFixed(0).padStart(5)})  ` +
    `rms ${ref.rms.toFixed(3)}  flips ${ref.flips.toFixed(1)}  peak ${ref.peak.toFixed(3)}\n`,
);
process.stdout.write(`  ${'-'.repeat(94)}\n`);

let worst = 0;
for (const [label, x, z] of mapId === NOTES_MAP ? MARKED : []) {
  const r = around(x, z);
  const ratio = ref.rms > 0 ? r.rms / ref.rms : 0;
  worst = Math.max(worst, ratio);
  const verdict = ratio <= 1.05 ? 'as natural as the reference' : `${ratio.toFixed(1)}x the reference`;
  process.stdout.write(
    `  ${label.padEnd(41)} (${x.toFixed(0).padStart(5)}, ${z.toFixed(0).padStart(5)})  ` +
      `rms ${r.rms.toFixed(3)}  flips ${r.flips.toFixed(1)}  peak ${r.peak.toFixed(3)}  ${verdict}\n`,
  );
}

if (mapId === NOTES_MAP) process.stdout.write(`\n  worst marked location: ${worst.toFixed(1)}x the reference\n\n`);

// --- Sweep: is the whole island like this, or only the marked places? --------------------
//
// Seven notes is seven notes. If the same measurement over the entire walkable surface finds
// hundreds of comparable spots, the marked ones are a sample of a general property and there
// is no point moving anything; if it finds only these, they are defects with a cause.
const CELL = 4;
const measured: Array<[number, number, Ruggedness]> = [];
for (let z = -ISLAND_EXTENT; z <= ISLAND_EXTENT; z += CELL) {
  for (let x = -ISLAND_EXTENT; x <= ISLAND_EXTENT; x += CELL) {
    if (!isWalkable(x, z)) continue;
    if (heightAt(x, z) < 0.6) continue; // The waterline's own kink is not corrugation.
    measured.push([x, z, ruggedness(x, z)]);
  }
}

// The baseline is the player's reference hillside where we have one, and otherwise the map's
// own median — which is the same idea (compare against ground that reads as ordinary) derived
// from the pack instead of from a note. Without the fallback the threshold on any other pack
// is a comparison against zero, which reports either nothing or everything.
const sorted = [...measured].map(([, , r]) => r.rms).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
const baseline = mapId === NOTES_MAP && ref.rms > 0 ? ref.rms : median;
const baselineName = mapId === NOTES_MAP && ref.rms > 0 ? 'the reference' : "this map's median";

// …and an absolute floor as well as a relative one. A ratio alone is meaningless on a map
// with no relief: the atoll's median is 0.021, so 1.5x it flags any ground that bends at all,
// and a third of the pack comes back "corrugated" because it is not a billiard table. The
// floor is the reference hillside's own roughness — ground the player looked at and called
// natural — which is a defensible "no worse than this" on any pack, mountains or not.
const NATURAL_CEILING = 0.25;
const threshold = Math.max(baseline * 1.5, NATURAL_CEILING);

const sweep: Array<[number, number, number]> = [];
for (const [x, z, r] of measured) {
  if (r.rms > threshold && r.flips >= 3) sweep.push([x, z, r.rms / baseline]);
}
sweep.sort((a, b) => b[2] - a[2]);
process.stdout.write(
  `  island-wide: ${sweep.length} of ${measured.length} cells past ${threshold.toFixed(3)} ` +
    `(1.5x ${baselineName} ${baseline.toFixed(3)}, floored at ${NATURAL_CEILING}) with 3+ curvature flips\n`,
);
for (const [x, z, ratio] of sweep.slice(0, 12)) {
  process.stdout.write(`    (${x.toFixed(0).padStart(5)}, ${z.toFixed(0).padStart(5)})  ${ratio.toFixed(1)}x  h ${heightAt(x, z).toFixed(1)}\n`);
}
process.stdout.write('\n');

// --- What is making it? -----------------------------------------------------------------
//
// The elevations in the sweep above cluster — the worst cells sit in two narrow bands rather
// than scattering over the hillside — and a band of elevations is a signature, not noise. The
// two structures in `heightAt` that can produce one are a terrace's blend ring (a pad sits at
// a fixed height, so its rim lands at a fixed height too) and a path's carve. So for each of
// the worst cells, name the nearest of each and how far away it is. If a cause is real the
// distances will be small and consistent; if they are large and scattered, the corrugation is
// in `naturalHeight` itself and no amount of moving things will help.
process.stdout.write('  attribution of the worst cells:\n');
for (const [x, z] of sweep.slice(0, 12)) {
  let pad: { id: string; d: number } | null = null;
  for (const p of PADS) {
    const d = Math.hypot(x - p.x, z - p.z);
    // Distance to the *rim*, not the centre: the rim is where a blend ring can corrugate.
    const rim = Math.abs(d - p.outer);
    if (!pad || rim < pad.d) pad = { id: p.id, d: rim };
  }
  const hit = nearestPath(x, z);
  process.stdout.write(
    `    (${x.toFixed(0).padStart(5)}, ${z.toFixed(0).padStart(5)})  h ${heightAt(x, z).toFixed(1).padStart(5)}  ` +
      `pad rim ${pad ? `${pad.id} ${pad.d.toFixed(1)} m` : '—'}`.padEnd(34) +
      `  path ${hit.path ? `${hit.path.id} ${hit.dist.toFixed(1)} m` : '—'}\n`,
  );
}
process.stdout.write('\n');
