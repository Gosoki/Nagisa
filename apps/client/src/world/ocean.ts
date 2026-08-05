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
 *
 * ### Why the sea draws its own lines
 *
 * The screen-space contour pass (`engine/ink/ink-pass.ts`) is told to ignore water: the
 * sea writes 0 into the outline mask. Left switched on it would trace the entire
 * coastline as a single hard cut-out edge, which reads as a sticker rather than as a
 * shore. What a person drawing this would put down instead is a *foam line* that thickens
 * in the shallows and a scatter of short horizontal wave strokes — so the shader draws
 * those itself, at the exact contours of the bathymetry, where they belong.
 */

import * as THREE from 'three';
import { ISLAND_EXTENT, OCEAN_RADIUS, SCENE_COLORS, heightAt } from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';
import { DEPTH_CODEC, NORMAL_CODEC, PAPER_NOISE } from '../engine/ink/glsl.js';
import { inkLighting } from '../engine/ink/ink-material.js';

/** Resolution of the baked bathymetry texture. 256² covers the island at ~2 m per texel. */
const BATHY_RES = 256;

/**
 * Area covered by the bathymetry bake, metres from origin. Slightly past the terrain.
 *
 * A function, not a constant, because `ISLAND_EXTENT` is a live binding that changes with
 * the active map. Captured at module scope it would freeze whichever map happened to be
 * active when this file was first imported — which is always the *default* one, since
 * imports are evaluated before any code gets to choose. The result on a smaller map is a
 * bathymetry texture stretched over the wrong area, so the foam line sits offshore.
 */
function bathyExtent(): number {
  return ISLAND_EXTENT + 40;
}

/**
 * Bake sea-floor depth into a red-channel texture.
 *
 * Stored value is `depth / 24` clamped to [0,1] — 0 at the waterline, 1 at 24 m and
 * deeper. The shallow band is where all the interesting shading happens, so the encoding
 * spends its precision there rather than on the abyss.
 */
