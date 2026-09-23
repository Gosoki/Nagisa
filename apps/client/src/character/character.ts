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
 *
 * ### Things held in the hand
 *
 * A rod while fishing and a paper lantern on the lantern walk. Both are built the first
 * time they are needed rather than with the figure — most islanders never hold either, and
 * a prop nobody is carrying should cost nothing — and both hang off the forearm joint, so
 * they move with the pose instead of being positioned by anyone else.
 */

import * as THREE from 'three';
import { AnimState } from '@nagisa/shared';
import { inkDepthMaterial } from '../engine/ink/ink-material.js';
import { hair as hairMaterial, outfit as outfitMaterial, shoji, skin as skinMaterial, surface, wood } from '../world/materials.js';
import { paperLantern } from '../world/props/kit.js';
import { mergeByMaterial } from '../world/props/geometry.js';

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
  // Both forearms level in front of the chest, holding the rod out over the water; a slight
  // forward lean toward the float. The arms are placed by `applyPoseOverrides`, which reads
  // `armRaise` and `elbowBend` from here so the pose blends in rather than snapping. Slow
  // breathing and nothing else: a person watching a float stands very still.
  [AnimState.Fish]: { armSwing: 0.03, legSwing: 0, elbowBend: 0.55, kneeBend: 0.1, rate: 0.8, bob: 0.005, lean: 0.1, armRaise: 0.95, hipFold: 0 },
  // Both arms up in a V and a small bounce on the knees. The rate is half what a jump for
  // joy would be: this is someone pleased with a fish, not a goal celebration.
  [AnimState.Cheer]: { armSwing: 0.1, legSwing: 0, elbowBend: 0.3, kneeBend: 0.2, rate: 5.5, bob: 0.03, lean: -0.08, armRaise: 2.75, hipFold: 0 },
};

/** States whose pose override takes over the left arm, so a carried lantern goes with it. */
const TWO_HANDED: ReadonlySet<AnimState> = new Set([AnimState.Clap, AnimState.Bow, AnimState.Fish, AnimState.Cheer]);

/**
 * How the rod sits in the hand, as a pitch about the forearm's own x axis.
 *
 * The fishing pose puts the forearm level and pointing forward (shoulder −0.95 plus elbow
 * −0.55, less the 0.1 forward lean), so a rod built along +y needs about 135° of pitch in
 * the forearm's frame to come out forward and some 35° above horizontal in the world —
 * the angle an angler actually holds a float rod at.
 */
const ROD_PITCH = 2.36;

/** Rod length ahead of the hand, and how much of the butt sticks out behind it, metres. */
const ROD_LENGTH = 2.3;
const ROD_BUTT = 0.25;

/**
 * The lantern pole's pitch in the forearm's frame: forward and some 30° up while the arm is
 * in the carrying pose (shoulder −0.5, elbow −0.95), which hangs the lantern at chest height
 * a pace ahead — where it lights the path, not the carrier's face.
 */
const POLE_PITCH = 2.5;
const POLE_LENGTH = 0.72;

/**
 * How opaque a disconnected ("away") player is drawn. Enough to be clearly there — they
 * are, for up to 45 seconds — and clearly not quite present.
 */
const FADED_OPACITY = 0.45;

/**
 * Translucent twins of the shared character materials, one per base material.
 *
 * ### Why not `material.transparent = true`
 *
 * Character materials come from the cache in `world/materials.ts` and are **shared** by
 * every figure wearing the same outfit, skin, hair or shoes. Setting `transparent` and
 * `opacity` on them — which is what fading a disconnected player used to do — fades every
 * islander dressed alike, and the next player to come back makes all of them opaque again.
 * And it did not even fade properly: the ink shader only writes its opacity into the alpha
 * channel when it was *compiled* with `IS_TRANSPARENT`, so flipping the flag afterwards
 * blended with the material id as alpha instead.
 *
 * ### Why not `material.clone()`
 *
 * `ShaderMaterial.clone` deep-copies its uniforms, and an ink material's lighting uniforms
 * are the *shared* `inkLighting` objects the sky writes once a frame. A clone would keep
 * the light of the moment it was made — a ghost lit for noon standing in the dusk.
 *
 * So a variant is a new material over the same shader source with `IS_TRANSPARENT`
 * defined, and a **shallow** copy of the uniform map: every uniform object is the base's
 * own (lighting, colour, the shoji glow) except `uOpacity`, which is the variant's.
 * Weakly keyed, so a variant lives exactly as long as the material it shadows.
 */
