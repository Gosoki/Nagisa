/**
 * Nagisa terrain field.
 * =====================
 *
 * The island's surface is defined **analytically**, as one pure function of (x, z).
 * There is no heightmap texture and no exported mesh: {@link heightAt} *is* the terrain.
 *
 * Why an analytic field rather than a baked asset:
 *
 * - **Client and server agree by construction.** The server validates player positions
 *   against exactly the geometry the client is standing on. A baked mesh would require
 *   shipping collision data to the server and keeping two artefacts in sync forever.
 * - **The island costs zero bytes to download.** The whole landmass is a few hundred
 *   lines of maths; the client meshes it in a worker at load time. This is what keeps us
 *   inside the reference product's asset budget while still having a full island.
 * - **It is editable by anyone.** Moving the shrine 20 m east is a number change here,
 *   not a Blender round-trip.
 *
 * Determinism is non-negotiable: every function below uses integer hashing
 * (`Math.imul`, bit ops) and never `Math.random`, `Date`, or transcendental identities
 * that differ across engines. Given the same (x, z), every machine returns the same
 * height, bit for bit.
 *
 * Units are metres. `y = 0` is mean sea level. Negative heights are seabed.
 */

// ---------------------------------------------------------------------------
// Deterministic noise primitives
// ---------------------------------------------------------------------------

/** Integer hash → [0, 1). Bit-exact on every JS engine. */
function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Quintic smoothstep — C² continuous, so the meshed terrain has no shading creases. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 2D value noise in [0, 1). Cheap, and smooth enough once stacked into fbm. */
function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

/**
 * Fractal brownian motion: `octaves` layers of value noise at doubling frequency and
 * halving amplitude. Returns roughly [0, 1).
 */
function fbm(x: number, y: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
    // Rotate each octave slightly so the layers do not align into visible grid streaks.
    const nx = fx * 0.8 - fy * 0.6;
    const ny = fx * 0.6 + fy * 0.8;
    fx = nx;
    fy = ny;
  }
  return sum / norm;
}

/** Ridged noise — inverted absolute value noise, used for the mountain spine. */
function ridge(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(fx, fy) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.1;
    fy *= 2.1;
  }
  return sum / norm;
}

/** Standard smoothstep, clamped. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Island silhouette
// ---------------------------------------------------------------------------

/** Extent of the terrain grid the client meshes, metres from origin on each axis. */
export const ISLAND_EXTENT = 260;

/** Radius beyond which there is nothing but open water. Used for camera + fog limits. */
export const OCEAN_RADIUS = 2400;

/**
 * Signed island mask: 1 deep inland, 0 at the waterline, negative offshore.
 *
 * The silhouette is an ellipse pulled out of round by low-frequency noise, then bitten
 * into by two inlets — the harbour basin in the south-west and a narrow cove on the east
 * coast. Capes are added back on the north-east (lighthouse) and north-west.
 */
function islandMask(x: number, z: number): number {
  // Base ellipse: the island is wider east-west than north-south.
  const ex = x / 168;
  const ez = z / 142;
  let d = Math.sqrt(ex * ex + ez * ez);

  // Coastline wobble. Angular noise keeps bays and headlands at a believable scale.
  const ang = Math.atan2(z, x);
  const wob =
    fbm(Math.cos(ang) * 2.2 + 11.3, Math.sin(ang) * 2.2 + 7.1, 4) * 0.24 +
    fbm(Math.cos(ang) * 6.0 + 3.7, Math.sin(ang) * 6.0 + 19.4, 3) * 0.08;
  d -= wob - 0.11;

  // North-east cape carrying the lighthouse: a lobe pushed out past the base ellipse.
  const capeNE = smoothstep(46, 0, Math.hypot(x - 120, z + 84)) * 0.42;
  // North-west headland, the high cliff walk.
  const capeNW = smoothstep(52, 0, Math.hypot(x + 112, z + 70)) * 0.3;
  d -= capeNE + capeNW;

  // Harbour basin: water cut into the south-west shore.
  const harbourBite = smoothstep(58, 14, Math.hypot((x + 98) * 0.9, (z - 106) * 1.15)) * 0.5;
  // Small east cove, gives the teahouse coast some shape.
  const coveBite = smoothstep(30, 8, Math.hypot(x - 146, z - 20)) * 0.34;
  d += harbourBite + coveBite;

  return 1 - d;
}

/** True where the analytic surface is above sea level (before flattening is applied). */
export function isLand(x: number, z: number): boolean {
  return islandMask(x, z) > 0;
}

// ---------------------------------------------------------------------------
// Flattened areas
// ---------------------------------------------------------------------------

/**
 * A flat pad blended into the terrain. Everything people gather on gets one: an event
 * plaza on a natural slope is unusable, and characters sliding down a shrine courtyard
 * would break the calm instantly.
 *
 * `inner` is fully flat at `height`; between `inner` and `outer` the pad blends back
 * into the natural surface.
 */
export interface Pad {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly inner: number;
  readonly outer: number;
}

