/**
 * Furniture and ground detail.
 * ============================
 *
 * The small objects that populate a place once its buildings are standing: lanterns,
 * benches, boulders, grass. Individually none of them matters; collectively they are the
 * difference between "there is a shrine here" and "people come to this shrine".
 *
 * ### Two construction styles, for two different jobs
 *
 * - **Hand-placed furniture** — `stoneLantern`, `postLantern`, `bench` — are landmarks
 *   like any in `buildings.ts`: fixed shape, dispatched by kind through `props/index.ts`.
 * - **Scattered detail** — `boulderProp`, `grassTuft` — is placed procedurally by
 *   `world/scatter.ts`, thousands of times. Every scattered builder therefore takes a
 *   `seed` and threads it through `mulberry32()` rather than touching `Math.random()`, so
 *   the same seed yields the same object on every machine and after every reload, and
 *   stays in the tens of triangles rather than the hundreds.
 *
 * There is no vegetation here beyond ground tufts. Trees are deliberately out of scope for
 * this pass of the world — the effort is going into terrain and architecture — and the
 * hillsides are read by their contours and colour banding instead of by planting.
 */

import * as THREE from 'three';
import { box, cyl, mergeByMaterial, mulberry32, numOpt, randRange } from './geometry.js';
import { boulder, paperLantern } from './kit.js';
import { cloth, glow, ground, metal, rockFace, shoji, stone, wood } from '../materials.js';

type Opts = Record<string, unknown> | undefined;

function assemble(name: string, parts: THREE.Mesh[]): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  for (const mesh of mergeByMaterial(parts)) group.add(mesh);
  return group;
}

// ---------------------------------------------------------------------------
// Lanterns
// ---------------------------------------------------------------------------

/**
 * A stone lantern (*tōrō*) — the most-repeated object on the island: shrine approach,
 * plaza, teahouse garden, coast road.
 *
 * Anatomy bottom to top, all six parts of a real tōrō: the buried base (*kiso*), the shaft
 * (*sao*), the platform (*chūdai*), the light chamber (*hibukuro*) with its openings, the
 * roof (*kasa*) with upturned corners, and the jewel finial (*hōju*).
 *
 * The light chamber is the only part that matters at night, so it gets an unlit emissive
 * core behind stone panels rather than a glowing block: the light should read as coming
 * from *inside* something.
 */
export function stoneLantern(opts?: Opts): THREE.Group {
  const height = numOpt(opts, 'height', 2.1);
  const parts: THREE.Mesh[] = [];
  const rock = stone();
  const dark = stone('dark');

  const s = height / 2.1; // Everything below is authored at height 2.1 and scaled.

  parts.push(cyl(0.36 * s, 0.44 * s, 0.24 * s, 8, dark, 0, 0.12 * s, 0));
  parts.push(cyl(0.19 * s, 0.22 * s, 0.86 * s, 8, rock, 0, 0.67 * s, 0));
  parts.push(cyl(0.4 * s, 0.3 * s, 0.16 * s, 8, rock, 0, 1.18 * s, 0));
  parts.push(cyl(0.44 * s, 0.44 * s, 0.08 * s, 8, dark, 0, 1.29 * s, 0));

  // Light chamber: four corner posts with the glow between them, so the openings read.
  const chamberY = 1.55 * s;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    parts.push(box(0.12 * s, 0.44 * s, 0.12 * s, rock, Math.cos(a) * 0.28 * s, chamberY, Math.sin(a) * 0.28 * s));
  }
  parts.push(cyl(0.24 * s, 0.24 * s, 0.4 * s, 8, glow(0xffd9a0), 0, chamberY, 0));
  parts.push(cyl(0.42 * s, 0.42 * s, 0.06 * s, 8, rock, 0, chamberY + 0.24 * s, 0));

  // Roof: a six-sided cap with a raised rim, plus the finial.
  parts.push(cyl(0.62 * s, 0.36 * s, 0.3 * s, 6, rock, 0, 1.94 * s, 0));
  parts.push(cyl(0.66 * s, 0.62 * s, 0.07 * s, 6, dark, 0, 1.82 * s, 0));
  parts.push(cyl(0.0, 0.15 * s, 0.24 * s, 6, rock, 0, 2.2 * s, 0));

  return assemble('stone-lantern', parts);
}

/**
 * A timber post lantern: a paper *chōchin* hanging from a capped post. Lines the quays and
 * the Old Street, where a stone tōrō would read as too formal.
 */
