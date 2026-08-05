/**
 * Characters.
 * ===========
 *
 * Every islander — yours and everyone else's — is built here: a small articulated figure
 * assembled from primitives and animated by hand-written procedural cycles.
 *
 * ### Why procedural rather than a rigged GLB
 *
 * A skinned character with baked animations is the conventional answer, and it would cost
 * 1–3 MB plus a skinning cost per instance. Procedural articulation costs *zero bytes*,
 * animates sixty players without a single `AnimationMixer`, and blends between states by
 * interpolating a handful of numbers. The trade is that we cannot have subtle motion —
 * which suits a drawn art direction, where readability at distance matters far more than
 * secondary animation nobody will ever resolve.
 *
 * ### Proportions
 *
 * Slightly heroic-cartoon rather than realistic: the head is about a sixth of the total
 * height instead of an eighth, the hands and feet are oversized, and the torso is short.
 * This is not stylisation for its own sake — it is what makes a 1.7 m figure legible at
 * thirty metres against a hillside, which is the distance most of the population is seen
 * at. Realistic proportions at this scale read as a stick.
 *
 * ### Rig
 *
 * Two joints per limb, which is one more than the previous rig had and the difference
 * between a figure that walks and one that scissors:
 *
 * ```
 * root ── hips ── torso ── neck ── head ── hair / face / accessory
 *              │        ├─ shoulderL/R ── elbowL/R ── handL/R
 *              └─ hipL/R ── kneeL/R ── footL/R
 * ```
 *
 * Every joint is a `Group` pivoted at the joint with its geometry hanging below, so
 * rotating the group swings the limb rather than spinning it about its middle.
 *
 * ### Working with the contour pass
 *
 * The renderer draws lines wherever the *material id* changes between neighbouring pixels
 * (see `world/materials.ts`), so a character's clothing is deliberately split across two
 * ids: `clothingA` for the outer layer (jacket, sleeves) and `clothingB` for the inner
 * (trousers, collar). That single decision is what makes a jacket read as a garment worn
 * over something rather than as a differently-coloured section of the same solid.
 *
 * ### Level of detail
 *
 * Beyond `LOD_DISTANCE` the face and accessory are hidden and the animation update is
 * skipped entirely — a crowd of eighty on the far side of the plaza costs almost nothing
 * while still reading as a crowd.
 */

import * as THREE from 'three';
import { AnimState } from '@nagisa/shared';
import { inkDepthMaterial } from '../engine/ink/ink-material.js';
import { hair as hairMaterial, outfit as outfitMaterial, skin as skinMaterial, surface } from '../world/materials.js';

/** Character height, metres. Everything on the island is scaled against this. */
export const CHARACTER_HEIGHT = 1.7;

/** Beyond this distance, characters stop animating and drop their detail parts. */
const LOD_DISTANCE = 55;

/** Beyond this, they are hidden outright. Matches the fog's practical visibility. */
const CULL_DISTANCE = 320;

/** How many outfits, skins and accessories the entry screen may offer. */
export const OUTFIT_COUNT = 8;
export const SKIN_COUNT = 5;
export const HAIR_COUNT = 6;
/** Accessory 0 is "none"; the rest are hats and hoods. */
export const ACCESSORY_COUNT = 5;

export interface CharacterAppearance {
  outfit: number;
  skin: number;
  accessory: number;
}

// ---------------------------------------------------------------------------
// Animation profiles
// ---------------------------------------------------------------------------

/** Which way a limb swings, and how far, for each animation state. */
interface AnimProfile {
  /** Peak shoulder swing, radians. */
  armSwing: number;
  /** Peak hip swing, radians. */
  legSwing: number;
  /** Peak elbow bend, radians. Always a *bend*, never a hyperextension. */
  elbowBend: number;
  /** Peak knee bend, radians. */
  kneeBend: number;
  /** Cycle speed multiplier. */
  rate: number;
  /** Vertical bob amplitude, metres. */
  bob: number;
  /** Constant forward lean, radians. */
  lean: number;
  /** Constant shoulder elevation — raised for waving and clapping. */
  armRaise: number;
  /** Hip flexion held constant, for sitting. */
  hipFold: number;
}

