/**
 * The local player.
 * =================
 *
 * Movement is **client-predicted**: your character responds to your input on the very
 * next frame, with no round trip. The server validates the result and corrects you only
 * when you have gone somewhere you should not be (see `player.ts` on the server).
 *
 * This is the right trade for a social world. Server-authoritative movement with
 * reconciliation would cost 100–200 ms of input lag on a transatlantic connection, and
 * would buy protection against a threat model — speed-hacking in a world with no
 * competition and nothing to win — that barely exists here. What the server *does*
 * enforce is that you are on the island and moving at a plausible speed, which is enough
 * to keep the shared space coherent.
 *
 * ### Physics
 * Deliberately simple, and entirely against the analytic height field:
 * - horizontal velocity is accelerated toward the input direction and damped;
 * - vertical velocity integrates gravity;
 * - the ground is `heightAt(x, z)`, so there is no collision mesh, no BVH and no
 *   raycast — a ground query is one function call;
 * - slopes steeper than the walkable limit push you back downhill instead of blocking,
 *   which prevents the "stuck on an invisible wall" feeling at cliff edges;
 * - the sea is a soft boundary: you can wade, you slow down, and past a depth you are
 *   gently turned around. No invisible walls anywhere on the island.
 */

import * as THREE from 'three';
import {
  AnimState,
  GRAVITY,
  JUMP_VELOCITY,
  MAX_CLIENT_SPEED,
  MAX_WADE_DEPTH,
  MAX_WALKABLE_SLOPE,
  MOVE_SPEED,
  footingDownhill,
  footingSlopeAt,
  heightAt,
  canEnterFrom,
  illegality,
  nearestWalkable,
} from '@nagisa/shared';
import type { CameraRig } from '../engine/camera-rig.js';
import type { Input } from '../input/input.js';
import { Character, type CharacterAppearance } from './character.js';

/**
 * Ground speeds. Imported, never authored here — see `@nagisa/shared/movement` for why the
 * client and the server must not hold their own copies of these numbers.
 */
const WALK_SPEED = MOVE_SPEED.walk;
const RUN_SPEED = MOVE_SPEED.run;

/** Speed while wading. Slow enough that walking into the sea feels like a decision. */
const WADE_SPEED = MOVE_SPEED.wade;

/** Depth past which the player is turned back toward shore. */


/** Horizontal acceleration and damping, per second. */
const ACCELERATION = 26;
const DAMPING = 14;




/** Vertical distance within which the character counts as standing on the ground. */
const GROUND_EPSILON = 0.08;

/** How fast the character turns to face its direction of travel, radians per second. */
const TURN_RATE = 11;

export class LocalPlayer {
  readonly character: Character;

  /** Feet position in world space. This is what gets networked. */
  readonly position = new THREE.Vector3();

  /** Facing, radians. Networked. */
  yaw = 0;

  private readonly velocity = new THREE.Vector3();
  private grounded = true;

  /** Set while the player is attached to a seat; suppresses movement input. */
  private seated = false;

  /** Set while a scripted move is running (walking to an activity slot). */
  private autoWalkTarget: THREE.Vector3 | null = null;
  private autoWalkResolve: (() => void) | null = null;

  /** Scratch vectors — allocating in the update loop is how frame times die. */
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();

  constructor(
    appearance: CharacterAppearance,
    private readonly input: Input,
    private readonly camera: CameraRig,
  ) {
    this.character = new Character(appearance);
  }

  /** Place the character, cancelling any motion. Used on spawn and on room switch. */
  teleport(x: number, y: number, z: number, yaw = this.yaw): void {
    this.position.set(x, y, z);
    this.yaw = yaw;
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.autoWalkTarget = null;
    this.syncTransform();
  }

  /** Apply a server correction. Hard snap — blending would fight the server. */
  applyCorrection(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.syncTransform();
  }

  /** Current horizontal speed, m/s. Used to pick the animation state. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  /** Sit down / stand up. Seated players do not accept movement input. */
  setSeated(seated: boolean): void {
    this.seated = seated;
    if (seated) this.velocity.set(0, 0, 0);
    this.character.setAnim(seated ? AnimState.Sit : AnimState.Idle);
  }

  /**
   * Walk the character to a point automatically, resolving when it arrives.
   *
   * Joining an activity uses this rather than teleporting: being moved somewhere while
   * you watch is a very different feeling from blinking there, and preserving the walk
   * is most of what keeps the world continuous.
   */
  walkTo(x: number, z: number): Promise<void> {
    const [wx, wz] = nearestWalkable(x, z);
    this.autoWalkTarget = new THREE.Vector3(wx, heightAt(wx, wz), wz);
    return new Promise((resolve) => {
      this.autoWalkResolve = resolve;
    });
  }

