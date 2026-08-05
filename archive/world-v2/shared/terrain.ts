/**
 * Nagisa terrain field — world model v2.
 * ======================================
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
 *   lines of maths; the client meshes it in a worker at load time.
 * - **It is editable by anyone.** Moving the shrine 20 m east is a number change here,
 *   not a Blender round-trip.
 *
 * ### What changed from v1 (see `archive/world-v1/`)
 *
 * v1 was an east–west ellipse with a mountain ridge shoved against its northern edge, a
 * single harbour, and the main plaza sitting at the origin. It read as a coastline with
 * some hills behind it rather than as an island.
 *
 * v2 is built the other way round, from the middle outward:
 *
 * ```
 *                       ── open sea, every direction ──
 *                        北港 North Harbour  ·  灯台岬 Lighthouse Cape
 *          神社 Shrine ┐                                    ┌ 茶屋 Teahouse
 *                      └──── 山頂 Summit (the massif) ──────┘
 *          浜 Beach   ┘                                     └ 町並み Old Street
 *                        広場 Main Plaza  ·  南港 South Harbour
 * ```
 *
 * - **Sea on all four sides.** The silhouette is a compact disc, not an ellipse pushed up
 *   against the edge of the meshed area. From any shore you are looking at open water.
 * - **The high ground is in the centre.** One massif at the island's heart, with radial
 *   spurs and the valleys between them. Everything else is arranged around its foot, so
 *   the mountain is the thing you orient by from anywhere on the island.
 * - **Two harbours, north and south.** Each sits in its own bay bitten out of the coast.
 *   The south is the arrival port (bigger, busier, faces the plaza); the north is the
 *   working fishing harbour.
 * - **Settlement is distributed.** Six inhabited places spread around the ring rather
 *   than clustered along one shore, connected by a coast road and three climbing lanes.
 *
 * Determinism is non-negotiable: every function below uses integer hashing
 * (`Math.imul`, bit ops) and never `Math.random`, `Date`, or transcendental identities
 * that differ across engines. Given the same (x, z), every machine returns the same
 * height, bit for bit.
 *
 * Units are metres. `y = 0` is mean sea level. Negative heights are seabed. `-z` is
 * north, `+x` is east — the three.js convention, kept everywhere in this codebase.
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

/**
 * Ridged noise — inverted absolute value noise. Where fbm gives rounded dunes, this
 * gives creases and crests, which is what a rock massif needs.
 */
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
// Island dimensions
// ---------------------------------------------------------------------------

/** Extent of the terrain grid the client meshes, metres from origin on each axis. */
export const ISLAND_EXTENT = 320;

/** Radius beyond which there is nothing but open water. Used for camera + fog limits. */
export const OCEAN_RADIUS = 2600;

/** Mean radius of the coastline, before capes, bays and wobble. */
const COAST_RADIUS = 238;

/** Summit of the central massif. Every other place on the island is described relative to it. */
export const SUMMIT = { x: 0, z: -14, height: 88 } as const;

/**
 * Horizontal reach of the massif — beyond this the ground is coastal shelf.
 *
 * Height and radius are chosen together, not independently. A smoothstep cone's steepest
 * point is its midpoint, where the gradient is `1.5 · height / radius`; at 88 m over
 * 182 m that is 0.73, or 36°, comfortably inside {@link MAX_WALKABLE_SLOPE} once the
 * spurs and rock detail have added their share. Raising the peak without widening the
 * base is the quickest way to make the whole mountain unclimbable.
 */
const MASSIF_RADIUS = 182;

// ---------------------------------------------------------------------------
// Island silhouette
// ---------------------------------------------------------------------------

/**
 * A lobe added to or bitten out of the coastline.
 *
 * `strength` is in mask units, where 1.0 ≈ the whole island radius, so a cape of 0.30
 * pushes the shore out by roughly 30% of `COAST_RADIUS` at its centre. Positive values
 * are handled by {@link CAPES} (land pushed seaward), negative by {@link BAYS} (sea cut
 * inland) — they are separate arrays only because reading them as two lists is clearer
 * than reading one list with signs in it.
 */
interface CoastFeature {
  readonly x: number;
  readonly z: number;
  /** Radius over which the feature falls off to nothing. */
  readonly reach: number;
  readonly strength: number;
}

/**
 * Headlands. Each one carries something: the lighthouse stands on the north-east cape,
 * the shrine on the west headland, the beach runs off the south-west spit.
 */
const CAPES: readonly CoastFeature[] = [
  { x: 150, z: -196, reach: 96, strength: 0.3 }, // north-east: lighthouse cape
  { x: -212, z: 26, reach: 88, strength: 0.24 }, // west: shrine headland
  { x: 196, z: 88, reach: 84, strength: 0.2 }, // east: the old street's shelf
  { x: -158, z: 172, reach: 92, strength: 0.22 }, // south-west: beach spit
] as const;

