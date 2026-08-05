/**
 * Vegetation and rock scattering.
 * ===============================
 *
 * The island's density — the thing that makes it feel like a place rather than a
 * diagram — comes from thousands of small props: pines on the headlands, bamboo in the
 * gullies, maples around the shrine, grass tufts along the promenade, rocks at the
 * waterline.
 *
 * Two constraints shape the whole design:
 *
 * 1. **It must be one draw call per variant per material.** Thousands of individual
 *    meshes would be thousands of draw calls. Everything here ends up in
 *    `THREE.InstancedMesh`.
 *
 * 2. **It must be deterministic.** Every client scatters the island *independently* —
 *    scatter data is never networked, because sending 4 000 transforms to every visitor
 *    would dwarf the entire rest of the protocol. So the placement must be a pure
 *    function of a fixed seed, and every player must get the same tree in the same spot.
 *    Any `Math.random()` in this file would silently give each player a different island.
 *
 * Placement itself is **rejection sampling against the terrain field**: propose a point,
 * ask the height field whether it is plausible (right altitude band, gentle enough
 * slope, not on the promenade, not inside a gathering pad), and keep it if so. This is
 * how vegetation ends up respecting a plaza that was moved 20 m without anyone editing
 * a scatter map.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  ISLAND_EXTENT,
  PADS,
  PROMENADE_HALF_WIDTH,
  ZONES,
  heightAt,
  promenadeDistance,
  slopeAt,
} from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';
import { bambooClump, grassTuft, mapleTree, pineTree, rock, shrub } from './props/index.js';

/** Master seed. Changing it re-rolls the entire island's vegetation. */
const SCATTER_SEED = 0x5eed1a;

/** Deterministic PRNG. Same sequence on every device, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One kind of scattered thing, and the rules for where it may stand. */
interface ScatterSpecies {
  readonly id: string;
  /** Builds one visual variant. `seed` varies the shape between variants. */
  readonly build: (seed: number) => THREE.Group;
  /** Number of distinct variants to generate. More variants, less obvious repetition. */
  readonly variants: number;
  /** Target instance count at `scatterDensity === 1`. */
  readonly count: number;
  /** Permitted altitude band, metres. */
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Steepest ground it will grow on, radians. */
  readonly maxSlope: number;
  /** Clearance kept from the promenade centre line, metres. 0 means "may grow on it". */
  readonly pathClearance: number;
  /** Clearance kept from the flat gathering pads. Keeps plazas and stages clear. */
  readonly padClearance: number;
  /** Random scale range. */
  readonly scale: readonly [number, number];
  /** Whether instances cast shadows. Grass does not — it would cost more than it shows. */
  readonly castShadow: boolean;
  /**
   * Bias placement toward a zone, if set. Maples cluster at the shrine, not because a
   * rule says so but because that is where maples look right.
   */
  readonly favorZone?: string;
  readonly favorStrength?: number;
}

/**
 * The island's flora.
 *
 * Counts are tuned so `high` totals roughly 6 000 instances across ~20 InstancedMeshes.
 * That is dense enough that the eye stops counting individual trees, which is the point
 * at which a world starts to feel real.
 */
