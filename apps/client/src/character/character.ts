/**
 * Characters.
 * ===========
 *
 * Every islander — yours and everyone else's — is built here: a small articulated figure
 * assembled from primitives and animated by hand-written procedural cycles.
 *
 * ### Why procedural rather than a rigged GLB
 * A skinned character with a set of baked animations is the conventional answer, and it
 * would cost 1–3 MB plus a skinning cost per instance. Procedural articulation costs
 * *zero bytes*, animates 60 players without a single `AnimationMixer`, and blends between
 * states by interpolating a handful of numbers. The trade is that we cannot have subtle
 * motion — which is fine, because the art direction is deliberately simple and readable
 * at distance.
 *
 * ### Rig
 * A flat hierarchy, because that is all the motion needs:
 * ```
 * root ── body ── head ── (face)
 *              ├─ armL / armR   (pivot at the shoulder)
 *              └─ legL / legR   (pivot at the hip)
 * ```
 * Every limb rotates about its pivot only. There are no knees or elbows; at this scale
 * the eye reads the silhouette, not the joint count.
 *
 * ### Level of detail
 * Beyond `LOD_DISTANCE` the face and the accessory are hidden and the animation update
 * is skipped entirely — a crowd of eighty on the far side of the plaza costs almost
 * nothing while still reading as a crowd, which is exactly the trade a populated world
 * needs to make.
 */

import * as THREE from 'three';
import { AnimState } from '@nagisa/shared';
import { surface } from '../world/materials.js';

/** Character height, metres. Everything on the island is scaled against this. */
export const CHARACTER_HEIGHT = 1.7;

/** Beyond this distance, characters stop animating and drop their detail parts. */
const LOD_DISTANCE = 55;

/** Beyond this, they are hidden outright. Matches the fog's practical visibility. */
const CULL_DISTANCE = 320;

/**
 * Outfit palette. Muted, natural dyes — indigo, persimmon, moss, charcoal, ochre. The
 * one thing a crowd must never look like is a bag of sweets, so nothing here is
 * saturated.
 */
const OUTFIT_COLORS = [
  0x3d5a80, // indigo
  0xb8663f, // persimmon
  0x5f7a52, // moss
  0x4a4a52, // charcoal
  0xc09a5b, // ochre
  0x8c5a6e, // plum
  0x6d7f8c, // slate
  0xa8a08c, // flax
] as const;

const SKIN_COLORS = [0xf2d7bd, 0xe8c4a0, 0xd2a279, 0xb07c53, 0x8a5a3c, 0x6b4430] as const;

/** Accessory 0 is "none"; the rest are small hats and hoods. */
const ACCESSORY_COUNT = 5;

export interface CharacterAppearance {
  outfit: number;
  skin: number;
  accessory: number;
}

/** Which way a limb swings, and how far, for each animation state. */
interface AnimProfile {
  /** Peak arm swing, radians. */
  armSwing: number;
  /** Peak leg swing, radians. */
  legSwing: number;
  /** Cycle speed multiplier. */
  rate: number;
  /** Vertical bob amplitude, metres. */
  bob: number;
  /** Constant forward lean, radians. */
  lean: number;
  /** Constant arm elevation — raised for waving and clapping. */
  armRaise: number;
}

/**
 * Per-state motion parameters.
 *
 * These numbers are the entire animation system. Tuning the world's *feel* — whether
 * people bustle or amble — happens here and nowhere else.
 */
const PROFILES: Record<AnimState, AnimProfile> = {
  [AnimState.Idle]: { armSwing: 0.05, legSwing: 0.0, rate: 1.1, bob: 0.012, lean: 0, armRaise: 0 },
  [AnimState.Walk]: { armSwing: 0.55, legSwing: 0.72, rate: 7.4, bob: 0.045, lean: 0.06, armRaise: 0 },
  [AnimState.Run]: { armSwing: 0.95, legSwing: 1.15, rate: 10.8, bob: 0.085, lean: 0.22, armRaise: 0.15 },
  [AnimState.Jump]: { armSwing: 0.1, legSwing: 0.25, rate: 0, bob: 0, lean: -0.12, armRaise: 1.5 },
  [AnimState.Fall]: { armSwing: 0.1, legSwing: 0.35, rate: 0, bob: 0, lean: 0.1, armRaise: 1.1 },
  [AnimState.Sit]: { armSwing: 0.02, legSwing: 0, rate: 0.8, bob: 0.006, lean: 0.14, armRaise: 0 },
  [AnimState.Clap]: { armSwing: 0.0, legSwing: 0, rate: 9.0, bob: 0.01, lean: 0.04, armRaise: 1.35 },
  [AnimState.Wave]: { armSwing: 0.0, legSwing: 0, rate: 6.0, bob: 0.012, lean: 0, armRaise: 2.35 },
  [AnimState.Bow]: { armSwing: 0.0, legSwing: 0, rate: 0, bob: 0, lean: 0.85, armRaise: 0 },
};

