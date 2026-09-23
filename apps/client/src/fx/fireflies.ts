/**
 * Fireflies.
 * ==========
 *
 * After dark, around the shrine, a few dozen small green-gold lights drift over the grass and
 * blink — the one thing on the island that is only there at night and only if you go and look.
 * Not on a dry night only: rain sends them into the grass.
 *
 * One `Points` draw. Each firefly is a vertex holding its home, a phase and a pace; wandering
 * and blinking are functions of time in the vertex shader, so a frame costs two uniform writes
 * however many there are, and nothing at all by day, when the draw is switched off.
 */

import * as THREE from 'three';
import { getZone, heightAt } from '@nagisa/shared';
import { inkLighting } from '../engine/ink/ink-material.js';
import type { FxHost } from './index.js';
import { FX_OUTPUTS, approach, fxMaterial, fxViewport, smoothstep, trackViewport } from './materials.js';

/** Fireflies, by quality tier. */
const COUNT = { low: 18, medium: 32, high: 44 } as const;

/** Where they gather, as offsets from the shrine's centre, metres, and how far each cluster spreads. */
const CLUSTERS: ReadonlyArray<readonly [number, number, number]> = [
  [-10, 8, 7],
  [9, -6, 6],
  [2, 16, 6],
];

/** How far one wanders from its home, metres, and how high above the ground it flies. */
const WANDER = 1.6;
const HEIGHT: readonly [number, number] = [0.4, 2.2];

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uViewport;
in float aPhase;
in float aPace;
out float vBlink;
void main() {
  // A slow Lissajous wander about home: no two alike, never leaving the grass.
  float t = uTime * aPace + aPhase * 6.2831;
  vec3 p = position + vec3(sin(t * 0.7) * ${WANDER.toFixed(2)}, sin(t * 1.3 + aPhase) * 0.35, cos(t * 0.5 + aPhase * 2.0) * ${WANDER.toFixed(2)});
  // On for a moment, off for longer: a firefly's blink, not a lamp's glow.
  float cycle = fract(uTime * (0.18 + aPace * 0.12) + aPhase);
  vBlink = smoothstep(0.0, 0.08, cycle) * (1.0 - smoothstep(0.18, 0.4, cycle));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(0.28 * projectionMatrix[1][1] * uViewport * 0.5 / max(0.5, -mv.z), 1.0, 24.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
in float vBlink;
${FX_OUTPUTS}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = pow(max(0.0, 1.0 - d), 2.0) * vBlink * uStrength;
  if (a < 0.004) discard;
  gColor = vec4(uColor, a);
  gInfo = vec4(0.0);
}
`;

export class Fireflies {
  private readonly points: THREE.Points | null = null;
  private readonly material: THREE.ShaderMaterial;
  private strength = 0;
  private rain = 0;

  constructor(host: FxHost, group: THREE.Group) {
    this.material = fxMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      blend: 'add',
      uniforms: {
        uTime: { value: 0 },
        uViewport: fxViewport,
        uColor: { value: new THREE.Color(0xd8f27a) },
        uStrength: { value: 0 },
      },
    });
    const shrine = getZone('shrine');
    if (!shrine) return;

    const count = COUNT[host.quality.tier];
    const home = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const pace = new Float32Array(count);
    // A fixed scatter: the same fireflies in the same places on every screen.
    let seed = 0x5eed;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const [ox, oz, spread] = CLUSTERS[i % CLUSTERS.length];
      const angle = next() * Math.PI * 2;
      const r = Math.sqrt(next()) * spread;
      const x = shrine.x + ox + Math.cos(angle) * r;
      const z = shrine.z + oz + Math.sin(angle) * r;
      home.set([x, heightAt(x, z) + HEIGHT[0] + next() * (HEIGHT[1] - HEIGHT[0]), z], i * 3);
      phase[i] = next();
      pace[i] = 0.5 + next() * 0.8;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(home, 3));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geometry.setAttribute('aPace', new THREE.BufferAttribute(pace, 1));
    geometry.computeBoundingSphere();
    // Their homes are fixed, but they wander past the bounds the homes alone would give.
    if (geometry.boundingSphere) geometry.boundingSphere.radius += WANDER + 1;

    this.points = new THREE.Points(geometry, this.material);
    this.points.name = 'fireflies';
    this.points.renderOrder = 4;
    this.points.visible = false;
    this.points.onBeforeRender = trackViewport;
    group.add(this.points);
  }

  /** How hard it is raining, 0–1: they keep to the grass in the rain. */
  setRain(level: number): void {
    this.rain = level;
  }

  update(dt: number, elapsed: number): void {
    if (!this.points) return;
    const wanted = smoothstep(0.45, 0.8, inkLighting.uNight.value) * (1 - this.rain);
    this.strength = approach(this.strength, wanted, dt, 0.6);
    const on = this.strength > 0.01;
    this.points.visible = on;
    if (!on) return;
    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uStrength.value = this.strength;
  }

  dispose(): void {
    this.points?.geometry.dispose();
    this.material.dispose();
    this.points?.removeFromParent();
  }
}
