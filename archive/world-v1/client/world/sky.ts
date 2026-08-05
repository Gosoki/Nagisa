/**
 * Sky, sun and the day cycle.
 * ===========================
 *
 * The island runs on a slow shared clock. Time of day is derived from **server time**,
 * not from the local machine, so everyone standing on the plaza sees the same light at
 * the same moment. Shared weather is a surprisingly large part of a world feeling
 * inhabited rather than instanced — if your dusk is my noon, we are not in the same
 * place.
 *
 * The cycle is deliberately long (90 minutes by default). A visible sunset every four
 * minutes is a novelty; a sunset you happen to be present for is an event.
 *
 * Lighting is a three-source rig, which is all a toon-shaded world needs:
 *
 * - a **key** directional light with the shadow map, warm, tracking the sun;
 * - a **hemisphere** fill, sky above and sea-bounce below, which is what keeps shadowed
 *   faces from going flat grey;
 * - a weak **rim** directional from behind the sun, which separates silhouettes from the
 *   water. Without it, a dark character against dark sea disappears.
 */

import * as THREE from 'three';
import { OCEAN_RADIUS, SCENE_COLORS } from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';
import { setNightFactor } from './materials.js';

/** Length of one full day/night cycle, milliseconds. */
export const DAY_LENGTH_MS = 90 * 60 * 1000;

/**
 * Key colours through the day, as (t, colour) stops where t is the normalised cycle
 * position: 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk.
 */
interface Stop {
  t: number;
  horizon: number;
  zenith: number;
  sun: number;
  ambient: number;
  sunIntensity: number;
  /** How "night" it is, 0–1. Drives lamp emissives and the water tint. */
  night: number;
}

const STOPS: Stop[] = [
  { t: 0.0, horizon: 0x2b3a52, zenith: 0x141d31, sun: 0x8ea7d0, ambient: 0x2c3a52, sunIntensity: 0.18, night: 1 },
  { t: 0.2, horizon: 0x6a6a82, zenith: 0x33445f, sun: 0xb9a2b0, ambient: 0x4a5670, sunIntensity: 0.35, night: 0.85 },
  { t: 0.26, horizon: 0xf0b98a, zenith: 0x7d9fc4, sun: 0xffd2a6, ambient: 0x8fa3bd, sunIntensity: 0.9, night: 0.35 },
  { t: 0.35, horizon: 0xf6e2c8, zenith: 0x8fb8d4, sun: 0xfff2dc, ambient: 0xa8c0d0, sunIntensity: 1.25, night: 0.05 },
  { t: 0.5, horizon: 0xf2e6d4, zenith: 0x82b0d6, sun: 0xfffaf0, ambient: 0xb2c6d4, sunIntensity: 1.45, night: 0 },
  { t: 0.66, horizon: 0xf4dcbe, zenith: 0x8fb8d4, sun: 0xfff0d4, ambient: 0xa8c0d0, sunIntensity: 1.25, night: 0.05 },
  { t: 0.76, horizon: 0xf0a077, zenith: 0x6f92bd, sun: 0xffb478, ambient: 0x93a2bb, sunIntensity: 0.85, night: 0.4 },
  { t: 0.82, horizon: 0x8a6a7e, zenith: 0x3f4d69, sun: 0xc08a94, ambient: 0x55617d, sunIntensity: 0.4, night: 0.8 },
  { t: 1.0, horizon: 0x2b3a52, zenith: 0x141d31, sun: 0x8ea7d0, ambient: 0x2c3a52, sunIntensity: 0.18, night: 1 },
];

