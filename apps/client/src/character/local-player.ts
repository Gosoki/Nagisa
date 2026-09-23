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
  isSliverAt,
  nearestWalkable,
  routeTo,
} from '@nagisa/shared';
import type { CameraRig } from '../engine/camera-rig.js';
import type { Input } from '../input/input.js';
import { benchSeat, type BenchSeat } from '../world/props/furniture.js';
import { Character, type CharacterAppearance } from './character.js';

/**
 * Ground speeds. Imported, never authored here — see `@nagisa/shared/movement` for why the
 * client and the server must not hold their own copies of these numbers.
 */
const WALK_SPEED = MOVE_SPEED.walk;
const RUN_SPEED = MOVE_SPEED.run;

/**
 * How a scripted walk ended.
 *
 * `cancelled` is the player taking over, which is normal and silent. `blocked` is the walk
 * failing — no route, or three seconds of getting nowhere — and is the one a caller has to
 * say something about.
 */
export type WalkOutcome = 'arrived' | 'cancelled' | 'blocked';

/** How close counts as arrived at the destination, metres. */
const ARRIVAL_RADIUS = 1.0;

/** How close counts as reaching an intermediate waypoint. Looser — it is a corner, not a place. */
const WAYPOINT_RADIUS = 1.8;

/** Progress that resets the stall watchdog, metres. Above the noise of a character settling. */
const STALL_PROGRESS = 0.05;

/** How long a scripted walk may make no progress before it gives up, seconds. */
const STALL_TIMEOUT = 3;

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

/**
 * How far from a bench a player may be when they sit and still be walked onto it. A `sit`
 * prompt reaches 3 m from the bench it names; a little over that, so its whole reach counts.
 */
const SEAT_REACH = 3.5;

/** Close enough to the seat to sit down on it, metres. */
const SEAT_ARRIVAL = 0.04;

/** How far out in front of a bench standing up steps, metres: clear of the seat's edge. */
const SEAT_STEP_OFF = 0.42;