/**
 * The two harbour bays. Both are deliberately generous — a harbour you cannot see across
 * does not read as a harbour, and boats need somewhere to be.
 */
const BAYS: readonly CoastFeature[] = [
  { x: 16, z: 264, reach: 116, strength: 0.46 }, // south bay: the arrival port
  { x: -36, z: -266, reach: 100, strength: 0.4 }, // north bay: the fishing harbour
] as const;

/**
 * Signed island mask: ~1 at the summit, 0 at the waterline, negative offshore.
 *
 * The base shape is a circle rather than v1's ellipse. That is the whole point of "sea on
 * four sides": an ellipse inside a square meshed area leaves the player looking at a
 * distant edge in two directions and open water in the other two. A disc looks the same
 * from every shore.
 */
function islandMask(x: number, z: number): number {
  let d = Math.hypot(x, z) / COAST_RADIUS;

  // Coastline wobble, sampled on the unit circle so it is periodic in angle and cannot
  // seam. Two octaves: the low one makes broad bays, the high one makes rocky detail.
  const ang = Math.atan2(z, x);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const wobble =
    (fbm(ca * 2.1 + 11.3, sa * 2.1 + 7.1, 4) - 0.5) * 0.17 + (fbm(ca * 5.6 + 3.7, sa * 5.6 + 19.4, 3) - 0.5) * 0.07;
  d -= wobble;

  for (const cape of CAPES) {
    d -= smoothstep(cape.reach, 0, Math.hypot(x - cape.x, z - cape.z)) * cape.strength;
  }
  for (const bay of BAYS) {
    d += smoothstep(bay.reach, 0, Math.hypot(x - bay.x, z - bay.z)) * bay.strength;
  }

  return 1 - d;
}

/** True where the analytic surface is above sea level (before flattening is applied). */
export function isLand(x: number, z: number): boolean {
  return islandMask(x, z) > 0;
}

// ---------------------------------------------------------------------------
// The central massif
// ---------------------------------------------------------------------------

/**
 * Height contributed by the mountain at the island's centre.
 *
 * Three things stacked, in order of decreasing scale:
 *
 * 1. **The cone.** A smoothstep profile raised to a power, so the flanks flare out near
 *    the bottom (walkable foothills) and steepen toward the top (a summit you have to
 *    mean to reach). A linear cone reads as a pile of sand.
 * 2. **Radial spurs.** Six ridges running down from the peak with valleys between them,
 *    driven by `cos(6θ)` warped by noise so they are not mechanically regular. This is
 *    what turns "a bump" into "a mountain": it gives the silhouette corners, it gives the
 *    lanes somewhere natural to climb, and it hides the fact that the base is a circle.
 * 3. **Ridged detail.** Rock creases, faded out at the very summit (so the peak stays a
 *    clean readable shape) and at the foot (so the terraces below sit on calm ground).
 */