/** Interpolated sky state at a normalised cycle position. */
export interface SkyState {
  horizon: THREE.Color;
  zenith: THREE.Color;
  sun: THREE.Color;
  ambient: THREE.Color;
  sunIntensity: number;
  night: number;
  /** Sun direction, normalised. */
  sunDir: THREE.Vector3;
}

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    // The dome is drawn at the far plane with depth writes off, so its actual radius
    // is irrelevant — only the direction matters.
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);

    // Vertical gradient. The pow() biases the blend toward the horizon so the warm band
    // sits low, the way it does in life, rather than filling the upper half of the sky.
    float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 color = mix(uHorizon, uZenith, pow(h, 0.72));

    // A broad glow around the sun rather than a disc: at this art direction a hard sun
    // reads as a bug, and the glow is what sells low light.
    float sunDot = max(0.0, dot(d, normalize(uSunDir)));
    color += uSunColor * pow(sunDot, 8.0) * 0.35;
    color += uSunColor * pow(sunDot, 128.0) * 0.9;

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
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
  out.ambient.setHex(a.ambient).lerp(new THREE.Color(b.ambient), k);
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
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly rim: THREE.DirectionalLight;

  private readonly dome: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly state: SkyState = {
    horizon: new THREE.Color(),
    zenith: new THREE.Color(),
    sun: new THREE.Color(),
    ambient: new THREE.Color(),
    sunIntensity: 1,
    night: 0,
    sunDir: new THREE.Vector3(1, 1, 0),
  };

  /** Fixed time of day, 0–1, when the cycle is paused. `null` means "follow the clock". */
  private frozenAt: number | null = null;

  constructor(private readonly quality: QualitySettings) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms: {
        uHorizon: { value: new THREE.Color(SCENE_COLORS.skyHorizon) },
        uZenith: { value: new THREE.Color(SCENE_COLORS.skyZenith) },
        uSunColor: { value: new THREE.Color(SCENE_COLORS.sunLight) },
        uSunDir: { value: new THREE.Vector3(1, 1, 0) },
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

    this.sun = new THREE.DirectionalLight(SCENE_COLORS.sunLight, 1.4);
    this.sun.name = 'sun';
    if (quality.shadows) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
      // A tight ortho box that follows the player — see `update`. Covering the whole
      // island at once would put ~1 texel per 15 cm even at 2048², which is mush.
      const cam = this.sun.shadow.camera;
      cam.left = -90;
      cam.right = 90;
      cam.top = 90;
      cam.bottom = -90;
      cam.near = 1;
      cam.far = 400;
      // Bias tuned against the flat-shaded terrain; too little and the plaza acnes,
      // too much and characters detach from their own shadows.
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.5;
    }
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(SCENE_COLORS.ambientLight, SCENE_COLORS.bounceLight, 0.75);
    this.group.add(this.hemi);

    this.rim = new THREE.DirectionalLight(SCENE_COLORS.bounceLight, 0.35);
    this.rim.name = 'rim';
    this.group.add(this.rim);
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
  update(serverTimeMs: number, focus: THREE.Vector3): void {
    const t = this.timeOfDay(serverTimeMs);
    sampleStops(t, this.state);

    this.material.uniforms.uHorizon.value.copy(this.state.horizon);
    this.material.uniforms.uZenith.value.copy(this.state.zenith);
    this.material.uniforms.uSunColor.value.copy(this.state.sun);
    this.material.uniforms.uSunDir.value.copy(this.state.sunDir);

    this.sun.color.copy(this.state.sun);
    this.sun.intensity = this.state.sunIntensity;
    // Keep the light a fixed distance from the focus point along the sun direction, so
    // the shadow frustum is always centred on the action.
    this.sun.position.copy(this.state.sunDir).multiplyScalar(180).add(focus);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();

    this.hemi.color.copy(this.state.zenith);
    this.hemi.groundColor.setHex(SCENE_COLORS.bounceLight);
    this.hemi.intensity = 0.35 + (1 - this.state.night) * 0.5;

    this.rim.position.copy(this.state.sunDir).multiplyScalar(-140).add(focus);
    this.rim.intensity = 0.2 + this.state.night * 0.25;

    // Lamps and paper screens light up as the sun goes down.
    setNightFactor(this.state.night);

    // The dome travels with the camera focus so its far edge never enters the frustum.
    this.dome.position.copy(focus);
  }

  /** Suggested bloom strength for the current light. Lamps matter at night. */
  bloomStrength(): number {
    if (!this.quality.postProcessing) return 0;
    return 0.22 + this.state.night * 0.5;
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.material.dispose();
  }
}