const SPECIES: readonly ScatterSpecies[] = [
  {
    id: 'pine',
    build: pineTree,
    variants: 5,
    count: 900,
    minHeight: 2.5,
    maxHeight: 62,
    maxSlope: 0.62,
    pathClearance: 5.5,
    padClearance: 4,
    scale: [0.8, 1.45],
    castShadow: true,
  },
  {
    id: 'maple',
    build: mapleTree,
    variants: 4,
    count: 260,
    minHeight: 6,
    maxHeight: 40,
    maxSlope: 0.5,
    pathClearance: 5,
    padClearance: 3,
    scale: [0.85, 1.3],
    castShadow: true,
    favorZone: 'shrine',
    favorStrength: 0.55,
  },
  {
    id: 'bamboo',
    build: bambooClump,
    variants: 4,
    count: 320,
    minHeight: 8,
    maxHeight: 34,
    maxSlope: 0.45,
    pathClearance: 5,
    padClearance: 4,
    scale: [0.9, 1.35],
    castShadow: true,
    favorZone: 'teahouse',
    favorStrength: 0.4,
  },
  {
    id: 'shrub',
    build: shrub,
    variants: 5,
    count: 1100,
    minHeight: 1.4,
    maxHeight: 56,
    maxSlope: 0.75,
    pathClearance: 3.2,
    padClearance: 2,
    scale: [0.7, 1.4],
    castShadow: false,
  },
  {
    id: 'grass',
    build: grassTuft,
    variants: 4,
    count: 2600,
    minHeight: 1.0,
    maxHeight: 52,
    maxSlope: 0.7,
    // Grass is allowed right up to the paving edge — a hard border between path and
    // ground is one of the surest signs of a generated world.
    pathClearance: 0,
    padClearance: 1,
    scale: [0.6, 1.5],
    castShadow: false,
  },
  {
    id: 'rock',
    build: rock,
    variants: 6,
    count: 700,
    // Rocks are the one species allowed below the waterline: they break up the surf line.
    minHeight: -1.6,
    maxHeight: 60,
    maxSlope: 1.2,
    pathClearance: 4,
    padClearance: 3,
    scale: [0.5, 2.2],
    castShadow: true,
  },
] as const;

/** A single accepted placement. */
interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  variant: number;
}

/**
 * Whether a species may stand at a point.
 *
 * Ordered cheapest-test-first: the height lookup is the expensive one, so bail out on
 * the trivially disqualifying cases before paying for it.
 */
function accepts(species: ScatterSpecies, x: number, z: number): number | null {
  // Pads: keep gathering places and their approaches clear.
  if (species.padClearance > 0) {
    for (const pad of PADS) {
      if (Math.hypot(x - pad.x, z - pad.z) < pad.inner + species.padClearance) return null;
    }
  }

  if (species.pathClearance > 0) {
    const { dist } = promenadeDistance(x, z);
    if (dist < PROMENADE_HALF_WIDTH + species.pathClearance) return null;
  }

  const y = heightAt(x, z);
  if (y < species.minHeight || y > species.maxHeight) return null;
  if (slopeAt(x, z) > species.maxSlope) return null;

  return y;
}

/**
 * Generate placements for one species.
 *
 * Rejection sampling with a bounded attempt budget: if the terrain simply has nowhere
 * left that satisfies the rules, we place fewer rather than looping forever. The budget
 * is generous (30× the target) because early rejections are cheap.
 */
function placeSpecies(species: ScatterSpecies, target: number, rand: () => number): Placement[] {
  const out: Placement[] = [];
  const maxAttempts = target * 30;
  const favored = species.favorZone ? ZONES.find((z) => z.id === species.favorZone) : undefined;

  for (let attempt = 0; attempt < maxAttempts && out.length < target; attempt++) {
    let x: number;
    let z: number;

    // A fraction of the instances are drawn from a disc around the favoured zone; the
    // rest are uniform over the island.
    if (favored && rand() < (species.favorStrength ?? 0)) {
      const a = rand() * Math.PI * 2;
      // sqrt gives a uniform area distribution rather than a centre-heavy one.
      const r = Math.sqrt(rand()) * favored.radius * 1.6;
      x = favored.x + Math.cos(a) * r;
      z = favored.z + Math.sin(a) * r;
    } else {
      x = (rand() * 2 - 1) * ISLAND_EXTENT;
      z = (rand() * 2 - 1) * ISLAND_EXTENT;
    }

    const y = accepts(species, x, z);
    if (y === null) continue;

    out.push({
      x,
      y,
      z,
      yaw: rand() * Math.PI * 2,
      scale: species.scale[0] + rand() * (species.scale[1] - species.scale[0]),
      variant: Math.floor(rand() * species.variants),
    });
  }
  return out;
}

