/**
 * Prop geometry kit.
 * ==================
 *
 * Low-level building blocks shared by every file in `props/`. Nothing here knows what a
 * "machiya" or a "torii" is — this file only knows boxes, cylinders, roofs and how to
 * squash many small meshes into one draw call.
 *
 * Two conventions every builder in this library follows, both enforced by helpers here:
 *
 * 1. **Base-centre origin.** A prop's group sits at `y = 0` at ground level, exactly like
 *    the terrain field promises the caller. `box()`/`cyl()` take a *centre* position, so
 *    the common pattern is `box(w, h, d, mat, x, h / 2, z)` — the caller supplies half the
 *    height as `y` to plant the box's bottom face on the ground.
 * 2. **Flat shading via unique-vertex geometry.** The art direction is faceted low-poly,
 *    not smooth-shaded. `MeshToonMaterial.flatShading` (see `materials.ts`) only reads
 *    correctly when a face's three corners are not shared with a differently-angled
 *    neighbour — shared vertices get *averaged* normals, which smears the facets. Built-in
 *    THREE geometries (Box, Cylinder, Icosahedron) already give every face its own
 *    vertices, so they need nothing extra. The hand-rolled roof geometries below follow
 *    the same rule deliberately: every triangle gets three private vertices, never an
 *    index buffer, so `computeVertexNormals()` reduces to "the true face normal" instead
 *    of an average.
 *
 * No file in `props/` should ever call `new THREE.MeshToonMaterial` or similar directly —
 * materials always come from `../materials.ts`. This file only ever receives an
 * already-built `THREE.Material` and applies it to geometry.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/**
 * mulberry32 — a tiny, fast, deterministic PRNG.
 *
 * Vegetation is instanced thousands of times across the island, and `Math.random()` is
 * banned throughout `props/`: the client and server must be able to agree on what the
 * island looks like (and, more mundanely, re-running the scatterer must not reshuffle
 * every tree on every reload). Given the same seed this always produces the same
 * sequence, on every machine, forever.
 *
 * Returns a closure `() => number` yielding floats in `[0, 1)`, matching `Math.random`'s
 * shape so it drops into existing "roll a float" call sites unchanged.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random float in `[lo, hi)` drawn from a mulberry32 generator. */
