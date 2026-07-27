/**
 * Nature & small-object builders.
 * =================================
 *
 * Two different jobs live in this file, and they call for two different construction
 * styles:
 *
 * - **Hand-placed small objects** — `stoneLantern`, `bench`, `lantern` — are landmarks
 *   like any in `buildings.ts`/`structures.ts`: fixed shape, dispatched by `kind` through
 *   `props/index.ts`.
 * - **Vegetation** — `pineTree`, `mapleTree`, `bambooClump`, `shrub`, `grassTuft`,
 *   `rock` — is scattered procedurally by the terrain system directly (see the module
 *   doc comment in `world.ts`: "everything else... is scattered procedurally... because
 *   those are texture, not architecture"). The scatterer calls these functions directly,
 *   not through `createLandmark()`, and calls them thousands of times. Every vegetation
 *   builder therefore:
 *   1. takes a `seed: number` and threads it through `mulberry32()` to vary its shape —
 *      never `Math.random()`, so the same seed always yields the same plant, on the
 *      client and the server, on every reload;
 *   2. stays in the tens of triangles, not hundreds — a forest is thousands of these.
 */

import * as THREE from 'three';
import { box, cyl, cone, icosphere, meshFrom, mergeByMaterial, mulberry32, randRange, randPick, numOpt } from './geometry.js';
import { stone, glow, shoji, wood, foliage } from '../materials.js';

type Opts = Record<string, unknown> | undefined;

// ---------------------------------------------------------------------------
// Stone lantern — tōrō
// ---------------------------------------------------------------------------

/**
 * A stone lantern (tōrō): base, shaft, firebox, pyramidal roof, finial — the classic
 * garden/path lantern silhouette, stacked straight up the y-axis. The firebox holds a
 * `glow()` mesh named `'flame'` so it reads as lit even though no dynamic light is
 * attached (thousands of these would be far too many real lights; the emissive material
 * alone sells "lit" at this art scale).
 */
export function stoneLantern(_opts: Opts = {}): THREE.Group {
  const parts: THREE.Mesh[] = [];

  const baseH = 0.26;
  parts.push(cyl(0.36, 0.46, baseH, 6, stone(), 0, baseH / 2, 0));

  const shaftH = 0.85;
  const shaftY = baseH + shaftH / 2;
  parts.push(cyl(0.15, 0.17, shaftH, 8, stone(), 0, shaftY, 0));

  const plateH = 0.12;
  const plateY = baseH + shaftH + plateH / 2;
  parts.push(cyl(0.34, 0.28, plateH, 8, stone(), 0, plateY, 0));

  const fireboxH = 0.4;
  const fireboxY = baseH + shaftH + plateH + fireboxH / 2;
  parts.push(box(0.38, fireboxH, 0.38, stone(), 0, fireboxY, 0));

  const roofY = baseH + shaftH + plateH + fireboxH;
  parts.push(cyl(0, 0.42, 0.34, 4, stone(), 0, roofY + 0.17, 0, 0, Math.PI / 4, 0)); // low pyramidal cap
  parts.push(icosphere(0.09, stone(), 0, roofY + 0.34 + 0.08, 0));

  const group = new THREE.Group();
  group.name = 'stone-lantern';
  group.add(...mergeByMaterial(parts));

  // The flame: unmerged so it keeps its own material identity as a findable, glowing
  // accent (stone-lantern instances share their stone geometry buckets, but each one's
  // flame stays a distinct small mesh rather than disappearing into a shared batch).
  const flame = icosphere(0.1, glow(0xffb35c, 1.2), 0, fireboxY, 0);
  flame.name = 'flame';
  flame.castShadow = false;
  group.add(flame);

  return group;
}

// ---------------------------------------------------------------------------
// Bench
// ---------------------------------------------------------------------------