function massif(x: number, z: number): number {
  const dx = x - SUMMIT.x;
  const dz = z - SUMMIT.z;
  const r = Math.hypot(dx, dz);
  if (r > MASSIF_RADIUS) return 0;

  // 1 — the cone. Plain smoothstep: it has zero gradient at both the foot (so the
  // terraces around the base sit on calm ground) and the summit (so the top is a dome
  // you can stand on), and its worst gradient is bounded and known — see MASSIF_RADIUS.
  const t = 1 - r / MASSIF_RADIUS;
  const profile = t * t * (3 - 2 * t);

  // 2 — radial spurs. The angular offset is warped by low-frequency noise so the six
  // ridges are not evenly spaced, and the warp is a function of radius so they wander as
  // they descend rather than running dead straight.
  const ang = Math.atan2(dz, dx);
  const warp = (fbm(Math.cos(ang) * 1.6 + 21.7, Math.sin(ang) * 1.6 + 5.2, 3) - 0.5) * 2.4;
  const spur = 0.5 + 0.5 * Math.cos(ang * 6 + warp + r * 0.004);
  // Spurs are invisible at the summit (where everything converges) and strongest halfway
  // down, fading again at the foot so they do not chop up the terraces.
  const spurWeight = 0.2 * smoothstep(14, 78, r) * (1 - smoothstep(120, MASSIF_RADIUS, r));
  const shaped = profile * (1 - spurWeight + spurWeight * spur);

  // 3 — rock detail. Amplitude is the budget left over after the cone and the spurs have
  // spent theirs: enough to read as rock, not enough to push any flank past walkable.
  const rough = ridge(x * 0.0105 + 5.5, z * 0.0105 + 2.2, 4) - 0.42;
  const detailMask = smoothstep(0, 0.3, profile) * (1 - smoothstep(0.86, 1, profile));

  return SUMMIT.height * shaped + rough * 10 * detailMask;
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
 * `scripts/world-smoke.ts` asserts that `heightAt(pad.x, pad.z) === pad.height`, which is
 * what catches a pad that has drifted off its zone or been swallowed by a later one.
 */
export const PADS: readonly Pad[] = [
  // — Coastal ring, roughly clockwise from the south ————————————————
  /**
   * The arrival port. Barely above the water, so the boats read as boats.
   *
   * Harbour terraces are kept deliberately tight. A pad's blend raises the ground all the
   * way out to `outer`, and the ground it is raising here is *seabed* — an over-generous
   * quay does not make a bigger harbour, it fills the bay in and leaves the piers standing
   * on a beach. 26/46 puts the waterline about 30 m out from the quay's centre, which is
   * enough to moor against and not enough to drain the anchorage.
   */
  { id: 'south-harbor', x: 16, z: 192, height: 2.6, inner: 26, outer: 46 },
  /** Sunset beach: a wide, almost-flat apron running into the sea. */
  { id: 'beach', x: -166, z: 146, height: 1.2, inner: 30, outer: 64 },
  /** Shrine courtyard, cut into the west headland above the water. */
  { id: 'shrine', x: -186, z: 20, height: 26.0, inner: 26, outer: 54 },
  /** The fishing harbour on the north bay. Same tight-terrace rule as the south. */
  { id: 'north-harbor', x: -36, z: -198, height: 2.4, inner: 22, outer: 42 },
  /** Lighthouse cape: a flat clifftop, deliberately exposed. */
  { id: 'lighthouse', x: 138, z: -190, height: 32.0, inner: 22, outer: 52 },
  /** Teahouse rest terrace, high on the eastern flank. */
  { id: 'teahouse', x: 168, z: -62, height: 33.0, inner: 21, outer: 50 },
  /** The old street, on the eastern shelf. */
  { id: 'village', x: 176, z: 76, height: 18.0, inner: 30, outer: 62 },

  // — Inland ————————————————————————————————————————————————————————
  //
  // Pads must not overlap unless the nesting is deliberate: they are applied in order and
  // a later pad wins, so a big terrace whose `outer` reaches a small one downhill will
  // quietly drag it to the wrong height. The plaza is sized to stop short of the harbour
  // quay for exactly that reason; the notice board is the one intentional nesting.
  /** The main event plaza, on the mountain's southern shoulder above the port. */
  { id: 'plaza', x: 0, z: 108, height: 22.0, inner: 34, outer: 62 },
  /** Notice-board terrace, one step up from the plaza floor. */
  { id: 'noticeboard', x: -26, z: 94, height: 24.4, inner: 11, outer: 23 },
  /** The summit court itself: a small flat terrace at the true peak, around the inner shrine. */
  { id: 'summit', x: SUMMIT.x, z: SUMMIT.z, height: SUMMIT.height, inner: 18, outer: 44 },
] as const;

/** Lookup used by `world.ts` and by spawn placement. */
export function padById(id: string): Pad | undefined {
  return PADS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** How a path is surfaced. Drives terrain vertex colour and the prop scatterer. */
export type PathSurface = 'stone' | 'gravel' | 'boardwalk';

/**
 * A walking route carved into the terrain.
 *
 * Paths do two jobs. Physically they hold a gentle grade across ground that would
 * otherwise be too steep to walk, which is what makes a 96 m mountain climbable without
 * any stair geometry. Visually they are the island's circulation diagram: if you can see
 * where a path goes, you know where you can go, and you never need a minimap.
 */
export interface WorldPath {
  readonly id: 'coast' | 'shrine-ascent' | 'south-approach' | 'east-lane';
  readonly name: string;
  /** Waypoints, in order, as [x, z]. */
  readonly points: readonly (readonly [number, number])[];
  /** Half-width of the walkable surface, metres. */
  readonly halfWidth: number;
  /** Distance beyond `halfWidth` over which the carve blends back to natural ground. */
  readonly shoulder: number;
  /** How strongly the path flattens what is under it, 0–1. */
  readonly carve: number;
  readonly surface: PathSurface;
}

/**
 * Every route on the island.
 *
 * The coast road is the spine: it touches all six inhabited places and closes into a
 * loop, so walking in one direction eventually brings you back. The three lanes climb
 * inland off it — one up the west ridge from the shrine, one up the southern shoulder
 * from the plaza, one along the eastern shelf linking the old street to the teahouse.
 */
export const PATHS: readonly WorldPath[] = [
  {
    id: 'coast',
    name: 'Coast Road',
    halfWidth: 3.6,
    shoulder: 7,
    carve: 0.95,
    surface: 'stone',
    points: [
      [16, 192], // south harbour
      [-58, 186],
      [-118, 172],
      [-166, 146], // beach
      [-196, 108],
      [-208, 62],
      [-186, 20], // shrine
      [-176, -34],
      [-150, -92],
      [-116, -142],
      [-74, -180],
      [-36, -198], // north harbour
      [20, -206],
      [78, -206],
      [138, -190], // lighthouse cape
      [176, -150],
      [188, -108],
      [168, -62], // teahouse
      [180, -16],
      [190, 30],
      [176, 76], // old street
      [150, 122],
      [110, 158],
      [66, 182],
      [16, 198],
    ],
  },
  {
    id: 'south-approach',
    name: 'Plaza Steps',
    halfWidth: 3.2,
    shoulder: 6,
    carve: 0.95,
    surface: 'stone',
    points: [
      [16, 192], // off the harbour quay
      [12, 168],
      [4, 138],
      [0, 108], // the plaza
      [-26, 94], // notice-board terrace
      [-8, 72],
      [26, 52],
      [32, 20],
      [0, -14], // summit
    ],
  },
  {
    id: 'shrine-ascent',
    name: 'Shrine Path',
    halfWidth: 2.8,
    shoulder: 5.5,
    carve: 0.94,
    surface: 'gravel',
    points: [
      [-186, 20], // shrine courtyard
      [-152, 6],
      [-118, -4],
      // Switchbacks: the west flank is the steepest side of the massif, so the lane
      // doubles back on itself twice rather than running straight at the slope.
      [-88, -30],
      [-96, -62],
      [-64, -74],
      [-38, -52],
      [-18, -32],
      [0, -14], // summit
    ],
  },
  {
    id: 'east-lane',
    name: 'East Lane',
    halfWidth: 3.0,
    shoulder: 6,
    carve: 0.94,
    surface: 'gravel',
    points: [
      [176, 76], // old street
      [150, 44],
      [136, 6],
      [148, -34],
      [168, -62], // teahouse
      [132, -84],
      [92, -76],
      [56, -56],
      [26, -34],
      [0, -14], // summit
    ],
  },
] as const;

/** The coast road, by name, for callers that mean *that* path specifically. */
export const COAST_PATH: WorldPath = PATHS[0];

/**
 * Backwards-compatible alias for the v1 name. The half-width of the coast road is what
 * the prop scatterer and the terrain colourer used to key off, and keeping the constant
 * saves touching every call site for a rename that carries no information.
 */
export const PROMENADE_HALF_WIDTH = COAST_PATH.halfWidth;

// --- Path spatial index ------------------------------------------------------------
//
// `heightAt` is called ~115 000 times to mesh the terrain and again on every position the
// server validates. A naive nearest-point-on-polyline search over all four paths is 90-odd
// segment tests per call, which turns terrain meshing into a visible stall on a phone.
//
// So segments are bucketed into a uniform grid once, lazily, on first use. A lookup then
// tests only the segments whose influence reaches the query cell — typically zero (most of
// the island is not near a path, and that is the case worth making fast) or two or three.

interface Segment {
  readonly path: WorldPath;
  readonly ax: number;
  readonly az: number;
  /** b - a, precomputed. */
  readonly dx: number;
  readonly dz: number;
  /** 1 / |b - a|², precomputed; segments of zero length are dropped at build time. */
  readonly invLenSq: number;
  readonly length: number;
  /** Arc length from the start of the path to `a`. */
  readonly s0: number;
}

/** Grid cell size, metres. Comfortably larger than the widest path influence. */
const PATH_CELL = 32;
/** Grid half-extent in cells, sized to cover the meshed area with room to spare. */
const PATH_GRID_HALF = Math.ceil((ISLAND_EXTENT + PATH_CELL) / PATH_CELL);
const PATH_GRID_SIZE = PATH_GRID_HALF * 2 + 1;

let pathGrid: (Segment[] | undefined)[] | null = null;
const pathLengths = new Map<string, number>();

function cellIndex(cx: number, cz: number): number {
  return (cz + PATH_GRID_HALF) * PATH_GRID_SIZE + (cx + PATH_GRID_HALF);
}

function buildPathIndex(): (Segment[] | undefined)[] {
  const grid: (Segment[] | undefined)[] = new Array(PATH_GRID_SIZE * PATH_GRID_SIZE);

  for (const path of PATHS) {
    const reach = path.halfWidth + path.shoulder;
    let acc = 0;
    for (let i = 0; i < path.points.length - 1; i++) {
      const [ax, az] = path.points[i];
      const [bx, bz] = path.points[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      if (lenSq === 0) continue; // A repeated waypoint is a data typo, not geometry.
      const length = Math.sqrt(lenSq);
      const segment: Segment = { path, ax, az, dx, dz, invLenSq: 1 / lenSq, length, s0: acc };
      acc += length;

      // Register the segment in every cell its influence can touch: the cells covering
      // its bounding box, grown by the reach plus one cell of slack for the diagonal.
      const minX = Math.min(ax, bx) - reach;
      const maxX = Math.max(ax, bx) + reach;
      const minZ = Math.min(az, bz) - reach;
      const maxZ = Math.max(az, bz) + reach;
      const cx0 = clamp(Math.floor(minX / PATH_CELL), -PATH_GRID_HALF, PATH_GRID_HALF);
      const cx1 = clamp(Math.floor(maxX / PATH_CELL), -PATH_GRID_HALF, PATH_GRID_HALF);
      const cz0 = clamp(Math.floor(minZ / PATH_CELL), -PATH_GRID_HALF, PATH_GRID_HALF);
      const cz1 = clamp(Math.floor(maxZ / PATH_CELL), -PATH_GRID_HALF, PATH_GRID_HALF);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cellIndex(cx, cz);
          (grid[key] ??= []).push(segment);
        }
      }
    }
    pathLengths.set(path.id, acc);
  }

  return grid;
}

function segmentsNear(x: number, z: number): Segment[] | undefined {
  pathGrid ??= buildPathIndex();
  const cx = Math.floor(x / PATH_CELL);
  const cz = Math.floor(z / PATH_CELL);
  if (cx < -PATH_GRID_HALF || cx > PATH_GRID_HALF || cz < -PATH_GRID_HALF || cz > PATH_GRID_HALF) return undefined;
  return pathGrid[cellIndex(cx, cz)];
}

/** What {@link nearestPath} found. `path` is null when nothing is within influence. */
export interface PathHit {
  readonly path: WorldPath | null;
  /** Distance to the path centreline, metres. `Infinity` when `path` is null. */
  readonly dist: number;
  /** Arc length along that path of the closest point. */
  readonly s: number;
}

const NO_PATH: PathHit = { path: null, dist: Infinity, s: 0 };

/**
 * The nearest path to a point, and how far away it is.
 *
 * Only paths whose influence (half-width + shoulder) reaches the point are considered —
 * this is a "am I on a path" query, not a global nearest-neighbour search, and the whole
 * point of the grid is that most of the island answers "no" in constant time.
 */
export function nearestPath(x: number, z: number): PathHit {
  const segments = segmentsNear(x, z);
  if (!segments) return NO_PATH;

  let best = Infinity;
  let bestPath: WorldPath | null = null;
  let bestS = 0;

  for (const seg of segments) {
    const t = clamp(((x - seg.ax) * seg.dx + (z - seg.az) * seg.dz) * seg.invLenSq, 0, 1);
    const px = seg.ax + seg.dx * t;
    const pz = seg.az + seg.dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bestPath = seg.path;
      bestS = seg.s0 + seg.length * t;
    }
  }

  if (!bestPath || best > bestPath.halfWidth + bestPath.shoulder) return NO_PATH;
  return { path: bestPath, dist: best, s: bestS };
}

