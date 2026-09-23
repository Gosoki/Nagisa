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
import { serverNow } from '../state/stores.js';
import { createInkMaterial, inkDepthMaterial } from '../engine/ink/ink-material.js';
import { cloth, hair as hairMaterial, outfit as outfitMaterial, shoji, skin as skinMaterial, surface, wood } from '../world/materials.js';
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
}

/**
 * Per-state motion parameters.
 *
 * These numbers are the entire animation system. Tuning the world's *feel* — whether
 * people bustle or amble — happens here and nowhere else.
 *
 * `bob` is the lift *on top of* a planted stride (see {@link legReach}): the dip of the body
 * as the legs open is the walk's own rise and fall, so a walk needs almost none and a run
 * gets its flight from it. Sitting is not a profile at all — it depends on what is under the
 * figure, and is posed by `Character.applySeat`.
 */
const PROFILES: Record<AnimState, AnimProfile> = {
  [AnimState.Idle]: { armSwing: 0.04, legSwing: 0.0, elbowBend: 0.18, kneeBend: 0.05, rate: 1.1, bob: 0.011, lean: 0, armRaise: 0 },
  [AnimState.Walk]: { armSwing: 0.5, legSwing: 0.62, elbowBend: 0.42, kneeBend: 0.62, rate: 7.0, bob: 0.012, lean: 0.05, armRaise: 0 },
  [AnimState.Run]: { armSwing: 0.9, legSwing: 0.95, elbowBend: 0.95, kneeBend: 1.15, rate: 10.4, bob: 0.07, lean: 0.2, armRaise: 0.12 },
  [AnimState.Jump]: { armSwing: 0.1, legSwing: 0.22, elbowBend: 0.5, kneeBend: 0.8, rate: 0, bob: 0, lean: -0.1, armRaise: 1.5 },
  [AnimState.Fall]: { armSwing: 0.1, legSwing: 0.32, elbowBend: 0.4, kneeBend: 0.5, rate: 0, bob: 0, lean: 0.09, armRaise: 1.1 },
  // Legs still: `applySeat` places them, and a knee bend here used to fold one shin up
  // through its own thigh and the bench every few seconds.
  [AnimState.Sit]: { armSwing: 0.02, legSwing: 0, elbowBend: 0.55, kneeBend: 0, rate: 0.8, bob: 0.005, lean: 0.1, armRaise: 0 },
  [AnimState.Clap]: { armSwing: 0.0, legSwing: 0, elbowBend: 1.25, kneeBend: 0.05, rate: 9.0, bob: 0.009, lean: 0.03, armRaise: 1.05 },
  [AnimState.Wave]: { armSwing: 0.0, legSwing: 0, elbowBend: 0.9, kneeBend: 0.05, rate: 6.0, bob: 0.011, lean: 0, armRaise: 2.2 },
  [AnimState.Bow]: { armSwing: 0.0, legSwing: 0, elbowBend: 0.15, kneeBend: 0.05, rate: 0, bob: 0, lean: 0.8, armRaise: 0 },
  // The rod held out over the water in the right hand, forearm level; a slight forward lean
  // toward the float. The arms are placed by `applyPoseOverrides`, which reads `armRaise` and
  // `elbowBend` from here so the pose blends in rather than snapping. Slow breathing and
  // nothing else: a person watching a float stands very still.
  [AnimState.Fish]: { armSwing: 0.03, legSwing: 0, elbowBend: 0.55, kneeBend: 0.1, rate: 0.8, bob: 0.005, lean: 0.1, armRaise: 0.95 },
  // Both arms up in a V and a small bounce on the knees. The rate is half what a jump for
  // joy would be: this is someone pleased with a fish, not a goal celebration.
  [AnimState.Cheer]: { armSwing: 0.1, legSwing: 0, elbowBend: 0.3, kneeBend: 0.2, rate: 5.5, bob: 0.03, lean: -0.08, armRaise: 2.75 },
  // Bon-odori: the arms are placed by `applyPoseOverrides` on the island's beat, not on this
  // figure's own phase; the rate only keeps a small bounce going in the knees.
  [AnimState.Dance]: { armSwing: 0, legSwing: 0, elbowBend: 0.7, kneeBend: 0.18, rate: 3.1, bob: 0.02, lean: 0, armRaise: 1.25 },
};