function bakeBathymetry(): THREE.DataTexture {
  const extent = bathyExtent();
  const data = new Uint8Array(BATHY_RES * BATHY_RES);
  const step = (extent * 2) / (BATHY_RES - 1);
  for (let j = 0; j < BATHY_RES; j++) {
    const z = -extent + j * step;
    for (let i = 0; i < BATHY_RES; i++) {
      const x = -extent + i * step;
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
  const extent = bathyExtent();
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
      uvs.push((x + extent) / (extent * 2), (z + extent) / (extent * 2));
    }
  }

  // Winding is counter-clockwise **seen from above**, so the surface normal points +Y and
  // the sea is front-facing to a camera standing on the island. Getting this backwards
  // does not produce a dark sea or a flipped sea: it back-face culls every triangle, the
  // water vanishes completely, and what you see instead is the seabed and the underside of
  // the sky dome — which reads as "the ocean shader is broken" and sends you debugging the
  // wrong file entirely.
  for (let s = 0; s < sectors; s++) {
    const a = 1 + s;
    const b = 1 + ((s + 1) % sectors);
    indices.push(0, b, a);
  }
  for (let r = 0; r < rings - 1; r++) {
    const base = 1 + r * sectors;
    const next = base + sectors;
    for (let s = 0; s < sectors; s++) {
      const s2 = (s + 1) % sectors;
      indices.push(base + s, base + s2, next + s);
      indices.push(base + s2, next + s2, next + s);
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
precision highp float;

uniform float uTime;
uniform float uWaveEnabled;

out vec2 vUv;
out vec3 vWorldPos;
out vec3 vViewPos;
out float vWave;

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
  vec4 viewPos = viewMatrix * world;
  vViewPos = viewPos.xyz;
  gl_Position = projectionMatrix * viewPos;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uBathymetry;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uInk;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uNight;
uniform float uDepthScale;

in vec2 vUv;
in vec3 vWorldPos;
in vec3 vViewPos;
in float vWave;

layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gInfo;

${NORMAL_CODEC}
${DEPTH_CODEC}
${PAPER_NOISE}

void main() {
  // Depth, 0 at the waterline → 1 at 24 m. Outside the baked area the clamp returns
  // the edge texel, which is deep ocean.
  float depth = texture(uBathymetry, vUv).r;

  // --- Flat bands, not a gradient ----------------------------------------------------
  // Three discrete tones with only a couple of percent of blend between them. A smooth
  // depth ramp is what a renderer does; stepped tones are what a painter does, and the
  // steps double as the sea's own depth contours.
  vec3 color = uShallow;
  color = mix(color, uMid, smoothstep(0.06, 0.10, depth));
  // Deliberately partial: open water keeps most of its mid teal rather than falling all
  // the way to the deep tone. A sea that goes slate at the horizon reads as weather, and
  // the whole point of this palette is a bright, flat, drawn ocean.
  color = mix(color, uDeep, smoothstep(0.34, 0.55, depth) * 0.55);

  // --- Shore foam --------------------------------------------------------------------
  // A hard band right at the waterline plus a softer wash outside it, both modulated by a
  // travelling surge so the surf breathes instead of sitting as a static outline.
  // The bathymetry stores depth/24, so these thresholds are in *metres of water*: the
  // hard band covers the first ~0.35 m and the wash reaches ~1.4 m. Generous numbers here
  // do not make prettier surf, they make a sheltered harbour render as solid white.
  float surge = sin(uTime * 1.6 + vWorldPos.x * 0.06 + vWorldPos.z * 0.05) * 0.5 + 0.5;
  float edge = 1.0 - smoothstep(0.0, 0.015 + surge * 0.009, depth);
  float wash = (1.0 - smoothstep(0.0, 0.058, depth)) * 0.4 * surge;
  float foam = clamp(edge + wash, 0.0, 1.0);
  color = mix(color, uFoam, foam * 0.92);

  // The drawn line just outside the foam: where the wash ends, a pen stroke follows it.
  float foamEdge = smoothstep(0.045, 0.062, depth) * (1.0 - smoothstep(0.062, 0.085, depth));
  color = mix(color, uInk, foamEdge * 0.32);

  // --- Wave strokes ------------------------------------------------------------------
  // Short horizontal dashes lying on the surface, in world space so they belong to the
  // water rather than to the screen, thinning out with depth and distance. This is the
  // detail that makes a flat teal plane read as drawn sea.
  float strokeFade = smoothstep(0.02, 0.12, depth) * (1.0 - smoothstep(140.0, 420.0, length(vViewPos)));
  if (strokeFade > 0.002) {
    vec2 p = vWorldPos.xz * 0.35;
    p.x += uTime * 0.25 + inkValueNoise(p * 0.35) * 2.0;
    // Rows of dashes: sin() across the row makes the line, and a hashed gap along it
    // breaks the line into strokes.
    float rows = sin(p.y * 2.2 + sin(p.x * 0.3) * 1.4);
    float row = smoothstep(0.9, 0.998, rows);
    float gaps = step(0.42, inkValueNoise(vec2(floor(p.x * 0.8), floor(p.y * 0.35 + 0.5)) * 1.7));
    color = mix(color, uInk, row * gaps * strokeFade * 0.11);
  }

  // Wave crests catch the light; troughs go a shade deeper. Cheap specular substitute
  // that suits the flat, illustrative look far better than a real highlight would.
  color += vWave * 0.05;

  // Night tint, driven by the day cycle.
  color = mix(color, color * vec3(0.36, 0.44, 0.64), uNight);

  // Paper tooth, matching the land.
  color *= 1.0 + paperGrain(gl_FragCoord.xy) * 0.045;

  // Match the scene's exponential-squared fog so the sea and the land dissolve into
  // the same haze at the same rate.
  float d = length(vViewPos);
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
  color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

  // Material id 9 (MAT_ID.water); outline mask 0 — see the module header.
  gColor = vec4(color, 9.0 / 15.0);
  gInfo = vec4(encodeLinearDepth(vViewPos.z, uDepthScale), encodeNormalSpheremap(vec3(0.0, 0.0, 1.0)), 0.0);
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
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uWaveEnabled: { value: quality.animatedWater ? 1 : 0 },
        uBathymetry: { value: this.bathymetry },
        uShallow: { value: new THREE.Color(SCENE_COLORS.waterShallow) },
        uMid: { value: new THREE.Color(SCENE_COLORS.waterMid) },
        uDeep: { value: new THREE.Color(SCENE_COLORS.waterDeep) },
        uFoam: { value: new THREE.Color(SCENE_COLORS.waterFoam) },
        uInk: { value: new THREE.Color(SCENE_COLORS.ink) },
        uNight: { value: 0 },
        // Fog and the depth scale are shared with the ink materials so the sea and the
        // land dissolve at exactly the same rate and encode depth onto the same scale.
        uFogColor: inkLighting.uFogColor,
        uFogDensity: inkLighting.uFogDensity,
        uDepthScale: inkLighting.uDepthScale,
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
