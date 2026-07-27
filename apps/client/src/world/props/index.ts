/**
 * Prop library entry point.
 * ==========================
 *
 * The scene assembly code (whatever walks `LANDMARKS` from `@nagisa/shared` and drops a
 * mesh at each entry's terrain-resolved position) only needs to know one function:
 * {@link createLandmark}. This file is the single place that maps a `Landmark['kind']`
 * string onto the builder that knows how to construct it, so the data file
 * (`world.ts`) and the geometry code stay decoupled — adding a landmark to the island
 * never requires touching this switch unless it introduces a genuinely new *kind*.
 *
 * Individual builders are re-exported too: the terrain scatterer calls the vegetation
 * builders (`pineTree`, `mapleTree`, `bambooClump`, `shrub`, `grassTuft`, `rock`)
 * directly, thousands of times, rather than going through `createLandmark` — see the
 * module doc comment in `nature.ts` for why.
 */

import * as THREE from 'three';
import type { Landmark } from '@nagisa/shared';

import { minka, machiya, teahouse, shrineHall, warehouse, lighthouse } from './buildings.js';
import { torii, gate, pier, boat, stage, noticeBoard, rail } from './structures.js';
import { stoneLantern, bench, lantern } from './nature.js';

export * from './geometry.js';
export { minka, machiya, teahouse, shrineHall, warehouse, lighthouse } from './buildings.js';
export { torii, gate, pier, boat, stage, noticeBoard, rail } from './structures.js';
export {
  stoneLantern,
  bench,
  lantern,
  pineTree,
  mapleTree,
  bambooClump,
  shrub,
  grassTuft,
  rock,
} from './nature.js';

/**
 * Build the `THREE.Group` for one landmark `kind`. `opts` mirrors `Landmark.opts`
 * (a loose `Record<string, number | string | boolean>`) — each builder reads only the
 * keys it recognises and falls back to sane defaults for everything else, so a landmark
 * entry in `world.ts` never has to specify more than it cares about.
 *
 * The returned group is centred at its base (`y = 0` at ground level) and unscaled and
 * unpositioned: the caller applies `Landmark.x/z/rot/scale` and the terrain height.
 *
 * An unrecognised `kind` cannot happen if `Landmark['kind']` is respected by the
 * caller, but data can drift from types (a hand-edited save, a future kind added to one
 * side and not the other) — rather than throw and take the whole scene assembly down
 * with it, this logs a warning and hands back an empty group, so one bad landmark
 * degrades to "one missing prop", not "blank island".
 */
export function createLandmark(kind: Landmark['kind'], opts?: Record<string, unknown>): THREE.Group {
  switch (kind) {
    case 'minka':
      return minka(opts);
    case 'machiya':
      return machiya(opts);
    case 'teahouse':
      return teahouse(opts);
    case 'shrine-hall':
      return shrineHall(opts);
    case 'warehouse':
      return warehouse(opts);
    case 'lighthouse':
      return lighthouse(opts);
    case 'torii':
      return torii(opts);
    case 'gate':
      return gate(opts);
    case 'pier':
      return pier(opts);
    case 'boat':
      return boat(opts);
    case 'stage':
      return stage(opts);
    case 'notice-board':
      return noticeBoard(opts);
    case 'rail':
      return rail(opts);
    case 'stone-lantern':
      return stoneLantern(opts);
    case 'bench':
      return bench(opts);
    case 'lantern':
      return lantern(opts);
    default: {
      console.warn(`[props] unknown landmark kind: ${String(kind)}`);
      return new THREE.Group();
    }
  }
}
