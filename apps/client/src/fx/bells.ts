/**
 * Bells.
 * ======
 *
 * Someone rings one of the island's bells and everyone within earshot hears it: a bronze
 * note that carries across the water and takes ten seconds to die, and — for anyone who
 * can see the tower — three thin ink rings spreading out from the bell, the way a drawing
 * would show a sound. Nothing flashes and nothing swings; the rings are the only motion.
 */

import * as THREE from 'three';
import { LANDMARKS, getInteractable, heightAt, interactablePosition, SCENE_COLORS, type Landmark } from '@nagisa/shared';
import type { FxHost } from './index.js';
import { bellVoice, placeSound } from './audio.js';
import { ringMaterial, ringQuad } from './materials.js';

/** Beyond this a bell is not heard at all, metres. */
const EARSHOT = 120;

/** Rings per strike, the gap between them, and how long each takes to spread, seconds. */
const RINGS_PER_STRIKE = 3;
const RING_GAP = 0.45;
const RING_LIFE = 3.2;

/** How far a ring spreads, metres. */
const RING_REACH = 10;

/** Bell height inside the tower, before the landmark's scale: `bellTower` hangs it here. */
const BELL_HEIGHT = 2.5;

/** Strike note of a full-size tower, Hz. Smaller towers ring higher. */
const BELL_NOTE = 128;

/** How many rings can be spreading at once. Four towers rung together is the worst case. */
const POOL = 12;

interface Ripple {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** Seconds since this ring started; negative while it waits its turn. */
  age: number;
  active: boolean;
}

export class Bells {
  private readonly ripples: Ripple[] = [];
  private readonly geometry = ringQuad();
  private readonly at = new THREE.Vector3();
  /** Resolved bell positions, by interactable id. A tower does not move. */
  private readonly bellPositions = new Map<string, { position: THREE.Vector3; note: number }>();

  constructor(
    private readonly host: FxHost,
    group: THREE.Group,
  ) {
    for (let i = 0; i < POOL; i++) {
      const material = ringMaterial(SCENE_COLORS.ink);
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.scale.setScalar(RING_REACH + 1);
      material.uniforms.uScale.value = RING_REACH + 1;
      material.uniforms.uWidth.value = 0.09;
      material.uniforms.uWobble.value = 0.12;
      mesh.renderOrder = 3;
      group.add(mesh);
      this.ripples.push({ mesh, material, age: 0, active: false });
    }
  }

  /** A bell was rung. `id` is the interactable. */
  ring(id: string): void {
    const bell = this.locate(id);
    if (!bell) return;

    const sound = this.host.sfx();
    if (sound) {
      const input = placeSound(sound, bell.position, this.host.camera, EARSHOT, 1);
      if (input) bellVoice(sound.ctx, input, bell.note);
    }

    // Rings only for someone who could plausibly see them; a ring nobody can see still
    // costs a draw call.
    if (bell.position.distanceTo(this.host.camera.position) > this.host.quality.drawDistance * 0.5) return;
    for (let i = 0; i < RINGS_PER_STRIKE; i++) {
      const ripple = this.ripples.find((r) => !r.active) ?? this.oldest();
      ripple.active = true;
      ripple.age = -i * RING_GAP;
      ripple.mesh.position.copy(bell.position);
      ripple.material.uniforms.uSeed.value = Math.random() * 10;
    }
  }

  update(dt: number): void {
    for (const ripple of this.ripples) {
      if (!ripple.active) continue;
      ripple.age += dt;
      if (ripple.age >= RING_LIFE) {
        ripple.active = false;
        ripple.mesh.visible = false;
        continue;
      }
      if (ripple.age < 0) {
        ripple.mesh.visible = false;
        continue;
      }
      const t = ripple.age / RING_LIFE;
      // Fast at first and slowing, like a ripple on water; fading all the way.
      const spread = 1 - (1 - t) * (1 - t);
      ripple.mesh.visible = true;
      ripple.material.uniforms.uRadius.value = 1.1 + spread * (RING_REACH - 1.1);
      ripple.material.uniforms.uOpacity.value = 0.55 * (1 - t) * Math.min(1, ripple.age / 0.15);
    }
  }

  dispose(): void {
    for (const ripple of this.ripples) {
      ripple.material.dispose();
      ripple.mesh.removeFromParent();
    }
    this.geometry.dispose();
  }

  private oldest(): Ripple {
    return this.ripples.reduce((a, b) => (a.age > b.age ? a : b));
  }

  /**
   * Where the bell hangs and what note it strikes: the `bell-tower` landmark nearest the
   * interactable (the prompt stands beside the tower, not in it), at the bell's height in
   * that tower — read from the tower as placed, since `island.ts` sets it on the highest
   * corner of its footprint rather than at the ground under its centre.
   */
  private locate(id: string): { position: THREE.Vector3; note: number } | null {
    const known = this.bellPositions.get(id);
    if (known) return known;
    const interactable = getInteractable(id);
    if (!interactable) return null;
    const near = interactablePosition(interactable);

    let tower: Landmark | null = null;
    let best = Infinity;
    for (const landmark of LANDMARKS) {
      if (landmark.kind !== 'bell-tower') continue;
      const d = Math.hypot(landmark.x - near.x, landmark.z - near.z);
      if (d < best) {
        best = d;
        tower = landmark;
      }
    }

    const scale = tower?.scale ?? 1;
    const placed = tower ? this.host.scene.getObjectByName(tower.id) : undefined;
    const x = tower?.x ?? near.x;
    const z = tower?.z ?? near.z;
    const ground = placed ? placed.getWorldPosition(this.at).y : heightAt(x, z);
    const resolved = { position: new THREE.Vector3(x, ground + BELL_HEIGHT * scale, z), note: BELL_NOTE / scale };
    this.bellPositions.set(id, resolved);
    return resolved;
  }
}