/** Total length of a path, metres. Computed once when the index is built. */
export function pathLength(id: WorldPath['id']): number {
  pathGrid ??= buildPathIndex();
  return pathLengths.get(id) ?? 0;
}

// --- Longitudinal grade profiles ---------------------------------------------------
//
// Flattening the ground *across* a path is not enough to make it walkable. A lane that
// is perfectly level from side to side but follows every gully and spur *along* its
// length still throws 70° pitches at the player, and the island's whole middle is a 96 m
// mountain, so this is not a corner case — it is the main event.
//
// Real roads are surveyed: a grade is chosen and the ground is cut and filled to hold it.
// That is what this does. Each path gets a height profile sampled along its arc length,
// which is then smoothed and, crucially, **grade-limited** — a relaxation pass that walks
// the profile forward and backward clamping the rise between neighbouring samples until
// no step exceeds MAX_PATH_GRADE. `heightAt` reads the profile instead of the raw terrain
// under the path, so the lane climbs at a comfortable, constant-ish angle and the terrain
// is cut or banked either side of it.

/** Arc-length spacing of profile samples, metres. */
const PROFILE_STEP = 4;

/** Steepest grade any path is allowed to hold — tan(θ). 0.30 ≈ 17°, a stiff but easy walk. */
const MAX_PATH_GRADE = 0.3;

