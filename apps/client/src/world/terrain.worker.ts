/**
 * Terrain meshing worker.
 * =======================
 *
 * Turns the analytic height field in `@nagisa/shared/terrain` into a vertex-coloured
 * mesh, off the main thread.
 *
 * This runs in a worker for one concrete reason: a `high` tier island is a 400 × 400 grid,
 * and every vertex costs a `heightAt` call that evaluates fbm noise, resolves the nearest
 * path through a spatial index and blends ten terraces. That is ~160 000 evaluations,
 * which is comfortably enough to drop frames — and it happens exactly when the player is
 * staring at the loading screen forming an opinion about whether this world is worth their
 * time.
 *
 * Everything crosses the wire as transferable typed arrays, so handing the result back
 * costs nothing.
 *
 * ### Colour is geology, not decoration
 *
 * The vertex colours below are the island's only "texture". They are layered in the order
 * a landscape actually forms — altitude decides the base, slope overrides it because a
 * steep face is bare rock whatever its height, and the roads override everything because
 * paving is paving. Getting that order wrong produces grass growing on a cliff, which is
 * the single most obvious tell that a world is procedural.
 */

import {
  ISLAND_EXTENT,
  PADS,
  heightAt,
  nearestPath,
  normalAt,
  smoothstep,
  type PathSurface,
} from '@nagisa/shared';

/**
 * Terraces that are *paved* rather than grassed or sanded.
 *
 * Without this the two harbour quays inherit the sand band their altitude puts them in,
 * and the busiest built-up places on the island read as beaches with warehouses standing
 * on them. The plaza and the summit court get the same treatment for the same reason: a
 * gathering place has a floor.
 */
const PAVED_PADS = new Set(['south-harbor', 'north-harbor', 'plaza', 'summit', 'village', 'noticeboard']);

/** Request sent by the main thread. */
export interface TerrainBuildRequest {
  /** Vertices per side. Total vertex count is resolution². */
  resolution: number;
  /** Half-extent of the meshed area in metres; matches `ISLAND_EXTENT` by default. */
  extent?: number;
}

