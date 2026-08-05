/**
 * Sky, sun and the day cycle.
 * ===========================
 *
 * The island runs on a slow shared clock. Time of day is derived from **server time**,
 * not from the local machine, so everyone standing on the plaza sees the same light at
 * the same moment. Shared weather is a surprisingly large part of a world feeling
 * inhabited rather than instanced — if your dusk is my noon, we are not in the same place.
 *
 * The cycle is deliberately long (90 minutes by default). A visible sunset every four
 * minutes is a novelty; a sunset you happen to be present for is an event.
 *
 * ### What this module actually drives
 *
 * Almost nothing on Nagisa is lit by a three.js light. The ink material does its own
 * shading from a small set of shared uniforms (`inkLighting`), so this class's real job is
 * to write those uniforms once per frame: sun direction, key colour and strength, sky and
 * bounce fill, fog, and the night factor that lights the paper screens.
 *
 * One real `DirectionalLight` survives, and it exists **only to produce the shadow map**.
 * Its colour and intensity are never read by any shader; three needs a light object with
 * `castShadow` set in order to render a depth map and hand the matrices to our material.
 *
 * ### Clouds
 *
 * Drawn, not simulated: a noise field on the view direction, hard-thresholded into a
 * paper-cut shape with an ink line where the field crosses the threshold. Two layers at
 * different scales and drift speeds give parallax. Doing this in the dome shader rather
 * than with billboards means no sorting, no overdraw, no transparency, and no chance of a
 * cloud clipping through the lighthouse.
 */

import * as THREE from 'three';
import { OCEAN_RADIUS, SCENE_COLORS } from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';
import { inkLighting } from '../engine/ink/ink-material.js';
import { PAPER_NOISE } from '../engine/ink/glsl.js';
import { setNightFactor } from './materials.js';

/** Length of one full day/night cycle, milliseconds. */
export const DAY_LENGTH_MS = 90 * 60 * 1000;

/**
 * Key colours through the day, as (t, colour) stops where t is the normalised cycle
 * position: 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk.
 *
 * The palette stays high-key and desaturated even at night — a drawn world goes *blue*
 * after dark, not black, because ink on paper never reads as an absence of light.
 */
interface Stop {
  t: number;
  horizon: number;
  zenith: number;
  sun: number;
  /** Sky-dome fill colour, also used as the upper hemisphere term in the ink material. */
  fill: number;
  sunIntensity: number;
  /** How "night" it is, 0–1. Drives lamp emissives and the water tint. */
  night: number;
}

const STOPS: Stop[] = [
  { t: 0.0, horizon: 0x40506b, zenith: 0x232f4a, sun: 0x8ea7d0, fill: 0x46577a, sunIntensity: 0.2, night: 1 },
  { t: 0.2, horizon: 0x7a7a94, zenith: 0x455879, sun: 0xb9a2b0, fill: 0x5e6a8a, sunIntensity: 0.4, night: 0.85 },
  { t: 0.26, horizon: 0xf3c49a, zenith: 0x8fadcb, sun: 0xffd2a6, fill: 0x9fb2c8, sunIntensity: 0.85, night: 0.35 },
  { t: 0.35, horizon: 0xf3ead6, zenith: 0x9dc5cb, sun: 0xfff2dc, fill: 0xa9c6cd, sunIntensity: 1.0, night: 0.05 },
  { t: 0.5, horizon: 0xeef0e6, zenith: 0x93bfc9, sun: 0xfffaf0, fill: 0xb2ccd0, sunIntensity: 1.08, night: 0 },
  { t: 0.66, horizon: 0xf3e8d2, zenith: 0x9dc5cb, sun: 0xfff0d4, fill: 0xa9c6cd, sunIntensity: 1.0, night: 0.05 },
  { t: 0.76, horizon: 0xf2ab86, zenith: 0x7f9ec4, sun: 0xffb478, fill: 0x9aabc2, sunIntensity: 0.8, night: 0.4 },
  { t: 0.82, horizon: 0x9a7a8c, zenith: 0x54637f, sun: 0xc08a94, fill: 0x6b788f, sunIntensity: 0.42, night: 0.8 },
  { t: 1.0, horizon: 0x40506b, zenith: 0x232f4a, sun: 0x8ea7d0, fill: 0x46577a, sunIntensity: 0.2, night: 1 },
];

