/**
 * Mist on the mountain.
 * =====================
 *
 * When the island clouds over, a band of mist gathers round the mountain's shoulders and
 * drifts slowly about it; in the rain it thickens until the summit is an outline above it.
 * On a clear day there is none, and the draw is switched off. The weather is the island's
 * own (`weatherLevels` in the shared package), so everyone sees the same mist.
 *
 * One instanced draw of soft, wide, upright quads — a mist bank is long and low, and turns
 * to face you about the vertical only, so it keeps lying along the slope. Each puff's orbit,
 * height and size are fixed; drifting and swelling are functions of time in the vertex
 * shader, so a frame is a few uniform writes. Its colour is the island's fog colour, which
 * already follows the time of day and the weather, so the mist is never brighter than the air.
 *
 * Laid `over` the drawing like every mark (`fx/materials.ts`): the contour pass never learns
 * it is there, so no pen line rings a cloud. A puff fades as the camera comes close, or
 * standing on the summit in the rain would be standing inside a grey card.
 */

import * as THREE from 'three';
import { getZone, heightAt } from '@nagisa/shared';
import { inkLighting } from '../engine/ink/ink-material.js';
import type { FxHost } from './index.js';
import { FX_OUTPUTS, approach, fxMaterial, smoothstep } from './materials.js';

/** Puffs, by quality tier. */
const COUNT = { low: 9, medium: 14, high: 20 } as const;

/** How far from the summit's centre the band lies, metres. */
const RING: readonly [number, number] = [24, 40];
/** How far above the ground under it a puff floats, metres, and how wide and tall one is. */
const LIFT: readonly [number, number] = [2.5, 5.5];
const WIDTH: readonly [number, number] = [11, 18];
const ASPECT = 0.38;

/** Drift round the mountain, radians per second: a lap in a quarter of an hour or so. */
const DRIFT = 0.007;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform vec3 uCentre;
in vec3 aOrbit;   // angle, radius, height above sea level
in vec3 aShape;   // width, height, phase
out vec2 vUv;
out float vFade;
out float vPhase;
void main() {
  float angle = aOrbit.x + uTime * ${DRIFT.toFixed(4)} * (0.7 + aShape.z * 0.6);
  vec3 centre = uCentre + vec3(cos(angle) * aOrbit.y, aOrbit.z + sin(uTime * 0.21 + aShape.z * 6.2831) * 0.5, sin(angle) * aOrbit.y);
  // Face the camera about the vertical only.
  vec3 toCamera = cameraPosition - centre;
  vec3 right = normalize(vec3(toCamera.z, 0.0, -toCamera.x) + vec3(1e-4, 0.0, 0.0));
  float swell = 1.0 + 0.08 * sin(uTime * 0.13 + aShape.z * 12.0);
  vec3 p = centre + right * position.x * aShape.x * 0.5 * swell + vec3(0.0, position.y * aShape.y * 0.5, 0.0);
  vUv = position.xy;
  vPhase = aShape.z;
  // Thin out close to the camera, so the summit in the rain is misty and not grey.
  vFade = smoothstep(4.0, 16.0, length(toCamera));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
in vec2 vUv;
in float vFade;
in float vPhase;
${FX_OUTPUTS}
void main() {
  // A soft oval with a lumpy top edge: a bank of mist, not a disc.
  vec2 uv = vUv;
  float lump = 0.1 * sin(uv.x * 4.0 + vPhase * 17.0) + 0.06 * sin(uv.x * 9.0 - vPhase * 5.0);
  float d = length(vec2(uv.x, (uv.y - lump * step(0.0, uv.y)) * 1.1));
  float a = (1.0 - smoothstep(0.25, 1.0, d)) * uStrength * vFade;
  if (a < 0.004) discard;
  gColor = vec4(uColor, a);
  gInfo = vec4(0.0);
}
`;

/** Strongest a puff's centre gets, 0–1, in the heaviest rain. */
const MAX_ALPHA = 0.5;

export class Mist {
  private readonly mesh: THREE.Mesh | null = null;
  private readonly material: THREE.ShaderMaterial;
  private readonly color = new THREE.Color();
  private strength = 0;
  private cloud = 0;
  private rain = 0;

  constructor(host: FxHost, group: THREE.Group) {
    this.material = fxMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      blend: 'over',
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uCentre: { value: new THREE.Vector3() },
        uColor: { value: this.color },
        uStrength: { value: 0 },
      },
    });
    const summit = getZone('summit');
    if (!summit) return;
    this.material.uniforms.uCentre.value.set(summit.x, 0, summit.z);

    const count = COUNT[host.quality.tier];
    const orbit = new Float32Array(count * 3);
    const shape = new Float32Array(count * 3);
    // A fixed scatter: the same mist in the same places on every screen.
    let seed = 0x3157;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      // Evenly round the mountain, give or take, so the band has no gap on one side.
      const angle = ((i + next() * 0.8) / count) * Math.PI * 2;
      const radius = RING[0] + next() * (RING[1] - RING[0]);
      const ground = heightAt(summit.x + Math.cos(angle) * radius, summit.z + Math.sin(angle) * radius);
      const width = WIDTH[0] + next() * (WIDTH[1] - WIDTH[0]);
      orbit.set([angle, radius, ground + LIFT[0] + next() * (LIFT[1] - LIFT[0])], i * 3);
      shape.set([width, width * ASPECT, next()], i * 3);
    }

    const quad = new THREE.PlaneGeometry(2, 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 3));
    geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 3));
    geometry.instanceCount = count;

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'mist';
    // Placed in the shader, so the quad's own bounds say nothing about where it is.
    this.mesh.frustumCulled = false;
    // Far and wide: drawn before the other marks and lights, which sit in front of it.
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    group.add(this.mesh);
  }

  /** How overcast and how wet it is, 0–1 each (`weatherLevels`). */
  setWeather(cloud: number, rain: number): void {
    this.cloud = cloud;
    this.rain = rain;
  }

  update(dt: number, elapsed: number): void {
    if (!this.mesh) return;
    const wanted = MAX_ALPHA * (0.55 * smoothstep(0.3, 0.9, this.cloud) + 0.45 * this.rain);
    this.strength = approach(this.strength, wanted, dt, 0.25);
    const on = this.strength > 0.005;
    this.mesh.visible = on;
    if (!on) return;
    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uStrength.value = this.strength;
    // The air's own colour, a shade lighter by day: mist is lit, not painted grey.
    this.color.copy(inkLighting.uFogColor.value).lerp(WHITE, 0.22 * (1 - inkLighting.uNight.value));
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material.dispose();
    this.mesh?.removeFromParent();
  }
}

const WHITE = new THREE.Color(1, 1, 1);
