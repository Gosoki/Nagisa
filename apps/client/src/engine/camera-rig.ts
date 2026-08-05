/**
 * Third-person camera.
 * ====================
 *
 * The camera is most of the "camera language" the product borrows from its reference:
 * a following orbit that sits a little above and behind the character, frames the world
 * rather than the player, and never moves faster than the eye can follow.
 *
 * Behaviours worth knowing about:
 *
 * - **Critically-damped follow.** Position and target are smoothed with a
 *   frame-rate-independent exponential decay. No springs — a spring overshoots, and an
 *   overshooting camera in a calm world reads as seasickness.
 *
 * - **Terrain-aware.** The camera never goes underground: it lifts to clear the height
 *   field and rises out of the sea, so backing into a hillside pushes it up and over
 *   rather than inside.
 *
 * - **Framing by context.** Standing still in a scenic zone widens and pulls back;
 *   moving, or standing in a crowd, tightens in. The scene director sets a framing hint
 *   and the rig eases toward it, which is how the reference product's camera "breathes"
 *   without ever taking control away.
 */

import * as THREE from 'three';
import { heightAt } from '@nagisa/shared';
import type { Input } from '../input/input.js';

/** How the camera should frame the subject right now. */
export type Framing = 'default' | 'wide' | 'close' | 'cinematic';

interface FramingSpec {
  /** Distance behind the subject, metres. */
  distance: number;
  /** Height above the subject's feet the camera sits at. */
  height: number;
  /** Height above the feet the camera looks at. */
  targetHeight: number;
  /** Vertical field of view. */
  fov: number;
}

const FRAMINGS: Record<Framing, FramingSpec> = {
  // The everyday view: close enough to read your own character, wide enough that the
  // island is the subject.
  default: { distance: 10.5, height: 3.4, targetHeight: 1.3, fov: 50 },
  // Lookouts and the cape. Pulls back and flattens out to show the horizon.
  wide: { distance: 16.0, height: 5.0, targetHeight: 1.6, fov: 56 },
  // Interiors, the teahouse, dense crowds. Tightens so the camera stops fighting walls.
  close: { distance: 6.8, height: 2.4, targetHeight: 1.2, fov: 46 },
  // Held during an activity's opening moments. Long lens, low, deliberate.
  cinematic: { distance: 13.0, height: 2.4, targetHeight: 1.35, fov: 38 },
};

/** Pitch limits, radians. Stops short of straight down and of the horizon flipping. */
const MIN_PITCH = -0.35;
const MAX_PITCH = 1.15;

export class CameraRig {
  /** Orbit yaw, radians. Also the direction "forward" means for movement. */
  yaw = Math.PI;

  /** Orbit pitch, radians. Positive looks down at the subject. */
  pitch = 0.32;

  private framing: Framing = 'default';
  private readonly spec: FramingSpec = { ...FRAMINGS.default };

  /** Smoothed camera position and look-at target. */
  private readonly smoothPos = new THREE.Vector3();
  private readonly smoothTarget = new THREE.Vector3();

  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();

  private initialised = false;

  /** Set true while the UI wants the camera to ignore input (e.g. entry screen). */
  locked = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly input: Input,
  ) {}

  /** Request a framing. The rig eases toward it over roughly a second. */
  setFraming(framing: Framing): void {
    this.framing = framing;
  }

  get currentFraming(): Framing {
    return this.framing;
  }

  /**
   * Update the camera to follow `subject` (the character's feet position).
   *
   * `dt` is real elapsed time — the smoothing is computed as an exponential decay over
   * it, so the camera behaves identically at 30 and at 144 fps.
   */
  update(dt: number, subject: THREE.Vector3): void {
    if (!this.locked) {
      this.yaw -= this.input.look.x;
      this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch + this.input.look.y));
    }
    this.input.clearLook();

    // Ease the framing spec toward the requested one.
    const goal = FRAMINGS[this.framing];
    const fk = 1 - Math.exp(-dt * 2.2);
    this.spec.distance += (goal.distance - this.spec.distance) * fk;
    this.spec.height += (goal.height - this.spec.height) * fk;
    this.spec.targetHeight += (goal.targetHeight - this.spec.targetHeight) * fk;
    this.spec.fov += (goal.fov - this.spec.fov) * fk;

    // Orbit position. Pitch lifts the camera and shortens its horizontal reach, which is
    // what makes looking down feel like craning over rather than sliding under.
    const horizontal = Math.cos(this.pitch) * this.spec.distance;
    const vertical = Math.sin(this.pitch) * this.spec.distance;

    this.desiredPos.set(
      subject.x + Math.sin(this.yaw) * horizontal,
      subject.y + this.spec.height + vertical,
      subject.z + Math.cos(this.yaw) * horizontal,
    );
    this.desiredTarget.set(subject.x, subject.y + this.spec.targetHeight, subject.z);

    // Keep the camera above the ground and above the waterline. A metre of clearance is
    // enough that the near plane never clips into a slope.
    const groundY = heightAt(this.desiredPos.x, this.desiredPos.z);
    const floor = Math.max(groundY, 0) + 1.1;
    if (this.desiredPos.y < floor) this.desiredPos.y = floor;

    if (!this.initialised) {
      this.smoothPos.copy(this.desiredPos);
      this.smoothTarget.copy(this.desiredTarget);
      this.initialised = true;
    } else {
      // Position lags slightly more than the look target: the world swings before the
      // camera catches up, which reads as weight rather than lag.
      const posK = 1 - Math.exp(-dt * 6.5);
      const tgtK = 1 - Math.exp(-dt * 9.0);
      this.smoothPos.lerp(this.desiredPos, posK);
      this.smoothTarget.lerp(this.desiredTarget, tgtK);
    }

    this.camera.position.copy(this.smoothPos);
    this.camera.lookAt(this.smoothTarget);

    // Only touch the projection matrix when the FOV has actually moved; it is a matrix
    // rebuild and it happens every frame otherwise.
    if (Math.abs(this.camera.fov - this.spec.fov) > 0.02) {
      this.camera.fov = this.spec.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Snap the camera to its ideal position without smoothing.
   * Used on spawn and after a room switch, where easing in from the previous position
   * would fly the camera across the island.
   */
  snap(subject: THREE.Vector3): void {
    this.initialised = false;
    this.update(1 / 60, subject);
  }

  /** Direction the camera is facing, flattened to the ground plane. */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
  }

  /** Rightward direction on the ground plane. */
  right(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();
  }
}
