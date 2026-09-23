/**
 * The lighthouse lamp.
 * ====================
 *
 * The lighthouse already has a lamp: a glowing optic, a child of the tower named `lamp`,
 * that `island.ts` turns every frame (see `world/props/buildings.ts#lighthouse`). What it
 * does not have is a *beam* — and a lamp that turns in daylight with nothing coming out of
 * it is exactly right for the rest of the day.
 *
 * While a `lamp` activity is live, this adds the beam: a long, soft cone of light hung on
 * that same `lamp` group, so it sweeps with the optic the island already turns rather than
 * being a second, separately-timed lighthouse. It comes up slowly over a few seconds, and
 * only really shows once the sky is going dark — at noon a beam is invisible, as it should
 * be, and the lamp lighting is held at dusk precisely so that it is not.
 *
 * The cone is additive light, never outlined, and does not disturb the contour pass (see
 * `fx/materials.ts`); the headland in front of it still hides it.
 */

import * as THREE from 'three';
import { LANDMARKS } from '@nagisa/shared';
import { inkLighting } from '../engine/ink/ink-material.js';
import type { FxHost } from './index.js';
import { FX_OUTPUTS, approach, fxMaterial, smoothstep } from './materials.js';

/** Beam length and its radius at the lamp and at the far end, metres (tower scale 1). */
const LENGTH = 78;
const NEAR_RADIUS = 0.55;
const FAR_RADIUS = 9;

const VERTEX = /* glsl */ `
out float vAlong;
out float vFacing;
void main() {
  // The cylinder's v runs 1 at the lamp to 0 at the far end.
  vAlong = 1.0 - uv.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  // How squarely this bit of the cone faces the eye: edge-on is the cone's silhouette,
  // which is where a beam of light has least in it, so that is where it fades.
  vFacing = abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
in float vAlong;
in float vFacing;
${FX_OUTPUTS}
void main() {
  float a = pow(1.0 - vAlong, 1.7) * smoothstep(0.0, 0.7, vFacing) * uStrength;
  if (a < 0.003) discard;
  gColor = vec4(uColor, a);
  gInfo = vec4(0.0);
}
`;

export class LighthouseBeam {
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly beam: THREE.Mesh;
  /** The island's `lamp` group, found on first need: the island is built after the fx. */
  private lamp: THREE.Object3D | null | undefined;
  private live = false;
  private level = 0;

  constructor(private readonly host: FxHost) {
    // Narrow end at the origin, opening along +z — the way the optic's own glow points.
    this.geometry = new THREE.CylinderGeometry(NEAR_RADIUS, FAR_RADIUS, LENGTH, 18, 1, true)
      .translate(0, -LENGTH / 2, 0)
      .rotateX(-Math.PI / 2);
    this.material = fxMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      blend: 'add',
      // Both faces: standing inside the beam is standing in light, not outside a hollow cone.
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(0xfff0cc) }, uStrength: { value: 0 } },
    });
    this.beam = new THREE.Mesh(this.geometry, this.material);
    this.beam.name = 'lamp-beam';
    this.beam.visible = false;
    this.beam.renderOrder = 4;
  }

  /** Whether a lamp lighting is live. */
  setLive(live: boolean): void {
    this.live = live;
  }

  update(dt: number): void {
    const dark = smoothstep(0.2, 0.75, inkLighting.uNight.value);
    this.level = approach(this.level, this.live ? dark : 0, dt, 0.7);
    if (this.level < 0.005) {
      this.beam.visible = false;
      return;
    }
    const lamp = this.findLamp();
    if (!lamp) return;
    if (this.beam.parent !== lamp) lamp.add(this.beam);
    this.material.uniforms.uStrength.value = this.level * 0.3;
    this.beam.visible = true;
  }

  dispose(): void {
    this.beam.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  private findLamp(): THREE.Object3D | null {
    if (this.lamp === undefined) {
      const tower = LANDMARKS.find((l) => l.kind === 'lighthouse');
      // A map with no lighthouse has no beam, for good. One whose tower is not built yet is
      // looked for again next time rather than remembered as missing.
      if (!tower) this.lamp = null;
      else this.lamp = this.host.scene.getObjectByName(tower.id)?.getObjectByName('lamp') ?? undefined;
    }
    return this.lamp ?? null;
  }
}
