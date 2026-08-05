#!/usr/bin/env node
/**
 * Footprint flatness audit — development tool.
 *
 * Reports, for every landmark, how much the ground varies across the patch it actually
 * stands on. A building is placed at a *single* height sample, so any variation across its
 * footprint is a corner in the air on one side and a corner buried on the other.
 *
 *     node tools/flatness.mjs            # only the offenders
 *     node tools/flatness.mjs --all      # every landmark
 *
 * The three usual causes, in order of how often they are the answer:
 *   1. the building is on a road's carve shoulder, not on its terrace;
 *   2. it is outside its terrace's flat inner radius;
 *   3. its terrace is too small for it.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LANDMARKS, heightAt, nearestPath, PADS } = require('../packages/shared/dist/index.js');

const showAll = process.argv.includes('--all');

/** Kinds that are supposed to stand on water or on a slope. */
const EXEMPT = new Set(['pier', 'boat', 'breakwater', 'boathouse', 'rock', 'sea-wall', 'steps']);

/**
 * Ground footprint per kind, as [width, depth] in the prop's own local axes.
 *
 * Deliberately *not* square by default. A torii is six metres across and half a metre
 * deep; a railing is twenty long and a third of a metre wide. Treating either as a square
 * samples the terrain metres away from anything it touches and reports a cliff that the
 * prop never stands on.
 */
const DEFAULT_SIZE = {
  lighthouse: [7, 7],
  stage: [14, 10],
  'bell-tower': [3.4, 3.4],
  gate: [5.5, 0.6],
  torii: [6, 0.6],
  well: [2.6, 2.6],
  'notice-board': [3.6, 0.5],
  temizuya: [3.8, 3.2],
  komainu: [1.6, 1.4],
  'market-stall': [3.4, 2.6],
  'net-rack': [1.6, 5],
  banner: [1.2, 1.2],
  'post-lantern': [0.8, 0.8],
  'stone-lantern': [1.4, 1.4],
  bench: [2.4, 0.8],
  rail: [0.4, 20],
  'summit-marker': [1.6, 1.6],
  'beach-hut': [8, 6],
  minka: [12, 10],
  machiya: [9, 12],
  warehouse: [13, 9],
  teahouse: [12, 9],
  bathhouse: [15, 12],
  'keepers-house': [11, 8],
  'shrine-hall': [14, 11],
};

/** Footprint of a landmark, from its options where it declares them. */
function footprint(landmark) {
  const scale = landmark.scale ?? 1;
  const [dw, dd] = DEFAULT_SIZE[landmark.kind] ?? [3, 3];
  const w = Number(landmark.opts?.w ?? dw) * scale;
  const d = Number(landmark.opts?.d ?? dd) * scale;
  return { w, d };
}

const rows = [];
for (const landmark of LANDMARKS) {
  if (EXEMPT.has(landmark.kind) || landmark.opts?.inWater) continue;
  const { w, d } = footprint(landmark);
  const cos = Math.cos(landmark.rot);
  const sin = Math.sin(landmark.rot);

  let min = Infinity;
  let max = -Infinity;
  let onShoulder = 0;
  for (const [ox, oz] of [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [w / 2, d / 2],
    [0, 0],
  ]) {
    const x = landmark.x + ox * cos - oz * sin;
    const z = landmark.z + ox * sin + oz * cos;
    const h = heightAt(x, z);
    if (h < min) min = h;
    if (h > max) max = h;
    // A corner sitting between a road's edge and the end of its blend is on the
    // embankment, which is where the ground is steepest.
    const hit = nearestPath(x, z);
    if (hit.path && hit.dist > hit.path.halfWidth && hit.dist < hit.path.halfWidth + hit.path.shoulder) onShoulder++;
  }

  const pad = PADS.find((p) => Math.hypot(landmark.x - p.x, landmark.z - p.z) <= p.inner);
  rows.push({ id: landmark.id, kind: landmark.kind, drop: max - min, onShoulder, pad: pad?.id ?? '—', w, d });
}

rows.sort((a, b) => b.drop - a.drop);

/** Above this, the gap under a corner is visible from the ground. */
const TOLERANCE = 0.45;

let bad = 0;
console.log('  drop  shoulder  terrace        landmark');
for (const row of rows) {
  // Drop is the verdict; the shoulder count is only a hint at *why*. A prop standing on a
  // road that runs across its own terrace reads as "on a shoulder" while being perfectly
  // flat, because the road's carve target there is the terrace height.
  const isBad = row.drop > TOLERANCE;
  if (isBad) bad++;
  if (!isBad && !showAll) continue;
  console.log(
    `${isBad ? '!' : ' '} ${row.drop.toFixed(2).padStart(5)}m  ${String(row.onShoulder).padStart(4)}     ${row.pad.padEnd(14)} ${row.id} (${row.kind} ${row.w.toFixed(0)}×${row.d.toFixed(0)})`,
  );
}
console.log(`\n${rows.length} grounded landmarks, ${bad} above ${TOLERANCE} m of drop`);