/** A plain wooden bench — the seating half of "somewhere to sit" (`kind: 'sit'`). */
export function bench(_opts: Opts = {}): THREE.Group {
  const seatW = 1.6;
  const seatD = 0.5;
  const seatH = 0.46;

  const parts: THREE.Mesh[] = [];
  parts.push(box(seatW, 0.07, seatD, wood('light'), 0, seatH, 0));
  for (const sx of [-1, 1]) {
    parts.push(box(0.08, seatH, seatD - 0.08, wood('dark'), (sx * (seatW - 0.2)) / 2, seatH / 2, 0));
  }
  // Backrest, offset toward the rear edge.
  parts.push(box(seatW, 0.4, 0.06, wood('light'), 0, seatH + 0.26, -seatD / 2 + 0.05));

  const group = new THREE.Group();
  group.name = 'bench';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Hanging paper lantern
// ---------------------------------------------------------------------------

/**
 * A paper lantern (chochin) hung from a post — the informal, low, path-side counterpart
 * to the stone lantern. The barrel silhouette is two truncated cones bulging out from a
 * narrow waist at top and bottom, built from `shoji()` so it inherits the same
 * night-time warm-glow response as every other paper surface on the island, plus a
 * small `glow()` core so it already reads as "lit" before dusk triggers that response.
 */
export function lantern(opts: Opts = {}): THREE.Group {
  const postH = numOpt(opts, 'postHeight', 2.1);

  const parts: THREE.Mesh[] = [];
  parts.push(cyl(0.07, 0.09, postH, 6, wood('dark'), 0, postH / 2, 0));
  const armLen = 0.55;
  parts.push(box(armLen, 0.08, 0.08, wood('dark'), armLen / 2, postH - 0.1, 0));

  const hangY = postH - 0.5;
  const armX = armLen;
  parts.push(cyl(0.24, 0.1, 0.3, 8, shoji(), armX, hangY + 0.18, 0));
  parts.push(cyl(0.1, 0.24, 0.3, 8, shoji(), armX, hangY - 0.12, 0));
  parts.push(cyl(0.09, 0.09, 0.06, 8, wood('dark'), armX, hangY + 0.33, 0));
  parts.push(cyl(0.09, 0.09, 0.06, 8, wood('dark'), armX, hangY - 0.27, 0));

  const group = new THREE.Group();
  group.name = 'lantern';
  group.add(...mergeByMaterial(parts));

  const glowCore = icosphere(0.14, glow(0xffce8a, 1.1), armX, hangY, 0);
  glowCore.name = 'glow';
  glowCore.castShadow = false;
  group.add(glowCore);

  return group;
}

// ---------------------------------------------------------------------------
// Vegetation
// ---------------------------------------------------------------------------

/**
 * A conifer (matsu-style pine). Two or three stacked, shrinking foliage cones over a
 * gently tapered trunk, with the whole silhouette given a small seeded lean and the
 * cone sizes/counts jittered — the cheapest way to make a stand of pines avoid looking
 * like the same tree copy-pasted across a hillside.
 */
export function pineTree(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const trunkH = randRange(rng, 2.0, 3.4);
  const lean = randRange(rng, -0.06, 0.06);
  const tiers = randPick(rng, [2, 3]);

  const parts: THREE.Mesh[] = [];
  parts.push(cyl(0.08, 0.14, trunkH, 6, wood('dark'), 0, trunkH / 2, 0, lean, 0, lean * 0.6));

  let y = trunkH * 0.55;
  let r = randRange(rng, 1.1, 1.5);
  for (let i = 0; i < tiers; i++) {
    const h = randRange(rng, 1.1, 1.6);
    parts.push(cone(r, h, 7, foliage('pine'), Math.sin(lean) * y * 0.4, y + h / 2, 0));
    y += h * 0.62;
    r *= 0.72;
  }

  const group = new THREE.Group();
  group.name = 'pine-tree';
  group.add(...mergeByMaterial(parts));
  return group;
}

/**
 * A broadleaf maple: slim trunk, a cluster of overlapping low-poly foliage masses. The
 * cluster (3–4 icospheres at random offsets/sizes) is what keeps the canopy from reading
 * as a single obviously-a-sphere blob.
 */
export function mapleTree(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const trunkH = randRange(rng, 1.8, 2.6);
  const canopyR = randRange(rng, 1.3, 1.9);
  const lean = randRange(rng, -0.08, 0.08);

  const parts: THREE.Mesh[] = [];
  parts.push(cyl(0.09, 0.15, trunkH, 6, wood('dark'), 0, trunkH / 2, 0, lean, 0, lean * 0.5));

  const lobes = randPick(rng, [3, 4]);
  const canopyY = trunkH * 0.92;
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rng() * 0.8;
    const off = canopyR * 0.42;
    const r = canopyR * randRange(rng, 0.55, 0.8);
    parts.push(
      icosphere(r, foliage('maple'), Math.cos(a) * off, canopyY + randRange(rng, -0.2, 0.35), Math.sin(a) * off),
    );
  }

  const group = new THREE.Group();
  group.name = 'maple-tree';
  group.add(...mergeByMaterial(parts));
  return group;
}

