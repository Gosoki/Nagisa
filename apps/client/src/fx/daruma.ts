/**
 * だるまさんがころんだ on the sand.
 * ================================
 *
 * The oni is a daruma: a big red roly-poly doll at the far end of the lane, with a white face
 * and two ink eyes. While it chants it faces away, out toward the breakwater; on the last
 * syllable it turns round — briskly, the one quick movement the island allows itself — with
 * the dry "kan!" of wooden clappers, rocks once on its round base, and faces the racers until
 * it turns away again. An indigo line across the sand is the start; a vermilion one, in front
 * of the doll, the goal.
 *
 * All of it is there only while a race is on (`daruma` store not null), and the turn is timed
 * like the card's: at the chant's `endsAt` on the server's clock, not when the look arrives,
 * so the doll, the card and the sound turn together for everyone. Library materials and a
 * handful of meshes, merged per material: a few draw calls, and nothing at all when hidden.
 */

import * as THREE from 'three';
import { DARUMA_COURSE, SCENE_COLORS, darumaCourseLength, darumaOni, heightAt, type DarumaView } from '@nagisa/shared';
import { inkDepthMaterial } from '../engine/ink/ink-material.js';
import { MAT_ID, plaster, surface, vermilion } from '../world/materials.js';
import { meshFrom, mergeByMaterial } from '../world/props/geometry.js';
import type { FxHost } from './index.js';
import { clapperVoice, placeSound } from './audio.js';
import { approach } from './materials.js';
import { barStrip } from './quiz-arena.js';

/** The same indigo as the quiz's ×: the island's other dye. */
const INDIGO = 0x4a6680;
const INDIGO_SHADOW = 0x3d566c;

/** The doll's body radius, metres, before it is stretched a little upright. */
const BODY_R = 0.85;
const UPRIGHT = 1.15;

/** Width of the painted lines, metres. */
const LINE_WIDTH = 0.3;

/** How fast the doll turns, per second (a whole turn in about a third of a second). */
const TURN_RATE = 9;
/** How fast its rocking dies away, per second, and how far it rocks, radians. */
const WOBBLE_DECAY = 2.2;
const WOBBLE_TILT = 0.12;

/** Beyond this the clappers are not heard, metres. */
const EARSHOT = 90;
/** A turn heard about later than this — arriving mid-look — is not sounded, ms. */
const LATE_MS = 800;

export class DarumaCourse {
  private readonly root = new THREE.Group();
  private readonly doll = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly oniYaw: number;
  private readonly oniAt: THREE.Vector3;

  private view: DarumaView | null = null;
  /** 0 = its back to the lane, 1 = facing it. */
  private facing = 1;
  private wobble = 0;
  private elapsed = 0;
  /** The turn last sounded, by the moment it happened (server ms). */
  private soundedTurn = 0;

  constructor(
    private readonly host: FxHost,
    group: THREE.Group,
  ) {
    const course = DARUMA_COURSE!;
    const oni = darumaOni()!;
    this.oniYaw = oni.yaw;
    this.oniAt = new THREE.Vector3(oni.x, heightAt(oni.x, oni.z), oni.z);
    this.root.name = 'daruma-course';
    this.root.visible = false;
    group.add(this.root);

    // The lines, square across the lane.
    const length = darumaCourseLength();
    const ux = (course.goal.x - course.start.x) / length;
    const uz = (course.goal.z - course.start.z) / length;
    const line = (x: number, z: number, material: THREE.Material): void => {
      const geometry = barStrip(
        x - uz * course.halfWidth,
        z + ux * course.halfWidth,
        x + uz * course.halfWidth,
        z - ux * course.halfWidth,
        LINE_WIDTH,
      );
      this.geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = true;
      this.root.add(mesh);
    };
    line(course.start.x, course.start.z, surface('daruma-indigo', { color: INDIGO, shadowColor: INDIGO_SHADOW, matId: MAT_ID.accent, hatch: 0.3 }));
    line(course.goal.x, course.goal.z, vermilion());

    this.buildDoll();
    this.doll.position.copy(this.oniAt);
    this.root.add(this.doll);
  }

