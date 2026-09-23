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
 *
 * - **Vistas.** At a lookout the camera is lent to the view for a few seconds: it eases
 *   once into a framing the map authored — looking along the view, pitched down over it,
 *   pulled back so you stand in the foreground — holds it, and gives itself back the
 *   moment you move. See {@link CameraRig.setVista}.
 */

import * as THREE from 'three';
import { getInteractable, heightAt } from '@nagisa/shared';
import type { Input } from '../input/input.js';
import { vista } from '../state/stores.js';

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

/** A lookout's authored framing: `Interactable.view`. */
export interface VistaView {
  /** Bearing to look along, in the world's convention: toward `(sin yaw, cos yaw)`. */
  readonly yaw: number;
  /** How far below level to look, radians. */
  readonly pitch: number;
  /** How far behind the viewer to stand back, metres. */
  readonly distance?: number;
}

/** Seconds the camera takes to go into a vista, and to come back out of it. */
const VISTA_EASE_SECONDS = 1.2;

/** A vista gives the camera back on its own after this long, seconds. */
const VISTA_HOLD_SECONDS = 9;

/** Stand-back when the map gives none, metres. */
const VISTA_DEFAULT_DISTANCE = 16;

/** The point a vista is framed around: the viewer's shoulders, so they stand in the shot. */
const VISTA_ANCHOR_HEIGHT = 1.5;

/** Stick or key travel that counts as "I want to walk", and so ends a vista. */
const MOVE_DEADZONE = 0.12;

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

  /** The vista being taken in, or null. Mirrored from the `vista` store. */
  private vistaView: VistaView | null = null;
  /** Seconds the current vista has been held, for its time limit. */
  private vistaHeld = 0;
  /**
   * How far into the vista the camera is, 0–1, advanced linearly and eased on use. Kept
   * after the vista ends so the way back out is the same one slow ease as the way in.
   */
  private vistaBlend = 0;
  /** The vista the camera is easing out of, framed until the blend reaches zero. */
  private vistaFraming: VistaView | null = null;

  private readonly vistaPos = new THREE.Vector3();
  private readonly vistaTarget = new THREE.Vector3();
  private readonly blendTarget = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly input: Input,
  ) {
    // Subscribed once and mirrored into a field: the frame loop reads the field, never the
    // store. The interface opens a vista by setting the store (a lookout's prompt) and may
    // close it (its own button); the rig closes it itself when the player moves or the hold
    // runs out. Lives as long as the page, like the rig.
    vista.subscribe((v) => this.setVista(v ? (getInteractable(v.id)?.view ?? null) : null));
  }

  /**
   * Take in a view, or give it back.
   *
   * Going in, the orbit is turned to face the same way — invisibly, underneath the vista —
   * so that coming out is a pull-in toward the usual framing rather than the camera
   * swinging back round to wherever it was before. You leave a lookout facing the view.
   */
  setVista(view: VistaView | null): void {
    this.vistaView = view;
    this.vistaHeld = 0;
    if (!view) return;
    this.vistaFraming = view;
    this.yaw = view.yaw + Math.PI;
  }

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
    // Looking around is suspended while a vista holds the camera: the view is the point.
    if (!this.locked && !this.vistaView) {
      this.yaw -= this.input.look.x;
      this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch + this.input.look.y));
    }
    this.input.clearLook();
    this.advanceVista(dt);

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

    // Sine in-out: one slow ease with no overshoot, the same shape going in and coming out.
    const ease = 0.5 - 0.5 * Math.cos(Math.PI * this.vistaBlend);
    if (ease > 0 && this.vistaFraming) {
      this.frameVista(this.vistaFraming, subject);
      this.camera.position.lerpVectors(this.smoothPos, this.vistaPos, ease);
      this.camera.lookAt(this.blendTarget.lerpVectors(this.smoothTarget, this.vistaTarget, ease));
    } else {
      this.camera.position.copy(this.smoothPos);
      this.camera.lookAt(this.smoothTarget);
    }

    // A slightly longer lens for the view, eased with it.
    const fov = this.spec.fov * (1 - 0.1 * ease);

    // Only touch the projection matrix when the FOV has actually moved; it is a matrix
    // rebuild and it happens every frame otherwise.
    if (Math.abs(this.camera.fov - fov) > 0.02) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Run the vista's clock: ease toward it while one is set, away from it when not, and end
   * it — through the store, so the interface hears — on movement input or when the hold
   * runs out. Movement still moves you; it just takes the camera back on the way.
   */
  private advanceVista(dt: number): void {
    if (this.vistaView) {
      this.vistaHeld += dt;
      const moving = Math.abs(this.input.move.x) > MOVE_DEADZONE || Math.abs(this.input.move.y) > MOVE_DEADZONE;
      if (moving || this.vistaHeld > VISTA_HOLD_SECONDS) {
        vista.set(null);
      }
    }
    const step = dt / VISTA_EASE_SECONDS;
    this.vistaBlend = this.vistaView ? Math.min(1, this.vistaBlend + step) : Math.max(0, this.vistaBlend - step);
    if (this.vistaBlend === 0 && !this.vistaView) this.vistaFraming = null;
  }

  /**
   * Where the camera stands for a vista: back along the view from the viewer's shoulders by
   * the authored distance, looking exactly along the view — its bearing, pitched down by
   * its pitch. Recomputed from the subject every frame, so it holds on them.
   */
  private frameVista(view: VistaView, subject: THREE.Vector3): void {
    const level = Math.cos(view.pitch);
    const dx = Math.sin(view.yaw) * level;
    const dy = -Math.sin(view.pitch);
    const dz = Math.cos(view.yaw) * level;
    const distance = view.distance ?? VISTA_DEFAULT_DISTANCE;
    const ax = subject.x;
    const ay = subject.y + VISTA_ANCHOR_HEIGHT;
    const az = subject.z;

    this.vistaPos.set(ax - dx * distance, ay - dy * distance, az - dz * distance);
    const floor = Math.max(heightAt(this.vistaPos.x, this.vistaPos.z), 0) + 1.1;
    if (this.vistaPos.y < floor) this.vistaPos.y = floor;
    this.vistaTarget.set(ax + dx * 20, ay + dy * 20, az + dz * 20);
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