/** Smoothing passes applied before grade limiting; removes gully-scale noise. */
const PROFILE_SMOOTH_PASSES = 10;

/** Relaxation passes for the grade limiter. Each pass is one forward + one backward sweep. */
const PROFILE_GRADE_PASSES = 40;

/** Never carve a path below this: a coast road at sea level would flood at the shoreline. */
const PATH_MIN_HEIGHT = 1.2;

const pathProfiles = new Map<string, Float64Array>();

/**
 * Build one path's grade profile.
 *
 * Sampling averages the natural surface over a small cross centred on the path, so a
 * single boulder-sized noise spike beside the centreline cannot pull the road up.
 */
function buildProfile(path: WorldPath): Float64Array {
  const total = pathLengths.get(path.id) ?? 0;
  const count = Math.max(2, Math.ceil(total / PROFILE_STEP));
  const closed = isClosedLoop(path);
  const profile = new Float64Array(count);
  /**
   * Samples that sit on a terrace are **pinned**: neither the smoothing nor the grade
   * limiter may move them. Terraces are the island's fixed levels — the quay is at 2.6 m
   * because boats tie up to it, the summit court is at the summit — so they are the
   * survey's control points and the lane between them is what gets graded.
   *
   * Pinning also silently fixes path *junctions*. Every place two routes meet on this
   * island is a terrace centre, so both profiles are pinned to the same height there, and
   * the step that would otherwise appear where `nearestPath` switches from one route to
   * the other cannot exist.
   */
  const pinned = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const { x, z } = pathAt(path.id, i * PROFILE_STEP);
    const pad = padContaining(x, z);
    if (pad) {
      profile[i] = pad.height;
      pinned[i] = 1;
      continue;
    }
    profile[i] = Math.max(
      PATH_MIN_HEIGHT,
      (paddedHeight(x, z) * 2 +
        paddedHeight(x + 5, z) +
        paddedHeight(x - 5, z) +
        paddedHeight(x, z + 5) +
        paddedHeight(x, z - 5)) /
        6,
    );
  }

  // Index arithmetic differs for a loop (wraps) and an open lane (clamps at the ends).
  const at = (i: number): number =>
    closed ? profile[((i % count) + count) % count] : profile[clamp(i, 0, count - 1) | 0];

  // 1 — smooth. A [1 2 1] kernel, repeated, is a cheap Gaussian.
  const scratch = new Float64Array(count);
  for (let pass = 0; pass < PROFILE_SMOOTH_PASSES; pass++) {
    for (let i = 0; i < count; i++) {
      scratch[i] = pinned[i] ? profile[i] : (at(i - 1) + profile[i] * 2 + at(i + 1)) * 0.25;
    }
    profile.set(scratch);
  }

  // 2 — grade limit. Sweeping in both directions and clamping the step each time
  // converges on the flattest profile that stays within MAX_PATH_GRADE everywhere, which
  // is exactly a surveyor's cut-and-fill. Corrections are pushed entirely onto whichever
  // end of the pair is free; a pair that is pinned at both ends is left alone (a terrace
  // placed too high above its neighbour is a layout problem, and `world-smoke` reports
  // it as a pad drift rather than having it silently absorbed here).
  const maxStep = MAX_PATH_GRADE * PROFILE_STEP;
  const relax = (lo: number, hi: number): boolean => {
    const delta = profile[hi] - profile[lo];
    const excess = Math.abs(delta) - maxStep;
    if (excess <= 0) return false;
    const signed = excess * Math.sign(delta);
    if (pinned[lo] && pinned[hi]) return false;
    if (pinned[lo]) profile[hi] -= signed;
    else if (pinned[hi]) profile[lo] += signed;
    else {
      profile[hi] -= signed * 0.5;
      profile[lo] += signed * 0.5;
    }
    return true;
  };

  for (let pass = 0; pass < PROFILE_GRADE_PASSES; pass++) {
    let moved = false;
    for (let i = 1; i < count; i++) moved = relax(i - 1, i) || moved;
    for (let i = count - 2; i >= 0; i--) moved = relax(i, i + 1) || moved;
    if (closed) moved = relax(count - 1, 0) || moved;
    if (!moved) break;
  }

  for (let i = 0; i < count; i++) profile[i] = Math.max(PATH_MIN_HEIGHT, profile[i]);
  return profile;
}