/**
 * Terraces, in application order. Later pads win where they overlap, so a small pad may
 * be cut into a larger one (the notice-board terrace sits inside the plaza).
 *
 * Keep these in sync with `ZONES` in `world.ts` — the zone centres are anchored to them.
 */
export const PADS: readonly Pad[] = [
  // Harbour quay: barely above the water, so boats read as boats.
  { id: 'harbor', x: -96, z: 104, height: 2.2, inner: 30, outer: 62 },
  // The main event plaza, on the island's central shelf.
  { id: 'plaza', x: 0, z: 0, height: 8.0, inner: 34, outer: 74 },
  // Notice-board terrace, one step up from the plaza floor.
  { id: 'noticeboard', x: 6, z: -34, height: 9.2, inner: 11, outer: 22 },
  // Village street between plaza and teahouse.
  { id: 'village', x: 46, z: 10, height: 9.4, inner: 26, outer: 52 },
  // Teahouse rest terrace above the east cove.
  { id: 'teahouse', x: 78, z: 44, height: 12.5, inner: 20, outer: 42 },
  // Shrine courtyard on the north-west slope.
  { id: 'shrine', x: -58, z: -62, height: 22.0, inner: 22, outer: 46 },
  // Scenic viewing terrace, cantilevered off the mountain's south shoulder.
  { id: 'viewpoint', x: -14, z: -84, height: 44.0, inner: 15, outer: 34 },
  // Lighthouse cape: a flat clifftop, deliberately exposed.
  { id: 'lighthouse', x: 112, z: -78, height: 26.0, inner: 20, outer: 44 },
  // Sunset beach: a wide, almost-flat apron running into the sea.
  { id: 'beach', x: -122, z: 22, height: 0.9, inner: 26, outer: 58 },
] as const;

