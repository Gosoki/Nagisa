/**
 * The island.
 * ===========
 *
 * Assembles everything that is *not* a player: the terrain mesh, the sea, the sky, the
 * hand-placed landmarks, the scattered vegetation and the promenade's lanterns.
 *
 * ### Build order matters
 * The terrain is meshed in a worker first, because it is the long pole and because the
 * loading screen's progress is dominated by it. Landmarks and scatter follow on the main
 * thread in small batches, yielding between them, so the browser stays responsive and
 * the loader keeps animating instead of freezing at 60%.
 *
 * ### Culling
 * Landmarks are grouped into **zone buckets**. Each bucket has a bounding sphere and is
 * shown or hidden as a unit based on distance to the camera. This is coarser than
 * per-object frustum culling but very much cheaper: one distance test hides the entire
 * harbour when you are up at the lighthouse, rather than Three.js testing forty objects
 * every frame. Three's own frustum culling still runs on whatever remains visible.
 */

import * as THREE from 'three';
import {
  LANDMARKS,
  PROMENADE_HALF_WIDTH,
  ZONES,
  heightAt,
  promenadeAt,
  promenadeLength,
  type Landmark,
  type ZoneId,
} from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';
import { terrainMaterial } from './materials.js';
import { Ocean } from './ocean.js';
import { Sky } from './sky.js';
import { Scatter, disposeGroup } from './scatter.js';
import { createLandmark, stoneLantern } from './props/index.js';
import { buildTerrain, type TerrainBuildResult } from './terrain.worker.js';

/** Progress callback used to drive the loading screen. */
export type ProgressFn = (value: number, label: string) => void;

/**
 * A group of props that is shown or hidden together.
 *
 * Buckets are keyed by zone because zones are how the island is organised spatially and
 * semantically — the harbour's props are all near each other by definition.
 */
interface Bucket {
  zone: ZoneId | 'promenade';
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
  buildStats = { terrainMs: 0, landmarks: 0, scatterInstances: 0, drawCalls: 0 };

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

    onProgress(0.75, 'Hanging the lanterns');
    await this.buildPromenadeLanterns();

    onProgress(0.85, 'Planting the hillsides');
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
    const request = { resolution: this.quality.terrainResolution };
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
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geometry.computeBoundingSphere();

    this.terrainMesh = new THREE.Mesh(geometry, terrainMaterial());
    this.terrainMesh.name = 'terrain';
    this.terrainMesh.receiveShadow = this.quality.shadows;
    // The terrain does not cast: it would double the shadow-map cost to produce
    // self-shadowing that the toon ramp mostly hides anyway.
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
      // Yield every eight props so the loader can paint. Building forty buildings in one
      // synchronous burst freezes the tab for long enough to be noticed.
      if (built % 8 === 0) await nextFrame();
    }

    this.buildStats.landmarks = built;
    for (const [zone, group] of byZone) this.registerBucket(zone as ZoneId, group);
  }

  /** Build one landmark and place it on the terrain. */
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
    // Props are authored with their origin at the base centre, so dropping them onto the
    // terrain is a single height lookup.
    object.position.set(landmark.x, heightAt(landmark.x, landmark.z), landmark.z);
    object.rotation.y = landmark.rot;
    if (landmark.scale && landmark.scale !== 1) object.scale.setScalar(landmark.scale);

    if (this.quality.shadows) {
      object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
    }
    return object;
  }

  /**
   * Line the promenade with stone lanterns.
   *
   * Placed by arc length rather than by hand, so the spacing stays even however the path
   * is re-routed. They alternate sides, which reads as intentional without needing a
   * second row.
   */
  private async buildPromenadeLanterns(): Promise<void> {
    const group = new THREE.Group();
    group.name = 'promenade-lanterns';

    const total = promenadeLength();
    const spacing = this.quality.tier === 'low' ? 46 : 28;
    const count = Math.floor(total / spacing);

    for (let i = 0; i < count; i++) {
      const s = i * spacing;
      const { x, z, tx, tz } = promenadeAt(s);
      // Offset perpendicular to the path, alternating sides.
      const side = i % 2 === 0 ? 1 : -1;
      const offset = PROMENADE_HALF_WIDTH + 1.1;
      const px = x - tz * offset * side;
      const pz = z + tx * offset * side;

      // Promenade lanterns are deliberately identical — a matched run of tōrō along a
      // path is the real-world convention, and variation here would read as sloppiness.
      const lantern = stoneLantern();
      lantern.position.set(px, heightAt(px, pz), pz);
      lantern.rotation.y = Math.atan2(tx, tz);
      lantern.scale.setScalar(0.8);
      if (this.quality.shadows) {
        lantern.traverse((child) => {
          if (child instanceof THREE.Mesh) child.castShadow = true;
        });
      }
      group.add(lantern);

      if (i % 12 === 0) await nextFrame();
    }

    this.group.add(group);
    this.registerBucket('promenade', group);
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
  private registerBucket(zone: ZoneId | 'promenade', group: THREE.Group): void {
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
    this.buckets.push({ zone, group, center, radius });
  }

  /**
   * Show or hide prop buckets by distance.
   *
   * The promenade bucket is exempt: its lanterns run the whole way round the island, so
   * its bounding sphere covers everything and a distance test on it is meaningless.
   */
  updateCulling(cameraPosition: THREE.Vector3): void {
    const limit = this.quality.drawDistance;
    for (const bucket of this.buckets) {
      if (bucket.zone === 'promenade') continue;
      const distance = bucket.center.distanceTo(cameraPosition) - bucket.radius;
      const visible = distance < limit;
      if (bucket.group.visible !== visible) bucket.group.visible = visible;
    }
  }

  /** Per-frame update for the animated parts of the island. */
  update(elapsed: number, serverTime: number, focus: THREE.Vector3): void {
    this.sky.update(serverTime, focus);
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
      this.lampCache = this.group.getObjectByName('lighthouse-main')?.getObjectByName('lamp') ?? null;
    }
    if (this.lampCache) this.lampCache.rotation.y = elapsed * 0.55;
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
    if (zone.id === 'promenade') continue;
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