/** The terrace a point sits squarely on (inside its flat `inner` radius), if any. */
function padContaining(x: number, z: number): Pad | undefined {
  // Reverse order so the innermost/most-specific pad wins, matching the "later pad wins"
  // rule that `paddedHeight` applies.
  for (let i = PADS.length - 1; i >= 0; i--) {
    const pad = PADS[i];
    if (Math.hypot(x - pad.x, z - pad.z) <= pad.inner) return pad;
  }
  return undefined;
}

/** A path whose last waypoint returns to its first is a loop and must wrap when smoothed. */
function isClosedLoop(path: WorldPath): boolean {
  const first = path.points[0];
  const last = path.points[path.points.length - 1];
  return Math.hypot(first[0] - last[0], first[1] - last[1]) < 1;
}

/**
 * Designed surface height of a path at arc length `s`, linearly interpolated between
 * profile samples. This is the height the ground is cut or filled to.
 */
function profileHeight(path: WorldPath, s: number): number {
  let profile = pathProfiles.get(path.id);
  if (!profile) {
    profile = buildProfile(path);
    pathProfiles.set(path.id, profile);
  }
  const count = profile.length;
  const closed = isClosedLoop(path);
  const t = s / PROFILE_STEP;
  const i0 = Math.floor(t);
  const frac = t - i0;
  const wrap = (i: number): number => (closed ? ((i % count) + count) % count : clamp(i, 0, count - 1) | 0);
  return lerp(profile[wrap(i0)], profile[wrap(i0 + 1)], frac);
}