  /** True while a scripted walk is in progress. See {@link walkTo}. */
  get autoWalking(): boolean {
    return this.autoWalkTarget !== null;
  }

  /** Cancel an automatic walk — any manual input does this. */
  cancelWalkTo(): void {
    this.autoWalkTarget = null;
    this.autoWalkResolve?.();
    this.autoWalkResolve = null;
  }

  /**
   * Fixed-step physics. Runs at 60 Hz regardless of frame rate.
   */
  fixedUpdate(dt: number): void {
    this.resolveIntent(this.tmpDir);

    const depth = -Math.min(0, heightAt(this.position.x, this.position.z));
    const wading = depth > 0.15;
    const maxSpeed = wading ? WADE_SPEED : this.input.run && !this.seated ? RUN_SPEED : WALK_SPEED;

    // Horizontal: accelerate toward the intended velocity, then damp.
    if (this.tmpDir.lengthSq() > 0.0001) {
      this.velocity.x += this.tmpDir.x * maxSpeed * ACCELERATION * dt;
      this.velocity.z += this.tmpDir.z * maxSpeed * ACCELERATION * dt;
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      if (speed > maxSpeed) {
        this.velocity.x = (this.velocity.x / speed) * maxSpeed;
        this.velocity.z = (this.velocity.z / speed) * maxSpeed;
      }
    } else {
      const damp = Math.max(0, 1 - DAMPING * dt);
      this.velocity.x *= damp;
      this.velocity.z *= damp;
    }

    // Jump. Only from the ground, and never while seated or wading deep.
    if (this.input.consumeJump() && this.grounded && !this.seated && depth < 0.6) {
      this.velocity.y = JUMP_VELOCITY;
      this.grounded = false;
    }

    this.velocity.y -= GRAVITY * dt;

    // Whatever produced the horizontal velocity — input, a downhill slide, a shove out of
    // deep water — it is clamped here, once, before it can move anything. The server
    // measures speed between arrivals and corrects anything over budget, so a slide
    // impulse that bypassed the input clamp used to be enough on its own to get a running
    // player yanked backwards. See `@nagisa/shared/movement`.
    const planar = Math.hypot(this.velocity.x, this.velocity.z);
    if (planar > MAX_CLIENT_SPEED) {
      this.velocity.x = (this.velocity.x / planar) * MAX_CLIENT_SPEED;
      this.velocity.z = (this.velocity.z / planar) * MAX_CLIENT_SPEED;
    }

    // Integrate horizontally, then resolve against the terrain.
    const nextX = this.position.x + this.velocity.x * dt;
    const nextZ = this.position.z + this.velocity.z * dt;

    if (this.canOccupy(nextX, nextZ)) {
      this.position.x = nextX;
      this.position.z = nextZ;
    } else {
      // Slide along the obstacle rather than stopping dead: try each axis alone, which
      // is a cheap approximation of projecting velocity onto the surface and is what
      // makes walking along a cliff edge feel smooth.
      if (this.canOccupy(nextX, this.position.z)) {
        this.position.x = nextX;
        this.velocity.z *= 0.4;
      } else if (this.canOccupy(this.position.x, nextZ)) {
        this.position.z = nextZ;
        this.velocity.x *= 0.4;
      } else {
        this.velocity.x *= 0.2;
        this.velocity.z *= 0.2;
      }
    }

    // Vertical: integrate, then clamp to the ground.
    this.position.y += this.velocity.y * dt;
    const groundY = heightAt(this.position.x, this.position.z);
    // Standing in shallow water rests on the sea floor, not at sea level; the character
    // is knee-deep rather than walking on the surface.
    const floorY = groundY;

    if (this.position.y <= floorY + GROUND_EPSILON) {
      this.position.y = floorY;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.grounded = true;

      // On too-steep ground, slide downhill. This is the escape hatch that means a player
      // can never be permanently stuck on a cliff face — but it is only ever reached when
      // the player is *already* somewhere illegal (terrain retuned under a standing
      // player, a drifted spawn), because `canOccupy` no longer lets them walk onto it.
      //
      // Measured with the same footing fit as the contract, and pushed down the same fitted
      // plane. A slide that disagreed with the test that triggered it would shove the player
      // *along* a face they are not allowed to be on, one frame at a time, forever.
      if (footingSlopeAt(this.position.x, this.position.z) > MAX_WALKABLE_SLOPE) {
        const [dx, dz] = footingDownhill(this.position.x, this.position.z);
        this.velocity.x += dx * 24 * dt;
        this.velocity.z += dz * 24 * dt;
      }
    } else {
      this.grounded = false;
    }

    // Deep water: push back toward the shore. Same as the slide above — `canOccupy` keeps
    // the player out of water this deep in the first place, so this only runs as a
    // recovery when they are somehow already in it.
    if (depth > MAX_WADE_DEPTH) {
      const [sx, sz] = nearestWalkable(this.position.x, this.position.z, 60);
      const dx = sx - this.position.x;
      const dz = sz - this.position.z;
      const len = Math.hypot(dx, dz) || 1;
      this.velocity.x += (dx / len) * 9 * dt;
      this.velocity.z += (dz / len) * 9 * dt;
    }

    this.updateFacing(dt);
    this.updateAnimState(wading);
    this.syncTransform();
  }

