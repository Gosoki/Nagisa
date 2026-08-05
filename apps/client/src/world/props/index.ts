/**
 * Prop library entry point.
 * ==========================
 *
 * The scene assembly walks `LANDMARKS` from `@nagisa/shared` and drops a mesh at each
 * entry's terrain-resolved position. It only needs to know one function:
 * {@link createLandmark}. This file is the single place that maps a `LandmarkKind` string
 * onto the builder that knows how to construct it, so the data (`shared/world.ts`) and the
 * geometry code stay decoupled — adding a building to the island never requires touching
 * this switch unless it introduces a genuinely new *kind*.
 *
 * Individual builders are re-exported too: the terrain scatterer calls `boulderProp` and
 * `grassTuft` directly, thousands of times, rather than going through `createLandmark`.
 *
 * ### Layering
 *
 * ```
 *   index.ts        dispatch by kind
 *   buildings.ts    machiya, minka, shrine hall, lighthouse, …
 *   structures.ts   torii, pier, stage, rail, …
 *   furniture.ts    lanterns, benches, boulders
 *   kit.ts          roofs, framed walls, verandas, plinths, rope
 *   geometry.ts     boxes, cylinders, merging, seeded RNG
 * ```
 *
 * Nothing ever reaches *up* a level. `kit.ts` does not know what a teahouse is, and
 * `geometry.ts` does not know what a roof is.
 */

import * as THREE from 'three';
import type { LandmarkKind } from '@nagisa/shared';

import {
  bathhouse,
  beachHut,
  boathouse,
  keepersHouse,
  lighthouse,
  machiya,
  marketStall,
  minka,
  shrineHall,
  teahouse,
  temizuya,
  warehouse,
} from './buildings.js';
import {
  banner,
  bellTower,
  boat,
  breakwater,
  gate,
  komainu,
  netRack,
  noticeBoard,
  pier,
  rail,
  seaWall,
  stage,
  steps,
  summitMarker,
  torii,
  well,
} from './structures.js';
import { bench, bollard, boulderProp, grassTuft, postLantern, stoneLantern } from './furniture.js';

export * from './geometry.js';
export * from './kit.js';
export * from './buildings.js';
export * from './structures.js';
export * from './furniture.js';

/**
 * Which prop builder handles each landmark kind.
 *
 * A map rather than a `switch` so that {@link knownLandmarkKinds} can report coverage —
 * `world-smoke` asserts that every kind used in `LANDMARKS` has a builder, which is what
 * turns "someone added a landmark kind and forgot the geometry" from a silently missing
 * building into a failed build.
 */
const BUILDERS: Record<LandmarkKind, (opts?: Record<string, unknown>) => THREE.Group> = {
  // Waterfront
  pier,
  boat,
  breakwater,
  boathouse,
  'net-rack': netRack,
  'sea-wall': seaWall,
  'beach-hut': beachHut,
  // Buildings
  warehouse,
  machiya,
  minka,
  bathhouse,
  teahouse,
  'market-stall': marketStall,
  'keepers-house': keepersHouse,
  // Sacred
  torii,
  'shrine-hall': shrineHall,
  temizuya,
  komainu,
  'bell-tower': bellTower,
  // Civic
  stage,
  'notice-board': noticeBoard,
  gate,
  well,
  banner,
  lighthouse,
  // Furniture
  'stone-lantern': stoneLantern,
  'post-lantern': postLantern,
  bench,
  rail,
  steps,
  'summit-marker': summitMarker,
  rock: boulderProp,
};

/** Every landmark kind this library can build. Used by the world smoke test. */
export function knownLandmarkKinds(): LandmarkKind[] {
  return Object.keys(BUILDERS) as LandmarkKind[];
}

/**
 * Build the `THREE.Group` for one landmark kind. `opts` mirrors `Landmark.opts` — each
 * builder reads only the keys it recognises and falls back to sane defaults for everything
 * else, so a landmark entry in `world.ts` never has to specify more than it cares about.
 *
 * The returned group is centred at its base (`y = 0` at ground level), unscaled and
 * unpositioned: the caller applies `Landmark.x/z/rot/scale` and the terrain height.
 *
 * An unrecognised kind cannot happen if `LandmarkKind` is respected, but data can drift
 * from types (a hand-edited save, a kind added on one side and not the other) — rather
 * than throw and take the whole scene assembly down with it, this logs a warning and hands
 * back an empty group, so one bad landmark degrades to "one missing prop", not "blank
 * island".
 */
export function createLandmark(kind: LandmarkKind, opts?: Record<string, unknown>): THREE.Group {
  const builder = BUILDERS[kind];
  if (!builder) {
    console.warn(`[props] unknown landmark kind: ${String(kind)}`);
    return new THREE.Group();
  }
  return builder(opts);
}

export { bollard, boulderProp, grassTuft };