export function postLantern(opts?: Opts): THREE.Group {
  const height = numOpt(opts, 'height', 3.0);
  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');

  parts.push(box(0.16, height, 0.16, timber, 0, height / 2, 0));
  parts.push(box(0.34, 0.22, 0.34, stone(), 0, 0.11, 0));
  // Cross-arm with a small cap over it.
  parts.push(box(0.7, 0.1, 0.1, timber, 0.28, height - 0.18, 0));
  parts.push(box(0.34, 0.14, 0.34, timber, 0, height + 0.05, 0));

  for (const mesh of paperLantern(0.24, 0.62, shoji(), timber)) {
    mesh.position.set(mesh.position.x + 0.55, mesh.position.y + height - 0.9, mesh.position.z);
    parts.push(mesh);
  }
  // A short cord between arm and lantern.
  parts.push(cyl(0.02, 0.02, 0.16, 4, timber, 0.55, height - 0.24, 0));

  return assemble('post-lantern', parts);
}

// ---------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------

/**
 * A bench: a plank seat on two stone blocks, with a red felt cover over it. The felt is
 * the detail that makes it read as a place to rest at a teahouse rather than as municipal
 * street furniture.
 */
export function bench(opts?: Opts): THREE.Group {
  const length = numOpt(opts, 'length', 2.2);
  const parts: THREE.Mesh[] = [];
  const timber = wood('light');

  for (const sx of [-1, 1] as const) {
    parts.push(box(0.34, 0.44, 0.6, stone(), sx * (length / 2 - 0.32), 0.22, 0));
  }
  // Two planks with a gap, rather than one slab.
  for (const sz of [-1, 1] as const) {
    parts.push(box(length, 0.09, 0.28, timber, 0, 0.49, sz * 0.16));
  }
  parts.push(box(length * 0.94, 0.03, 0.66, cloth(0xa8503f), 0, 0.55, 0));

  return assemble('bench', parts);
}

// ---------------------------------------------------------------------------
// Ground detail
// ---------------------------------------------------------------------------

/**
 * A shoreline or mountain boulder. Hand-placed at landmark scale and also scattered by
 * `world/scatter.ts` at small scale.
 *
 * A large boulder gets a second, smaller lump leaning against it: a single displaced
 * icosahedron reads as a potato, and two overlapping ones read as rock.
 */
export function boulderProp(opts?: Opts): THREE.Group {
  const radius = numOpt(opts, 'radius', 1.6);
  const seed = Math.round(numOpt(opts, 'seed', 7));
  const parts: THREE.Mesh[] = [];
  const rng = mulberry32(seed);
  const material = rockFace();

  parts.push(boulder(radius, material, seed));
  if (radius > 0.9) {
    const satellite = boulder(radius * randRange(rng, 0.4, 0.62), material, seed + 91);
    satellite.position.set(radius * randRange(rng, 0.6, 1.0), 0, radius * randRange(rng, -0.8, 0.8));
    parts.push(satellite);
  }
  return assemble('rock', parts);
}

/**
 * A tuft of grass: three crossed blades. Scattered in the tens of thousands across the
 * hillsides, so it is three triangles' worth of geometry and no more.
 *
 * Instanced by the scatterer, which is why this returns a single mesh rather than a group.
 */
export function grassTuft(seed = 1, scale = 1): THREE.Mesh {
  const rng = mulberry32(seed);
  const parts: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const height = randRange(rng, 0.3, 0.52) * scale;
    const blade = box(0.05 * scale, height, 0.02 * scale, ground('grass'), 0, height / 2, 0);
    blade.rotation.y = (i / 3) * Math.PI * 2 + rng();
    blade.rotation.z = randRange(rng, -0.35, 0.35);
    parts.push(blade);
  }
  return mergeByMaterial(parts)[0];
}

/**
 * A mooring bollard on a quay edge, with a coil of rope at its foot. Small, but a quay
 * without them looks like a wall.
 */
export function bollard(opts?: Opts): THREE.Group {
  const parts: THREE.Mesh[] = [];
  const iron = metal();
  parts.push(cyl(0.16, 0.22, 0.7, 10, iron, 0, 0.35, 0));
  parts.push(cyl(0.26, 0.2, 0.14, 10, iron, 0, 0.74, 0));
  for (let i = 0; i < 3; i++) {
    parts.push(cyl(0.34 + i * 0.06, 0.34 + i * 0.06, 0.07, 10, cloth(0xcfc4a8), 0.5, 0.04 + i * 0.07, 0));
  }
  return assemble('bollard', parts);
}
