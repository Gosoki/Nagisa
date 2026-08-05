/**
 * Ground scatter.
 * ===============
 *
 * Places the small, repeated detail that keeps a hillside from reading as a painted
 * surface: boulders on the high slopes and along the shore, grass tufts on the gentle
 * ground, and driftwood at the tide line.
 *
 * ### No trees, deliberately
 *
 * This pass of the world puts its effort into terrain and architecture, and plants
 * nothing. That is a real constraint on the art direction rather than an omission: with no
 * canopy to hide behind, the hillsides have to be read by their *contours* and their
 * colour banding, which is why the terrain colourer patches two greens at a scale the eye
 * reads as brushwork and why the massif has spurs rather than being a smooth cone.
 * Vegetation slots back in here without touching anything else when it is wanted.
 *
 * ### Why instancing, and why a rejection sampler
 *
 * Everything here is an `InstancedMesh`: tens of thousands of objects at one draw call per
 * species. The alternative — individual meshes — would cost more draw calls than the rest
 * of the island put together.
 *
 * Placement is **rejection sampling against the analytic terrain field**, not a hand-made
 * list: propose a point, ask the terrain whether it qualifies (right altitude, right
 * slope, not on a path, not on a terrace, not underwater), keep it or throw it away. That
 * means the scatter follows the terrain automatically when the terrain changes, and it
 * means the rules are readable as rules ("boulders live on steep ground above the tide")
 * rather than as coordinates.
 *
 * Every random draw comes from a seeded `mulberry32`, never `Math.random`, so two players
 * looking at the same hillside see the same rocks.
 */

import * as THREE from 'three';
import {
  ISLAND_EXTENT,
  PADS,
  heightAt,
  nearestPath,
  slopeAt,
} from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';
import { inkDepthMaterial } from '../engine/ink/ink-material.js';
import { boulder } from './props/kit.js';
import { grassTuft } from './props/furniture.js';
import { mulberry32, randRange } from './props/geometry.js';
import { rockFace, wood } from './materials.js';

/**
 * Placement rules for one kind of scattered object.
 *
 * Reading a species top to bottom should tell you where it grows without looking at any
 * code: "boulders, from the tide line to the summit, on ground steeper than 15°, keeping
 * 3 m clear of any path".
 */
interface Species {
  readonly id: string;
  /** Relative share of the total instance budget. */
  readonly weight: number;
  /** Altitude band, metres. */
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Slope band, radians. */
  readonly minSlope: number;
  readonly maxSlope: number;
  /** How far from the centreline of any path this must stay, metres. */
  readonly pathClearance: number;
  /** Whether it may sit inside a terrace's flat area. */
  readonly allowOnPads: boolean;
  /** Scale range applied per instance. */
  readonly scale: readonly [number, number];
  /** Build one unit of this species. The result is instanced, so it is built once. */
  readonly build: (seed: number) => THREE.Mesh;
}

const SPECIES: readonly Species[] = [
  {
    id: 'grass',
    weight: 0.62,
    minHeight: 1.6,
    maxHeight: 74,
    minSlope: 0,
    maxSlope: 0.62,
    pathClearance: 2.6,
    allowOnPads: false,
    scale: [0.7, 1.5],
    build: (seed) => grassTuft(seed, 1),
  },
  {
    id: 'boulder',
    weight: 0.26,
    minHeight: -0.4,
    maxHeight: 88,
    minSlope: 0.26,
    maxSlope: 1.3,
    pathClearance: 3.4,
    allowOnPads: false,
    scale: [0.5, 1.9],
    build: (seed) => boulder(0.8, rockFace(), seed),
  },
  {
    id: 'shore-rock',
    weight: 0.08,
    minHeight: -0.8,
    maxHeight: 3.2,
    minSlope: 0,
    maxSlope: 0.8,
    pathClearance: 2.0,
    allowOnPads: false,
    scale: [0.35, 1.1],
    build: (seed) => boulder(0.55, rockFace(), seed + 17),
  },
  {
    id: 'driftwood',
    weight: 0.04,
    minHeight: 0.4,
    maxHeight: 3.0,
    minSlope: 0,
    maxSlope: 0.34,
    pathClearance: 1.6,
    allowOnPads: false,
    scale: [0.6, 1.4],
    build: (seed) => {
      // A single bleached log. Built here rather than in the prop library because it
      // exists only as scatter and has no landmark form.
      const rng = mulberry32(seed);
      const geo = new THREE.CylinderGeometry(0.16, 0.2, randRange(rng, 1.6, 3.0), 6, 1, true);
      geo.rotateZ(Math.PI / 2);
      geo.rotateY(rng() * Math.PI);
      geo.translate(0, 0.18, 0);
      const mesh = new THREE.Mesh(geo, wood('weathered'));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    },
  },
] as const;

/** Total instance budget per quality tier. */
const BUDGETS: Record<QualitySettings['tier'], number> = {
  low: 3200,
  medium: 9000,
  high: 20000,
};