/** Interpolated sky state at a normalised cycle position. */
export interface SkyState {
  horizon: THREE.Color;
  zenith: THREE.Color;
  sun: THREE.Color;
  fill: THREE.Color;
  sunIntensity: number;
  night: number;
  /** Sun direction, normalised, pointing from the ground toward the sun. */
  sunDir: THREE.Vector3;
}

const SKY_VERTEX = /* glsl */ `
precision highp float;
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The dome writes both render targets like everything else, but with an outline mask of
 * zero. Contours around clouds are drawn *by this shader*, deliberately, at the exact
 * threshold of the shape function — letting the screen-space detector find them instead
 * would put a line around the whole sky where it meets the horizon.
 */
const SKY_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uInkColor;
uniform vec3 uCloudColor;
uniform vec3 uCloudShadow;
uniform float uTime;
uniform float uNight;
uniform float uCloudAmount;

in vec3 vDir;

layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gInfo;

${PAPER_NOISE}

/** Two octaves of drifting noise, sampled on a plane above the viewer. */
float cloudField(vec2 p, float t) {
  float n = inkValueNoise(p + vec2(t * 0.9, t * 0.35)) * 0.62;
  n += inkValueNoise(p * 2.3 + vec2(-t * 0.6, t * 0.2)) * 0.26;
  n += inkValueNoise(p * 4.7 + vec2(t * 0.3, -t * 0.5)) * 0.12;
  return n;
}

void main() {
  vec3 d = normalize(vDir);

  // Vertical gradient. The pow() biases the blend toward the horizon so the warm band
  // sits low, the way it does in life, rather than filling the upper half of the sky.
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 color = mix(uHorizon, uZenith, pow(h, 0.72));

  // A broad glow around the sun rather than a disc: at this art direction a hard sun
  // reads as a bug, and the glow is what sells low light.
  float sunDot = max(0.0, dot(d, normalize(uSunDir)));
  color += uSunColor * pow(sunDot, 10.0) * 0.30;
  color += uSunColor * pow(sunDot, 200.0) * 0.75;

  // --- Clouds ------------------------------------------------------------------------
  // Project the view direction onto a flat sheet overhead. The projection divides by d.y,
  // so it stretches without bound as the view approaches the horizon: a cloud that is a
  // rounded shape overhead becomes a vertical smear reaching down to the sea. skyMask has
  // to hold it well clear of the horizon — 0.06 to 0.34 keeps the cloud deck to the upper
  // sky, which is also where a person drawing this would put it.
  float skyMask = smoothstep(0.06, 0.34, d.y);
  if (skyMask > 0.001 && uCloudAmount > 0.001) {
    vec2 plane = d.xz / max(0.12, d.y);

    // Layer 1: high, slow, large. Layer 2: lower, faster, smaller, offset so the two
    // never coincide. Both are sampled at a tighter scale than reads "correct" on paper,
    // because the projection onto the overhead sheet stretches everything toward the
    // horizon — a field that looks right overhead becomes enormous smears at the edges.
    float f1 = cloudField(plane * 1.15, uTime * 0.004);
    float f2 = cloudField(plane * 2.6 + 31.0, uTime * 0.009);
    float field = max(f1, f2 * 0.9);

    // Hard threshold makes the paper-cut edge; the two smoothsteps either side of it are
    // the fill and the ink line drawn exactly on the boundary.
    float threshold = mix(0.72, 0.60, uCloudAmount);
    float fill = smoothstep(threshold, threshold + 0.035, field);
    float edge = smoothstep(threshold - 0.016, threshold, field) * (1.0 - smoothstep(threshold + 0.002, threshold + 0.018, field));

    // Underside shading: the part of a cloud furthest from the sun is drawn darker, which
    // is the one piece of form a flat cloud needs to stop reading as a hole in the sky.
    float lit = smoothstep(-0.3, 0.5, dot(normalize(vec3(plane.x, 1.0, plane.y)), normalize(uSunDir)));
    vec3 body = mix(uCloudShadow, uCloudColor, lit);

    color = mix(color, body, fill * skyMask * 0.94);
    color = mix(color, uInkColor, edge * skyMask * 0.4);
  }

  // Paper tooth, so the sky is part of the same drawing as the island.
  color *= 1.0 + paperGrain(gl_FragCoord.xy) * 0.04;

  gColor = vec4(color, 0.0);
  // Depth 1 = beyond the reference range (see DEPTH_CODEC), normal facing the camera,
  // outline mask off. The dome covers every pixel, so this is also what stops the cleared
  // buffer's zeroes — which would mean "at the lens" — from ever reaching the detector.
  gInfo = vec4(1.0, 0.5, 0.5, 0.0);
}
`;

