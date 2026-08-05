/**
 * Nagisa terrain field — world model v3.
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
 * ### The island is not in this file
 *
 * Where things *are* — the coast's capes and bays, the terraces, the routes, the buildings —
 * is a {@link MapPack}, and this module reads whichever one is active. See `map/types.ts`
 * for the split and `maps/nagisa-island.ts` for the shipped world. Everything below is the
 * machinery that turns a pack into ground: how a terrace is applied, how a route's grade is
 * surveyed, what counts as walkable. Those are rules, and they are the same on every map.
 *
 * ### The shape of the shipped island
 *
 * ```
 *                     北港 North Harbour  2.4 m
 *                            (0, -74)
 *                         ╱            ╲
 *       灯台岬 Lighthouse                 町並み Old Street  ┐
 *          (-64, -37) 13 m                  (64, -37) 9 m   │ one shelf,
 *              │        ▲ 山頂 Summit          │            │ and the road
 *              │          (0, 0)  26 m         │            │ up the mountain
 *       神社 Shrine                       広場 Main Plaza    ┘
 *          (-64, 37) 11 m                   (64, 37) 8 m
 *                         ╲            ╱
 *                     南港 South Harbour  2.4 m
 *                            (0, 74)
 * ```
 *
 * Six places on a hexagon 74 m to a side, and the summit at the centre. Everything is a
 * few seconds from everything else: the ring road is 493 m, and the climb from the eastern
 * shelf to the summit is 86 m — under ten seconds at a run.
 *
 * The heights say what each place is:
 *
 * - **Two harbours**, north and south, at sea level in their own bays.
 * - **Two high places** — the shrine on its headland and the lighthouse on its cape —
 *   raised above the ring so they read as somewhere you go *up* to.
 * - **Two that adjoin**: the plaza and the old street share one continuous eastern shelf,
 *   with no dip between them, and the main road up the mountain leaves from between them.
 * - **The summit**, highest, in the middle, visible from everywhere.
 *
 * ### What v3 changed from v2 (see `archive/world-v2/`)
 *
 * Scale, and almost nothing else. Every mechanism below — the surveyed path grades, the
 * terraces applied before the paths, the coastline built from a disc plus capes and bays,
 * the segment index — is v2's, and the comments explaining why each is shaped that way were
 * written there. v2's island was 480 m across with a 1 289 m coast road; crossing it took
 * over two minutes. That is a world you explore. This is a world you gather in, so the
 * distances are halved and the layout is a shape you can learn in one visit.
 *
 * Determinism is non-negotiable: every function below uses integer hashing
 * (`Math.imul`, bit ops) and never `Math.random`, `Date`, or transcendental identities
 * that differ across engines. Given the same (x, z), every machine returns the same
 * height, bit for bit.
 *
 * Units are metres. `y = 0` is mean sea level. Negative heights are seabed. `-z` is
 * north, `+x` is east — the three.js convention, kept everywhere in this codebase.
 */

import { onMapChange } from './map/registry.js';
import type { CoastFeature, MapRelief, MapTerrain, Pad, PathSurface, Shelf, Shelter, WorldPath } from './map/types.js';
// Side effect: registers the built-in packs and activates one, so the bindings below are
// populated before any consumer reads them.
import './maps/index.js';

export type { CoastFeature, MapRelief, Pad, PathSurface, Shelf, Shelter, WorldPath };
export { activeMap, activeMapId, getMap, listMaps, onMapChange, registerMap, setActiveMap } from './map/registry.js';
export type { MapPack, MapTerrain, MapWorld } from './map/types.js';

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
// The active map
// ---------------------------------------------------------------------------

/**
 * The pack's data, republished as module bindings.
 *
 * These are `let`, not `const`, and reassigned by the subscriber below when the map changes.
 * ES module bindings are *live*: a consumer that wrote `import { PADS } from '@nagisa/shared'`
 * sees the new array on its very next read, with no subscription of its own and no
 * indirection at the call site. That property is why the decoupling cost the rest of the
 * codebase nothing — the thirteen modules that read this data were not touched.
 *
 * The one rule it imposes: **do not cache these at module scope elsewhere.** `const MY_PADS =
 * PADS` in another file snapshots the old map and silently keeps it. Read them where you use
 * them, or subscribe with {@link onMapChange}.
 */