  /** The `daruma` store changed. */
  setView(view: DarumaView | null): void {
    this.view = view;
    this.root.visible = view !== null;
  }

  update(dt: number): void {
    const view = this.view;
    if (!view) return;
    this.elapsed += dt;
    const now = this.host.serverNow();
    // Turned round: looking, or the chant has run out and the look is on its way. In the
    // lobby and at the finish it watches the lane too.
    const looking = view.phase !== 'walk' || now >= view.endsAt;
    if (view.phase === 'walk' || view.phase === 'look') {
      // The same moment whichever view says it: a look starts when its chant was due to end.
      const turnAt = view.phase === 'walk' ? view.endsAt : view.startedAt;
      if (looking && turnAt !== this.soundedTurn) {
        this.soundedTurn = turnAt;
        if (now - turnAt < LATE_MS) this.clack();
      }
    }
    const before = this.facing;
    this.facing = approach(this.facing, looking ? 1 : 0, dt, TURN_RATE);
    // Arriving at either end of a turn sets it rocking on its round base.
    if ((before < 0.98 && this.facing >= 0.98) || (before > 0.02 && this.facing <= 0.02)) this.wobble = 1;
    this.wobble = Math.max(0, this.wobble - WOBBLE_DECAY * dt);
    // Always turning the same way round, so the doll spins rather than flicks back and forth.
    this.doll.rotation.set(0, this.oniYaw + Math.PI * (1 - this.facing), Math.sin(this.elapsed * 13) * WOBBLE_TILT * this.wobble);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.root.removeFromParent();
  }

  /** The clappers, from where the doll stands. */
  private clack(): void {
    const sound = this.host.sfx();
    if (!sound) return;
    const input = placeSound(sound, this.oniAt, this.host.camera, EARSHOT, 1);
    if (input) clapperVoice(sound.ctx, input);
  }

  /**
   * A daruma: a red body a little taller than it is round, sitting on its base; a white face
   * on the front (local +z, which `rotation.y = yaw` turns toward `(sin yaw, cos yaw)`), and
   * two ink eyes. The face is a cap of a slightly larger sphere, so it follows the body's curve.
   */
  private buildDoll(): void {
    const parts: THREE.Mesh[] = [];
    const lift = BODY_R * UPRIGHT * 0.92;
    const body = meshFrom(new THREE.SphereGeometry(BODY_R, 14, 10), vermilion(), 0, lift, 0);
    body.scale.set(1, UPRIGHT, 1);
    parts.push(body);
    const face = meshFrom(
      new THREE.SphereGeometry(BODY_R * 1.015, 12, 6, Math.PI / 2 - 0.62, 1.24, 0.72, 1.02),
      plaster(),
      0,
      lift,
      0,
    );
    face.scale.set(1, UPRIGHT, 1);
    parts.push(face);
    const ink = surface('daruma-ink', { color: SCENE_COLORS.ink, shadowColor: SCENE_COLORS.ink, matId: MAT_ID.metal, hatch: 0 });
    for (const side of [-1, 1]) {
      const phi = Math.PI / 2 + side * 0.24;
      const theta = 1.12;
      const r = BODY_R * 1.03;
      parts.push(
        meshFrom(
          new THREE.IcosahedronGeometry(0.075, 1),
          ink,
          -r * Math.cos(phi) * Math.sin(theta),
          lift + r * Math.cos(theta) * UPRIGHT,
          r * Math.sin(phi) * Math.sin(theta),
        ),
      );
    }
    for (const mesh of mergeByMaterial(parts)) {
      mesh.customDepthMaterial = inkDepthMaterial();
      this.geometries.push(mesh.geometry);
      this.doll.add(mesh);
    }
    for (const part of parts) part.geometry.dispose();
  }
}
