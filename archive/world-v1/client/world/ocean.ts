/**
 * The sea.
 * ========
 *
 * The island is surrounded by water on every side, so the ocean is not set dressing —
 * it is roughly half of every frame. It has to do three things well and cheaply:
 *
 * 1. **Read as deep offshore and shallow at the shore.** A single flat blue plane makes
 *    an island look like it was pasted onto a bathroom tile.
 * 2. **Produce foam exactly where land meets water**, following every inlet and cape,
 *    without anyone hand-painting a coastline.
 * 3. **Move**, gently, without costing a vertex shader pass over a million triangles.
 *
 * The trick that makes all three affordable is a **bathymetry texture**: a small
 * (256²) single-channel image baked on the CPU from the same `heightAt` field the land
 * uses. The shader samples it to know the sea floor depth under any point, which gives
 * shallow-water colour and shoreline foam for the price of one texture fetch, and
 * guarantees the foam follows the real coastline because it is derived from it.
 *
 * Geometry is a **polar grid** with cubic radial spacing: dense where the player is and
 * where waves are visible, sparse out at the horizon where nothing is happening. A
 * uniform grid of the same visual quality would be about forty times the vertex count.
 */

import * as THREE from 'three';
import { ISLAND_EXTENT, OCEAN_RADIUS, SCENE_COLORS, heightAt } from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';

/** Resolution of the baked bathymetry texture. 256² covers the island at ~2 m per texel. */
const BATHY_RES = 256;

/** Area covered by the bathymetry bake, metres from origin. Slightly past the terrain. */
const BATHY_EXTENT = ISLAND_EXTENT + 40;

/**
 * Bake sea-floor depth into a red-channel texture.
 *
 * Stored value is `depth / 24` clamped to [0,1] — 0 at the waterline, 1 at 24 m and
 * deeper. The shallow band is where all the interesting shading happens, so the encoding
 * spends its precision there rather than on the abyss.
 */
