/**
 * The island.
 * ===========
 *
 * Assembles everything that is *not* a player: the terrain mesh, the sea, the sky, the
 * hand-placed landmarks, the roadside lanterns and the scattered ground detail.
 *
 * ### Build order matters
 *
 * The terrain is meshed in a worker first, because it is the long pole and because the
 * loading screen's progress is dominated by it. Landmarks and scatter follow on the main
 * thread in small batches, yielding between them, so the browser stays responsive and the
 * loader keeps animating instead of freezing at 60%.
 *
 * ### Placing a landmark
 *
 * Almost every prop is dropped at `heightAt(x, z)` — the terrain field is the single
 * source of truth for where the ground is, so nothing is ever hand-placed in Y. The
 * exception is the **waterfront kinds** (piers, boats, breakwaters and the two sea torii),
 * which are placed at `y = 0` instead: those props are authored with their piles and hulls
 * running well below their origin, so they meet the seabed at whatever depth the
 * bathymetry happens to be. Dropping a pier at terrain height would bury it.
 *
 * ### Culling
 *
 * Landmarks are grouped into **zone buckets**. Each bucket has a bounding sphere and is
 * shown or hidden as a unit based on distance to the camera. This is coarser than
 * per-object frustum culling but very much cheaper: one distance test hides the entire
 * south harbour when you are up at the lighthouse, rather than three.js testing forty
 * objects every frame. Three's own frustum culling still runs on whatever remains visible.
 */

import * as THREE from 'three';
import {
  LANDMARKS,
  ZONES,
  activeMapId,
  heightAt,
  roadsideLanterns,
  type Landmark,
  type LandmarkKind,
  type ZoneId,
} from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';
import { inkDepthMaterial } from '../engine/ink/ink-material.js';
import { stone, terrainMaterial } from './materials.js';
import { Ocean } from './ocean.js';
import { BREAKWATER_BED_SAMPLES, PIER_DECK_HEIGHT, PIER_PILE_DEPTH, TORII_SUBMERGED } from './props/structures.js';
import { WAVE_AMPLITUDE, seaSurfaceAt } from './waves.js';
import { Sky } from './sky.js';
import { Scatter, disposeGroup } from './scatter.js';
import { createLandmark, postLantern, stoneLantern } from './props/index.js';
import { buildTerrain, type TerrainBuildResult } from './terrain.worker.js';

/** Progress callback used to drive the loading screen. */
export type ProgressFn = (value: number, label: string) => void;

/** Footprint corners plus the centre, in units of half-width/half-depth. */
const CORNER_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
  [0, 0],
] as const;

/**
 * Landmark kinds that float on the water rather than standing on the ground. See the
 * module header for why they are placed differently.
 */
const WATERFRONT_KINDS: ReadonlySet<LandmarkKind> = new Set<LandmarkKind>(['pier', 'boat', 'breakwater']);

/**
 * Kinds that are *meant* to follow the ground rather than sit level on it — a railing
 * along a clifftop, a boulder, a flight of steps. These skip the levelling below.
 */
const FOLLOWS_GROUND: ReadonlySet<LandmarkKind> = new Set<LandmarkKind>(['rock', 'steps', 'rail', 'sea-wall']);

/**
 * Fraction of a prop's bounding box that is actually load-bearing.
 *
 * A Japanese roof overhangs its walls by a metre or more, so the bounding box of a
 * building is considerably wider than the ground it stands on. Sampling the terrain at the
 * *bounding box* corners would find the hillside a metre beyond the wall and dig a
 * foundation for it.
 */
const FOUNDATION_FRACTION = 0.62;

/** Ground variation below this is inside what a prop's own plinth already covers. */
const FOUNDATION_EPSILON = 0.12;

/** How many points along a run are fitted to place it. Enough to see a curve, cheap enough. */
const RUN_SAMPLES = 9;

/** Reused axes and scratch for `layAlongGround`; allocating per landmark is needless. */
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const PITCH = new THREE.Quaternion();

/**
 * A group of props that is shown or hidden together.
 *
 * Buckets are keyed by zone because zones are how the island is organised spatially and
 * semantically — the harbour's props are all near each other by definition.
 */