  /** Per-frame visual update: character animation. */
  update(dt: number): void {
    this.character.update(dt);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Resolve movement intent into a world-space unit direction.
   *
   * Input is camera-relative — pushing "forward" means "away from the camera", which is
   * the only scheme that stays intuitive while the camera orbits.
   */
  private resolveIntent(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    if (this.seated) return out;

    // A scripted walk overrides manual input, but any manual input cancels it.
    if (this.autoWalkTarget) {
      const dx = this.autoWalkTarget.x - this.position.x;
      const dz = this.autoWalkTarget.z - this.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.0) {
        this.cancelWalkTo();
        return out;
      }
      if (Math.abs(this.input.move.x) > 0.05 || Math.abs(this.input.move.y) > 0.05) {
        this.cancelWalkTo();
      } else {
        return out.set(dx / dist, 0, dz / dist);
      }
    }

    const mx = this.input.move.x;
    const my = this.input.move.y;
    if (Math.abs(mx) < 0.04 && Math.abs(my) < 0.04) return out;

    this.camera.forward(this.tmpForward);
    this.camera.right(this.tmpRight);
    out.addScaledVector(this.tmpForward, my).addScaledVector(this.tmpRight, mx);
    if (out.lengthSq() > 1) out.normalize();
    return out;
  }

  /**
   * Whether the character may stand at a horizontal position.
   *
   * Permissive by design: the only hard rejections are leaving the map and climbing
   * something unclimbable. Note the `currentDepth` argument — a player already wading is
   * allowed to keep wading, so you never get trapped in the shallows by a rule that says
   * "you may not enter water".
   */
  private canOccupy(x: number, z: number): boolean {
    // Not `isWalkable`: that is symmetric, and refuses the ground past a clifftop from the
    // clifftop as firmly as it refuses the clifftop from below. `canEnterFrom` keeps the
    // refusal for climbing and drops it for descending, which is how you get off a ledge.
    if (canEnterFrom(this.position.x, this.position.z, x, z)) return true;

    // Escape hatch. If the player is *already* somewhere the contract forbids — terrain
    // retuned under a standing player, a spawn point that drifted, a correction that
    // landed badly — refusing every move would weld them in place. So an illegal move is
    // allowed, but only from an illegal position, and only when it makes the situation
    // strictly better. That is enough to walk out of anywhere and impossible to abuse to
    // walk *into* somewhere.
    const here = illegality(this.position.x, this.position.z);
    return here > 0 && illegality(x, z) < here;
  }

  /** Turn to face the direction of travel. */
  private updateFacing(dt: number): void {
    const speed = this.speed;
    if (speed < 0.25) return;
    const desired = Math.atan2(this.velocity.x, this.velocity.z);
    // Shortest-arc interpolation; without the wrap the character spins the long way
    // round every time it crosses ±π.
    let delta = desired - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.yaw += delta * Math.min(1, TURN_RATE * dt);
  }

  /** Pick the animation state from the physics state. */
  private updateAnimState(wading: boolean): void {
    if (this.seated) {
      this.character.setAnim(AnimState.Sit);
      return;
    }
    if (!this.grounded) {
      this.character.setAnim(this.velocity.y > 0.6 ? AnimState.Jump : AnimState.Fall);
      return;
    }
    const speed = this.speed;
    if (speed < 0.35) this.character.setAnim(AnimState.Idle);
    else if (speed < WALK_SPEED * 1.15 || wading) this.character.setAnim(AnimState.Walk);
    else this.character.setAnim(AnimState.Run);
  }

  /** Push the authoritative transform onto the visual object. */
  private syncTransform(): void {
    this.character.root.position.copy(this.position);
    this.character.root.rotation.y = this.yaw;
  }
}