function bakeBathymetry(): THREE.DataTexture {
  const data = new Uint8Array(BATHY_RES * BATHY_RES);
  const step = (BATHY_EXTENT * 2) / (BATHY_RES - 1);
  for (let j = 0; j < BATHY_RES; j++) {
    const z = -BATHY_EXTENT + j * step;
    for (let i = 0; i < BATHY_RES; i++) {
      const x = -BATHY_EXTENT + i * step;
      const depth = Math.max(0, -heightAt(x, z));
      data[j * BATHY_RES + i] = Math.min(255, Math.round((depth / 24) * 255));
    }
  }
  const tex = new THREE.DataTexture(data, BATHY_RES, BATHY_RES, THREE.RedFormat);
  tex.needsUpdate = true;
  // Linear filtering is essential: nearest sampling would produce a visibly stepped
  // foam line, which is precisely the artefact this texture exists to avoid.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Build the polar sea surface.
 *
 * `rings` control radial detail, `sectors` angular detail. Radius follows `t³` so the
 * first third of the rings covers the first ~100 m — the water you actually stand next
 * to — and the last few rings stretch out to the horizon.
 */
function buildOceanGeometry(rings: number, sectors: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Centre vertex, so the disc has no hole under the player when they are at the origin.
  positions.push(0, 0, 0);
  uvs.push(0.5, 0.5);

  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    const radius = OCEAN_RADIUS * t * t * t;
    for (let s = 0; s < sectors; s++) {
      const a = (s / sectors) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      positions.push(x, 0, z);
      // UVs map world space onto the bathymetry texture; outside its extent the clamp
      // gives deep water, which is correct.
      uvs.push((x + BATHY_EXTENT) / (BATHY_EXTENT * 2), (z + BATHY_EXTENT) / (BATHY_EXTENT * 2));
    }
  }

  // Fan from the centre to ring 1.
  for (let s = 0; s < sectors; s++) {
    const a = 1 + s;
    const b = 1 + ((s + 1) % sectors);
    indices.push(0, a, b);
  }
  // Quads between successive rings.
  for (let r = 0; r < rings - 1; r++) {
    const base = 1 + r * sectors;
    const next = base + sectors;
    for (let s = 0; s < sectors; s++) {
      const s2 = (s + 1) % sectors;
      indices.push(base + s, next + s, base + s2);
      indices.push(base + s2, next + s, next + s2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uWaveEnabled;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying float vWave;

  /**
   * Two crossed sine trains at different scales and speeds. Not a Gerstner solver —
   * at this camera distance the difference is invisible and the cost is not.
   */
  float waveHeight(vec2 p, float t) {
    float w = sin(p.x * 0.055 + t * 0.9) * 0.34;
    w += sin(p.y * 0.041 - t * 0.7) * 0.28;
    w += sin((p.x + p.y) * 0.017 + t * 0.45) * 0.5;
    return w;
  }

  void main() {
    vUv = uv;
    vec3 pos = position;

    // Waves are damped with distance so the horizon stays a clean flat line — a
    // rippling horizon reads as a bug, not as sea.
    float dist = length(pos.xz);
    float damp = 1.0 - smoothstep(120.0, 900.0, dist);

    vWave = waveHeight(pos.xz, uTime) * damp * uWaveEnabled;
    pos.y += vWave;

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uBathymetry;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uTime;
  uniform float uNight;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying float vWave;

  void main() {
    // Depth, 0 at the waterline → 1 at 24 m. Outside the baked area the clamp returns
    // the edge texel, which is deep ocean.
    float depth = texture2D(uBathymetry, vUv).r;

    // Base colour: a fast ramp from shallow to deep, so the turquoise shelf hugs the
    // shore rather than washing across the whole bay.
    vec3 color = mix(uShallow, uDeep, smoothstep(0.02, 0.34, depth));

    // Shoreline foam. Two bands: a hard one right at the waterline and a soft one just
    // outside it, modulated by a travelling wave so the surf breathes instead of sitting
    // as a static outline.
    float surge = sin(uTime * 1.6 + vWorldPos.x * 0.06 + vWorldPos.z * 0.05) * 0.5 + 0.5;
    float edge = 1.0 - smoothstep(0.0, 0.055 + surge * 0.03, depth);
    float wash = (1.0 - smoothstep(0.0, 0.16, depth)) * 0.35 * surge;
    float foam = clamp(edge + wash, 0.0, 1.0);
    color = mix(color, uFoam, foam * 0.9);

    // Wave crests catch the light; troughs go a shade deeper. Cheap specular substitute
    // that suits the flat, illustrative look far better than a real highlight would.
    color += vWave * 0.06;

    // Night tint, driven by the day cycle.
    color = mix(color, color * vec3(0.34, 0.42, 0.62), uNight);

    // Match the scene's exponential-squared fog so the sea and the land dissolve into
    // the same haze at the same rate.
    float d = length(vWorldPos - cameraPosition);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
    color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

/**
 * The sea surface. Owns its geometry, shader and the baked bathymetry, and exposes a
 * single `update` for the frame loop.
 */
export class Ocean {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly bathymetry: THREE.DataTexture;

  constructor(quality: QualitySettings) {
    this.bathymetry = bakeBathymetry();

    // Tessellation scales with tier; even `low` keeps enough rings for a believable
    // shoreline, because the shoreline is the part anyone looks at.
    const rings = quality.tier === 'low' ? 48 : quality.tier === 'medium' ? 72 : 96;
    const sectors = quality.tier === 'low' ? 64 : 128;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uWaveEnabled: { value: quality.animatedWater ? 1 : 0 },
        uBathymetry: { value: this.bathymetry },
        uShallow: { value: new THREE.Color(SCENE_COLORS.waterShallow) },
        uDeep: { value: new THREE.Color(SCENE_COLORS.waterDeep) },
        uFoam: { value: new THREE.Color(SCENE_COLORS.waterFoam) },
        uFogColor: { value: new THREE.Color(SCENE_COLORS.fog) },
        uFogDensity: { value: 0.0016 },
        uNight: { value: 0 },
      },
    });

    this.mesh = new THREE.Mesh(buildOceanGeometry(rings, sectors), this.material);
    this.mesh.name = 'ocean';
    // The sea never casts or receives shadows: it would cost a second shadow-map pass
    // over an enormous surface for an effect nobody would be able to name.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Drawn early, so the opaque island overdraws it rather than the reverse.
    this.mesh.renderOrder = -1;
    // Its bounding sphere spans the horizon, so frustum culling can only ever produce
    // a wrong answer here.
    this.mesh.frustumCulled = false;
  }

  /** Advance the wave animation. `night` is 0 at midday, 1 after dusk. */
  update(elapsed: number, night: number): void {
    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uNight.value = night;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.bathymetry.dispose();
  }
}
