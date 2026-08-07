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
      object = createLandmark(landmark.kind, landmark.opts as Record<string, unknown> | undefined);
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
      object.position.set(landmark.x, 0, landmark.z);
    } else if (FOLLOWS_GROUND.has(landmark.kind)) {
      object.position.set(landmark.x, heightAt(landmark.x, landmark.z), landmark.z);
    } else {
      this.groundBuilding(object, landmark);
    }

    this.prepareForRendering(object);
    return object;
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
    const bounds = new THREE.Box3().setFromObject(object);
    const halfW = Math.max(0.4, (bounds.max.x - bounds.min.x) * 0.5 * FOUNDATION_FRACTION);
    const halfD = Math.max(0.4, (bounds.max.z - bounds.min.z) * 0.5 * FOUNDATION_FRACTION);

    const cos = Math.cos(landmark.rot);
    const sin = Math.sin(landmark.rot);
    let lowest = Infinity;
    let highest = -Infinity;
    for (const [ox, oz] of CORNER_OFFSETS) {
      const x = landmark.x + ox * halfW * cos - oz * halfD * sin;
      const z = landmark.z + ox * halfW * sin + oz * halfD * cos;
      const h = heightAt(x, z);
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
