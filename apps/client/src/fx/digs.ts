/**
 * Where a spade went in.
 * ======================
 *
 * A dig throws up a small ring of sand at the digger's feet — seen by everyone near, like the
 * heat over their head (see `onEvent` in index.ts) — and a find a wider ring of gold where
 * the thing came up. Pooled rings through the effects materials, the bells' ripple drawn
 * short and in the colours of sand.
 */

import * as THREE from 'three';
import type { PlayerId, Vec3 } from '@nagisa/shared';
import type { FxHost } from './index.js';
import { ringMaterial, ringQuad } from './materials.js';

/** Rings at once: a crowd digging together. */
const POOL = 10;

const SAND = 0xc9b48a;
const GOLD = 0xe2b64a;

interface Ring {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  age: number;
  life: number;
  reach: number;
  active: boolean;
}

export class Digs {
  private readonly rings: Ring[] = [];
  private readonly geometry = ringQuad();

  constructor(
    private readonly host: FxHost,
    group: THREE.Group,
  ) {
    for (let i = 0; i < POOL; i++) {
      const material = ringMaterial(SAND);
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      material.uniforms.uWidth.value = 0.14;
      material.uniforms.uWobble.value = 0.18;
      group.add(mesh);
      this.rings.push({ mesh, material, age: 0, life: 1, reach: 1, active: false });
    }
  }

  /** Someone dug. */
  dug(by: PlayerId): void {
    const at = this.host.playerPosition(by);
    if (at) this.start(at.x, at.y, at.z, SAND, 1.3, 0.8);
  }

  /** Something came up at `pos`. */
  found(pos: Vec3): void {
    this.start(pos[0], pos[1], pos[2], GOLD, 3.2, 1.6);
  }

  update(dt: number): void {
    for (const ring of this.rings) {
      if (!ring.active) continue;
      ring.age += dt;
      if (ring.age >= ring.life) {
        ring.active = false;
        ring.mesh.visible = false;
        continue;
      }
      const t = ring.age / ring.life;
      const spread = 1 - (1 - t) * (1 - t);
      ring.material.uniforms.uRadius.value = 0.2 + spread * (ring.reach - 0.2);
      ring.material.uniforms.uOpacity.value = 0.75 * (1 - t);
      ring.mesh.visible = true;
    }
  }

  dispose(): void {
    for (const ring of this.rings) {
      ring.material.dispose();
      ring.mesh.removeFromParent();
    }
    this.geometry.dispose();
  }

  private start(x: number, y: number, z: number, color: number, reach: number, life: number): void {
    // Only for someone who could see it.
    const camera = this.host.camera.position;
    if (Math.hypot(camera.x - x, camera.z - z) > this.host.quality.drawDistance * 0.5) return;
    const ring = this.rings.find((r) => !r.active) ?? this.rings.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    ring.active = true;
    ring.age = 0;
    ring.life = life;
    ring.reach = reach;
    ring.mesh.position.set(x, y + 0.04, z);
    ring.mesh.scale.setScalar(reach + 0.4);
    ring.material.uniforms.uScale.value = reach + 0.4;
    ring.material.uniforms.uColor.value.setHex(color);
    ring.material.uniforms.uSeed.value = Math.random() * 10;
  }
}