/**
 * Point and unit tangent at arc-length `s` along a path. Used to place lanterns, railings
 * and paving evenly without hand-authoring their positions.
 *
 * `s` wraps, so a caller can walk past the end of a closed loop without special-casing it.
 */
export function pathAt(id: WorldPath['id'], s: number): { x: number; z: number; tx: number; tz: number } {
  const path = PATHS.find((p) => p.id === id) ?? COAST_PATH;
  const total = pathLength(path.id);
  if (total <= 0) return { x: path.points[0][0], z: path.points[0][1], tx: 1, tz: 0 };
  // A loop wraps; an open lane clamps. Wrapping an open lane would teleport a caller
  // walking off the end of the shrine ascent back down to the shrine gate, which is how
  // an "88° grade" appears in a profile that is in fact perfectly graded.
  let rem = isClosedLoop(path) ? ((s % total) + total) % total : clamp(s, 0, total);
  for (let i = 0; i < path.points.length - 1; i++) {
    const [ax, az] = path.points[i];
    const [bx, bz] = path.points[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    if (rem <= len) {
      const t = rem / len;
      return { x: ax + dx * t, z: az + dz * t, tx: dx / len, tz: dz / len };
    }
    rem -= len;
  }
  const [lx, lz] = path.points[path.points.length - 1];
  return { x: lx, z: lz, tx: 1, tz: 0 };
}

// ---------------------------------------------------------------------------
// The height field
// ---------------------------------------------------------------------------

/**
 * Natural terrain before pads and paths are blended in.
 *
 * Composed as: seabed offshore, then onshore a coastal shelf plus the massif plus
 * cliff-forming steepening where the mask rises fast, plus fine detail.
 */
function naturalHeight(x: number, z: number): number {
  const mask = islandMask(x, z);

  // Offshore: a seabed that drops away, so the water reads as deep further out. The
  // gradient is gentle in the bays (mask barely below zero) and steep past the capes.
  if (mask <= 0) {
    return -2.2 + mask * 52 - fbm(x * 0.006 + 4.2, z * 0.006 + 1.7, 3) * 5;
  }

  // Shore-to-inland ramp. The first stretch of the mask is beach-flat, then it climbs.
  const inland = smoothstep(0.0, 0.16, mask);

  const mountain = massif(x, z);

  // The coastal shelf everything is built on: gently rolling, 4–18 m. Its amplitude
  // decays as the massif takes over, so the mountain's own profile is not riding on top
  // of a second, unrelated 15 m of noise — without this the true summit ends up wherever
  // the shelf noise happens to peak rather than where SUMMIT says it is.
  const shelfWeight = 1 - smoothstep(6, 42, mountain);
  const shelf = (4 + (fbm(x * 0.0072 + 2.1, z * 0.0072 + 9.4, 5) - 0.42) * 26) * shelfWeight;

  // Sea cliffs. This is a *coastal* feature: `coastal` confines it to a slice of the mask
  // near the shore, since a cliff term that stayed switched on inland would silently raise
  // the entire island by its full amplitude.
  //
  // Crucially it is not applied to the whole coastline. A cliff everywhere means a
  // shoreline you can never walk down to — the ring of unwalkable ground that made v2's
  // first draft an island you could only see the sea from, never stand beside it. So the
  // amplitude is modulated by `cliffiness`, an angular field that is high on the exposed
  // capes and low in the sheltered south-west, and the rise is spread over a wider band so
  // that even the cliffiest stretch stays under MAX_WALKABLE_SLOPE at the top.
  const coastal = smoothstep(0.015, 0.26, mask) * (1 - smoothstep(0.24, 0.52, mask));
  const ang2 = Math.atan2(z, x);
  const cliffiness = clamp(fbm(Math.cos(ang2) * 1.8 + 41.2, Math.sin(ang2) * 1.8 + 13.9, 3) * 2.1 - 0.5, 0, 1);
  const shelterSouthBay = 1 - smoothstep(150, 60, Math.hypot(x - 16, z - 240));
  const shelterNorthBay = 1 - smoothstep(130, 50, Math.hypot(x + 36, z + 244));
  const shelterBeach = 1 - smoothstep(130, 46, Math.hypot(x + 166, z - 146));
  const cliff = coastal * 22 * cliffiness * shelterSouthBay * shelterNorthBay * shelterBeach;

  // Fine surface detail, kept small so the walkable slope stays comfortable.
  const detail = (fbm(x * 0.042 + 17.0, z * 0.042 + 31.0, 3) - 0.5) * 2.6;

  return inland * (shelf + cliff + mountain) + detail * inland + mask * 2.5;
}

/**
 * Natural terrain with the gathering pads terraced into it, but *before* the paths are
 * cut. This is the surface the path profiles are surveyed against, and it exists as its
 * own function for exactly that reason — see {@link heightAt} for why the order is what
 * it is.
 */
function paddedHeight(x: number, z: number): number {
  let h = naturalHeight(x, z);
  for (const pad of PADS) {
    const dx = x - pad.x;
    const dz = z - pad.z;
    const dSq = dx * dx + dz * dz;
    if (dSq > pad.outer * pad.outer) continue;
    const w = 1 - smoothstep(pad.inner, pad.outer, Math.sqrt(dSq));
    h = lerp(h, pad.height, w);
  }
  return h;
}

/**
 * Ground height at a world position, metres. **The** definition of the island's surface.
 *
 * Order of operations: natural terrain → gathering pads → path cut.
 *
 * The pads come first so that a path crossing a terrace is surveyed against the *flat*
 * plaza, not against the hillside underneath it. Cutting the paths first (as v1 did) and
 * letting the pads win afterwards produced a specific, ugly failure: a lane arriving at
 * the summit court was graded gently up the mountain, and then the summit pad's own blend
 * ring added its 30-odd degrees back on top of that gradient, so the last ten metres of
 * every ascent were steeper than the mountain it was meant to make climbable.
 *
 * The trade-off is that a path now cuts a shallow groove across the very edge of a
 * terrace instead of vanishing into it. That is both invisible at `carve` ≈ 0.95 and
 * what a real road cut does anyway.
 */
export function heightAt(x: number, z: number): number {
  const h = paddedHeight(x, z);

  // Cut the paths in to their designed grade (see the profile section above). Between
  // `halfWidth` and `halfWidth + shoulder` the cut blends back to the surrounding ground,
  // which is what forms the embankment on the downhill side and the cutting on the uphill.
  const hit = nearestPath(x, z);
  if (!hit.path) return h;
  const w = 1 - smoothstep(hit.path.halfWidth, hit.path.halfWidth + hit.path.shoulder, hit.dist);
  return lerp(h, profileHeight(hit.path, hit.s), w * hit.path.carve);
}

/**
 * Surface normal, by central difference. Used for character alignment, for scattering
 * props only on gentle slopes, and for the "is this walkable" test.
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
 * Deepest water a character may stand in, metres below sea level.
 *
 * Exported because **the client must use this exact number**. See {@link isWalkable}.
 */
export const MAX_WADE_DEPTH = 0.9;

/**
 * Whether a position is somewhere a player may legitimately be.
 *
 * ### This is a contract, not a server-side opinion
 *
 * The server calls this on every reported transform and snaps the client back whenever it
 * returns false. That makes it the single definition of where a player may be, and the
 * client's movement code has to enforce *the same* rule — as a hard constraint, not as a
 * soft nudge that lets the player drift somewhere illegal and then pushes them back.
 *
 * Getting that wrong does not look like a validation disagreement. It looks like the
 * player being **teleported at random while running**, because every frame the client
 * spends outside the contract earns a correction. Three separate versions of this bug
 * shipped at once: the client waded to 1.25 m where the server allowed 0.9; the client let
 * a player stand on a too-steep face and slide off it while the server rejected the first
 * frame; and the client's slide impulse was applied *after* its speed clamp, so sliding
 * could exceed the server's speed budget.
 *
 * If this function changes, `local-player.ts` changes with it, and
 * `world-smoke`'s walkability-contract check is what catches it if it does not.
 *
 * It is intentionally forgiving about *height* (the client owns its own jump arc) and
 * strict about *place*: you may not be in deep water, off the map, or on a cliff face.
 */
export function isWalkable(x: number, z: number): boolean {
  if (Math.abs(x) > ISLAND_EXTENT || Math.abs(z) > ISLAND_EXTENT) return false;
  const h = heightAt(x, z);
  // Standing in shallow water at the shoreline is fine and looks good; deep water is not.
  if (h < -MAX_WADE_DEPTH) return false;
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
  const plaza = padById('plaza')!;
  return [plaza.x, plaza.z];
}