/** Sample the stop table at a normalised cycle position. */
function sampleStops(t: number, out: SkyState): SkyState {
  const p = ((t % 1) + 1) % 1;
  let a = STOPS[0];
  let b = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (p >= STOPS[i].t && p <= STOPS[i + 1].t) {
      a = STOPS[i];
      b = STOPS[i + 1];
      break;
    }
  }
  const span = b.t - a.t || 1;
  const k = (p - a.t) / span;

  out.horizon.setHex(a.horizon).lerp(new THREE.Color(b.horizon), k);
  out.zenith.setHex(a.zenith).lerp(new THREE.Color(b.zenith), k);
  out.sun.setHex(a.sun).lerp(new THREE.Color(b.sun), k);
  out.fill.setHex(a.fill).lerp(new THREE.Color(b.fill), k);
  out.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * k;
  out.night = a.night + (b.night - a.night) * k;

  // Sun arc: rises in the east (+X), sets in the west (−X), tilted south so shadows
  // fall across the island rather than straight down it.
  const angle = (p - 0.25) * Math.PI * 2;
  out.sunDir.set(Math.cos(angle), Math.sin(angle), 0.35).normalize();
  return out;
}

/**
 * Sky dome, light rig and day clock.
 *
 * Call {@link update} once per frame with the current server time; everything else
 * follows from it.
 */
export class Sky {
  readonly group = new THREE.Group();
  /** Shadow-map source only. Nothing reads its colour — see the module header. */
  readonly sun: THREE.DirectionalLight;

  private readonly dome: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly state: SkyState = {
    horizon: new THREE.Color(),
    zenith: new THREE.Color(),
    sun: new THREE.Color(),
    fill: new THREE.Color(),
    sunIntensity: 1,
    night: 0,
    sunDir: new THREE.Vector3(1, 1, 0),
  };

  /** Fixed time of day, 0–1, when the cycle is paused. `null` means "follow the clock". */
  private frozenAt: number | null = null;
  private elapsed = 0;