interface Bucket {
  zone: ZoneId | 'roadside';
  group: THREE.Group;
  center: THREE.Vector3;
  radius: number;
}

/**
 * Half the hull, for the two slope samples that tilt a boat. The fleet is 7 m by 2.2 m and
 * the ferry half again as big; one set of numbers for all of them is right, because this is
 * asking "how much does the sea tip under something boat-sized", not measuring a specific
 * hull.
 */
const BOAT_HALF_LENGTH = 3.5;
const BOAT_HALF_BEAM = 1.1;

/**
 * Height of a pier's deck: the quay it starts from, or a freeboard clear of the crests when
 * it starts over open water.
 *
 * Both the placement and the pile length are derived from this, which is why it is a function
 * and not two copies of the same `Math.max`. The two copies were written first, and they are
 * the reason this file already carries three separate notes about numbers that must not be
 * kept in two places.
 */
function pierDeckY(landmark: Landmark): number {
  return Math.max(heightAt(landmark.x, landmark.z), WAVE_AMPLITUDE, PIER_DECK_HEIGHT);
}

/**
 * Fit a waterfront prop to the water it actually stands in.
 *
 * Three props, one idea: a pier's piles, a breakwater's toe and a sea torii's pillars all have
 * to reach the seabed, and none of their generators can know where that is. It is a property
 * of where the prop stands, not of what the prop is — and a constant is wrong on an island
 * whose shelf falls from −1 m to −22 m inside sixteen metres. So the terrain is sampled here,
 * once, and the measurement handed down. Everything else passes straight through.
 *
 * The result is a plain option bag rather than a `Landmark['opts']`: that type is *authored
 * map data* and is scalars by design, while what comes out of here is measured — a whole
 * sampled profile, in one case. Widening the authored type to admit it would let a map file
 * declare a seabed, which is not a thing a map file gets to have an opinion about.
 */
function fittedOpts(landmark: Landmark): Record<string, unknown> | undefined {
  if (landmark.kind === 'breakwater') {
    // A breakwater is centred on its origin and runs both ways along local z, unlike a pier,
    // which starts at its origin. Sampling the wrong span puts the toe under the wrong half.
    const length = numberOpt(landmark.opts, 'length', 50) * (landmark.scale ?? 1);
    const fx = Math.sin(landmark.rot);
    const fz = Math.cos(landmark.rot);
    const origin = Math.max(0, heightAt(landmark.x, landmark.z));
    const bed: number[] = [];
    for (let i = 0; i < BREAKWATER_BED_SAMPLES; i++) {
      const t = -length / 2 + (i / (BREAKWATER_BED_SAMPLES - 1)) * length;
      bed.push((heightAt(landmark.x + fx * t, landmark.z + fz * t) - origin) / (landmark.scale ?? 1));
    }
    return { ...landmark.opts, bed };
  }
  if (landmark.opts?.inWater === true && landmark.kind === 'torii') {
    // Same idea a third time: a sea torii's pillars should end in the seabed, not at a depth
    // that happened to suit the one place a sea torii used to stand. Moving the south gate out
    // past the pier put it over 25 m of water with 8 m legs.
    const depth = -heightAt(landmark.x, landmark.z) + 1;
    return { ...landmark.opts, submerged: Math.max(TORII_SUBMERGED, depth) / (landmark.scale ?? 1) };
  }
  if (landmark.kind !== 'pier') return landmark.opts;
  const length = numberOpt(landmark.opts, 'length', 36) * (landmark.scale ?? 1);
  const deckHeight = numberOpt(landmark.opts, 'deckHeight', PIER_DECK_HEIGHT);
  const deck = pierDeckY(landmark);
  const fx = Math.sin(landmark.rot);
  const fz = Math.cos(landmark.rot);
  let deepest = Infinity;
  for (let t = 0; t <= length; t += 2) {
    deepest = Math.min(deepest, heightAt(landmark.x + fx * t, landmark.z + fz * t));
  }
  // A metre into the seabed, so the pile is planted rather than resting on it.
  const needed = deck - deepest + 1;
  return { ...landmark.opts, pileDepth: Math.max(PIER_PILE_DEPTH, needed) / (landmark.scale ?? 1), deckHeight };
}