/** Transferable result. Buffers are moved, not copied. */
export interface TerrainBuildResult {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Ground memberships, four floats per vertex. See {@link SurfaceMix}. */
  bands: Float32Array;
  indices: Uint32Array;
  /** Wall-clock cost of the build, ms — logged so tier tuning has real numbers. */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Surface colouring
// ---------------------------------------------------------------------------

/**
 * Palette, as linear RGB triples.
 *
 * Kept as local literals rather than imported from the shared tokens because this module
 * runs in a worker, where pulling in the token package would mean shipping the whole
 * design system (including the CSS emitter) into a second bundle for the sake of twelve
 * colours. They are the same values; `world-smoke` has no way to check that, so the pairs
 * are listed together here with their token names for review.
 */
const C = {
  /** SCENE_COLORS.sand, wetted */
  sandWet: [0.78, 0.73, 0.62],
  /** SCENE_COLORS.sand */
  sand: [0.902, 0.863, 0.761],
  /** SCENE_COLORS.grass */
  grass: [0.533, 0.627, 0.416],
  /** a cooler grass for hollows, so the hillsides are not one flat wash */
  grassCool: [0.451, 0.588, 0.427],
  /** SCENE_COLORS.grassDry — the upland above the treeline */
  grassDry: [0.663, 0.671, 0.486],
  /** SCENE_COLORS.rock */
  rock: [0.69, 0.655, 0.58],
  /** SCENE_COLORS.cliff */
  cliff: [0.557, 0.533, 0.478],
  /** the bare summit */
  scree: [0.62, 0.6, 0.557],
  /**
   * The terraces. Cooler and greyer than `SCENE_COLORS.paving`, deliberately.
   *
   * At the token's own value a paved square and a beach differ by about a tenth in each
   * channel, and at the scale a terrace is seen from that is no difference at all — the
   * summit court, a stone court at the top of a mountain, read as sand. Built ground and
   * natural ground want to be separable at a glance; the contour line between them now
   * exists, and this gives it two different things to separate.
   */
  paving: [0.757, 0.749, 0.722],
  /** a cooler paving tone, patched into the above so a quay is not one flat sheet */
  pavingCool: [0.702, 0.706, 0.694],
  /** SCENE_COLORS.path — the gravel lanes */
  gravel: [0.871, 0.824, 0.714],
  /** boardwalk timber */
  boardwalk: [0.588, 0.494, 0.376],
  /** the seabed, visible through shallow water */
  seabed: [0.4, 0.44, 0.42],
} as const;

type RGB = readonly [number, number, number] | number[];

function mix(a: RGB, b: RGB, t: number, out: number[]): number[] {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  out[0] = a[0] + (b[0] - a[0]) * u;
  out[1] = a[1] + (b[1] - a[1]) * u;
  out[2] = a[2] + (b[2] - a[2]) * u;
  return out;
}

/** Deterministic hash used for the patchy colour variation. Matches terrain.ts's. */
function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Smooth, low-frequency variation in [0, 1). One octave is enough at this scale. */
function patch(x: number, z: number, scale: number): number {
  const fx = x * scale;
  const fz = z * scale;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

const SURFACE_COLORS: Record<PathSurface, RGB> = {
  stone: C.paving,
  gravel: C.gravel,
  boardwalk: C.boardwalk,
};

/**
 * How much of each kind of ground this point is — four *continuous* memberships.
 *
 * Written to an `aSurface` vertex attribute and turned into a material id per fragment, so
 * the contour pass draws a line where one ground meets another: the shoreline, the edge of a
 * lane, the rim of a paved terrace. Without it the ground is a single material and the
 * contour pass finds nothing on it anywhere, which is why a paved square rendered as a sheet
 * of blank paper.
 *
 * Continuous, not a band index, and that distinction is the whole thing. Storing the winning
 * band as an integer and rounding the interpolation puts every boundary on the diagonal of a
 * grid cell, so the shoreline comes out as a staircase — in a style whose premise is that
 * every line looks drawn by hand. Thresholding a smooth field puts the boundary where the
 * ground actually changes, and it curves.
 *
 * - `x` — altitude coordinate, ramping 0 → 3 through water, sand, grass, upland.
 * - `y` — rockiness, `z` — pavedness, `w` — laneness. Read in that order, later winning,
 *   which is the same order the colour is layered in below.
 */
export interface SurfaceMix {
  alt: number;
  rock: number;
  paved: number;
  lane: number;
}

/**
 * Vertex colour for a point on the surface, and what kind of ground it is.
 * See the header for the layering rule. Writes the colour into `out` and the mix into `mix4`.
 */
function colorAt(x: number, z: number, h: number, slope: number, out: number[], mix4: SurfaceMix): number[] {
  // The altitude coordinate is the sum of the three transitions, which makes it monotone
  // and continuous across the branch boundaries below even though the colour is not.
  mix4.alt =
    smoothstep(-7, -0.6, h) + smoothstep(2.2, 5.6, h) + smoothstep(17, 23, h);
  mix4.rock = 0;
  mix4.paved = 0;
  mix4.lane = 0;

  // 1 — altitude bands.
  if (h < -0.6) {
    mix(C.seabed, C.sandWet, smoothstep(-7, -0.6, h), out);
  } else if (h < 2.2) {
    mix(C.sandWet, C.sand, smoothstep(-0.6, 1.4, h), out);
  } else if (h < 7) {
    mix(C.sand, C.grass, smoothstep(2.2, 5.6, h), out);
  } else if (h < 17) {
    // Broad patches of two greens, so a hillside has weather in it rather than being one
    // flat fill — the drawn look needs variation at a scale the eye reads as brushwork.
    mix(C.grass, C.grassCool, patch(x, z, 0.019), out);
  } else if (h < 24) {
    const upland: number[] = [0, 0, 0];
    mix(C.grass, C.grassCool, patch(x, z, 0.019), upland);
    mix(upland, C.grassDry, smoothstep(17, 23, h), out);
  } else {
    mix(C.grassDry, C.scree, smoothstep(24, 27, h), out);
  }

  // 2 — steep faces are rock regardless of altitude.
  //
  // The threshold matters more than it looks. The massif's flanks sit at 30–36° by
  // construction (see MASSIF_RADIUS in terrain.ts), so a rock threshold anywhere near
  // 23° turns the entire mountain to bare scree and the island reads as a quarry.
  // Widened from 0.66–0.95 for the same reason as the lane edge below: a transition that
  // resolves in one mesh cell is a polygon, not a gradient.
  const rockiness = smoothstep(0.58, 1.02, slope);
  if (rockiness > 0) {
    mix(out, h > 10 ? C.cliff : C.rock, rockiness, out);
  }
  mix4.rock = rockiness;

  // 3 — paved terraces. Applied before the roads so a lane crossing a quay still reads
  // as a lane.
  for (const pad of PADS) {
    if (!PAVED_PADS.has(pad.id)) continue;
    const d = Math.hypot(x - pad.x, z - pad.z);
    if (d > pad.outer) continue;
    // Cover the pad's flat area *and* most of its blend ring: the quay's edge is where a
    // harbour stops being a harbour, and leaving that ring sand-coloured puts a beach
    // between the warehouses and the water.
    const paved = 1 - smoothstep(pad.inner, pad.outer * 0.86, d);
    if (paved > 0) {
      const tone: number[] = [0, 0, 0];
      mix(C.paving, C.pavingCool, patch(x, z, 0.05), tone);
      mix(out, tone, paved * 0.94, out);
      mix4.paved = Math.max(mix4.paved, paved);
    }
  }

  // 4 — the roads, with a soft shoulder so they bed into the ground rather than sitting
  // on it as a stripe.
  const hit = nearestPath(x, z);
  if (hit.path && h > 0.2) {
    const edge = hit.path.halfWidth;
    // 6 m of transition, not 2.4. Vertex colours are interpolated across a mesh whose cells
    // are about 1.8 m, so a transition narrower than a few cells cannot be represented: the
    // boundary snaps to the grid and the lane comes out edged in polygons. The *line* along
    // it is drawn from a continuous field and stays a curve either way (see SurfaceMix), and
    // a crisp line over a soft wash is what a drawn map does anyway.
    const paved = 1 - smoothstep(edge, edge + 6, hit.dist);
    if (paved > 0) {
      mix(out, SURFACE_COLORS[hit.path.surface], paved * 0.9, out);
      mix4.lane = paved;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Mesh the height field.
 *
 * Layout is a plain regular grid in XZ. A grid rather than an adaptive mesh because the
 * field is smooth, the vertex budget is affordable, and a regular grid is trivially
 * correct — no cracks, no T-junctions, no LOD seams to debug on a phone at 3 a.m.
 */
export function buildTerrain(req: TerrainBuildRequest): TerrainBuildResult {
  const started = Date.now();
  const res = Math.max(16, Math.floor(req.resolution));
  const extent = req.extent ?? ISLAND_EXTENT;
  const span = extent * 2;
  const step = span / (res - 1);

  const vertexCount = res * res;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  /** Ground memberships, four per vertex. See {@link SurfaceMix}. */
  const bands = new Float32Array(vertexCount * 4);
  const indices = new Uint32Array((res - 1) * (res - 1) * 6);

  const rgb: number[] = [0, 0, 0];
  const mix4: SurfaceMix = { alt: 0, rock: 0, paved: 0, lane: 0 };

  for (let j = 0; j < res; j++) {
    const z = -extent + j * step;
    for (let i = 0; i < res; i++) {
      const x = -extent + i * step;
      const v = (j * res + i) * 3;

      const h = heightAt(x, z);
      positions[v] = x;
      positions[v + 1] = h;
      positions[v + 2] = z;

      // Normals come from the analytic field rather than from face averaging: it is
      // both cheaper and exactly consistent with the collision the character uses.
      const n = normalAt(x, z, step * 0.75);
      normals[v] = n[0];
      normals[v + 1] = n[1];
      normals[v + 2] = n[2];

      const slope = Math.acos(Math.min(1, Math.max(-1, n[1])));
      colorAt(x, z, h, slope, rgb, mix4);
      colors[v] = rgb[0];
      colors[v + 1] = rgb[1];
      colors[v + 2] = rgb[2];

      const b = (j * res + i) * 4;
      bands[b] = mix4.alt;
      bands[b + 1] = mix4.rock;
      bands[b + 2] = mix4.paved;
      bands[b + 3] = mix4.lane;
    }
  }

  let t = 0;
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const a = j * res + i;
      const b = a + 1;
      const c = a + res;
      const d = c + 1;
      // Counter-clockwise winding when viewed from +Y.
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }

  return { positions, normals, colors, bands, indices, elapsedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------

// Guarded so this module can also be imported directly on the main thread as a
// synchronous fallback when `Worker` is unavailable (older WebViews, some embeds).
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  self.onmessage = (event: MessageEvent<TerrainBuildRequest>) => {
    try {
      const result = buildTerrain(event.data);
      self.postMessage(result, {
        transfer: [
          result.positions.buffer,
          result.normals.buffer,
          result.colors.buffer,
          result.bands.buffer,
          result.indices.buffer,
        ],
      });
    } catch (err) {
      // Surface the failure rather than leaving the main thread waiting forever on a
      // promise that will never settle.
      self.postMessage({ error: String(err) });
    }
  };
}