/**
 * Per-state motion parameters.
 *
 * These numbers are the entire animation system. Tuning the world's *feel* — whether
 * people bustle or amble — happens here and nowhere else.
 */
const PROFILES: Record<AnimState, AnimProfile> = {
  [AnimState.Idle]: { armSwing: 0.04, legSwing: 0.0, elbowBend: 0.18, kneeBend: 0.05, rate: 1.1, bob: 0.011, lean: 0, armRaise: 0, hipFold: 0 },
  [AnimState.Walk]: { armSwing: 0.5, legSwing: 0.68, elbowBend: 0.42, kneeBend: 0.62, rate: 7.0, bob: 0.042, lean: 0.05, armRaise: 0, hipFold: 0 },
  [AnimState.Run]: { armSwing: 0.9, legSwing: 1.1, elbowBend: 0.95, kneeBend: 1.15, rate: 10.4, bob: 0.082, lean: 0.2, armRaise: 0.12, hipFold: 0 },
  [AnimState.Jump]: { armSwing: 0.1, legSwing: 0.22, elbowBend: 0.5, kneeBend: 0.8, rate: 0, bob: 0, lean: -0.1, armRaise: 1.5, hipFold: 0 },
  [AnimState.Fall]: { armSwing: 0.1, legSwing: 0.32, elbowBend: 0.4, kneeBend: 0.5, rate: 0, bob: 0, lean: 0.09, armRaise: 1.1, hipFold: 0 },
  [AnimState.Sit]: { armSwing: 0.02, legSwing: 0, elbowBend: 0.55, kneeBend: 1.5, rate: 0.8, bob: 0.005, lean: 0.1, armRaise: 0, hipFold: 1.45 },
  [AnimState.Clap]: { armSwing: 0.0, legSwing: 0, elbowBend: 1.25, kneeBend: 0.05, rate: 9.0, bob: 0.009, lean: 0.03, armRaise: 1.05, hipFold: 0 },
  [AnimState.Wave]: { armSwing: 0.0, legSwing: 0, elbowBend: 0.9, kneeBend: 0.05, rate: 6.0, bob: 0.011, lean: 0, armRaise: 2.2, hipFold: 0 },
  [AnimState.Bow]: { armSwing: 0.0, legSwing: 0, elbowBend: 0.15, kneeBend: 0.05, rate: 0, bob: 0, lean: 0.8, armRaise: 0, hipFold: 0 },
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * A rounded box, built by subdividing a box and pushing its corners in toward a sphere.
 *
 * Everything on a character uses this rather than a plain `BoxGeometry`. A cube's hard
 * 90° corners give the contour detector a huge normal discontinuity, so a figure built
 * from cubes gets a heavy line drawn around every single edge and reads as a pile of
 * blocks. Rounding the corners softens those into the one or two lines a person would
 * actually draw, while keeping the flat faces that make the shading read as flat.
 */
function roundedBox(w: number, h: number, d: number, radius: number, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const half = new THREE.Vector3(w / 2, h / 2, d / 2);
  const inner = new THREE.Vector3(Math.max(0.001, half.x - radius), Math.max(0.001, half.y - radius), Math.max(0.001, half.z - radius));
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Clamp to the inner box, then push back out by `radius` along the direction to the
    // original vertex — the standard rounded-box construction.
    const clamped = new THREE.Vector3(
      THREE.MathUtils.clamp(v.x, -inner.x, inner.x),
      THREE.MathUtils.clamp(v.y, -inner.y, inner.y),
      THREE.MathUtils.clamp(v.z, -inner.z, inner.z),
    );
    const offset = v.clone().sub(clamped);
    if (offset.lengthSq() > 1e-9) offset.normalize().multiplyScalar(radius);
    pos.setXYZ(i, clamped.x + offset.x, clamped.y + offset.y, clamped.z + offset.z);
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = inkDepthMaterial();
  return mesh;
}

/** A capsule-ish limb segment: a tapered cylinder with a rounded cap at the far end. */
function limbSegment(length: number, topRadius: number, bottomRadius: number, material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(topRadius, bottomRadius, length, 7), material);
  shaft.position.y = -length / 2;
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  shaft.customDepthMaterial = inkDepthMaterial();
  group.add(shaft);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(bottomRadius, 7, 5), material);
  cap.position.y = -length;
  cap.castShadow = true;
  cap.customDepthMaterial = inkDepthMaterial();
  group.add(cap);
  return group;
}

