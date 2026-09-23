/**
 * Rain.
 * =====
 *
 * Short grey strokes falling past you — the way a pen draws rain, not a simulation of it.
 *
 * A box of drops travels with the camera. Each drop has a fixed place in the box, and the
 * box's contents wrap as the camera moves, so rain stays put in the world while there is
 * always rain around you; falling wraps the same way top to bottom, faded at both ends so
 * the wrap is never seen. Everything moves in the vertex shader: a frame costs three uniform
 * writes, however many drops there are. A light shower is the same drops thinned out — each
 * has a fixed share of the heaviest rain it belongs to — so rain arriving is drops appearing
 * one by one, not the whole box fading in at once.
 *
 * Drawn as GL lines through the effects materials (`fx/materials.ts`): marks laid over the
 * drawing, hidden by a roof in front of them, never outlined.
 */

import * as THREE from 'three';
import type { FxHost } from './index.js';
import { FX_OUTPUTS, fxMaterial } from './materials.js';

/** The box of rain around the camera, metres. */
const BOX = new THREE.Vector3(34, 20, 34);
/** How fast it falls, m/s, and how long a stroke is, metres. */
const FALL = 13;
const STREAK = 0.6;
/** How far it drifts sideways per metre fallen: a little wind off the sea. */
const WIND = new THREE.Vector2(0.16, 0.05);

/** Drops in the box at the heaviest, by quality tier. */
const DROPS = { low: 350, medium: 800, high: 1400 } as const;

const VERTEX = /* glsl */ `
uniform vec3 uCamera;
uniform vec3 uBox;
uniform float uTime;
uniform float uFall;
uniform float uStreak;
uniform vec2 uWind;
uniform float uRain;
in float aEnd;
out float vFade;
void main() {
  // position: this drop's place in the box, 0–1 on each axis (the same for both ends).
  vec3 o = position * uBox;
  vec3 base = uCamera - uBox * 0.5;
  float y = mod(o.y - uTime * uFall, uBox.y);
  vec3 p = vec3(base.x + mod(o.x - base.x, uBox.x), base.y + y, base.z + mod(o.z - base.z, uBox.z));
  p.xz += uWind * (uBox.y - y);
  // The upper end of the stroke, back along the way it is falling.
  p += aEnd * vec3(uWind.x, 1.0, uWind.y) * uStreak;
  float h = y / uBox.y;
  vFade = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.82, 1.0, h));
  // A light shower is fewer drops, not fainter ones.
  vFade *= step(fract(position.x * 91.7 + position.z * 17.3), uRain);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
in float vFade;
${FX_OUTPUTS}
void main() {
  float a = uOpacity * vFade;
  if (a < 0.01) discard;
  gColor = vec4(uColor, a);
  gInfo = vec4(0.0);
}
`;

export class Rain {
  private readonly lines: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private level = 0;

  constructor(
    private readonly host: FxHost,
    group: THREE.Group,
  ) {
    const count = DROPS[host.quality.tier];
    const place = new Float32Array(count * 6);
    const end = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = Math.random();
      const y = Math.random();
      const z = Math.random();
      place.set([x, y, z, x, y, z], i * 6);
      end[i * 2 + 1] = 1;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(place, 3));
    geometry.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));

    this.material = fxMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      blend: 'over',
      uniforms: {
        uCamera: { value: new THREE.Vector3() },
        uBox: { value: BOX },
        uTime: { value: 0 },
        uFall: { value: FALL },
        uStreak: { value: STREAK },
        uWind: { value: WIND },
        uRain: { value: 0 },
        uColor: { value: new THREE.Color(0x8795a0) },
        uOpacity: { value: 0.5 },
      },
    });
    this.lines = new THREE.LineSegments(geometry, this.material);
    this.lines.name = 'rain';
    // Placed in the shader, around the camera: never outside the frustum it is drawn for.
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.renderOrder = 5;
    group.add(this.lines);
  }

  /** How hard it is raining, 0–1. */
  setLevel(level: number): void {
    this.level = level;
  }

  update(elapsed: number): void {
    const on = this.level > 0.01;
    this.lines.visible = on;
    if (!on) return;
    const u = this.material.uniforms;
    u.uCamera.value.copy(this.host.camera.position);
    u.uTime.value = elapsed;
    u.uRain.value = this.level;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.material.dispose();
    this.lines.removeFromParent();
  }
}