/** Extent of the terrain grid the client meshes, metres from origin on each axis. */
export let ISLAND_EXTENT = 0;

/** Radius beyond which there is nothing but open water. Used for camera + fog limits. */
export let OCEAN_RADIUS = 0;

/** Summit of the central massif. Every other place is described relative to it. */
export let SUMMIT: MapTerrain['summit'] = { x: 0, z: 0, height: 0 };

/**
 * Terraces, in application order. Later pads win where they overlap, so a small pad may be
 * cut into a larger one (the notice-board terrace sits inside the plaza).
 *
 * `scripts/world-smoke.ts` asserts that `heightAt(pad.x, pad.z) === pad.height`, which is
 * what catches a pad that has drifted off its zone or been swallowed by a later one.
 */
export let PADS: readonly Pad[] = [];

/** Every route on the active map. The first is the spine; branches may pin to it. */
export let PATHS: readonly WorldPath[] = [];

let COAST_RADIUS = 0;
let MASSIF_RADIUS = 1;
let CAPES: readonly CoastFeature[] = [];
let BAYS: readonly CoastFeature[] = [];
let SHELVES: readonly Shelf[] = [];
let RELIEF: MapRelief = { rolling: 0, rollingVariation: 0, cliff: 0, detail: 0 };
let SHELTERS: readonly Shelter[] = [];


// ---------------------------------------------------------------------------
// Island silhouette
// ---------------------------------------------------------------------------

/** Combined shelf contribution at a point. */
function shelfHeight(x: number, z: number): number {
  let total = 0;
  for (const shelf of SHELVES) {
    const d = Math.hypot(x - shelf.x, z - shelf.z);
    if (d >= shelf.reach) continue;
    total += shelf.height * (1 - smoothstep(shelf.reach * 0.35, shelf.reach, d));
  }
  return total;
}

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
  const spurWeight =
    0.2 * smoothstep(MASSIF_RADIUS * 0.11, MASSIF_RADIUS * 0.5, r) * (1 - smoothstep(MASSIF_RADIUS * 0.78, MASSIF_RADIUS, r));
  const shaped = profile * (1 - spurWeight + spurWeight * spur);

  // 3 — rock detail. Amplitude is the budget left over after the cone and the spurs have
  // spent theirs: enough to read as rock, not enough to push any flank past walkable.
  const rough = ridge(x * 0.019 + 5.5, z * 0.019 + 2.2, 4) - 0.42;
  const detailMask = smoothstep(0, 0.3, profile) * (1 - smoothstep(0.86, 1, profile));

  // Rock detail is a fixed share of the peak: a 3 m dune does not get 6 m of crags.
  return SUMMIT.height * (shaped + rough * 0.23 * detailMask);
}

// ---------------------------------------------------------------------------
// Flattened areas
// ---------------------------------------------------------------------------