/** A pivot group placed at a joint, so rotating it swings everything below. */
function joint(x: number, y: number, z = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  return group;
}

/**
 * Place an object and return it, so a part can be built and positioned inside the same
 * `add()` call. The rig below is thirty parts long and reads far better as
 * `add(at(roundedBox(...), 0, 0.22, 0))` than as a named temporary for each one.
 */
function at<T extends THREE.Object3D>(object: T, x: number, y: number, z: number): T {
  object.position.set(x, y, z);
  return object;
}

// ---------------------------------------------------------------------------
// The character
// ---------------------------------------------------------------------------

/**
 * One islander.
 *
 * Owns its own object graph. Not pooled — a character is a few hundred triangles, and
 * pooling would complicate appearance changes for no measurable gain at our population
 * ceiling.
 */
export class Character {
  readonly root = new THREE.Group();

  private readonly hips: THREE.Group;
  private readonly torso: THREE.Group;
  private readonly head: THREE.Group;
  private readonly shoulderL: THREE.Group;
  private readonly shoulderR: THREE.Group;
  private readonly elbowL: THREE.Group;
  private readonly elbowR: THREE.Group;
  private readonly hipL: THREE.Group;
  private readonly hipR: THREE.Group;
  private readonly kneeL: THREE.Group;
  private readonly kneeR: THREE.Group;
  /** Face and accessory: hidden beyond `LOD_DISTANCE`. */
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
  private emoteState: AnimState | null = null;

  /** Resting hip height, metres. The bob rides on top of this. */
  private readonly hipHeight = 0.79;