  constructor(private readonly quality: QualitySettings) {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms: {
        uHorizon: { value: new THREE.Color(SCENE_COLORS.skyHorizon) },
        uZenith: { value: new THREE.Color(SCENE_COLORS.skyZenith) },
        uSunColor: { value: new THREE.Color(SCENE_COLORS.sunLight) },
        uSunDir: { value: new THREE.Vector3(1, 1, 0) },
        uInkColor: { value: new THREE.Color(SCENE_COLORS.ink) },
        uCloudColor: { value: new THREE.Color(0xfbfaf4) },
        uCloudShadow: { value: new THREE.Color(0xc9d3d4) },
        uTime: { value: 0 },
        uNight: { value: 0 },
        uCloudAmount: { value: quality.tier === 'low' ? 0.35 : 0.5 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    // Low-poly sphere: the gradient is smooth in the fragment shader, so the dome only
    // needs enough vertices to avoid a visibly polygonal silhouette at the horizon.
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(OCEAN_RADIUS * 1.2, 32, 16), this.material);
    this.dome.name = 'sky-dome';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -2;
    this.group.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.name = 'sun';
    if (quality.shadows) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
      // A tight ortho box that follows the player — see `update`. Covering the whole
      // island at once would put ~1 texel per 20 cm even at 2048², which is mush.
      const cam = this.sun.shadow.camera;
      cam.left = -95;
      cam.right = 95;
      cam.top = 95;
      cam.bottom = -95;
      cam.near = 1;
      cam.far = 460;
      // Bias tuned against the flat-shaded terrain; too little and the plaza acnes,
      // too much and characters detach from their own shadows.
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.5;
      this.sun.shadow.intensity = 0.86;
    }
    this.group.add(this.sun);
    this.group.add(this.sun.target);
  }

  /** Current interpolated sky state. Read by the ocean and the scene director. */
  get current(): Readonly<SkyState> {
    return this.state;
  }

  /** Normalised time of day, 0–1. */
  timeOfDay(serverTimeMs: number): number {
    if (this.frozenAt !== null) return this.frozenAt;
    return (serverTimeMs % DAY_LENGTH_MS) / DAY_LENGTH_MS;
  }

  /**
   * Pin the cycle to a fixed time of day. Used by the host console to hold an event at
   * dusk, and by screenshot tooling. `null` resumes the shared clock.
   */
  freeze(t: number | null): void {
    this.frozenAt = t;
  }

  /**
   * Advance the sky. `focus` is the point the shadow box should follow — normally the
   * local player, so shadow resolution is spent where the player is looking.
   */
  update(serverTimeMs: number, focus: THREE.Vector3, dt = 0): void {
    this.elapsed += dt;
    const t = this.timeOfDay(serverTimeMs);
    sampleStops(t, this.state);

    const u = this.material.uniforms;
    u.uHorizon.value.copy(this.state.horizon);
    u.uZenith.value.copy(this.state.zenith);
    u.uSunColor.value.copy(this.state.sun);
    u.uSunDir.value.copy(this.state.sunDir);
    u.uTime.value = this.elapsed;
    u.uNight.value = this.state.night;

    // --- Feed the shared ink lighting -------------------------------------------------
    inkLighting.uSunDir.value.copy(this.state.sunDir);
    inkLighting.uSunColor.value.copy(this.state.sun);
    inkLighting.uSkyColor.value.copy(this.state.fill);
    inkLighting.uSunStrength.value = this.state.sunIntensity;
    // Ambient rises a little at night so nothing on the island goes to a flat black.
    inkLighting.uAmbient.value = 0.3 + this.state.night * 0.22;
    inkLighting.uNight.value = this.state.night;
    inkLighting.uFogColor.value.copy(this.state.horizon).lerp(this.state.zenith, 0.35);
    inkLighting.uTime.value = this.elapsed;

    // Bounce from the sea takes the water's colour, warmed slightly at dusk.
    inkLighting.uBounceColor.value.setHex(SCENE_COLORS.bounceLight).lerp(this.state.sun, this.state.night * 0.3);

    // Keep the shadow light a fixed distance from the focus point along the sun
    // direction, so the shadow frustum is always centred on the action.
    this.sun.position.copy(this.state.sunDir).multiplyScalar(200).add(focus);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();

    // Lamps and paper screens light up as the sun goes down.
    setNightFactor(this.state.night);

    // The dome travels with the camera focus so its far edge never enters the frustum.
    this.dome.position.copy(focus);
  }

  /** Suggested bloom strength for the current light. Lamps matter at night. */
  bloomStrength(): number {
    if (!this.quality.postProcessing) return 0;
    return 0.14 + this.state.night * 0.36;
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.material.dispose();
  }
}