export function randRange(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Random pick from a fixed list, drawn from a mulberry32 generator. */
export function randPick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------
//
// `Landmark.opts` (see `@nagisa/shared` `world.ts`) is typed as a loose
// `Record<string, number | string | boolean>` so the data file can stay generic across
// every landmark kind. Builders pull typed values out of it defensively — a missing or
// mistyped key falls back to a sane default rather than producing `NaN` geometry.

/** Read a numeric option, falling back if absent or the wrong type. */
export function numOpt(opts: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = opts?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Read a boolean option, falling back if absent or the wrong type. */
export function boolOpt(opts: Record<string, unknown> | undefined, key: string, fallback: boolean): boolean {
  const v = opts?.[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** Read a string option, falling back if absent or the wrong type. */
export function strOpt(opts: Record<string, unknown> | undefined, key: string, fallback: string): string {
  const v = opts?.[key];
  return typeof v === 'string' ? v : fallback;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Stamp position/rotation onto an arbitrary geometry and wrap it in a shadow-casting
 * mesh. Every other primitive helper in this file is a thin wrapper around this one, and
 * builders reach for it directly when they need a geometry type with no dedicated helper
 * (e.g. `THREE.IcosahedronGeometry` for rock/foliage clumps).
 *
 * `x, y, z` position the geometry's own origin (for `BoxGeometry`/`CylinderGeometry` that
 * is the shape's centre, not its base — see the base-centre convention note above).
 */
export function meshFrom(
  geometry: THREE.BufferGeometry,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A box, the workhorse of every timber-framed building. Centred at `(x, y, z)` — pass
 * `y = h / 2` (plus any additional stack height) to sit its base on the ground.
 */
export function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.Mesh {
  return meshFrom(new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz);
}

/**
 * A cylinder (or, with `rTop = 0` or `rBottom = 0`, a cone) — posts, pillars, roof
 * finials, lantern shafts. `seg` stays low (6–10) throughout this library on purpose: a
 * hexagonal post reads as "hand-turned timber", a 32-gon post reads as a lathe-CNC part
 * and breaks the low-poly illusion. Pass `openEnded = true` to skip the (usually hidden)
 * end caps — e.g. a pier pile whose top is buried in the deck and whose bottom is buried
 * in the seabed never shows either end, so the caps are pure wasted triangles.
 */
export function cyl(
  rTop: number,
  rBottom: number,
  h: number,
  seg: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  openEnded = false,
): THREE.Mesh {
  return meshFrom(new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, openEnded), mat, x, y, z, rx, ry, rz);
}

/** Sugar over `cyl` for a simple cone (finials, foliage masses on conifers). */
export function cone(r: number, h: number, seg: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  return cyl(0, r, h, seg, mat, x, y, z);
}

/**
 * A low-poly faceted sphere — foliage clumps, rock cores. `detail = 0` (the default)
 * keeps every face a flat visible triangle, which is the point: a `detail: 2` icosphere
 * reads as a smooth ball and stops looking hand-built.
 */
export function icosphere(
  radius: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  detail = 0,
): THREE.Mesh {
  return meshFrom(new THREE.IcosahedronGeometry(radius, detail), mat, x, y, z);
}

// ---------------------------------------------------------------------------
// Roofs
// ---------------------------------------------------------------------------
//
// The three roof builders below share one construction strategy: push raw triangles
// (three unique vertices each, never shared, never indexed) into a flat number array,
// hand that to a BufferGeometry, and call computeVertexNormals(). Because no vertex is
// shared between two differently-angled faces, "average the normals sharing this vertex"
// degenerates to "this face's own normal" — exactly the crisp per-facet look the art
// direction wants, with zero risk of it depending on whether the renderer's `flat` GLSL
// qualifier happens to be honoured.
//
// All three are built in *local* space with the eave line at y = 0 and the building's
// footprint centred on the x/z origin — callers position the whole roof with
// `mesh.position.y = wallHeight` the same way every other prop is placed.

function pushTri(out: number[], a: THREE.Vector3Tuple, b: THREE.Vector3Tuple, c: THREE.Vector3Tuple): void {
  out.push(...a, ...b, ...c);
}

/** Two triangles (a,b,c) and (a,c,d) — `a,b,c,d` must already be wound so both are CCW. */
function pushQuad(
  out: number[],
  a: THREE.Vector3Tuple,
  b: THREE.Vector3Tuple,
  c: THREE.Vector3Tuple,
  d: THREE.Vector3Tuple,
): void {
  pushTri(out, a, b, c);
  pushTri(out, a, c, d);
}

function roofMeshFromPositions(positions: number[], mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A two-slope gable (kirizuma) roof — the single most-used shape in the library.
 *
 * `w`/`d` are the footprint the roof sits over (the wall box below it); `rise` is the
 * ridge height above the eave line; `overhang` extends the roof past the walls on *every*
 * side — the deep eave that keeps monsoon rain off the plaster and the walk-around
 * veranda dry, and visually the single detail that reads "Japanese roof" instead of
 * "generic gable". The ridge runs along z; the two slopes fall away in ±x.
 *
 * Built as a triangular-prism wedge: two rectangular slope faces plus two triangular
 * gable-end caps (the barge-board silhouette). No underside/soffit faces — they sit
 * against the building interior and are never seen from outside or from head height.
 */
export function gableRoof(w: number, d: number, rise: number, overhang: number, mat: THREE.Material): THREE.Mesh {
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;

  const ridgeFront: THREE.Vector3Tuple = [0, rise, -hd];
  const ridgeBack: THREE.Vector3Tuple = [0, rise, hd];
  const eaveFL: THREE.Vector3Tuple = [-hw, 0, -hd];
  const eaveFR: THREE.Vector3Tuple = [hw, 0, -hd];
  const eaveBL: THREE.Vector3Tuple = [-hw, 0, hd];
  const eaveBR: THREE.Vector3Tuple = [hw, 0, hd];

  const positions: number[] = [];
  pushQuad(positions, eaveFL, eaveBL, ridgeBack, ridgeFront); // left slope, outward normal -x
  pushQuad(positions, eaveBR, eaveFR, ridgeFront, ridgeBack); // right slope, outward normal +x
  pushTri(positions, eaveFR, eaveFL, ridgeFront); // front gable cap, outward normal -z
  pushTri(positions, eaveBL, eaveBR, ridgeBack); // back gable cap, outward normal +z

  return roofMeshFromPositions(positions, mat);
}

/**
 * A four-slope hipped (yosemune) roof — used where a building should read as more formal
 * or more enclosed than a gable (the warehouse, the shrine hall's optional variant, small
 * square teahouses). Unlike the gable, there is no vertical wall triangle at either end:
 * the roof slopes down on all four sides, which is what "hipped" means.
 *
 * The ridge is shortened relative to the eave (`ridgeHalfLength = max(0, d/2 - w/2)`,
 * the standard hipped-roof construction so the hip lines run at a natural ~45°); when
 * the footprint is square this collapses to zero and the roof becomes a simple pyramid,
 * which is the correct degenerate case, not a bug.
 */
export function hippedRoof(w: number, d: number, rise: number, overhang: number, mat: THREE.Material): THREE.Mesh {
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;
  const rHalf = Math.max(0, d / 2 - w / 2);

  const ridgeFront: THREE.Vector3Tuple = [0, rise, -rHalf];
  const ridgeBack: THREE.Vector3Tuple = [0, rise, rHalf];
  const eaveFL: THREE.Vector3Tuple = [-hw, 0, -hd];
  const eaveFR: THREE.Vector3Tuple = [hw, 0, -hd];
  const eaveBL: THREE.Vector3Tuple = [-hw, 0, hd];
  const eaveBR: THREE.Vector3Tuple = [hw, 0, hd];

  const positions: number[] = [];
  pushQuad(positions, eaveFL, eaveBL, ridgeBack, ridgeFront); // left slope (trapezoid)
  pushQuad(positions, eaveBR, eaveFR, ridgeFront, ridgeBack); // right slope (trapezoid)
  pushTri(positions, eaveFR, eaveFL, ridgeFront); // front hip
  pushTri(positions, eaveBL, eaveBR, ridgeBack); // back hip

  return roofMeshFromPositions(positions, mat);
}

/**
 * A gable roof whose eave line lifts toward the corners — the *sori* upward curl seen on
 * shrine and temple roofs. The ridge stays a straight line at `rise`; only the eave edge
 * curves, rising from `0` at mid-span to `lift` at the two gable-end corners, following
 * `t^4` so the lift stays flat through the middle of the span and only kicks up hard in
 * the last stretch near each corner — the visual signature of the curve (a gentle sweep
 * that flicks up at the very end, not a uniform bow).
 *
 * Reserved for the shrine hall; every other roof in the library is a plain gable or hip.
 * Overuse would cheapen it — restraint is the same rule the palette applies to vermilion.
 */
export function curvedEaveRoof(
  w: number,
  d: number,
  rise: number,
  overhang: number,
  mat: THREE.Material,
  lift = rise * 0.22,
  segments = 6,
): THREE.Mesh {
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;

  const eavePoint = (t: number): THREE.Vector3Tuple => [-hw, lift * t ** 4, t * hd];
  const eavePointR = (t: number): THREE.Vector3Tuple => [hw, lift * t ** 4, t * hd];
  const ridgePoint = (t: number): THREE.Vector3Tuple => [0, rise, t * hd];

  const positions: number[] = [];
  for (let i = 0; i < segments; i++) {
    const t0 = -1 + (2 * i) / segments;
    const t1 = -1 + (2 * (i + 1)) / segments;
    // Left slope strip.
    pushQuad(positions, eavePoint(t0), eavePoint(t1), ridgePoint(t1), ridgePoint(t0));
    // Right slope strip (reversed winding to face outward in +x).
    pushQuad(positions, eavePointR(t1), eavePointR(t0), ridgePoint(t0), ridgePoint(t1));
  }
  // Gable-end caps at the fully-lifted corners.
  pushTri(positions, eavePointR(-1), eavePoint(-1), ridgePoint(-1));
  pushTri(positions, eavePoint(1), eavePointR(1), ridgePoint(1));

  return roofMeshFromPositions(positions, mat);
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Bake each mesh's local transform into its geometry and merge the results into one
 * `BufferGeometry`. This is what lets a building built from forty `box()`/`cyl()` calls —
 * easy to reason about one post or one beam at a time — collapse to a handful of draw
 * calls: call `merge()` once per material on all the parts that share it.
 *
 * The input meshes are consumed for their geometry + matrix only; they are never added to
 * a scene themselves; discard them once passed here.
 */
export function merge(meshes: readonly THREE.Mesh[]): THREE.BufferGeometry {
  const geometries = meshes.map((m) => {
    m.updateMatrix();
    let g = m.geometry.clone();
    g.applyMatrix4(m.matrix);
    // `mergeGeometries` refuses to mix indexed and non-indexed inputs. The hand-rolled
    // roof geometries above are built non-indexed on purpose (see the comment at the top
    // of the roofs section); built-in geometries like BoxGeometry/CylinderGeometry are
    // indexed, but PolyhedronGeometry (which IcosahedronGeometry is built from) is not —
    // so a building mixing boxes, cylinders and an icosphere under one material would
    // otherwise fail here. Normalising everything to non-indexed sidesteps the mismatch
    // and costs nothing extra: it is also exactly the "no shared vertices across faces"
    // shape flat shading wants.
    if (g.index) {
      const flat = g.toNonIndexed();
      g.dispose();
      g = flat;
    }
    return g;
  });
  const result = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  return result;
}

/**
 * The usual way builders finish: take every small part a builder assembled, bucket them
 * by material, and return one merged, shadow-ready mesh per bucket. A machiya built from
 * ~40 primitives across ~4 materials (wood, plaster, roof tile, shoji) collapses to ~4
 * draw calls instead of 40 — the difference between a village and a frame-rate problem.
 */
export function mergeByMaterial(parts: readonly THREE.Mesh[]): THREE.Mesh[] {
  const buckets = new Map<THREE.Material, THREE.Mesh[]>();
  for (const part of parts) {
    const mat = part.material as THREE.Material;
    const bucket = buckets.get(mat);
    if (bucket) bucket.push(part);
    else buckets.set(mat, [part]);
  }
  const out: THREE.Mesh[] = [];
  for (const [mat, bucket] of buckets) {
    const mesh = new THREE.Mesh(merge(bucket), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}