/**
 * The dance's beat, radians: one figure — raise to the right, raise to the left — every two
 * seconds, read off the server's clock. Everyone dancing is on the same beat because they are
 * all reading the same clock; nothing about the dance is sent but the fact of it.
 */
function danceBeat(): number {
  return (serverNow() / 1000) * Math.PI;
}

/**
 * Leg geometry, metres: the thigh and shin bones, and the shoe hanging off the shin. The rig
 * below is built from these and {@link legReach} measures it, and the two have to agree.
 */
const THIGH = 0.34;
const SHIN = 0.34;
const SHOE = { height: 0.075, length: 0.2, forward: 0.045 };

/**
 * How far below its hip joint a leg reaches at these joint angles — to the lowest corner of
 * the shoe, because a shoe tipped by the shin puts its toe or its heel down first.
 */
function legReach(hip: number, knee: number): number {
  const shin = hip + knee;
  // Rotating about +x swings the foot backward for a positive angle, which drops the toe.
  const end = Math.sin(shin) > 0 ? SHOE.forward + SHOE.length / 2 : SHOE.forward - SHOE.length / 2;
  return THIGH * Math.cos(hip) + (SHIN + SHOE.height / 2) * Math.cos(shin) + end * Math.sin(shin);
}

/** A straight leg's reach. The resting hip height is set against it. */
const REST_REACH = legReach(0, 0);

/** States in which the feet are off the ground by design, and are not planted. */
const AIRBORNE: ReadonlySet<AnimState> = new Set([AnimState.Jump, AnimState.Fall]);

/**
 * From a seat's surface up to the hips: the depth of the hips block below its origin, so the
 * figure sits *on* the seat rather than hovering over it or sinking into it.
 */
const SEAT_TO_HIPS = 0.13;

/** The hip joints hang this far below the hips. */
const HIP_DROP = 0.085;

/** States whose pose override takes over the left arm, so a carried lantern goes with it. */
const TWO_HANDED: ReadonlySet<AnimState> = new Set([AnimState.Clap, AnimState.Bow, AnimState.Fish, AnimState.Cheer, AnimState.Dance]);

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
 * The umbrella: a wagasa of oiled paper on a bamboo shaft, the canopy this far above the
 * hand and this wide — clear over the head and a straw hat's crown with the arm in the
 * umbrella pose, and wide enough to cover the shoulders.
 */
const UMBRELLA_RISE = 0.78;
const UMBRELLA_RADIUS = 0.52;
const UMBRELLA_DEPTH = 0.2;
/** Oiled-paper colours an umbrella may be, chosen per figure so a crowd is not one umbrella. */
const UMBRELLA_COLORS = [0xb4412f, 0x2f4a6b, 0xc58a3a, 0x5e7d4f] as const;

/** Poses that need the left arm for themselves; an umbrella is held up through anything else. */
const ARM_BUSY: ReadonlySet<AnimState> = new Set([AnimState.Clap, AnimState.Bow, AnimState.Cheer, AnimState.Dance]);

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

/**
 * A faded figure's depth, drawn before any of its colour.
 *
 * Translucent surfaces are sorted back to front *per mesh* and each blends over whatever is
 * already there, so a faded figure showed everything inside it: the upper arms running into
 * the chest, the neck inside the collar, the back of the head through the face, the eyes
 * through the hair. A ghost should be the figure's front surface, faded — so every faded
 * mesh carries a depth-only twin, all of them drawn first (`GHOST_DEPTH_ORDER`), and the
 * faded colour after them passes the depth test only where it is the nearest surface.
 *
 * After the opaque world rather than with it, as a translucent pass that writes no colour:
 * drawn with the opaque meshes it would hide the scenery behind the ghost, and there would
 * be nothing there to see through to.
 */