/** Lookup used by `world.ts` and by spawn placement. */
export function padById(id: string): Pad | undefined {
  return PADS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// The seaside promenade
// ---------------------------------------------------------------------------

/**
 * Waypoints of the coastal walking path, in order, as [x, z].
 *
 * The path is carved into the terrain (see {@link heightAt}) so it stays walkable across
 * slopes, and the client strews it with lanterns and paving. It is a loop: harbour →
 * sunset beach → north-west cliff → viewpoint → shrine → lighthouse cape → east coast →
 * teahouse → village → plaza → back down to the harbour.
 */
export const PROMENADE: readonly (readonly [number, number])[] = [
  [-96, 104],
  [-118, 78],
  [-128, 46],
  [-122, 22],
  [-124, -14],
  [-108, -48],
  [-84, -70],
  [-58, -62],
  [-34, -78],
  [-14, -84],
  [16, -88],
  [54, -92],
  [88, -88],
  [112, -78],
  [132, -48],
  [136, -10],
  [118, 24],
  [96, 42],
  [78, 44],
  [58, 30],
  [46, 10],
  [22, 4],
  [0, 0],
  [-26, 14],
  [-52, 44],
  [-74, 76],
  [-96, 104],
] as const;

/** Half-width of the paved promenade, metres. */
export const PROMENADE_HALF_WIDTH = 3.4;

/**
 * Squared distance from (x, z) to the promenade polyline, plus the parametric position
 * along it. Returned together because the client needs both — distance to carve and
 * pave, position to space lanterns evenly.
 */
export function promenadeDistance(x: number, z: number): { dist: number; s: number } {
  let best = Infinity;
  let bestS = 0;
  let acc = 0;
  for (let i = 0; i < PROMENADE.length - 1; i++) {
    const [ax, az] = PROMENADE[i];
    const [bx, bz] = PROMENADE[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const segLen = Math.hypot(dx, dz);
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bestS = acc + segLen * t;
    }
    acc += segLen;
  }
  return { dist: best, s: bestS };
}

/** Total promenade length, metres. Cached on first use — the polyline never changes. */
let promenadeLengthCache = -1;
export function promenadeLength(): number {
  if (promenadeLengthCache < 0) {
    let acc = 0;
    for (let i = 0; i < PROMENADE.length - 1; i++) {
      acc += Math.hypot(PROMENADE[i + 1][0] - PROMENADE[i][0], PROMENADE[i + 1][1] - PROMENADE[i][1]);
    }
    promenadeLengthCache = acc;
  }
  return promenadeLengthCache;
}

/** Point and tangent at arc-length `s` along the promenade. Used to place props. */
export function promenadeAt(s: number): { x: number; z: number; tx: number; tz: number } {
  const total = promenadeLength();
  let rem = ((s % total) + total) % total;
  for (let i = 0; i < PROMENADE.length - 1; i++) {
    const [ax, az] = PROMENADE[i];
    const [bx, bz] = PROMENADE[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (rem <= len) {
      const t = rem / len;
      return { x: ax + dx * t, z: az + dz * t, tx: dx / len, tz: dz / len };
    }
    rem -= len;
  }
  const [lx, lz] = PROMENADE[PROMENADE.length - 1];
  return { x: lx, z: lz, tx: 1, tz: 0 };
}

// ---------------------------------------------------------------------------
// The height field
// ---------------------------------------------------------------------------

/** Natural terrain before pads and the promenade are blended in. */
function naturalHeight(x: number, z: number): number {
  const mask = islandMask(x, z);

  // Offshore: a seabed that drops away, so the water reads as deep further out.
  if (mask <= 0) {
    return -2.5 + mask * 46 - fbm(x * 0.006 + 4.2, z * 0.006 + 1.7, 3) * 5;
  }

  // Shore-to-inland ramp. The first 12% of the mask is beach-flat, then it climbs.
  const inland = smoothstep(0.0, 0.34, mask);

  // Rolling ground.
  const rolling = (fbm(x * 0.0075 + 2.1, z * 0.0075 + 9.4, 5) - 0.5) * 24;

  // Mountain spine across the north of the island.
  const spine = Math.hypot((x + 20) * 0.9, (z + 96) * 1.5);
  const mountainMask = smoothstep(150, 20, spine);
  const mountain = ridge(x * 0.0105 + 5.5, z * 0.0105 + 2.2, 4) * 74 * mountainMask;

  // Cliff on the north and north-east coasts: land meets sea vertically, not gently.
  const northness = smoothstep(-20, -95, z);
  const cliff = smoothstep(0.02, 0.16, mask) * 22 * northness;

  // Fine surface detail, kept small so the walkable slope stays comfortable.
  const detail = (fbm(x * 0.045 + 17.0, z * 0.045 + 31.0, 3) - 0.5) * 2.4;

  return inland * (7 + rolling + mountain + cliff) + detail * inland + mask * 3.5;
}

/**
 * Ground height at a world position, metres. **The** definition of the island's surface.
 *
 * Order of operations matters: natural terrain → promenade carve → gathering pads. Pads
 * are applied last because a flat plaza must win over a path that crosses it.
 */
export function heightAt(x: number, z: number): number {
  let h = naturalHeight(x, z);

  // Carve the promenade: blend toward a locally smoothed height so the path holds a
  // gentle grade instead of following every bump.
  const { dist } = promenadeDistance(x, z);
  if (dist < PROMENADE_HALF_WIDTH + 7) {
    // Average the natural surface across a short span of the path to get its grade.
    const smooth =
      (naturalHeight(x + 6, z) + naturalHeight(x - 6, z) + naturalHeight(x, z + 6) + naturalHeight(x, z - 6)) * 0.25;
    const w = 1 - smoothstep(PROMENADE_HALF_WIDTH, PROMENADE_HALF_WIDTH + 7, dist);
    h = lerp(h, Math.max(smooth, 1.4), w * 0.85);
  }

  // Blend in the flat gathering pads.
  for (const pad of PADS) {
    const d = Math.hypot(x - pad.x, z - pad.z);
    if (d > pad.outer) continue;
    const w = 1 - smoothstep(pad.inner, pad.outer, d);
    h = lerp(h, pad.height, w);
  }

  return h;
}

/**
 * Surface normal, by central difference. Used for character alignment, for scattering
 * vegetation only on gentle slopes, and for the "is this walkable" test.
 */
export function normalAt(x: number, z: number, eps = 0.6): [number, number, number] {
  const hL = heightAt(x - eps, z);
  const hR = heightAt(x + eps, z);
  const hD = heightAt(x, z - eps);
  const hU = heightAt(x, z + eps);
  const nx = hL - hR;
  const nz = hD - hU;
  const ny = 2 * eps;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Slope in radians, 0 = flat. */
export function slopeAt(x: number, z: number): number {
  return Math.acos(clamp(normalAt(x, z)[1], -1, 1));
}

/** Steepest slope a character may stand on. Beyond this they slide. */
export const MAX_WALKABLE_SLOPE = 0.86; // ≈ 49°

/**
 * Whether a position is somewhere a player may legitimately be.
 *
 * The server calls this on every reported transform. It is intentionally forgiving
 * about *height* (the client owns its own jump arc) and strict about *place*: you may
 * not be inside the sea, off the map, or clinging to a cliff face.
 */
export function isWalkable(x: number, z: number): boolean {
  if (Math.abs(x) > ISLAND_EXTENT || Math.abs(z) > ISLAND_EXTENT) return false;
  const h = heightAt(x, z);
  // Standing in shallow water at the shoreline is fine and looks good; deep water is not.
  if (h < -0.9) return false;
  return slopeAt(x, z) <= MAX_WALKABLE_SLOPE;
}

/**
 * Nudge a position back onto walkable ground, searching outward in a ring.
 * Used by the server to build {@link isWalkable} corrections that do not teleport the
 * player somewhere absurd, and by the client when a spawn point drifts after a terrain
 * tweak.
 */
export function nearestWalkable(x: number, z: number, maxRadius = 40): [number, number] {
  if (isWalkable(x, z)) return [x, z];
  for (let r = 2; r <= maxRadius; r += 2) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const nx = x + Math.cos(a) * r;
      const nz = z + Math.sin(a) * r;
      if (isWalkable(nx, nz)) return [nx, nz];
    }
  }
  // Last resort: the plaza is flat by construction and always walkable.
  return [0, 0];
}