/** Read a numeric landmark option, falling back when it is absent or not a number. */
function numberOpt(opts: Landmark['opts'], key: string, fallback: number): number {
  const value = opts?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export class Island {
  readonly group = new THREE.Group();
  readonly ocean: Ocean;
  readonly sky: Sky;

  private terrainMesh: THREE.Mesh | null = null;
  private scatter: Scatter | null = null;
  private readonly buckets: Bucket[] = [];

  /** Statistics reported to the debug readout after the build. */
  buildStats = { terrainMs: 0, landmarks: 0, scatterInstances: 0, roadsideProps: 0 };

  constructor(private readonly quality: QualitySettings) {
    this.group.name = 'island';
    this.sky = new Sky(quality);
    this.ocean = new Ocean(quality);
    this.group.add(this.sky.group);
    this.group.add(this.ocean.mesh);
  }

  /**
   * Build the island. Resolves when it is ready to be walked on.
   *
   * Deliberately sequential with explicit yields: parallelism here would not make it
   * faster (it is all one main thread plus one worker) and would make progress reporting
   * meaningless.
   */
  async build(onProgress: ProgressFn): Promise<void> {
    onProgress(0.05, 'Shaping the coastline');
    const terrain = await this.buildTerrainMesh();
    this.buildStats.terrainMs = terrain.elapsedMs;

    onProgress(0.55, 'Raising the buildings');
    // Any cached lookup into the previous build's scene graph is now pointing at meshes that
    // are about to be replaced. Cheap to drop, expensive to notice: a stale entry animates an
    // object nothing is drawing, and the thing you are looking at never moves.
    this.boats = null;
    this.lampCache = undefined;
    await this.buildLandmarks();

    onProgress(0.8, 'Hanging the lanterns');
    await this.buildRoadside();

    onProgress(0.9, 'Settling the ground');
    await this.buildScatter();

    onProgress(1, 'Ready');
  }

  // -------------------------------------------------------------------------
  // Terrain
  // -------------------------------------------------------------------------

  /**
   * Mesh the height field, in a worker when one is available.
   *
   * The synchronous fallback is not dead code: some embedded WebViews and strict CSP
   * environments block module workers, and an island that will not load at all is a far
   * worse outcome than one that hitches for 400 ms while it builds.
   */
  private async buildTerrainMesh(): Promise<TerrainBuildResult> {
    // The map id travels with the request. A worker is a separate module graph and resolves
    // its own default, so without this it meshes whichever island `maps/index.ts` activates
    // rather than the one the rest of the client is simulating. See `TerrainBuildRequest`.
    const request = { resolution: this.quality.terrainResolution, mapId: activeMapId() ?? undefined };
    let result: TerrainBuildResult;

    if (typeof Worker === 'function') {
      try {
        result = await new Promise<TerrainBuildResult>((resolve, reject) => {
          const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
          const timeout = setTimeout(() => {
            worker.terminate();
            reject(new Error('terrain worker timed out'));
          }, 30_000);
          worker.onmessage = (e: MessageEvent) => {
            clearTimeout(timeout);
            worker.terminate();
            if ((e.data as { error?: string }).error) reject(new Error((e.data as { error: string }).error));
            else resolve(e.data as TerrainBuildResult);
          };
          worker.onerror = (e) => {
            clearTimeout(timeout);
            worker.terminate();
            reject(new Error(e.message || 'terrain worker failed'));
          };
          worker.postMessage(request);
        });
      } catch (err) {
        console.warn('[island] worker meshing failed, building on the main thread', err);
        result = buildTerrain(request);
      }
    } else {
      result = buildTerrain(request);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(result.colors, 3));
    // Which ground each vertex is, so the contour pass can draw the boundaries between
    // them — the shoreline, the edge of a lane, the rim of a terrace. See SURFACE_BAND.
    geometry.setAttribute('aSurface', new THREE.BufferAttribute(result.bands, 4));
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geometry.computeBoundingSphere();

    this.terrainMesh = new THREE.Mesh(geometry, terrainMaterial());
    this.terrainMesh.name = 'terrain';
    this.terrainMesh.receiveShadow = this.quality.shadows;
    // The terrain does not cast: it would double the shadow-map cost to produce
    // self-shadowing that the flat shading mostly hides anyway.
    this.terrainMesh.castShadow = false;
    // One mesh spanning the whole island — culling it can only ever be wrong.
    this.terrainMesh.frustumCulled = false;
    this.group.add(this.terrainMesh);

    return result;
  }

  // -------------------------------------------------------------------------
  // Landmarks
  // -------------------------------------------------------------------------

  /** Instantiate every hand-placed landmark, bucketed by nearest zone. */
  private async buildLandmarks(): Promise<void> {
    const byZone = new Map<string, THREE.Group>();

    let built = 0;
    for (const landmark of LANDMARKS) {
      const object = this.instantiate(landmark);
      if (!object) continue;

      const zone = nearestZone(landmark.x, landmark.z);
      let bucket = byZone.get(zone);
      if (!bucket) {
        bucket = new THREE.Group();
        bucket.name = `landmarks:${zone}`;
        byZone.set(zone, bucket);
        this.group.add(bucket);
      }
      bucket.add(object);

      built++;
      // Yield every eight props so the loader can paint. Building a hundred buildings in
      // one synchronous burst freezes the tab for long enough to be noticed.
      if (built % 8 === 0) await nextFrame();
    }

    this.buildStats.landmarks = built;
    for (const [zone, group] of byZone) this.registerBucket(zone as ZoneId, group);
  }

  /** Build one landmark and place it on the terrain (or on the water). */
  private instantiate(landmark: Landmark): THREE.Object3D | null {
    let object: THREE.Group;
    try {
      object = createLandmark(landmark.kind, fittedOpts(landmark));
    } catch (err) {
      // A broken prop generator must cost one building, not the whole island.
      console.error(`[island] failed to build landmark ${landmark.id} (${landmark.kind})`, err);
      return null;
    }

    object.name = landmark.id;
    object.rotation.y = landmark.rot;
    if (landmark.scale && landmark.scale !== 1) object.scale.setScalar(landmark.scale);

    const floats = WATERFRONT_KINDS.has(landmark.kind) || landmark.opts?.inWater === true;
    if (floats) {
      // Sea level *or the ground, whichever is higher*.
      //
      // These are authored with their piles and hulls running below the origin so they meet
      // the seabed at whatever depth is under them, and y = 0 is right as long as there is
      // water there. The harbour terraces hold the ground at 2.4 m out to thirty-four metres
      // from their centres — well past the old shoreline — so "there is water there" stopped
      // being true: `sh-pier-west` had all thirty-seven of its samples on 2.4 m of quay, and
      // was drawn 2.4 m underneath it with only its bollard caps showing.
      //
      // A pier's origin is its landward end — but what has to meet the quay is its *deck*,
      // which stands `PIER_DECK_HEIGHT` above that origin. Placing the origin on the quay put
      // the planks 1.9 m above the ground they start from, on every pier on both maps: you
      // walked to the harbour and the pier began at chest height. So the deck height is
      // subtracted, and the deck lands exactly on the quay.
      //
      // Over open water there is no quay to match, and the deck instead wants a freeboard —
      // enough that a crest does not wash over it. `WAVE_AMPLITUDE` is that number by
      // definition, with the old 1.9 m as the floor so nothing got lower than it already was.
      if (landmark.kind === 'pier') {
        const deckHeight = numberOpt(landmark.opts, 'deckHeight', PIER_DECK_HEIGHT);
        object.position.set(landmark.x, pierDeckY(landmark) - deckHeight, landmark.z);
      } else {
        object.position.set(landmark.x, Math.max(0, heightAt(landmark.x, landmark.z)), landmark.z);
      }
    } else if (FOLLOWS_GROUND.has(landmark.kind)) {
      this.layAlongGround(object, landmark);
    } else {
      this.groundBuilding(object, landmark);
    }

    this.prepareForRendering(object);
    return object;
  }

  /**
   * Lay a long, rigid prop along the ground rather than on one sample of it.
   *
   * A railing, a sea wall and a flight of steps are all built running along their own local
   * **z**, and they were all placed from a single `heightAt` at their origin and then drawn
   * rigid and level. That is fine on the flat and wrong everywhere else: the north harbour's
   * 14 m sea wall spans 1.56 m of ground, so it floated 0.87 m in the air at one end and was
   * buried 0.69 m at the other.
   *
   * So: sample both ends, sit the middle at their mean, and pitch the run to match. A
   * railing following a slope is exactly what a railing does, and it is far closer to right
   * for a wall than hanging in the air is.
   *
   * The pitch is composed as a quaternion — yaw, then pitch about the **local** x — rather
   * than by setting two Euler angles, because the result of combining those depends on the
   * Euler order and the intent here is unambiguous.
   *
   * Props with no length (a boulder) get no pitch. They sit at the *lowest* sample under
   * them, so they read as set into the ground rather than perched on it.
   */
  private layAlongGround(object: THREE.Object3D, landmark: Landmark): void {
    const length = typeof landmark.opts?.length === 'number' ? landmark.opts.length : 0;
    const scale = landmark.scale ?? 1;
    const span = length * scale;

    // Point-like: a boulder. Sample its own footprint and take the **mean**.
    //
    // Not the lowest — on the summit's slope that is 1.4 m of ground under a two-metre rock,
    // and placing it at the bottom of that swallows it whole. Not the origin either, which is
    // what left it perched with daylight under one side. The mean splits the difference, and
    // a blob is irregular enough to absorb what is left.
    if (span < 1) {
      const bounds = new THREE.Box3().setFromObject(object);
      const rx = Math.max(0.4, (bounds.max.x - bounds.min.x) * 0.35);
      const rz = Math.max(0.4, (bounds.max.z - bounds.min.z) * 0.35);
      let sum = 0;
      for (const [ox, oz] of CORNER_OFFSETS) sum += heightAt(landmark.x + ox * rx, landmark.z + oz * rz);
      object.position.set(landmark.x, sum / CORNER_OFFSETS.length, landmark.z);
      return;
    }

    // A run: a railing, a sea wall, a flight of steps. All are built along their own local
    // **z** and drawn rigid, and all were placed from a single `heightAt` at their origin —
    // fine on the flat and wrong everywhere else. The north harbour's 14 m sea wall spans
    // 1.56 m of ground, so it hung 0.87 m in the air at one end and was buried 0.69 m at the
    // other.
    //
    // Fit a line to the ground along the run, then drop it until nothing is left in the air.
    // Least squares gives the pitch that follows the slope; the drop is what makes "no gap
    // underneath" true rather than approximately true, and it costs only a little burial on
    // ground that is convex along the run.
    const tx = Math.sin(landmark.rot);
    const tz = Math.cos(landmark.rot);
    const half = span / 2;
    const samples: Array<[number, number]> = [];
    for (let i = 0; i < RUN_SAMPLES; i++) {
      const t = -half + (i / (RUN_SAMPLES - 1)) * span;
      samples.push([t, heightAt(landmark.x + tx * t, landmark.z + tz * t)]);
    }
    let sumT = 0;
    let sumH = 0;
    let sumTT = 0;
    let sumTH = 0;
    for (const [t, h] of samples) {
      sumT += t;
      sumH += h;
      sumTT += t * t;
      sumTH += t * h;
    }
    const n = samples.length;
    const denom = n * sumTT - sumT * sumT;
    const slope = denom === 0 ? 0 : (n * sumTH - sumT * sumH) / denom;
    let intercept = (sumH - slope * sumT) / n;
    let highest = 0;
    for (const [t, h] of samples) highest = Math.max(highest, intercept + slope * t - h);
    intercept -= highest;

    object.position.set(landmark.x, intercept, landmark.z);
    // Rotating about local +x by φ moves the +z end down, so the sign is negative to raise
    // the far end when the ground rises toward it. Composed as a quaternion — yaw, then pitch
    // about the *local* x — rather than as two Euler angles, whose combined effect depends on
    // the Euler order while the intent here does not.
    object.quaternion
      .setFromAxisAngle(UP, landmark.rot)
      .multiply(PITCH.setFromAxisAngle(RIGHT, -Math.atan(slope)));
  }

  /**
   * Sit a building on the ground with no gap under any corner.
   *
   * A prop is a rigid body placed at **one** height sample, so the moment its footprint
   * spans ground that is not level, one corner is in the air and the opposite one is
   * buried. Placing it at the *lowest* corner buries most of it; placing it at the mean
   * does both at once. So: place it at the **highest** corner — nothing is ever swallowed
   * — and fill what that leaves underneath with a foundation.
   *
   * The foundation is a plain block sized to the footprint and reaching from the placement
   * height down past the lowest corner. It is invisible on level ground, where it is
   * shorter than the prop's own plinth, and on a slight slope it reads as exactly what a
   * building on a slight slope actually has.
   *
   * This is a backstop, not a licence. Landmarks are still expected to be on level ground —
   * `tools/flatness.mjs` measures it and `world-smoke` fails the build over it — because a
   * foundation deep enough to hide a real slope is a retaining wall, and a village of
   * buildings on retaining walls looks like a village that was placed by a script.
   */
  private groundBuilding(object: THREE.Object3D, landmark: Landmark): void {
    // Measure the footprint **unrotated**.
    //
    // `setFromObject` returns an axis-aligned box in world axes, so taking it after the yaw
    // has been applied measures the box that *circumscribes* the turned building: the harbour
    // office's 12 × 12 m footprint came out 16.4 × 16.4 m. Those inflated half-extents were
    // then rotated a second time, as if they had been local all along.
    const yaw = object.rotation.y;
    object.rotation.y = 0;
    object.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(object);
    object.rotation.y = yaw;
    object.updateMatrixWorld(true);

    const halfW = Math.max(0.4, (bounds.max.x - bounds.min.x) * 0.5 * FOUNDATION_FRACTION);
    const halfD = Math.max(0.4, (bounds.max.z - bounds.min.z) * 0.5 * FOUNDATION_FRACTION);

    // Local → world for a `rotation.y` of θ is (x·cos + z·sin, −x·sin + z·cos). This had the
    // signs the other way round, which is a rotation by −θ: the sampled box was the
    // building's footprint mirrored, and for the shrine hall at −69° it read the ground
    // 16.6 m from the corner it was meant to represent. `terrain.rebuildSolids` has the same
    // transform written correctly, and the two disagreed silently because nothing compares
    // them. Verified against `THREE.Object3D` itself rather than derived on paper.
    const cos = Math.cos(landmark.rot);
    const sin = Math.sin(landmark.rot);
    let lowest = Infinity;
    let highest = -Infinity;
    for (const [ox, oz] of CORNER_OFFSETS) {
      const lx = ox * halfW;
      const lz = oz * halfD;
      const h = heightAt(landmark.x + lx * cos + lz * sin, landmark.z - lx * sin + lz * cos);
      if (h < lowest) lowest = h;
      if (h > highest) highest = h;
    }

    object.position.set(landmark.x, highest, landmark.z);

    const drop = highest - lowest;
    if (drop <= FOUNDATION_EPSILON) return;

    // Built in the object's local space, so it inherits the rotation and scale already
    // applied above and needs no trigonometry of its own.
    const scale = object.scale.x || 1;
    const depth = (drop + 0.25) / scale;
    const foundation = new THREE.Mesh(
      new THREE.BoxGeometry((halfW * 2) / scale, depth, (halfD * 2) / scale),
      stone('dark'),
    );
    foundation.name = 'foundation';
    foundation.position.y = -depth / 2;
    foundation.castShadow = false;
    foundation.receiveShadow = true;
    object.add(foundation);
  }

  /**
   * Give every mesh in a prop what the renderer needs from it.
   *
   * `customDepthMaterial` is the important one: the ink materials are custom
   * `ShaderMaterial`s, and three cannot render an arbitrary shader into a shadow map. One
   * shared depth material assigned here is what makes the whole island cast shadows.
   */
  private prepareForRendering(object: THREE.Object3D): void {
    const depth = inkDepthMaterial();
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (this.quality.shadows) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.customDepthMaterial = depth;
      }
    });
  }

  /**
   * Line the roads with lanterns.
   *
   * Placed by arc length rather than by hand, so the spacing stays even however a road is
   * re-routed. The coast road gets stone tōrō — a matched run of them is the real-world
   * convention and variation there would read as sloppiness — while the three inland lanes
   * get timber post lanterns, which are what a working lane would actually have.
   *
   * ### Where the positions come from
   *
   * `roadsideLanterns` in `@nagisa/shared`, not from here. Choosing the spots means asking
   * what else is on the ground — and once it has to consult the world, it belongs beside the
   * world, where `npm run audit:placement` can test the function itself rather than a copy of
   * it. See that function for the four lanterns that used to stand inside buildings.
   *
   * What is left here is the part that is genuinely the renderer's: which mesh, how big, and
   * yielding to the frame every so often so the loading screen keeps moving.
   */
  private async buildRoadside(): Promise<void> {
    const group = new THREE.Group();
    group.name = 'roadside';

    const spacing = this.quality.tier === 'low' ? 34 : 21;
    const lanterns = roadsideLanterns(spacing);

    for (let i = 0; i < lanterns.length; i++) {
      const lamp = lanterns[i]!;
      const prop = lamp.kind === 'stone' ? stoneLantern({ height: 2.1 }) : postLantern({ height: 3.0 });
      prop.position.set(lamp.x, heightAt(lamp.x, lamp.z), lamp.z);
      prop.rotation.y = lamp.yaw;
      if (lamp.kind === 'stone') prop.scale.setScalar(0.85);
      this.prepareForRendering(prop);
      group.add(prop);

      if ((i + 1) % 12 === 0) await nextFrame();
    }

    this.buildStats.roadsideProps = lanterns.length;
    this.group.add(group);
    this.registerBucket('roadside', group);
  }

  // -------------------------------------------------------------------------
  // Scatter
  // -------------------------------------------------------------------------

  private async buildScatter(): Promise<void> {
    // One frame's grace so the loader repaints before the scatter's long synchronous
    // placement pass begins.
    await nextFrame();
    this.scatter = new Scatter(this.quality);
    this.buildStats.scatterInstances = this.scatter.instanceCount;
    this.group.add(this.scatter.group);
  }

  // -------------------------------------------------------------------------
  // Culling
  // -------------------------------------------------------------------------

  /** Compute a bucket's bounds once, at build time. */
  private registerBucket(zone: ZoneId | 'roadside', group: THREE.Group): void {
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
    this.buckets.push({ zone, group, center, radius });
  }

  /**
   * Show or hide prop buckets by distance.
   *
   * The roadside bucket is exempt: its lanterns run the whole way round the island, so its
   * bounding sphere covers everything and a distance test on it is meaningless.
   */
  updateCulling(cameraPosition: THREE.Vector3): void {
    const limit = this.quality.drawDistance;
    for (const bucket of this.buckets) {
      if (bucket.zone === 'roadside') continue;
      const distance = bucket.center.distanceTo(cameraPosition) - bucket.radius;
      const visible = distance < limit;
      if (bucket.group.visible !== visible) bucket.group.visible = visible;
    }
  }

  /** Per-frame update for the animated parts of the island. */
  update(elapsed: number, serverTime: number, focus: THREE.Vector3, dt = 0): void {
    this.sky.update(serverTime, focus, dt);
    this.ocean.update(elapsed, this.sky.current.night);
    this.updateCulling(focus);
    this.animateLighthouse(elapsed);
    this.floatBoats(elapsed);
  }

  /**
   * Let the boats ride the sea instead of being nailed to mean sea level.
   *
   * Every floating landmark was placed once, at `y = max(0, ground)`, and never touched
   * again. The sea is not at 0 though — it swings through ±{@link WAVE_AMPLITUDE} as the
   * crests pass — so a hull pinned to 0 spends a good part of every cycle *inside* the water,
   * which is precisely what a player reported: the boats are sometimes swallowed whole, and
   * all of them do it.
   *
   * Raising them by a metre would trade a boat that sinks for a boat that hovers. Riding the
   * surface is the actual answer, and it costs one sine evaluation per boat per frame for a
   * harbour that moves.
   *
   * The tilt comes from sampling the surface a couple of metres fore and abeam and taking the
   * slope between, rather than from an analytic gradient: it is the same arithmetic, it stays
   * correct if the trains ever change, and sampling at the hull's own scale gives the boat the
   * *average* slope under it rather than the one at a point, which is what a hull does.
   */
  private boats: Array<{ object: THREE.Object3D; baseY: number; yaw: number }> | null = null;

  private floatBoats(elapsed: number): void {
    if (!this.quality.animatedWater) return;
    if (this.boats === null) {
      this.boats = [];
      for (const landmark of LANDMARKS) {
        if (landmark.kind !== 'boat') continue;
        const object = this.group.getObjectByName(landmark.id);
        if (object) this.boats.push({ object, baseY: object.position.y, yaw: landmark.rot });
      }
    }
    for (const boat of this.boats) {
      const { x, z } = boat.object.position;
      const cos = Math.cos(boat.yaw);
      const sin = Math.sin(boat.yaw);
      // A yaw of θ sends the hull's local +z to world (sin θ, cos θ) and its local +x to
      // world (cos θ, −sin θ). Sample the surface at the ends of both axes.
      const bowward = seaSurfaceAt(x + sin * BOAT_HALF_LENGTH, z + cos * BOAT_HALF_LENGTH, elapsed);
      const sternward = seaSurfaceAt(x - sin * BOAT_HALF_LENGTH, z - cos * BOAT_HALF_LENGTH, elapsed);
      const xPlus = seaSurfaceAt(x + cos * BOAT_HALF_BEAM, z - sin * BOAT_HALF_BEAM, elapsed);
      const xMinus = seaSurfaceAt(x - cos * BOAT_HALF_BEAM, z + sin * BOAT_HALF_BEAM, elapsed);

      boat.object.position.y = boat.baseY + seaSurfaceAt(x, z, elapsed);
      // 'YXZ': heading first, then pitch about the turned x, then roll about the twice-turned
      // z — which is the order that makes both angles mean what their names say.
      //
      // Signs, because they are easy to get backwards and invisible when wrong: a positive
      // rotation about +x carries +z *downward*, so a bow on higher water wants a negative
      // pitch. A positive rotation about +z carries +x *upward*, so higher water to local +x
      // wants a positive roll.
      boat.object.rotation.set(
        Math.atan2(sternward - bowward, BOAT_HALF_LENGTH * 2),
        boat.yaw,
        Math.atan2(xPlus - xMinus, BOAT_HALF_BEAM * 2),
        'YXZ',
      );
    }
  }

  /**
   * Rotate the lighthouse lamp.
   *
   * Cached by name on first use: `getObjectByName` walks the whole scene graph, which is
   * not something to do sixty times a second for one mesh.
   */
  private lampCache: THREE.Object3D | null | undefined;
  private animateLighthouse(elapsed: number): void {
    if (this.lampCache === undefined) {
      this.lampCache = this.group.getObjectByName('lh-tower')?.getObjectByName('lamp') ?? null;
    }
    if (this.lampCache) this.lampCache.rotation.y = elapsed * 0.5;
  }

  dispose(): void {
    this.ocean.dispose();
    this.sky.dispose();
    this.scatter?.dispose();
    if (this.terrainMesh) this.terrainMesh.geometry.dispose();
    for (const bucket of this.buckets) disposeGroup(bucket.group);
    this.group.clear();
  }
}

/** Nearest zone anchor to a point, used to bucket landmarks. */
function nearestZone(x: number, z: number): ZoneId {
  let best: ZoneId = 'plaza';
  let bestDistance = Infinity;
  for (const zone of ZONES) {
    if (zone.id === 'coast') continue; // The fallback zone has no meaningful anchor.
    const d = Math.hypot(x - zone.x, z - zone.z);
    if (d < bestDistance) {
      bestDistance = d;
      best = zone.id;
    }
  }
  return best;
}

/** Yield to the browser for one frame. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