/**
 * One islander.
 *
 * Owns its own object graph. Not pooled — a character is a few dozen triangles, and
 * pooling would complicate appearance changes for no measurable gain at our population
 * ceiling.
 */
export class Character {
  readonly root = new THREE.Group();

  private readonly body: THREE.Group;
  private readonly head: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly detail: THREE.Group;

  /** Animation phase, radians. Advances at the profile's rate. */
  private phase = 0;

  /** Current and target profile, blended so state changes do not snap. */
  private readonly blended: AnimProfile = { ...PROFILES[AnimState.Idle] };
  private target: AnimProfile = PROFILES[AnimState.Idle];

  private state: AnimState = AnimState.Idle;

  /** Set by the scene each frame; drives LOD and culling. */
  private distanceToCamera = 0;

  /** Transient one-shot emote, if any. Overrides `state` until it elapses. */
  private emoteRemaining = 0;
  private emoteProfile: AnimProfile | null = null;

  constructor(appearance: CharacterAppearance) {
    this.root.name = 'character';

    const outfit = surface(
      `outfit-${appearance.outfit % OUTFIT_COLORS.length}`,
      OUTFIT_COLORS[appearance.outfit % OUTFIT_COLORS.length],
    );
    const skin = surface(
      `skin-${appearance.skin % SKIN_COLORS.length}`,
      SKIN_COLORS[appearance.skin % SKIN_COLORS.length],
    );
    const hair = surface('hair', 0x2e2823);

    // — Body ————————————————————————————————————————————————
    // A tapered box: wider at the shoulders than the hem, which is enough to read as a
    // haori without any cloth simulation.
    this.body = new THREE.Group();
    this.body.position.y = 0.72;
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.26, 0.62, 6), outfit);
    torso.castShadow = true;
    torso.receiveShadow = true;
    this.body.add(torso);
    this.root.add(this.body);

    // — Head ————————————————————————————————————————————————
    this.head = new THREE.Group();
    this.head.position.y = 0.42;
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.28), skin);
    skull.castShadow = true;
    this.head.add(skull);
    const fringe = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.3), hair);
    fringe.position.set(0, 0.11, 0);
    this.head.add(fringe);
    this.body.add(this.head);

    // — Detail parts, dropped at distance ————————————————————
    this.detail = new THREE.Group();
    const eyeGeo = new THREE.BoxGeometry(0.035, 0.05, 0.02);
    const eyeMat = surface('eye', 0x2a2420);
    for (const dx of [-0.07, 0.07]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(dx, 0.01, 0.145);
      this.detail.add(eye);
    }
    if (appearance.accessory % ACCESSORY_COUNT !== 0) {
      this.detail.add(buildAccessory(appearance.accessory % ACCESSORY_COUNT, outfit));
    }
    this.head.add(this.detail);

    // — Limbs ————————————————————————————————————————————————
    // Each limb is a group pivoted at the joint with the geometry hanging below it, so
    // rotating the group swings the limb rather than spinning it about its middle.
    const makeLimb = (length: number, radius: number, mat: THREE.Material): THREE.Group => {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.8, radius, length, 5), mat);
      mesh.position.y = -length / 2;
      mesh.castShadow = true;
      g.add(mesh);
      return g;
    };

    this.armL = makeLimb(0.46, 0.055, outfit);
    this.armL.position.set(-0.24, 0.24, 0);
    this.body.add(this.armL);

    this.armR = makeLimb(0.46, 0.055, outfit);
    this.armR.position.set(0.24, 0.24, 0);
    this.body.add(this.armR);

    this.legL = makeLimb(0.7, 0.07, outfit);
    this.legL.position.set(-0.1, -0.3, 0);
    this.body.add(this.legL);

    this.legR = makeLimb(0.7, 0.07, outfit);
    this.legR.position.set(0.1, -0.3, 0);
    this.body.add(this.legR);
  }

  /** Current animation state. */
  get animState(): AnimState {
    return this.state;
  }

  /** Switch animation. Blending is handled in {@link update}; this is cheap to call. */
  setAnim(state: AnimState): void {
    if (this.state === state) return;
    this.state = state;
    this.target = PROFILES[state];
  }

  /**
   * Play a one-shot emote for `duration` seconds, after which the character returns to
   * its underlying locomotion state. Emotes are expressions, not states — you can wave
   * while walking.
   */
  playEmote(state: AnimState, duration = 2.0): void {
    this.emoteProfile = PROFILES[state];
    this.emoteRemaining = duration;
  }

  /** Distance-based LOD. Called by the scene once per frame with the camera position. */
  updateLod(cameraPosition: THREE.Vector3): void {
    this.distanceToCamera = this.root.position.distanceTo(cameraPosition);
    const visible = this.distanceToCamera < CULL_DISTANCE;
    if (this.root.visible !== visible) this.root.visible = visible;
    const detailed = this.distanceToCamera < LOD_DISTANCE;
    if (this.detail.visible !== detailed) this.detail.visible = detailed;
  }

  /**
   * Advance the animation.
   *
   * Skipped entirely for distant characters: their limbs are sub-pixel, and eighty
   * skipped updates per frame is the difference between a populated island and a
   * stuttering one.
   */
  update(dt: number): void {
    if (!this.root.visible) return;
    if (this.distanceToCamera > LOD_DISTANCE) return;

    // Resolve which profile is driving: a live emote wins over locomotion.
    let goal = this.target;
    if (this.emoteRemaining > 0) {
      this.emoteRemaining -= dt;
      if (this.emoteProfile) goal = this.emoteProfile;
    }

    // Blend toward the goal. A fixed rate rather than a spring: predictable, and it
    // cannot overshoot into a pose the rig was never meant to hold.
    const k = Math.min(1, dt * 9);
    this.blended.armSwing += (goal.armSwing - this.blended.armSwing) * k;
    this.blended.legSwing += (goal.legSwing - this.blended.legSwing) * k;
    this.blended.rate += (goal.rate - this.blended.rate) * k;
    this.blended.bob += (goal.bob - this.blended.bob) * k;
    this.blended.lean += (goal.lean - this.blended.lean) * k;
    this.blended.armRaise += (goal.armRaise - this.blended.armRaise) * k;

    this.phase += dt * this.blended.rate;

    const swing = Math.sin(this.phase);
    const counter = Math.sin(this.phase + Math.PI);

    // Arms and legs are in opposition — the diagonal gait every biped uses.
    this.armL.rotation.x = swing * this.blended.armSwing - this.blended.armRaise;
    this.armR.rotation.x = counter * this.blended.armSwing - this.blended.armRaise;
    this.legL.rotation.x = counter * this.blended.legSwing;
    this.legR.rotation.x = swing * this.blended.legSwing;

    // Waving is one arm only: mirroring it reads as surrender, not greeting.
    if (this.emoteRemaining > 0 && this.emoteProfile === PROFILES[AnimState.Wave]) {
      this.armL.rotation.x = 0;
      this.armR.rotation.z = -0.4 + Math.sin(this.phase) * 0.35;
    } else {
      this.armR.rotation.z = 0;
    }

    // Clapping brings the hands together in front rather than swinging them.
    if (this.emoteRemaining > 0 && this.emoteProfile === PROFILES[AnimState.Clap]) {
      const clap = Math.abs(Math.sin(this.phase)) * 0.34;
      this.armL.rotation.z = 0.5 - clap;
      this.armR.rotation.z = -0.5 + clap;
    } else if (this.emoteRemaining <= 0) {
      this.armL.rotation.z = 0;
    }

    // The body bobs at twice the limb rate: one rise per footfall, two per stride.
    this.body.position.y = 0.72 + Math.abs(Math.sin(this.phase)) * this.blended.bob;
    this.body.rotation.x = this.blended.lean;

    // A slight head counter-rotation keeps the gaze level while the body leans.
    this.head.rotation.x = -this.blended.lean * 0.55;
  }

  /** Release this character's geometry. Materials are shared and are left alone. */
  dispose(): void {
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.root.removeFromParent();
  }
}

/**
 * Head accessories: a conical straw hat, a headband, a hood, a flat cap. Small silhouette
 * changes are what let you pick a friend out of a crowd at fifty metres, which matters
 * far more here than facial detail ever could.
 */
function buildAccessory(index: number, outfitMaterial: THREE.Material): THREE.Object3D {
  const straw = surface('straw', 0xd8c08a);
  switch (index) {
    case 1: {
      // Kasa — wide conical hat.
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.16, 8), straw);
      hat.position.y = 0.2;
      hat.castShadow = true;
      return hat;
    }
    case 2: {
      // Hachimaki — headband.
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.06, 0.31), surface('band', 0xc4503a));
      band.position.y = 0.1;
      return band;
    }
    case 3: {
      // Hood, drawn up over the head.
      const hood = new THREE.Mesh(new THREE.SphereGeometry(0.2, 6, 4), outfitMaterial);
      hood.position.y = 0.1;
      hood.scale.set(1, 0.9, 1.05);
      hood.castShadow = true;
      return hood;
    }
    default: {
      // Flat cap.
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.08, 6), surface('cap', 0x4a4a52));
      cap.position.y = 0.19;
      cap.castShadow = true;
      return cap;
    }
  }
}