/**
 * Collapse a built variant `Group` into one merged geometry per material.
 *
 * Prop builders return readable hierarchies of small meshes; instancing needs the
 * opposite. This flattens the hierarchy, bakes each mesh's local transform into its
 * vertices, and merges everything sharing a material — which is why the material library
 * caches so aggressively, since shared material *identity* is what makes the merge
 * effective.
 */
function flattenToInstanceable(group: THREE.Group): Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  group.updateMatrixWorld(true);

  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const material = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const geo = obj.geometry.clone();
    geo.applyMatrix4(obj.matrixWorld);
    // Merging requires identical attribute sets; drop anything exotic a builder added.
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    }
    if (!geo.attributes.uv) {
      // mergeGeometries refuses a mixed set, so give UV-less geometry a zero channel.
      const count = geo.attributes.position.count;
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    const list = byMaterial.get(material);
    if (list) list.push(geo);
    else byMaterial.set(material, [geo]);
  });

  const result: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> = [];
  for (const [material, geos] of byMaterial) {
    const merged = geos.length === 1 ? geos[0] : BufferGeometryUtils.mergeGeometries(geos, false);
    if (merged) result.push({ geometry: merged, material });
    geos.forEach((g) => {
      if (g !== merged) g.dispose();
    });
  }
  return result;
}

/**
 * The scattered layer of the island.
 *
 * Built once at load time; after that it is static geometry that costs nothing per frame
 * beyond its draw calls.
 */
export class Scatter {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];

  /** Total instances placed, for the load report and the debug readout. */
  instanceCount = 0;

  constructor(quality: QualitySettings) {
    this.group.name = 'scatter';
    const rand = mulberry32(SCATTER_SEED);
    const dummy = new THREE.Object3D();

    for (const species of SPECIES) {
      const target = Math.round(species.count * quality.scatterDensity);
      if (target <= 0) continue;

      const placements = placeSpecies(species, target, rand);
      if (placements.length === 0) continue;
      this.instanceCount += placements.length;

      // Bucket placements by variant so each variant becomes its own InstancedMesh.
      const buckets: Placement[][] = Array.from({ length: species.variants }, () => []);
      for (const p of placements) buckets[p.variant % species.variants].push(p);

      for (let v = 0; v < species.variants; v++) {
        const bucket = buckets[v];
        if (bucket.length === 0) continue;

        // Variant shape is seeded from the species id and variant index, so it is stable
        // across sessions and independent of how many instances were placed.
        const variantSeed = (hashString(species.id) ^ (v * 0x9e3779b1)) >>> 0;
        const proto = species.build(variantSeed);
        const parts = flattenToInstanceable(proto);
        // The prototype was only ever a template; release its clones' source meshes.
        disposeGroup(proto);

        for (const part of parts) {
          const inst = new THREE.InstancedMesh(part.geometry, part.material, bucket.length);
          inst.name = `${species.id}-${v}`;
          inst.castShadow = species.castShadow;
          inst.receiveShadow = true;
          // Instances never move, so the matrix buffer is uploaded once.
          inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);

          for (let i = 0; i < bucket.length; i++) {
            const p = bucket[i];
            dummy.position.set(p.x, p.y, p.z);
            dummy.rotation.set(0, p.yaw, 0);
            dummy.scale.setScalar(p.scale);
            dummy.updateMatrix();
            inst.setMatrixAt(i, dummy.matrix);
          }
          inst.instanceMatrix.needsUpdate = true;
          // Instances are spread across the whole island, so the automatic bounding
          // sphere (computed from the source geometry) would be wrong and cull the mesh
          // as soon as the player walks away from wherever the prototype sat.
          inst.computeBoundingSphere();
          inst.frustumCulled = false;

          this.meshes.push(inst);
          this.group.add(inst);
        }
      }
    }
  }

  /** Number of InstancedMesh draw calls this layer contributes. */
  get drawCalls(): number {
    return this.meshes.length;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.dispose();
    }
    this.meshes.length = 0;
    this.group.clear();
  }
}

/** FNV-1a over a string, for stable per-species seeds. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Dispose every geometry under a group. Materials are shared and must NOT be disposed. */
export function disposeGroup(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
}