let ghostDepth: THREE.ShaderMaterial | null = null;

function ghostDepthMaterial(): THREE.ShaderMaterial {
  if (!ghostDepth) {
    ghostDepth = createInkMaterial({ transparent: true });
    ghostDepth.colorWrite = false;
    ghostDepth.name = 'ghost-depth';
  }
  return ghostDepth;
}

/** Translucent draw order: after the sea (−1), before every effect (3 and up). */
const GHOST_DEPTH_ORDER = 1;
const GHOST_FILL_ORDER = 2;

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
 *
 * ### Normals from the rounding, not from the triangles
 *
 * A box's six faces share no vertices, so normals computed from its triangles disagree
 * wherever two faces meet: the "rounded" corner was really two creases, the shading
 * stepped across it, and the contour pass drew both. The normal here is the direction
 * the rounding pushed the vertex out along — the face's own normal on the flat, turning
 * through the bevel — which is the same for the two copies of every edge vertex, so a
 * corner shades as the curve it is meant to be and draws as one line at most.
 *
 * ### Where the flat ends
 *
 * Parts big enough to be seen as masses (`bevel`) get three rows per face, and the two
 * inner rows are moved out to exactly where the rounding begins: each face is then a flat
 * panel with one row of bevel round it. On two uniform rows there is no vertex where the
 * flat ends, and the face shades as a dome. The small parts — brows, ears, cuffs — keep
 * two rows, and are too small for the difference to show.
 */