/** Lookup used by `world.ts` and by spawn placement. */
export function padById(id: string): Pad | undefined {
  return PADS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The coast road, by name, for callers that mean *that* path specifically. */
export let COAST_PATH: WorldPath;

/**
 * Backwards-compatible alias for the v1 name. The half-width of the coast road is what
 * the prop scatterer and the terrain colourer used to key off, and keeping the constant
 * saves touching every call site for a rename that carries no information.
 */
export let PROMENADE_HALF_WIDTH = 0;

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
let PATH_GRID_HALF = 1;
let PATH_GRID_SIZE = 3;

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
export function nearestPath(x: number, z: number, excludeId?: WorldPath['id']): PathHit {
  const segments = segmentsNear(x, z);
  if (!segments) return NO_PATH;

  let best = Infinity;
  let bestPath: WorldPath | null = null;
  let bestS = 0;

  for (const seg of segments) {
    if (excludeId !== undefined && seg.path.id === excludeId) continue;
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

/**
 * How far apart, in profile samples, two points must be before they count as a doubling
 * back rather than as ordinary neighbours. Three samples' worth of road either side.
 */
const SELF_PROXIMITY_MIN_GAP = 6;

/** Never carve a path below this: a coast road at sea level would flood at the shoreline. */
const PATH_MIN_HEIGHT = 1.2;

const pathProfiles = new Map<string, Float64Array>();

/**
 * Routes whose profile is mid-build.
 *
 * Endpoint pinning asks a joined route for its surface height, which builds that route's
 * profile if it has not been built yet. Two routes that ended on each other would recurse
 * for ever; this breaks the cycle by falling back to the bare ground for whichever one
 * asks second. Nothing on the island does that today, and the guard costs a set lookup.
 */
const profilesUnderConstruction = new Set<string>();

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

  // An open route's **ends** are pinned too, whether or not they land on a terrace.
  //
  // A road has to meet whatever it stops at. Without this, a lane with one end on a
  // terrace and the other on open hillside has only one fixed point, and the grade limiter
  // — whose job is to make the profile gentle, not to keep it on the ground — satisfies
  // itself by lifting the free end into the air. The summit road did exactly that: its top
  // pinned at 46 m, its bottom floating thirteen metres above the shelf it starts from,
  // with an 80° wall of terrain where the carve met the hillside.
  //
  // What it stops *at* matters as much as that it stops. A branch leaving the ring road
  // has to meet the **ring road's** surface, not the bare ground underneath it — the ring
  // has already been cut to its own profile there, and pinning to the untouched ground
  // reproduces the same cliff nine metres lower down. So: a terrace if there is one, else
  // the route it joins, else the ground.
  if (!closed) {
    for (const i of [0, count - 1]) {
      if (pinned[i]) continue;
      const { x, z } = pathAt(path.id, i * PROFILE_STEP);
      const junction = nearestPath(x, z, path.id);
      const joinsAnother = junction.path && junction.dist < junction.path.halfWidth + junction.path.shoulder * 0.5;
      profile[i] = Math.max(
        PATH_MIN_HEIGHT,
        joinsAnother && !profilesUnderConstruction.has(junction.path!.id)
          ? profileHeight(junction.path!, junction.s)
          : paddedHeight(x, z),
      );
      pinned[i] = 1;
    }
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

  // 3 — self-proximity. Where a route doubles back on itself — a switchback on a mountain
  // road — two samples that are eighty metres apart *along the road* are fifteen metres
  // apart *on the ground*. Their carve influences overlap, `nearestPath` flips between
  // them from one pixel to the next, and whatever height difference they hold becomes a
  // vertical step in the terrain. A hairpin with a four-metre drop across it does not read
  // as a hairpin; it reads as the road being broken.
  //
  // Real switchbacks answer this by making the turn itself level. So do we: any two
  // samples far apart in arc length but close in space are pulled toward their mean, in
  // proportion to how much their influence regions overlap. Straight road is untouched,
  // because no two distant samples on it are ever close together.
  const influence = (path.halfWidth + path.shoulder) * 2;
  const positions = Array.from({ length: count }, (_, i) => pathAt(path.id, i * PROFILE_STEP));

  const relaxSelfProximity = (): boolean => {
    let moved = false;
    for (let i = 0; i < count; i++) {
      for (let j = i + SELF_PROXIMITY_MIN_GAP; j < count; j++) {
        // On a loop, the two ends are neighbours, not a doubling back.
        if (closed && count - (j - i) < SELF_PROXIMITY_MIN_GAP) continue;
        const d = Math.hypot(positions[i].x - positions[j].x, positions[i].z - positions[j].z);
        if (d >= influence) continue;
        const delta = profile[j] - profile[i];
        if (Math.abs(delta) < 0.01) continue;
        // Full strength when the two are on top of each other, fading to nothing as they
        // separate — so the hairpin's apex flattens and its approaches keep their grade.
        const strength = (1 - d / influence) * 0.5;
        if (pinned[i] && pinned[j]) continue;
        if (pinned[i]) profile[j] -= delta * strength;
        else if (pinned[j]) profile[i] += delta * strength;
        else {
          profile[i] += delta * strength * 0.5;
          profile[j] -= delta * strength * 0.5;
        }
        moved = true;
      }
    }
    return moved;
  };

  // Interleaved with the grade limiter rather than run after it: flattening a hairpin
  // changes the grade of its approaches, and re-grading them changes the hairpin.
  for (let pass = 0; pass < PROFILE_GRADE_PASSES; pass++) {
    let moved = false;
    for (let i = 1; i < count; i++) moved = relax(i - 1, i) || moved;
    for (let i = count - 2; i >= 0; i--) moved = relax(i, i + 1) || moved;
    if (closed) moved = relax(count - 1, 0) || moved;
    moved = relaxSelfProximity() || moved;
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
    profilesUnderConstruction.add(path.id);
    profile = buildProfile(path);
    profilesUnderConstruction.delete(path.id);
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

  // The rolling coastal ground everything is built on. Its amplitude decays as the massif
  // takes over, so the mountain's own profile is not riding on top of a second, unrelated
  // band of noise — without this the true summit ends up wherever the noise happens to
  // peak rather than where SUMMIT says it is.
  // Thresholds are fractions of the peak, not metres: "the massif has taken over" happens
  // at a fifth of the way up whatever the summit height is.
  const rollingWeight = 1 - smoothstep(SUMMIT.height * 0.19, SUMMIT.height * 1.08, mountain);
  const rolling =
    (RELIEF.rolling + (fbm(x * 0.013 + 2.1, z * 0.013 + 9.4, 5) - 0.42) * RELIEF.rollingVariation) * rollingWeight;

  // Named landform: the eastern shelf and the two western headlands. See SHELVES.
  const shelf = rolling + shelfHeight(x, z) * rollingWeight;

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
  // Which shores stay gentle is the pack's business — these used to be three hard-coded
  // circles around Nagisa Island's own harbours, which is fine right up until the code is
  // asked about a different island.
  let sheltered = 1;
  for (const s of SHELTERS) {
    sheltered *= 1 - smoothstep(s.reach, s.reach * 0.4, Math.hypot(x - s.x, z - s.z));
  }
  const cliff = coastal * RELIEF.cliff * cliffiness * sheltered;

  // Fine surface detail, kept small so the walkable slope stays comfortable.
  const detail = (fbm(x * 0.062 + 17.0, z * 0.062 + 31.0, 3) - 0.5) * RELIEF.detail;

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

// ---------------------------------------------------------------------------
// Binding to the active map
// ---------------------------------------------------------------------------

/**
 * Rebind to a pack and drop everything derived from the previous one.
 *
 * The caches cleared here are not optional niceties — a stale path profile would put the
 * road at the old map's heights, and a stale segment index would report a route that is not
 * there — so this runs synchronously inside `setActiveMap`, before it returns to its caller.
 *
 * **This subscription is the last statement in the file, and must stay there.**
 * {@link onMapChange} invokes its listener immediately when a map is already active, and
 * every binding and cache it touches is declared above. Registering it any earlier reaches
 * them in the temporal dead zone, and the failure is a `TypeError` at import time.
 */
onMapChange((pack) => {

  const t = pack.terrain;
  ISLAND_EXTENT = t.extent;
  OCEAN_RADIUS = t.oceanRadius;
  SUMMIT = t.summit;
  PADS = t.pads;
  PATHS = t.paths;
  COAST_RADIUS = t.coastRadius;
  MASSIF_RADIUS = t.massifRadius;
  CAPES = t.capes;
  BAYS = t.bays;
  SHELVES = t.shelves;
  RELIEF = t.relief;
  SHELTERS = t.shelters;

  COAST_PATH = t.paths[0];
  PROMENADE_HALF_WIDTH = COAST_PATH?.halfWidth ?? 0;

  // The segment index is sized from the map's extent, so its dimensions move too.
  PATH_GRID_HALF = Math.ceil((ISLAND_EXTENT + PATH_CELL) / PATH_CELL);
  PATH_GRID_SIZE = PATH_GRID_HALF * 2 + 1;
  pathGrid = null;
  pathLengths.clear();
  pathProfiles.clear();
  profilesUnderConstruction.clear();
});