/** How long walking onto or off a seat may take before it gives up, seconds. */
const SEAT_WALK_TIMEOUT = 2;

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
  /** The bench being sat on, if it is one. See {@link setSeated}. */
  private seat: BenchSeat | null = null;
  /**
   * A few steps taken for the player: onto the seat after sitting, or off the front of the
   * bench after standing. Cleared on arrival, by the timeout, or — standing — by any input.
   */
  private seatWalk: { x: number; z: number; elapsed: number } | null = null;
  /** Holding a rod out while the line is in the water. See `setFishing`. */
  private fishing = false;

  /**
   * A ceiling on ground speed set from outside, m/s, or null for none: a race's careful step
   * (`DARUMA_STEP_SPEED`), which the server holds racers to. Applied in the same place as the
   * client's own clamp, after everything that can produce speed, so neither the run key nor a
   * slide gets past it.
   */
  speedCap: number | null = null;
  /** Dancing at the concert, until the player moves. See `setDancing`. */
  private dancing = false;

  /** Set while a scripted move is running (walking to an activity slot). */
  private autoWalkTarget: THREE.Vector3 | null = null;
  private autoWalkResolve: ((outcome: WalkOutcome) => void) | null = null;
  /** Remaining waypoints of the current scripted walk. See {@link walkTo}. */
  private autoWalkRoute: Array<[number, number]> | null = null;
  private autoWalkLeg = 0;
  /** Closest the character has come to the current waypoint, for the stall watchdog. */
  private autoWalkBest = Infinity;
  private autoWalkStalledFor = 0;

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
    this.leaveSeat();
    this.finishWalk('cancelled');
    this.syncTransform();
  }

  /** Apply a server correction. Hard snap — blending would fight the server. */
  applyCorrection(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    // A correction that leaves a seated player on their seat leaves them seated on it.
    if (!this.seat || Math.hypot(this.seat.x - x, this.seat.z - z) > 0.2) this.leaveSeat();
    this.syncTransform();
  }

  /**
   * Forget the bench and any steps toward or away from it. A player moved by anything but
   * their own feet — a room switch lands them at another island's harbour straight after
   * standing them up — must not walk back toward a bench that is no longer where they are,
   * and a figure moved off a bench while seated sits on the ground rather than in mid-air.
   */
  private leaveSeat(): void {
    this.seat = null;
    this.seatWalk = null;
    this.character.setSeatHeight(0);
  }

  /** Current horizontal speed, m/s. Used to pick the animation state. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  /**
   * Hold a rod out over the water, or put it away. The pose is only held while standing
   * still — walk off and the character walks, and the server reels the line in.
   */
  setFishing(fishing: boolean): void {
    this.fishing = fishing;
    // A line out is not a dance; nor does the dance come back by itself when the line is in.
    if (fishing) this.dancing = false;
  }

  /** Dance on the spot (the beach concert's bon-odori), or stop. Walking off stops it too. */
  setDancing(dancing: boolean): void {
    // Not while sitting or fishing: those are shown instead, and the dance would start by
    // itself the moment they end.
    this.dancing = dancing && !this.seated && !this.fishing;
  }

  get isDancing(): boolean {
    return this.dancing;
  }

  get isFishing(): boolean {
    return this.fishing;
  }

  /** Turn to face a bearing (the world's yaw convention), e.g. out over the water to cast. */
  faceYaw(yaw: number): void {
    this.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    this.syncTransform();
  }

  /**
   * Sit down / stand up. Seated players do not accept movement input.
   *
   * Sitting at a bench walks the player onto it first. The prompt reaches three metres, and
   * a figure that sat down where it stood either sat on nothing in front of the bench or —
   * benches are not solid — sat inside it, with the plank through its middle. The walk is
   * ordinary movement, so the server sees a player taking a few steps inside the seat's
   * reach, and everyone else sees them walk over, turn round and sit. Anywhere without a
   * bench (the teahouse's mats) is the ground, and they sit where they are.
   *
   * Standing up from a bench steps forward off it, for the same reason in reverse.
   */
  setSeated(seated: boolean): void {
    this.seated = seated;
    if (seated) this.dancing = false;
    if (seated) {
      this.velocity.set(0, 0, 0);
      this.finishWalk('cancelled');
      this.seat = benchSeat(this.position.x, this.position.z, SEAT_REACH);
      this.seatWalk = this.seat ? { x: this.seat.x, z: this.seat.z, elapsed: 0 } : null;
      this.character.setSeatHeight(0);
    } else {
      const seat = this.seat;
      this.seat = null;
      this.seatWalk = null;
      if (seat && Math.hypot(seat.x - this.position.x, seat.z - this.position.z) < 0.2) {
        this.seatWalk = {
          x: seat.x + Math.sin(seat.yaw) * SEAT_STEP_OFF,
          z: seat.z + Math.cos(seat.yaw) * SEAT_STEP_OFF,
          elapsed: 0,
        };
      }
    }
    this.character.setAnim(seated && !this.seatWalk ? AnimState.Sit : AnimState.Idle);
  }

  /**
   * Walk the character to a point automatically, resolving when the walk ends.
   *
   * Joining an activity uses this rather than teleporting: being moved somewhere while
   * you watch is a very different feeling from blinking there, and preserving the walk
   * is most of what keeps the world continuous.
   *
   * ### It follows a route, not a bearing
   *
   * This used to steer straight at the destination. The middle of the island is a mountain,
   * so a straight line from the south harbour to the north one goes over it: the character
   * walked into the hillside and ground against it indefinitely, with nothing on screen to
   * say why. Thirty of the seventy-two ordered pairs of named places never arrived. See
   * `routeTo` in `@nagisa/shared`.
   *
   * Resolves with how the walk ended. A caller that told the player "walking to the shrine"
   * needs to know when that turned out not to be true — and needs to tell the two apart,
   * because taking over yourself needs no comment and being unable to get there does.
   */
  walkTo(x: number, z: number): Promise<WalkOutcome> {
    const [wx, wz] = nearestWalkable(x, z);
    this.finishWalk('cancelled');

    const route = routeTo(this.position.x, this.position.z, wx, wz);
    if (!route.length) return Promise.resolve('blocked');

    this.autoWalkRoute = route;
    this.autoWalkLeg = 0;
    this.autoWalkTarget = new THREE.Vector3(route[0]![0], heightAt(route[0]![0], route[0]![1]), route[0]![1]);
    this.autoWalkBest = Infinity;
    this.autoWalkStalledFor = 0;
    return new Promise((resolve) => {
      this.autoWalkResolve = resolve;
    });
  }

  /** Move on to the next waypoint, resetting the stall watchdog for the new leg. */
  private advanceLeg(): void {
    if (!this.autoWalkRoute) return;
    this.autoWalkLeg++;
    const leg = this.autoWalkRoute[this.autoWalkLeg];
    if (!leg) {
      this.finishWalk('arrived');
      return;
    }
    this.autoWalkTarget = new THREE.Vector3(leg[0], heightAt(leg[0], leg[1]), leg[1]);
    this.autoWalkBest = Infinity;
    this.autoWalkStalledFor = 0;
  }

  /**
   * Give up on a walk that has stopped getting anywhere.
   *
   * The backstop behind the routing, and the thing that makes "the character grinds into a
   * hillside forever" impossible rather than merely unlikely. A route can be stale — someone
   * being followed walks somewhere unreachable, the map changes under a walk in flight — and
   * no amount of good pathfinding removes the need for a walk to be able to *end*.
   */
  private tickWalkWatchdog(dt: number): void {
    if (!this.autoWalkTarget) return;
    const dist = Math.hypot(
      this.autoWalkTarget.x - this.position.x,
      this.autoWalkTarget.z - this.position.z,
    );
    if (dist < this.autoWalkBest - STALL_PROGRESS) {
      this.autoWalkBest = dist;
      this.autoWalkStalledFor = 0;
      return;
    }
    this.autoWalkStalledFor += dt;
    if (this.autoWalkStalledFor > STALL_TIMEOUT) this.finishWalk('blocked');
  }

  /** End the current scripted walk, if any, and settle its promise. */
  private finishWalk(outcome: WalkOutcome): void {
    this.autoWalkTarget = null;
    this.autoWalkRoute = null;
    const resolve = this.autoWalkResolve;
    this.autoWalkResolve = null;
    // Settled even when a second `walkTo` supersedes the first, which used to drop the
    // earlier promise on the floor: nothing awaited it, but a promise that can never settle
    // is a leak waiting for the first caller who does.
    resolve?.(outcome);
  }

  /** True while a scripted walk is in progress. See {@link walkTo}. */
  get autoWalking(): boolean {
    return this.autoWalkTarget !== null;
  }

  /** Cancel an automatic walk — any manual input does this. */
  cancelWalkTo(): void {
    this.finishWalk('cancelled');
  }

  /**
   * Fixed-step physics. Runs at 60 Hz regardless of frame rate.
   */
  fixedUpdate(dt: number): void {
    this.tickWalkWatchdog(dt);
    this.tickSeatWalk(dt);
    this.resolveIntent(this.tmpDir);

    const depth = -Math.min(0, heightAt(this.position.x, this.position.z));
    const wading = depth > 0.15;
    let maxSpeed: number = wading ? WADE_SPEED : this.input.run && !this.seated ? RUN_SPEED : WALK_SPEED;
    if (this.speedCap !== null) maxSpeed = Math.min(maxSpeed, this.speedCap);
    // Ease into the last few centimetres of a step onto a seat rather than overshooting it:
    // at walking pace one physics step is 15 cm.
    if (this.seatWalk) {
      maxSpeed = Math.min(maxSpeed, Math.hypot(this.seatWalk.x - this.position.x, this.seatWalk.z - this.position.z) * 8 + 0.2);
    }

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
    const limit = this.speedCap === null ? MAX_CLIENT_SPEED : Math.min(MAX_CLIENT_SPEED, this.speedCap);
    if (planar > limit) {
      this.velocity.x = (this.velocity.x / planar) * limit;
      this.velocity.z = (this.velocity.z / planar) * limit;
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
      // Not on a sliver. `canEnterFrom` lets a player walk across a one-metre crease of
      // over-steep ground with level ground on both sides; sliding them off it would be the
      // physics contradicting the permission that got them there, and reads as being flung.
      if (
        footingSlopeAt(this.position.x, this.position.z) > MAX_WALKABLE_SLOPE &&
        !isSliverAt(this.position.x, this.position.z)
      ) {
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
    // On the seat: turn round to face out from the bench, the way one sits down.
    if (this.seated && this.seat && !this.seatWalk) this.turnToward(this.seat.yaw, dt);
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
    if (this.seatWalk) {
      // Any input takes over from stepping off a bench; nothing interrupts sitting down on
      // one, which is what the player just asked for.
      const steering = Math.abs(this.input.move.x) > 0.05 || Math.abs(this.input.move.y) > 0.05;
      if (!this.seated && steering) {
        this.seatWalk = null;
      } else {
        const dx = this.seatWalk.x - this.position.x;
        const dz = this.seatWalk.z - this.position.z;
        const dist = Math.hypot(dx, dz) || 1;
        return out.set(dx / dist, 0, dz / dist);
      }
    }
    if (this.seated) return out;

    // A scripted walk overrides manual input, but any manual input cancels it.
    if (this.autoWalkTarget && this.autoWalkRoute) {
      if (Math.abs(this.input.move.x) > 0.05 || Math.abs(this.input.move.y) > 0.05) {
        this.cancelWalkTo();
      } else {
        const dx = this.autoWalkTarget.x - this.position.x;
        const dz = this.autoWalkTarget.z - this.position.z;
        const dist = Math.hypot(dx, dz);
        const last = this.autoWalkLeg >= this.autoWalkRoute.length - 1;

        // Intermediate waypoints are corners to round, not places to stand on: releasing
        // them early is what makes a route read as walking down a road rather than as a
        // series of small corrections.
        if (dist < (last ? ARRIVAL_RADIUS : WAYPOINT_RADIUS)) {
          if (last) {
            this.finishWalk('arrived');
            return out;
          }
          this.advanceLeg();
          return out.set(dx / (dist || 1), 0, dz / (dist || 1));
        }
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
    this.turnToward(Math.atan2(this.velocity.x, this.velocity.z), dt);
  }

  /** Turn part of the way toward a bearing. */
  private turnToward(desired: number, dt: number): void {
    // Shortest-arc interpolation; without the wrap the character spins the long way
    // round every time it crosses ±π.
    let delta = desired - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.yaw += delta * Math.min(1, TURN_RATE * dt);
  }

  /**
   * Finish a step onto or off a seat: arrived, or given up on. Arriving on a bench sits the
   * figure at the bench's height; giving up on one sits it on the ground where it got to,
   * which is at least never inside anything.
   */
  private tickSeatWalk(dt: number): void {
    const walk = this.seatWalk;
    if (!walk) return;
    walk.elapsed += dt;
    const arrived = Math.hypot(walk.x - this.position.x, walk.z - this.position.z) < SEAT_ARRIVAL;
    if (!arrived && walk.elapsed < SEAT_WALK_TIMEOUT) return;
    this.seatWalk = null;
    this.velocity.x = 0;
    this.velocity.z = 0;
    if (!this.seated) return;
    if (arrived && this.seat) {
      this.character.setSeatHeight(this.seat.y - this.position.y);
    } else {
      this.seat = null;
    }
  }

  /** Pick the animation state from the physics state. */
  private updateAnimState(wading: boolean): void {
    if (this.seated && !this.seatWalk) {
      this.character.setAnim(AnimState.Sit);
      return;
    }
    if (!this.grounded) {
      this.character.setAnim(this.velocity.y > 0.6 ? AnimState.Jump : AnimState.Fall);
      return;
    }
    const speed = this.speed;
    // Moving off is leaving the dance: nobody dances their way down the beach.
    if (this.dancing && speed >= 0.35) this.dancing = false;
    if (speed < 0.35) this.character.setAnim(this.fishing ? AnimState.Fish : this.dancing ? AnimState.Dance : AnimState.Idle);
    else if (speed < WALK_SPEED * 1.15 || wading) this.character.setAnim(AnimState.Walk);
    else this.character.setAnim(AnimState.Run);
  }

  /** Push the authoritative transform onto the visual object. */
  private syncTransform(): void {
    this.character.root.position.copy(this.position);
    this.character.root.rotation.y = this.yaw;
  }
}