/**
 * Whether a proposed point qualifies for a species, and at what height.
 *
 * Returns `null` for a rejection, which the caller counts against its attempt budget. The
 * order of the tests is by cost: cheap arithmetic first, the path index lookup last.
 */
function accept(species: Species, x: number, z: number): { y: number; slope: number } | null {
  const y = heightAt(x, z);
  if (y < species.minHeight || y > species.maxHeight) return null;

  const slope = slopeAt(x, z);
  if (slope < species.minSlope || slope > species.maxSlope) return null;

  if (!species.allowOnPads) {
    for (const pad of PADS) {
      // Terraces are swept ground: a boulder in the middle of the plaza is not scenery, it
      // is an obstacle someone forgot to remove. The clearance covers most of the pad's
      // *blend* as well as its flat centre — a quay's edge is still a quay, and driftwood
      // scattered across it reads as a beach that someone put warehouses on.
      if (Math.hypot(x - pad.x, z - pad.z) < pad.outer * 0.8) return null;
    }
  }

  const hit = nearestPath(x, z);
  if (hit.path && hit.dist < hit.path.halfWidth + species.pathClearance) return null;

  return { y, slope };
}

/** Build statistics, reported to the debug readout. */
export interface ScatterStats {
  instances: number;
  perSpecies: Record<string, number>;
  attempts: number;
}

/**
 * The scattered ground layer. One `InstancedMesh` per species, all under one group.
 */
export class Scatter {
  readonly group = new THREE.Group();
  readonly stats: ScatterStats = { instances: 0, perSpecies: {}, attempts: 0 };

  private readonly meshes: THREE.InstancedMesh[] = [];

  constructor(quality: QualitySettings) {
    this.group.name = 'scatter';
    const budget = BUDGETS[quality.tier];
    const rng = mulberry32(0x5ca77e2);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scaleVec = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const normal = new THREE.Vector3();

    for (const species of SPECIES) {
      const target = Math.round(budget * species.weight);
      if (target <= 0) continue;

      const template = species.build(0x1234);
      const mesh = new THREE.InstancedMesh(template.geometry, template.material, target);
      mesh.name = `scatter:${species.id}`;
      mesh.castShadow = quality.shadows;
      mesh.receiveShadow = quality.shadows;
      // Custom shader materials are invisible to three's shadow pass without this.
      mesh.customDepthMaterial = inkDepthMaterial();
      // The scatter spans the whole island; culling the instanced mesh as a unit can only
      // ever be wrong, and per-instance culling is not something three does.
      mesh.frustumCulled = false;

      let placed = 0;
      // Cap attempts so a species whose rules match nowhere (a typo in a height band)
      // costs a bounded amount of time rather than hanging the loader forever.
      const maxAttempts = target * 12;
      let attempts = 0;

      while (placed < target && attempts < maxAttempts) {
        attempts++;
        const x = (rng() * 2 - 1) * ISLAND_EXTENT;
        const z = (rng() * 2 - 1) * ISLAND_EXTENT;
        const hit = accept(species, x, z);
        if (!hit) continue;

        const scale = randRange(rng, species.scale[0], species.scale[1]);
        position.set(x, hit.y, z);
        scaleVec.setScalar(scale);

        if (species.id === 'grass') {
          // Grass stands up regardless of the ground under it; a tuft tilted with the
          // slope reads as a mistake.
          quaternion.setFromAxisAngle(up, rng() * Math.PI * 2);
        } else {
          // Rock and driftwood lie *on* the slope, so align them to the surface normal
          // and then spin them about it.
          const [nx, ny, nz] = normalFromField(x, z, normal);
          quaternion.setFromUnitVectors(up, normal.set(nx, ny, nz));
          const spin = new THREE.Quaternion().setFromAxisAngle(up, rng() * Math.PI * 2);
          quaternion.multiply(spin);
        }

        matrix.compose(position, quaternion, scaleVec);
        mesh.setMatrixAt(placed, matrix);
        placed++;
      }

      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      this.meshes.push(mesh);
      this.group.add(mesh);

      this.stats.instances += placed;
      this.stats.attempts += attempts;
      this.stats.perSpecies[species.id] = placed;
    }
  }

  /** Total instances placed. */
  get instanceCount(): number {
    return this.stats.instances;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.meshes.length = 0;
    this.group.clear();
  }
}

/** Surface normal from the analytic field, written into `out`. */
function normalFromField(x: number, z: number, out: THREE.Vector3): [number, number, number] {
  const eps = 0.7;
  const nx = heightAt(x - eps, z) - heightAt(x + eps, z);
  const nz = heightAt(x, z - eps) - heightAt(x, z + eps);
  const ny = 2 * eps;
  out.set(nx, ny, nz).normalize();
  return [out.x, out.y, out.z];
}

/**
 * Recursively dispose a group's geometry. Materials are shared and cached in
 * `materials.ts`, so they are deliberately *not* disposed here — see `disposeMaterials`.
 */
export function disposeGroup(group: THREE.Object3D): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  });
  group.clear();
}