function roundedBox(w: number, h: number, d: number, radius: number, material: THREE.Material, bevel = Math.min(w, h, d) >= 0.06): THREE.Mesh {
  const rows = bevel ? 3 : 2;
  const geo = new THREE.BoxGeometry(w, h, d, rows, rows, rows);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const clamped = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const half = new THREE.Vector3(w / 2, h / 2, d / 2);
  const inner = new THREE.Vector3(Math.max(0.001, half.x - radius), Math.max(0.001, half.y - radius), Math.max(0.001, half.z - radius));
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (bevel) {
      // The inner rows sit at a third of the way in; move them to the edge of the flat.
      for (const axis of ['x', 'y', 'z'] as const) {
        if (Math.abs(v[axis]) < half[axis] * 0.99) v[axis] = Math.sign(v[axis]) * inner[axis];
      }
    }
    // Clamp to the inner box, then push back out by `radius` along the direction to the
    // original vertex — the standard rounded-box construction.
    clamped.set(
      THREE.MathUtils.clamp(v.x, -inner.x, inner.x),
      THREE.MathUtils.clamp(v.y, -inner.y, inner.y),
      THREE.MathUtils.clamp(v.z, -inner.z, inner.z),
    );
    offset.subVectors(v, clamped);
    // Every surface vertex lies outside the inner box along its own face's axis at least,
    // so the offset is never zero.
    offset.normalize();
    pos.setXYZ(i, clamped.x + offset.x * radius, clamped.y + offset.y * radius, clamped.z + offset.z * radius);
    nor.setXYZ(i, offset.x, offset.y, offset.z);
  }
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

  /**
   * What the figure sits on while seated, metres above its feet: 0 for the ground, a bench's
   * seat height on a bench. Set by whoever owns the figure's position — see `benchSeat`.
   */
  private seatHeight = 0;
  /** 0 standing, 1 seated, blended like the profiles so sitting down is a movement. */
  private sitAmount = 0;

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

  /** Whether it is raining on this figure (see `setUmbrella`), and the umbrella once built. */
  private umbrellaUp = false;
  private umbrella: THREE.Group | null = null;
  private readonly umbrellaColor: number;

  constructor(appearance: CharacterAppearance) {
    this.root.name = 'character';
    this.umbrellaColor = UMBRELLA_COLORS[(appearance.outfit + appearance.skin) % UMBRELLA_COLORS.length];

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
    // Deeper below the hip joints than above them: it is what a seated figure rests on, and
    // at 2 cm under the joints the thighs, not the hips, touched the seat — so the figure
    // either hovered over a bench with a gap under it or had its thighs sunk into the planks.
    this.hips.add(at(roundedBox(0.35, 0.105 + SEAT_TO_HIPS, 0.25, 0.07, trousers), 0, (0.105 - SEAT_TO_HIPS) / 2, 0));

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
      this.detail.add(buildAccessory(appearance.accessory % ACCESSORY_COUNT, outer));
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
      const hip = joint(sx * 0.095, -HIP_DROP, 0);
      this.hips.add(hip);
      hip.add(limbSegment(THIGH, 0.078, 0.062, trousers));

      const knee = joint(0, -THIGH, 0);
      hip.add(knee);
      knee.add(limbSegment(SHIN - 0.02, 0.062, 0.05, trousers));
      // Foot, projecting forward from the ankle.
      knee.add(at(roundedBox(0.1, SHOE.height, SHOE.length, 0.032, shoe), 0, -SHIN, SHOE.forward));
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
    // A state this build does not know — a newer client's, arriving over the wire — is
    // drawn standing rather than breaking every frame that reads its profile.
    if (!(state in PROFILES)) state = AnimState.Idle;
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
    if (!(state in PROFILES)) return;
    this.emoteState = state;
    this.emoteRemaining = duration;
    this.refreshRod();
  }

  /**
   * Move the cycle to a phase, radians. For the render probe, which reviews poses as stills
   * and has to photograph the same stride every time.
   */
  setPhase(phase: number): void {
    this.phase = phase;
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

  /**
   * Point every mesh under `object` at the material the current fade calls for, and show or
   * hide its depth twin (see {@link ghostDepthMaterial}). The twins are made the first time
   * a figure fades and kept, sharing the mesh's geometry; nobody who never disconnects pays
   * for one.
   */
  private applyFade(object: THREE.Object3D): void {
    const meshes: THREE.Mesh[] = [];
    object.traverse((obj) => {
      if (obj instanceof THREE.Mesh && !obj.userData.ghostDepth) meshes.push(obj);
    });
    for (const mesh of meshes) {
      // The original is remembered on the mesh the first time it is swapped; a mesh built
      // while the figure was already faded is caught the same way.
      const base = (mesh.userData.baseMaterial ??= mesh.material) as THREE.Material;
      mesh.material = this.faded ? fadedVariant(base) : base;
      mesh.renderOrder = this.faded ? GHOST_FILL_ORDER : 0;
      let twin = mesh.userData.ghostTwin as THREE.Mesh | undefined;
      if (this.faded && !twin) {
        twin = new THREE.Mesh(mesh.geometry, ghostDepthMaterial());
        twin.userData.ghostDepth = true;
        twin.renderOrder = GHOST_DEPTH_ORDER;
        mesh.add(twin);
        mesh.userData.ghostTwin = twin;
      }
      if (twin) twin.visible = this.faded;
    }
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
    this.refreshUmbrella();
  }

  /**
   * Put an umbrella up (in the rain) or down. Held in the left hand — the lantern's hand, and
   * the lantern wins: in a procession in the rain, the lantern is the point of the walk.
   */
  setUmbrella(up: boolean): void {
    if (this.umbrellaUp === up) return;
    this.umbrellaUp = up;
    if (up && !this.umbrella) this.umbrella = this.buildUmbrella();
    this.refreshUmbrella();
  }

  private get umbrellaShown(): boolean {
    return this.umbrellaUp && this.held !== 'lantern';
  }

  private refreshUmbrella(): void {
    if (this.umbrella) this.umbrella.visible = this.umbrellaShown;
  }

  get heldProp(): 'lantern' | null {
    return this.held;
  }

  /**
   * How high above its feet the figure's seat is, metres, for the next time it sits — and
   * while it sits. 0, the default, is the ground.
   */
  setSeatHeight(height: number): void {
    this.seatHeight = Math.max(0, height);
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
   * A wagasa in the left hand: a bamboo shaft and a shallow cone of oiled paper, with a small
   * cap at the crown. Built upright and turned every frame to stay upright
   * (`standUmbrella`), so it is held straight whatever the arm is doing.
   */
  private buildUmbrella(): THREE.Group {
    const holder = new THREE.Group();
    holder.name = 'umbrella';
    holder.position.set(0, -0.235, 0);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, UMBRELLA_RISE + 0.1, 5), wood('light'));
    shaft.position.y = (UMBRELLA_RISE - 0.1) / 2;
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(UMBRELLA_RADIUS, UMBRELLA_DEPTH, 12, 1, true), cloth(this.umbrellaColor));
    canopy.position.y = UMBRELLA_RISE;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.035, 0.05, 6), wood('dark'));
    cap.position.y = UMBRELLA_RISE + UMBRELLA_DEPTH / 2;
    for (const part of [shaft, canopy, cap]) {
      part.castShadow = true;
      part.customDepthMaterial = inkDepthMaterial();
      holder.add(part);
    }
    holder.visible = false;
    this.elbowL.add(holder);
    this.applyFade(holder);
    return holder;
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
    // On the *state*, not the goal profile: waving from a bench is waving while seated, and
    // an emote that took the legs with it stood the figure up inside the bench for two
    // seconds and sat it back down.
    this.sitAmount += ((this.state === AnimState.Sit ? 1 : 0) - this.sitAmount) * k;

    this.phase += dt * this.blended.rate;

    const swing = Math.sin(this.phase);
    const counter = -swing;

    // Arms and legs are in opposition — the diagonal gait every biped uses. The arms hang
    // from the *world's* vertical rather than the torso's, less the lean: a bow used to swing
    // them back behind the body with it, like a ski jumper's.
    this.shoulderL.rotation.x = swing * this.blended.armSwing - this.blended.armRaise - this.blended.lean;
    this.shoulderR.rotation.x = counter * this.blended.armSwing - this.blended.armRaise - this.blended.lean;
    this.hipL.rotation.x = counter * this.blended.legSwing;
    this.hipR.rotation.x = swing * this.blended.legSwing;

    // Elbows and knees bend on the *return* half of each stride only, and never the wrong
    // way. `max(0, …)` is doing real work here: an elbow that hyperextends is the single
    // most obvious tell that a rig is being driven by a raw sine.
    this.elbowL.rotation.x = -Math.max(0, counter) * this.blended.elbowBend - this.blended.elbowBend * 0.25;
    this.elbowR.rotation.x = -Math.max(0, swing) * this.blended.elbowBend - this.blended.elbowBend * 0.25;
    this.kneeL.rotation.x = Math.max(0, swing) * this.blended.kneeBend;
    this.kneeR.rotation.x = Math.max(0, counter) * this.blended.kneeBend;

    const pose = this.effectiveState;
    this.applyPoseOverrides(pose);
    if (this.held === 'lantern' && !TWO_HANDED.has(pose)) this.applyCarryPose();
    else if (this.umbrellaShown && !ARM_BUSY.has(pose)) this.applyUmbrellaPose();

    // Plant the stride: lower the body by however much the longer leg falls short of the
    // ground. Without it the hips rode at a fixed height while the legs opened beneath them,
    // and a walking figure floated 11 cm clear of the ground at the top of every step — 25 at
    // a run. The dip this gives is a walk's own rise and fall, low where the legs are apart
    // and high where they pass, so the bob on top of it can be small. Not in the air, where
    // tucked legs are the point.
    let hipsY = this.hipHeight + Math.abs(swing) * this.blended.bob;
    if (!AIRBORNE.has(this.state)) {
      const reach = Math.max(legReach(this.hipL.rotation.x, this.kneeL.rotation.x), legReach(this.hipR.rotation.x, this.kneeR.rotation.x));
      hipsY -= REST_REACH - reach;
    }
    if (this.sitAmount > 0.001) hipsY = this.applySeat(hipsY);
    this.hips.position.y = hipsY;
    this.torso.rotation.x = this.blended.lean;
    // A slight head counter-rotation keeps the gaze level while the body leans.
    this.head.rotation.x = -this.blended.lean * 0.55;

    if (this.held === 'lantern' && this.lantern) this.hangLantern();
    if (this.umbrella && this.umbrellaShown) this.standUmbrella();
  }

  /**
   * The left forearm raised in front of the chest, holding the shaft: the hand at about
   * shoulder height and a little forward, so the canopy sits over the head rather than in
   * front of the face.
   */
  private applyUmbrellaPose(): void {
    this.shoulderL.rotation.set(-0.55, 0, -0.18);
    this.elbowL.rotation.set(-1.35, 0, 0);
  }

  /**
   * Stand the umbrella straight up from the hand, however the arm is turned — the same
   * cancellation as the lantern's plumb line, with a slight backward tilt so the canopy
   * leans over the head, and the stride's small sway.
   */
  private standUmbrella(): void {
    this.elbowL.getWorldQuaternion(POLE_WORLD);
    this.root.getWorldQuaternion(ROOT_WORLD);
    SWAY.setFromAxisAngle(X_AXIS, -0.12 + Math.sin(this.phase) * 0.04 * this.blended.legSwing);
    this.umbrella!.quaternion.copy(POLE_WORLD.invert()).multiply(ROOT_WORLD).multiply(SWAY);
  }

  /**
   * The lower body on whatever the figure is sitting on, blended over the standing legs by
   * how far into sitting down it is. Returns the hips' height.
   *
   * Solved rather than posed, because the seat is not always the same height. The hips rest
   * on the seat; the thighs run level off a chair-height seat and rise toward the knees on
   * the ground, where there is nowhere for them to go but up; the shins then drop from the
   * knee to wherever the shoe meets the ground. A seat too high for the shins to reach tips
   * the thighs down instead, and one higher than the whole leg leaves the feet hanging.
   *
   * The old sitting pose was one fixed fold with the hips 0.38 m up whatever was under them:
   * on the ground that was a figure perched on nothing with its shoes 12 cm into the earth,
   * and at a bench it was a figure sitting inside the bench.
   */
  private applySeat(standingHipsY: number): number {
    const t = this.sitAmount;
    const hipsY = this.seatHeight + SEAT_TO_HIPS;
    const joint = hipsY - HIP_DROP;
    const shinReach = SHIN + SHOE.height / 2;
    // Level on a seat at knee height, 10° above level on the ground.
    let thigh = THREE.MathUtils.lerp(1.75, Math.PI / 2, THREE.MathUtils.clamp((joint - 0.045) / 0.3, 0, 1));
    let knee = joint - THIGH * Math.cos(thigh);
    if (knee > shinReach) {
      thigh = Math.acos(THREE.MathUtils.clamp((joint - shinReach) / THIGH, 0, 1));
      knee = shinReach;
    }
    // How far forward of the knee the shin swings to reach the ground — heel first, since a
    // shin swung forward tips the shoe back onto it: the reach is L·cos φ + heel·sin φ, which
    // is R·cos(φ − δ). Solved without the heel, the ground sit put it 4 cm into the ground.
    const heel = SHOE.length / 2 - SHOE.forward;
    const reach = Math.hypot(shinReach, heel);
    const shin = Math.atan2(heel, shinReach) + Math.acos(THREE.MathUtils.clamp(knee / reach, 0, 1));
    for (const [hip, kneeJoint] of [
      [this.hipL, this.kneeL],
      [this.hipR, this.kneeR],
    ] as const) {
      hip.rotation.x += (-thigh - hip.rotation.x) * t;
      kneeJoint.rotation.x += (thigh - shin - kneeJoint.rotation.x) * t;
    }
    return standingHipsY + (hipsY - standingHipsY) * t;
  }

  /**
   * The left arm held forward at the waist, carrying the lantern pole ahead of the body.
   * Applied over locomotion, so the lantern goes up the shrine path held steady rather than
   * swung like a handbag. Turned a little out from the body: turned in, the forearm ran 2 cm
   * into the chest.
   */
  private applyCarryPose(): void {
    this.shoulderL.rotation.set(-0.5, 0, -0.12);
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
   * drops the arms to hang in front of the thighs. Fishing holds the rod out; cheering puts
   * both arms up; sitting rests the hands at the sides of the lap.
   *
   * Keyed on the *effective* state, not only on emotes: a remote angler is in the `Fish`
   * state rather than playing an emote, and still has to hold the rod like one.
   *
   * ### Which way is in
   *
   * A shoulder's `rotation.z` is applied before its pitch, so it swings the arm *sideways*
   * from hanging: positive swings the right arm (+x) out from the body and the left arm in.
   * Two of these poses had it backwards — the clap splayed the arms outward so the hands
   * stopped half a metre apart, and the wave rolled the arm inward so the hand swept back
   * and forth across the face. The angles below were solved for where the hand should be,
   * with the elbow and forearm kept clear of the chest.
   */
  private applyPoseOverrides(pose: AnimState): void {
    if (pose === AnimState.Fish) {
      // Right hand on the grip with the forearm level. Driven by the blended profile so the
      // arm comes up rather than snapping, and with the breathing on the shoulder only, so
      // the rod tip barely moves.
      //
      // One hand, not two. The left used to be raised "further up the rod", but an arm this
      // length cannot reach a rod held out at the right hip — it ended a hand's width short
      // in the air — and every pose that could reach laid the forearm across the chest. A
      // float rod is held in one hand anyway; the other hangs.
      const raise = this.blended.armRaise;
      const bend = this.blended.elbowBend;
      const breath = Math.sin(this.phase) * this.blended.armSwing;
      this.shoulderR.rotation.set(-raise + breath, 0, -0.1);
      this.elbowR.rotation.set(-bend, 0, 0);
      this.shoulderL.rotation.set(-0.15 - this.blended.lean + breath * 0.5, 0, -0.06);
      this.elbowL.rotation.set(-0.3, 0, 0);
      return;
    }

    if (pose === AnimState.Dance) {
      // Both arms raised to the side and forward, one higher and then the other, the hands
      // opening outward on the high side — bon-odori's gesture, drawn with two joints.
      // Outward is +z for the right arm and −z for the left (see "Which way is in").
      const s = Math.sin(danceBeat());
      const raise = this.blended.armRaise;
      this.shoulderR.rotation.set(-raise * (0.55 + 0.45 * s), 0, 0.5 + 0.25 * s);
      this.shoulderL.rotation.set(-raise * (0.55 - 0.45 * s), 0, -0.5 + 0.25 * s);
      this.elbowR.rotation.set(-this.blended.elbowBend, 0, 0);
      this.elbowL.rotation.set(-this.blended.elbowBend, 0, 0);
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
      // Upper arm out to the side and forward, forearm up, hand beside the head at its own
      // height and a hand's width clear of it; the wave is the forearm rocking side to side.
      this.shoulderL.rotation.set(-this.blended.lean, 0, 0);
      this.elbowL.rotation.set(-0.2, 0, 0);
      this.shoulderR.rotation.set(-2.075, 0, 0.675);
      this.elbowR.rotation.set(-1.15, 0, Math.sin(this.phase) * 0.4);
      return;
    }

    if (emote === AnimState.Clap) {
      // Between hands a palm apart and hands meeting, a forearm's length out in front of the
      // chest — as close in as the elbows can come without going into it.
      const shut = Math.abs(Math.sin(this.phase));
      for (const [shoulder, elbow, sx] of [
        [this.shoulderL, this.elbowL, -1],
        [this.shoulderR, this.elbowR, 1],
      ] as const) {
        shoulder.rotation.set(-1.025 - 0.175 * shut, 0, -sx * (0.1 + 0.325 * shut));
        elbow.rotation.set(-0.95 + 0.55 * shut, 0, 0);
      }
      return;
    }

    if (emote === AnimState.Bow) {
      // Hanging plumb from the leaning shoulders and a little forward, so the hands come down
      // the front of the thighs the way a bow is made.
      for (const shoulder of [this.shoulderL, this.shoulderR]) {
        shoulder.rotation.set(-this.blended.lean * 1.15, 0, 0);
      }
      this.elbowL.rotation.set(-0.1, 0, 0);
      this.elbowR.rotation.set(-0.1, 0, 0);
      return;
    }

    if (this.sitAmount > 0.001) {
      // Hands down at the sides of the lap, forearms forward: on the bench beside the thighs,
      // or on the ground beside them. An arm this length cannot reach the top of its own
      // thigh without going through the waist on the way. On the blend rather than the state,
      // so the arms come back as the figure stands instead of snapping.
      const t = this.sitAmount;
      for (const [shoulder, elbow] of [
        [this.shoulderL, this.elbowL],
        [this.shoulderR, this.elbowR],
      ] as const) {
        shoulder.rotation.set(shoulder.rotation.x + (-0.15 - this.blended.lean - shoulder.rotation.x) * t, 0, 0);
        elbow.rotation.set(elbow.rotation.x + (-0.78 - elbow.rotation.x) * t, 0, 0);
      }
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
 *
 * Each one is sized against the hair it sits over — the cap on the crown is ±0.14 m across
 * and 0.31 m up, the fringe reaches 0.15 m forward — because a hat smaller than the hair is
 * a hat with hair growing through it.
 */
function buildAccessory(index: number, outer: THREE.Material): THREE.Object3D {
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
      // Hachimaki — headband, with the knot at the back. Tied *over* the fringe: at the old
      // size the fringe stood 1.5 cm proud of it, so from the front the band was hidden behind
      // the hair it was meant to be holding back, and at the sides it was exactly as wide as
      // the hair, the two surfaces fighting over the same pixels.
      const band = surface('band', { color: 0xc4503a, shadowColor: 0x8a3a2e, matId: 7, hatch: 0.4 });
      group.add(at(roundedBox(0.296, 0.045, 0.33, 0.018, band), 0, 0.2, -0.005));
      group.add(at(roundedBox(0.06, 0.05, 0.07, 0.02, band), 0, 0.2, -0.19));
      break;
    }
    case 3: {
      // Hood, drawn up over the head — and open at the front. It used to be one box a size
      // up from the head, which closed over the face: the figure looked out through a mask in
      // its jacket's colour, with its eyes and the crown of its hair poking through the cloth.
      // Now a crown, a fall down the back and a side to cover each ear, framing the face with
      // the fringe showing under the brim.
      group.add(at(roundedBox(0.32, 0.2, 0.3, 0.09, outer), 0, 0.26, -0.02));
      group.add(at(roundedBox(0.3, 0.2, 0.1, 0.045, outer), 0, 0.09, -0.13));
      for (const sx of [-1, 1] as const) {
        group.add(at(roundedBox(0.03, 0.22, 0.24, 0.012, outer), sx * 0.148, 0.13, -0.01));
      }
      break;
    }
    default: {
      // Flat cap with a short peak, in cloth. It was a disc in the hair's own material, which
      // the contour pass could not tell from the hair under it: it read as a heap of hair.
      const cloth = surface('cap', { color: 0x4f5968, shadowColor: 0x3a4250, matId: 7, hatch: 0.45 });
      group.add(at(roundedBox(0.31, 0.1, 0.31, 0.045, cloth), 0, 0.29, -0.005));
      const peak = roundedBox(0.2, 0.022, 0.11, 0.009, cloth);
      peak.position.set(0, 0.25, 0.185);
      peak.rotation.x = 0.12;
      group.add(peak);
      break;
    }
  }
  return group;
}