const fadedVariants = new WeakMap<THREE.Material, THREE.Material>();

function fadedVariant(base: THREE.Material): THREE.Material {
  const known = fadedVariants.get(base);
  if (known) return known;
  // Every character surface is an ink material; anything else is left opaque rather than
  // guessed at.
  if (!(base instanceof THREE.ShaderMaterial)) return base;
  const variant = new THREE.ShaderMaterial({
    glslVersion: base.glslVersion ?? undefined,
    defines: { ...base.defines, IS_TRANSPARENT: '' },
    uniforms: { ...base.uniforms, uOpacity: { value: FADED_OPACITY } },
    vertexShader: base.vertexShader,
    fragmentShader: base.fragmentShader,
    lights: base.lights,
    side: base.side,
    transparent: true,
  });
  // Not in three's typings for ShaderMaterial, but read by its program cache; see
  // `createInkMaterial`, which sets it the same way.
  const shading = base as unknown as { flatShading: boolean };
  (variant as unknown as { flatShading: boolean }).flatShading = shading.flatShading;
  variant.name = `${base.name}:faded`;
  fadedVariants.set(base, variant);
  return variant;
}

/** Scratch for the lantern's plumb line. Module-level: a figure's update never allocates. */
const POLE_WORLD = new THREE.Quaternion();
const ROOT_WORLD = new THREE.Quaternion();
const SWAY = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

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

  /** Drawn translucent — see {@link setFaded}. */
  private faded = false;

  /** The rod, built the first time this figure fishes. Shown only while it is. */
  private rod: THREE.Group | null = null;
  private rodTipMarker: THREE.Object3D | null = null;

  /** What the free hand is carrying. */
  private held: 'lantern' | null = null;
  /**
   * The lantern: a pole in the left hand and, at its tip, a hanger that is turned every
   * frame to cancel the pole's own rotation — so the lantern hangs plumb whatever the arm
   * is doing, and swings a little when the figure walks.
   */
  private lantern: { pole: THREE.Group; hanger: THREE.Group; body: THREE.Object3D } | null = null;

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

  /** What the figure is visibly doing: a live emote if there is one, else its state. */
  get effectiveState(): AnimState {
    return this.emoteRemaining > 0 && this.emoteState !== null ? this.emoteState : this.state;
  }

  /** Switch animation. Blending is handled in {@link update}; this is cheap to call. */
  setAnim(state: AnimState): void {
    if (this.state === state) return;
    this.state = state;
    this.target = PROFILES[state];
    this.refreshRod();
  }

  /**
   * Play a one-shot emote for `duration` seconds, after which the character returns to
   * its underlying locomotion state. Emotes are expressions, not states — you can wave
   * while walking.
   */
  playEmote(state: AnimState, duration = 2.0): void {
    this.emoteState = state;
    this.emoteRemaining = duration;
    this.refreshRod();
  }

  /**
   * Draw this figure translucent (a disconnected player inside their grace window) or
   * solid again.
   *
   * Per figure, not per material: each mesh is pointed at a translucent *variant* of its
   * material (see {@link fadedVariant}) and back, and the shared originals are never
   * touched. The ink pipeline handles the variant like any transparent surface — the fill
   * blends at `FADED_OPACITY` while the info buffer still takes the figure's depth and
   * normals, so the ghost keeps its pen contours.
   */
  setFaded(faded: boolean): void {
    if (this.faded === faded) return;
    this.faded = faded;
    this.applyFade(this.root);
  }

  /** Point every mesh under `object` at the material the current fade calls for. */
  private applyFade(object: THREE.Object3D): void {
    object.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      // The original is remembered on the mesh the first time it is swapped; a mesh built
      // while the figure was already faded is caught the same way.
      const base = (obj.userData.baseMaterial ??= obj.material) as THREE.Material;
      obj.material = this.faded ? fadedVariant(base) : base;
    });
  }

  /**
   * Carry something in the free hand, or nothing. The lantern walk is the only thing that
   * asks for this today.
   */
  setHeldProp(prop: 'lantern' | null): void {
    if (this.held === prop) return;
    this.held = prop;
    if (prop === 'lantern' && !this.lantern) this.lantern = this.buildLantern();
    if (this.lantern) this.lantern.pole.visible = prop === 'lantern';
  }

  get heldProp(): 'lantern' | null {
    return this.held;
  }

  /**
   * World position of the rod's tip, where a fishing line starts. Null when no rod is out.
   * Updates this figure's world matrices, which the renderer would do anyway.
   */
  rodTip(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.rod?.visible || !this.rodTipMarker || !this.root.visible) return null;
    return this.rodTipMarker.getWorldPosition(out);
  }

  /** World position of the carried lantern's paper body, for its glow. Null if none. */
  lanternPosition(out: THREE.Vector3): THREE.Vector3 | null {
    if (this.held !== 'lantern' || !this.lantern || !this.root.visible) return null;
    return this.lantern.body.getWorldPosition(out);
  }

  /** Show the rod exactly while the figure is visibly fishing. */
  private refreshRod(): void {
    const fishing = this.effectiveState === AnimState.Fish;
    if (fishing && !this.rod) this.rod = this.buildRod();
    if (this.rod && this.rod.visible !== fishing) this.rod.visible = fishing;
  }

  /**
   * A float rod: a tapering bamboo cane with a dark grip, in the right hand. Two meshes,
   * a few dozen triangles, two library materials.
   */
  private buildRod(): THREE.Group {
    const rod = new THREE.Group();
    rod.name = 'rod';
    rod.position.set(0, -0.235, 0);
    rod.rotation.x = ROD_PITCH;

    const cane = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.018, ROD_LENGTH + ROD_BUTT, 5), wood('light'));
    cane.position.y = (ROD_LENGTH - ROD_BUTT) / 2;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.028, 0.34, 6), wood('dark'));
    grip.position.y = -0.06;
    for (const part of [cane, grip]) {
      part.castShadow = true;
      part.customDepthMaterial = inkDepthMaterial();
      rod.add(part);
    }

    this.rodTipMarker = new THREE.Object3D();
    this.rodTipMarker.position.y = ROD_LENGTH;
    rod.add(this.rodTipMarker);

    rod.visible = false;
    this.elbowR.add(rod);
    this.applyFade(rod);
    return rod;
  }

  /**
   * A chōchin on a short pole, in the left hand: the kit's paper lantern, small, under a
   * cord. The paper is the library's `shoji`, whose glow the day cycle already raises
   * after dusk — so the lantern lights itself at exactly the moment every window on the
   * island does, and needs nothing of its own to do it.
   */
  private buildLantern(): { pole: THREE.Group; hanger: THREE.Group; body: THREE.Object3D } {
    const pole = new THREE.Group();
    pole.name = 'lantern';
    pole.position.set(0, -0.235, 0);
    pole.rotation.x = POLE_PITCH;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.014, POLE_LENGTH + 0.08, 5), wood('dark'));
    shaft.position.y = (POLE_LENGTH - 0.08) / 2;
    shaft.castShadow = true;
    shaft.customDepthMaterial = inkDepthMaterial();
    pole.add(shaft);

    const hanger = new THREE.Group();
    hanger.position.y = POLE_LENGTH;
    pole.add(hanger);
    const height = 0.26;
    const parts = paperLantern(0.095, height, shoji(), wood('dark'));
    for (const part of parts) part.position.y -= height + 0.08;
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.08, 4), wood('dark'));
    cord.position.y = -0.04;
    parts.push(cord);
    for (const mesh of mergeByMaterial(parts)) {
      mesh.customDepthMaterial = inkDepthMaterial();
      hanger.add(mesh);
    }
    const body = new THREE.Object3D();
    body.position.y = -0.08 - height / 2;
    hanger.add(body);

    this.elbowL.add(pole);
    this.applyFade(pole);
    return { pole, hanger, body };
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
      // A cheer over a catch ends with the figure back at its state, rod and all.
      if (this.emoteRemaining <= 0) this.refreshRod();
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

    const pose = this.effectiveState;
    this.applyPoseOverrides(pose);
    if (this.held === 'lantern' && !TWO_HANDED.has(pose)) this.applyCarryPose();

    // The body bobs at twice the limb rate: one rise per footfall, two per stride.
    this.hips.position.y = this.hipHeight - this.blended.hipFold * 0.28 + Math.abs(swing) * this.blended.bob;
    this.torso.rotation.x = this.blended.lean;
    // A slight head counter-rotation keeps the gaze level while the body leans.
    this.head.rotation.x = -this.blended.lean * 0.55;

    if (this.held === 'lantern' && this.lantern) this.hangLantern();
  }

  /**
   * The left arm held forward at the waist, carrying the lantern pole ahead of the body.
   * Applied over locomotion, so the lantern goes up the shrine path held steady rather than
   * swung like a handbag.
   */
  private applyCarryPose(): void {
    this.shoulderL.rotation.set(-0.5, 0, 0.1);
    this.elbowL.rotation.set(-0.95, 0, 0);
  }

  /**
   * Turn the lantern to hang plumb under the pole's tip, facing the way the figure does,
   * with a small pendulum swing in step with the stride.
   *
   * Exact rather than approximated from the joint angles: the hanger's local rotation is
   * the inverse of the pole's world rotation times the root's, which is right whatever
   * the arm is doing — a bow, a cheer and a wave all move the pole.
   */
  private hangLantern(): void {
    const { pole, hanger } = this.lantern!;
    pole.getWorldQuaternion(POLE_WORLD);
    this.root.getWorldQuaternion(ROOT_WORLD);
    SWAY.setFromAxisAngle(X_AXIS, Math.sin(this.phase + 0.6) * 0.25 * this.blended.legSwing);
    hanger.quaternion.copy(POLE_WORLD.invert()).multiply(ROOT_WORLD).multiply(SWAY);
  }

  /**
   * Poses that the swing/counter-swing cycle cannot express, applied after it.
   *
   * Waving is one arm only — mirroring it reads as surrender, not greeting. Clapping
   * brings the hands together in front rather than swinging them past each other. Bowing
   * drops the arms to the sides and holds them there. Fishing holds the rod out with both
   * hands; cheering puts both arms up.
   *
   * Keyed on the *effective* state, not only on emotes: a remote angler is in the `Fish`
   * state rather than playing an emote, and still has to hold the rod like one.
   */
  private applyPoseOverrides(pose: AnimState): void {
    if (pose === AnimState.Fish) {
      // Right hand on the grip with the forearm level; the left further up the rod and a
      // little inboard. Driven by the blended profile so the arms come up rather than
      // snap, and with the breathing on the shoulders only, so the rod tip barely moves.
      const raise = this.blended.armRaise;
      const bend = this.blended.elbowBend;
      const breath = Math.sin(this.phase) * this.blended.armSwing;
      this.shoulderR.rotation.set(-raise + breath, 0, -0.1);
      this.elbowR.rotation.set(-bend, 0, 0);
      this.shoulderL.rotation.set(-raise * 0.8 + breath, 0, 0.3);
      this.elbowL.rotation.set(-bend * 1.9, 0, 0);
      return;
    }

    if (pose === AnimState.Cheer) {
      // Both arms up and out in a V, pumping together — alternating reads as running.
      const up = -this.blended.armRaise + Math.sin(this.phase) * this.blended.armSwing;
      const splay = 0.38 * Math.min(1, this.blended.armRaise / 2.75);
      this.shoulderL.rotation.set(up, 0, -splay);
      this.shoulderR.rotation.set(up, 0, splay);
      this.elbowL.rotation.set(-this.blended.elbowBend, 0, 0);
      this.elbowR.rotation.set(-this.blended.elbowBend, 0, 0);
      return;
    }

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