  constructor(appearance: CharacterAppearance) {
    this.root.name = 'character';

    // Three garment tones, not two: jacket, under-layer and trousers. With only two, the
    // trousers inherit the vest's colour and the figure reads as a one-piece suit — and
    // whichever tone is the lighter of the pair turns the legs into pale sticks, which is
    // the single most distracting thing about a small figure seen at distance.
    const outer = outfitMaterial(appearance.outfit, 'a');
    const inner = outfitMaterial(appearance.outfit + 3, 'b');
    const trousers = outfitMaterial(appearance.outfit + 5, 'b');
    const flesh = skinMaterial(appearance.skin);
    const locks = hairMaterial(appearance.outfit + appearance.skin);
    const shoe = surface('shoe', { color: 0x4a4038, shadowColor: 0x332c26, matId: 2, hatch: 0.4 });

    // — Hips —————————————————————————————————————————————————
    this.hips = joint(0, this.hipHeight, 0);
    this.root.add(this.hips);
    this.hips.add(roundedBox(0.35, 0.21, 0.25, 0.07, trousers));

    // — Torso ————————————————————————————————————————————————
    // Two masses: a chest and a slightly narrower waist, so the figure has a shape rather
    // than a single tapering block.
    this.torso = joint(0, 0.06, 0);
    this.hips.add(this.torso);
    this.torso.add(at(roundedBox(0.38, 0.34, 0.26, 0.1, outer), 0, 0.23, 0));
    this.torso.add(at(roundedBox(0.32, 0.17, 0.22, 0.06, inner), 0, 0.05, 0));
    // The jacket's front opening: a narrow panel of the inner colour, which is the one
    // detail that makes the outer layer read as something you put on.
    this.torso.add(at(roundedBox(0.09, 0.3, 0.05, 0.02, inner), 0, 0.23, 0.125));
    // Collar.
    // Collar, sized to swallow the neck joint: a visible neck on a stylised figure of
    // this proportion reads as a mistake rather than as anatomy.
    this.torso.add(at(roundedBox(0.24, 0.09, 0.21, 0.035, inner), 0, 0.41, 0.01));

    // — Head —————————————————————————————————————————————————
    const neck = joint(0, 0.42, 0);
    this.torso.add(neck);
    neck.add(at(limbSegment(0.05, 0.05, 0.055, flesh), 0, 0.05, 0));

    this.head = joint(0, 0.035, 0);
    neck.add(this.head);
    // Head is wider than deep and slightly tapered toward the chin.
    this.head.add(at(roundedBox(0.26, 0.28, 0.25, 0.09, flesh), 0, 0.14, 0));
    // Ears.
    for (const sx of [-1, 1] as const) {
      this.head.add(at(roundedBox(0.03, 0.07, 0.05, 0.014, flesh), sx * 0.13, 0.145, -0.01));
    }

    // Hair, in three masses: a cap over the crown, a fringe across the brow, and a longer
    // mass down the back. Three parts rather than one is what gives a silhouette you can
    // recognise from behind.
    this.head.add(at(roundedBox(0.28, 0.17, 0.27, 0.095, locks), 0, 0.225, -0.005));
    // The fringe overhangs the brow and is the one hair element the eye actually reads at
    // conversation distance; without it the cap on the crown looks like a helmet.
    this.head.add(at(roundedBox(0.27, 0.085, 0.1, 0.032, locks), 0, 0.205, 0.1));
    this.head.add(at(roundedBox(0.25, 0.17, 0.11, 0.05, locks), 0, 0.115, -0.11));

    // — Face and accessory, dropped at distance ——————————————
    this.detail = new THREE.Group();
    this.head.add(this.detail);
    const eyeMat = surface('eye', { color: 0x2a2420, matId: 11, unlit: true, outline: false, hatch: 0 });
    for (const sx of [-1, 1] as const) {
      // Eyes are unlit dots: a shaded eye picks up the terminator across its own 3 mm and
      // ends up half in shadow, which reads as a bruise.
      // Small. An oversized eye on a head this size reads as a mask, not a face — the
      // reference's characters carry their expression in the brow and the silhouette, and
      // the eye is barely more than a dot.
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), eyeMat);
      eye.position.set(sx * 0.058, 0.128, 0.122);
      eye.scale.set(1, 1.15, 0.5);
      this.detail.add(eye);
      // Brows: small, high, and the only thing giving the face an expression.
      const brow = roundedBox(0.045, 0.012, 0.018, 0.005, locks);
      brow.position.set(sx * 0.058, 0.163, 0.12);
      brow.rotation.z = sx * 0.14;
      this.detail.add(brow);
    }
    const mouth = roundedBox(0.032, 0.011, 0.018, 0.004, eyeMat);
    mouth.position.set(0, 0.082, 0.123);
    this.detail.add(mouth);

    if (appearance.accessory % ACCESSORY_COUNT !== 0) {
      this.detail.add(buildAccessory(appearance.accessory % ACCESSORY_COUNT, outer, locks));
    }

    // — Arms —————————————————————————————————————————————————
    const buildArm = (sx: number): { shoulder: THREE.Group; elbow: THREE.Group } => {
      const shoulder = joint(sx * 0.215, 0.32, 0);
      this.torso.add(shoulder);
      // A small ball at the joint, so the sleeve meets the body without a gap. Kept
      // rounder and tighter than the torso: a cube here reads as shoulder armour.
      shoulder.add(at(roundedBox(0.095, 0.095, 0.1, 0.045, outer), 0, -0.01, 0));
      shoulder.add(limbSegment(0.2, 0.055, 0.046, outer));

      const elbow = joint(0, -0.2, 0);
      shoulder.add(elbow);
      // The forearm is bare skin below a sleeve cuff.
      elbow.add(at(roundedBox(0.09, 0.05, 0.1, 0.02, inner), 0, -0.02, 0));
      elbow.add(limbSegment(0.19, 0.042, 0.037, flesh));
      // Hand: oversized, which is what makes a gesture legible at distance.
      elbow.add(at(roundedBox(0.08, 0.1, 0.06, 0.03, flesh), 0, -0.235, 0));
      return { shoulder, elbow };
    };
    const left = buildArm(-1);
    const right = buildArm(1);
    this.shoulderL = left.shoulder;
    this.elbowL = left.elbow;
    this.shoulderR = right.shoulder;
    this.elbowR = right.elbow;

    // — Legs —————————————————————————————————————————————————
    const buildLeg = (sx: number): { hip: THREE.Group; knee: THREE.Group } => {
      const hip = joint(sx * 0.095, -0.085, 0);
      this.hips.add(hip);
      hip.add(limbSegment(0.34, 0.078, 0.062, trousers));

      const knee = joint(0, -0.34, 0);
      hip.add(knee);
      knee.add(limbSegment(0.32, 0.062, 0.05, trousers));
      // Foot, projecting forward from the ankle.
      knee.add(at(roundedBox(0.1, 0.075, 0.2, 0.032, shoe), 0, -0.34, 0.045));
      return { hip, knee };
    };
    const legLeft = buildLeg(-1);
    const legRight = buildLeg(1);
    this.hipL = legLeft.hip;
    this.kneeL = legLeft.knee;
    this.hipR = legRight.hip;
    this.kneeR = legRight.knee;
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
    this.emoteState = state;
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
      if (this.emoteState !== null) goal = PROFILES[this.emoteState];
    }

    // Blend toward the goal. A fixed rate rather than a spring: predictable, and it
    // cannot overshoot into a pose the rig was never meant to hold.
    const k = Math.min(1, dt * 9);
    this.blended.armSwing += (goal.armSwing - this.blended.armSwing) * k;
    this.blended.legSwing += (goal.legSwing - this.blended.legSwing) * k;
    this.blended.elbowBend += (goal.elbowBend - this.blended.elbowBend) * k;
    this.blended.kneeBend += (goal.kneeBend - this.blended.kneeBend) * k;
    this.blended.rate += (goal.rate - this.blended.rate) * k;
    this.blended.bob += (goal.bob - this.blended.bob) * k;
    this.blended.lean += (goal.lean - this.blended.lean) * k;
    this.blended.armRaise += (goal.armRaise - this.blended.armRaise) * k;
    this.blended.hipFold += (goal.hipFold - this.blended.hipFold) * k;

    this.phase += dt * this.blended.rate;

    const swing = Math.sin(this.phase);
    const counter = -swing;

    // Arms and legs are in opposition — the diagonal gait every biped uses.
    this.shoulderL.rotation.x = swing * this.blended.armSwing - this.blended.armRaise;
    this.shoulderR.rotation.x = counter * this.blended.armSwing - this.blended.armRaise;
    this.hipL.rotation.x = counter * this.blended.legSwing - this.blended.hipFold;
    this.hipR.rotation.x = swing * this.blended.legSwing - this.blended.hipFold;

    // Elbows and knees bend on the *return* half of each stride only, and never the wrong
    // way. `max(0, …)` is doing real work here: an elbow that hyperextends is the single
    // most obvious tell that a rig is being driven by a raw sine.
    this.elbowL.rotation.x = -Math.max(0, counter) * this.blended.elbowBend - this.blended.elbowBend * 0.25;
    this.elbowR.rotation.x = -Math.max(0, swing) * this.blended.elbowBend - this.blended.elbowBend * 0.25;
    this.kneeL.rotation.x = Math.max(0, swing) * this.blended.kneeBend + this.blended.hipFold;
    this.kneeR.rotation.x = Math.max(0, counter) * this.blended.kneeBend + this.blended.hipFold;

    this.applyEmoteOverrides();

    // The body bobs at twice the limb rate: one rise per footfall, two per stride.
    this.hips.position.y = this.hipHeight - this.blended.hipFold * 0.28 + Math.abs(swing) * this.blended.bob;
    this.torso.rotation.x = this.blended.lean;
    // A slight head counter-rotation keeps the gaze level while the body leans.
    this.head.rotation.x = -this.blended.lean * 0.55;
  }

  /**
   * Poses that the swing/counter-swing cycle cannot express, applied after it.
   *
   * Waving is one arm only — mirroring it reads as surrender, not greeting. Clapping
   * brings the hands together in front rather than swinging them past each other. Bowing
   * drops the arms to the sides and holds them there.
   */
  private applyEmoteOverrides(): void {
    const emote = this.emoteRemaining > 0 ? this.emoteState : null;

    if (emote === AnimState.Wave) {
      this.shoulderL.rotation.set(0, 0, 0);
      this.elbowL.rotation.x = -0.2;
      this.shoulderR.rotation.x = -2.2;
      this.shoulderR.rotation.z = -0.35;
      this.elbowR.rotation.x = -0.5;
      this.elbowR.rotation.z = Math.sin(this.phase) * 0.55;
      return;
    }

    if (emote === AnimState.Clap) {
      const clap = Math.abs(Math.sin(this.phase)) * 0.3;
      for (const [shoulder, elbow, sx] of [
        [this.shoulderL, this.elbowL, -1],
        [this.shoulderR, this.elbowR, 1],
      ] as const) {
        shoulder.rotation.x = -1.05;
        shoulder.rotation.z = sx * (0.52 - clap);
        elbow.rotation.x = -1.25;
        elbow.rotation.z = 0;
      }
      return;
    }

    if (emote === AnimState.Bow) {
      for (const shoulder of [this.shoulderL, this.shoulderR]) {
        shoulder.rotation.set(0, 0, 0);
      }
      this.elbowL.rotation.set(-0.1, 0, 0);
      this.elbowR.rotation.set(-0.1, 0, 0);
      return;
    }

    // No emote: clear the roll axis the emotes above use, so a character that has just
    // finished waving does not keep its arm out.
    this.shoulderL.rotation.z = 0;
    this.shoulderR.rotation.z = 0;
    this.elbowL.rotation.z = 0;
    this.elbowR.rotation.z = 0;
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
 * changes are what let you pick a friend out of a crowd at fifty metres, which matters far
 * more here than facial detail ever could.
 */
function buildAccessory(index: number, outer: THREE.Material, locks: THREE.Material): THREE.Object3D {
  const straw = surface('straw', { color: 0xd8c08a, shadowColor: 0x9c8b6a, matId: 7, hatch: 0.5 });
  const group = new THREE.Group();
  group.name = 'accessory';

  switch (index) {
    case 1: {
      // Kasa — the wide conical hat. Built as a cone plus a rim, because a bare cone has
      // no underside and reads as a paper party hat.
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.17, 10), straw);
      hat.position.y = 0.34;
      hat.castShadow = true;
      hat.customDepthMaterial = inkDepthMaterial();
      group.add(hat);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.3, 0.025, 10), straw);
      rim.position.y = 0.27;
      rim.castShadow = true;
      rim.customDepthMaterial = inkDepthMaterial();
      group.add(rim);
      break;
    }
    case 2: {
      // Hachimaki — headband, with the knot at the back.
      const band = roundedBox(0.28, 0.055, 0.27, 0.02, surface('band', { color: 0xc4503a, shadowColor: 0x8a3a2e, matId: 7, hatch: 0.4 }));
      band.position.y = 0.2;
      group.add(band);
      const knot = roundedBox(0.06, 0.05, 0.07, 0.02, surface('band', { color: 0xc4503a, shadowColor: 0x8a3a2e, matId: 7, hatch: 0.4 }));
      knot.position.set(0, 0.2, -0.15);
      group.add(knot);
      break;
    }
    case 3: {
      // Hood, drawn up over the head.
      const hood = roundedBox(0.3, 0.28, 0.29, 0.12, outer);
      hood.position.y = 0.16;
      group.add(hood);
      const drape = roundedBox(0.26, 0.14, 0.1, 0.05, outer);
      drape.position.set(0, 0.03, -0.13);
      group.add(drape);
      break;
    }
    default: {
      // Flat cap with a short peak.
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.15, 0.07, 10), locks);
      cap.position.y = 0.29;
      cap.castShadow = true;
      cap.customDepthMaterial = inkDepthMaterial();
      group.add(cap);
      const peak = roundedBox(0.19, 0.02, 0.11, 0.008, locks);
      peak.position.set(0, 0.265, 0.1);
      peak.rotation.x = -0.16;
      group.add(peak);
      break;
    }
  }
  return group;
}