/**
 * A clump of bamboo culms. Each stalk is an independently jittered thin cylinder (height,
 * lean, radius all seeded), topped with a small spray of leaf cones — cheap per-culm, and
 * a clump of 4–6 already reads as a thicket rather than "one bamboo, repeated".
 */
export function bambooClump(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const culms = randPick(rng, [4, 5, 6]);

  const parts: THREE.Mesh[] = [];
  for (let i = 0; i < culms; i++) {
    const h = randRange(rng, 3.2, 5.2);
    const r = randRange(rng, 0.05, 0.08);
    const ox = randRange(rng, -0.35, 0.35);
    const oz = randRange(rng, -0.35, 0.35);
    const lean = randRange(rng, -0.1, 0.1);
    parts.push(cyl(r * 0.85, r, h, 6, foliage('bamboo'), ox, h / 2, oz, lean, 0, lean * 0.7));
    // A small leaf spray near the top.
    parts.push(cone(0.5, 0.9, 5, foliage('bamboo'), ox + Math.sin(lean) * h * 0.4, h + 0.3, oz));
  }

  const group = new THREE.Group();
  group.name = 'bamboo-clump';
  group.add(...mergeByMaterial(parts));
  return group;
}

/** A low rounded shrub — 2–3 small overlapping foliage clumps at ground level. */
export function shrub(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const lobes = randPick(rng, [2, 3]);
  const baseR = randRange(rng, 0.4, 0.7);

  const parts: THREE.Mesh[] = [];
  for (let i = 0; i < lobes; i++) {
    const a = rng() * Math.PI * 2;
    const off = baseR * 0.4;
    const r = baseR * randRange(rng, 0.7, 1.0);
    parts.push(icosphere(r, foliage('shrub'), Math.cos(a) * off, r * 0.75, Math.sin(a) * off));
  }

  const group = new THREE.Group();
  group.name = 'shrub';
  group.add(...mergeByMaterial(parts));
  return group;
}

/**
 * A tuft of grass: a handful of thin blade "cards" fanned out from a point and tilted
 * outward, the standard cheap trick for ground cover — reads as grass at a walking
 * distance without the cost of individual blade geometry.
 */
export function grassTuft(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const blades = randPick(rng, [3, 4, 5]);
  const h = randRange(rng, 0.28, 0.5);

  const parts: THREE.Mesh[] = [];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rng() * 0.6;
    const tilt = randRange(rng, 0.15, 0.4);
    const bh = h * randRange(rng, 0.8, 1.15);
    parts.push(box(0.06, bh, 0.02, foliage('shrub'), 0, bh / 2, 0, tilt, a, 0));
  }

  const group = new THREE.Group();
  group.name = 'grass-tuft';
  group.add(...mergeByMaterial(parts));
  return group;
}

/**
 * A rock: a low-poly icosahedron with each vertex pushed outward by a random amount
 * along its own normal, then re-normalled. Cheap (20 triangles at `detail = 0`) and,
 * because the displacement is seeded, no two rocks share a silhouette even though they
 * share a base mesh.
 */
export function rock(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const radius = randRange(rng, 0.35, 1.1);
  const mat = stone(randPick(rng, ['light', 'dark'] as const));

  const geo = new THREE.IcosahedronGeometry(radius, 0);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    const push = 1 + randRange(rng, -0.22, 0.28);
    v.copy(n.multiplyScalar(v.length() * push));
    pos.setXYZ(i, v.x, v.y * randRange(rng, 0.7, 0.95), v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  // Settle it slightly into the ground rather than balancing on the lowest vertex.
  const mesh = meshFrom(geo, mat, 0, radius * 0.32, 0, rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);

  const group = new THREE.Group();
  group.name = 'rock';
  group.add(mesh);
  return group;
}
