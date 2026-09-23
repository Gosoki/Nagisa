/**
 * Fishing, as the water shows it.
 * ===============================
 *
 * The game itself is the server's and the interface's: the server rolls the catch, the
 * card says what it was. What is drawn here is what anyone on the pier would *see*:
 *
 * - **Your line.** The float goes out from the rod tip to a point six and a half metres off
 *   the spot, along the way the spot faces, and sits on the actual sea surface — the same
 *   swell the boats ride — bobbing on it. On a bite it ducks under with a ring and a few
 *   drops, and the line pulls taut and twitches. Landed, a fish (in its species' colour)
 *   leaps out of the splash in an arc toward you. Missed, the float is simply gone.
 * - **Everyone else's.** A remote player in the fishing pose gets a float six metres out
 *   along their facing, if that point is water; the rod comes with the pose. Bites are
 *   private — nobody else's float ducks — but a catch is broadcast, and it splashes and
 *   leaps for everyone.
 *
 * Floats, splashes and fish are pooled; the line is one small vertex buffer rewritten in
 * place. Nothing allocates per frame.
 */

import * as THREE from 'three';
import {
  AnimState,
  LANDMARKS,
  getFish,
  getInteractable,
  heightAt,
  interactablePosition,
  SCENE_COLORS,
  type PlayerId,
  type PlayerView,
  type WorldEvent,
} from '@nagisa/shared';
import { createInkMaterial, deriveShadow, inkDepthMaterial, inkLighting } from '../engine/ink/ink-material.js';
import { MAT_ID, vermilion, whitewash } from '../world/materials.js';
import { merge } from '../world/props/geometry.js';
import { seaSurfaceAt } from '../world/waves.js';
import type { FishingState } from '../state/stores.js';
import type { FxHost } from './index.js';
import { placeSound, splashVoice } from './audio.js';
import {
  BALLISTIC_FRAGMENT,
  BALLISTIC_VERTEX,
  ballisticGeometry,
  ballisticUniforms,
  fxMaterial,
  lineMaterial,
  ringMaterial,
  ringQuad,
  trackViewport,
} from './materials.js';

type CatchEvent = Extract<WorldEvent, { k: 'catch' }>;

/** How far out your float lands from the spot, along the spot's bearing, metres. */
const CAST_DISTANCE = 6.5;

/** How far out a remote angler's float is drawn, along their facing, metres. */
const REMOTE_CAST = 6;

/** Ground below this is water deep enough for a float, metres. */
const WATER_BELOW = -0.4;

/** Seconds the float takes to fly out. */
const CAST_SECONDS = 0.7;

/**
 * Remote floats drawn at most. Eight lines out at once is a crowded pier; past that, the
 * rest fish without one.
 */
const REMOTE_FLOATS = 8;

/** How often the room is scanned for anglers, seconds. A pose does not change faster. */
const SCAN_INTERVAL = 0.25;

/** Points along a line, rod tip to float. Enough for a smooth sag. */
const LINE_POINTS = 12;

const SPLASHES = 6;
const LEAPS = 3;

/** Seconds a leaping fish is in the air. */
const LEAP_SECONDS = 1.05;

/** Seconds a splash lasts. */
const SPLASH_SECONDS = 1.1;

/** A float and its line. */
interface Rig {
  float: THREE.Group;
  line: THREE.Line;
  positions: THREE.BufferAttribute;
  /** Where the float rests, x/z (y is the sea's). */
  readonly rest: THREE.Vector3;
  /** Whose it is, and whether it is in use. */
  owner: PlayerId | null;
  seed: number;
}

interface Splash {
  drops: THREE.Points;
  dropMaterial: THREE.ShaderMaterial;
  ring: THREE.Mesh;
  ringMaterial: THREE.ShaderMaterial;
  age: number;
  big: boolean;
  active: boolean;
}

interface Leap {
  group: THREE.Group;
  body: THREE.Mesh;
  material: THREE.ShaderMaterial;
  readonly from: THREE.Vector3;
  readonly to: THREE.Vector3;
  /** Metres, nose to tail. */
  length: number;
  age: number;
  active: boolean;
}

export class Fishing {
  private now = 0;
  private scanTimer = 0;
  private players: readonly PlayerView[] = [];

  private readonly floatParts: THREE.BufferGeometry[];
  private readonly lineMaterial = lineMaterial(SCENE_COLORS.ink, 0.7);
  private readonly local: Rig;
  private readonly remote = new Map<PlayerId, Rig>();
  /** The map's rigs as an array, rebuilt on each scan, so the frame loop allocates nothing. */
  private remoteRigs: Rig[] = [];
  private readonly spareRigs: Rig[] = [];

  /** Your line's story so far. */
  private phase: FishingState['phase'] = 'idle';
  private spot: string | null = null;
  private castAt = 0;
  private biteAt = 0;

  private readonly splashes: Splash[] = [];
  private readonly dropGeometry: THREE.BufferGeometry;
  private readonly ringGeometry = ringQuad();

  private readonly leaps: Leap[] = [];
  private readonly fishGeometry: THREE.BufferGeometry;
  private readonly bootGeometry: THREE.BufferGeometry;

  private readonly tip = new THREE.Vector3();
  private readonly floatTop = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  constructor(
    private readonly host: FxHost,
    private readonly group: THREE.Group,
  ) {
    // The float: a bead, red over white, with a short red antenna — the one part that
    // shows once the bead is riding low in the water. Oversized by a third; a true-to-life
    // float is invisible from where the camera stands.
    this.floatParts = [
      new THREE.SphereGeometry(0.085, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.SphereGeometry(0.085, 10, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.CylinderGeometry(0.014, 0.014, 0.22, 5).translate(0, 0.17, 0),
    ];
    this.local = this.makeRig();

    this.dropGeometry = dropletGeometry();
    for (let i = 0; i < SPLASHES; i++) this.splashes.push(this.makeSplash());

    this.fishGeometry = fishShape();
    this.bootGeometry = bootShape();
    for (let i = 0; i < LEAPS; i++) this.leaps.push(this.makeLeap());
  }

  /** The room's other players, for finding who is fishing. */
  setPlayers(players: readonly PlayerView[]): void {
    this.players = players;
  }

  /** Your line changed phase (the `fishing` store). */
  setLocal(state: FishingState): void {
    const before = this.phase;
    this.phase = state.phase;

    if (state.phase === 'waiting' && (before !== 'waiting' || state.spot !== this.spot)) {
      this.spot = state.spot;
      const rest = state.spot ? restPointFor(state.spot) : null;
      if (rest) {
        this.local.rest.copy(rest);
        this.local.owner = this.host.selfId();
        this.castAt = this.now;
      } else {
        this.local.owner = null;
      }
      return;
    }

    if (state.phase === 'bite' && before !== 'bite') {
      this.biteAt = this.now;
      if (this.local.owner) {
        this.splash(this.floatAt(this.local, this.scratch), false);
        this.sound(this.local.rest, false);
      }
      return;
    }

    if (state.phase === 'caught' && before !== 'caught' && this.local.owner && state.caught) {
      const from = this.floatAt(this.local, this.scratch);
      this.splash(from, true);
      this.sound(from, true);
      const me = this.host.selfId();
      const to = me ? this.host.playerPosition(me) : null;
      if (to) this.leap(state.caught.fish, state.caught.size, from, to);
    }

    // Caught, escaped or reeled in: the float goes. An escape takes it quietly.
    if (state.phase !== 'waiting' && state.phase !== 'bite') this.release(this.local);
  }

  /** Someone landed a fish. Yours is drawn from your own line; this is everyone else's. */
  onCatch(event: CatchEvent): void {
    if (event.by === this.host.selfId()) return;
    const position = this.host.playerPosition(event.by);
    const character = this.host.characterOf(event.by);
    if (!position || !character) return;

    // Their own float if they had one drawn; otherwise the water in front of them.
    const rig = this.remote.get(event.by);
    const from = rig ? this.floatAt(rig, this.scratch) : this.inFront(position, character.root.rotation.y, this.scratch);
    if (rig) this.retire(event.by, rig);
    if (from) {
      this.splash(from, true);
      this.sound(from, true);
      this.leap(event.fish, event.size, from, position);
    }
    // They cheer on their own screen; this is where everyone else sees it.
    character.playEmote(AnimState.Cheer, 1.6);
  }

  update(dt: number, elapsed: number): void {
    this.now = elapsed;

    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = SCAN_INTERVAL;
      this.scanAnglers();
    }

    this.drawRig(this.local, true);
    for (const rig of this.remoteRigs) this.drawRig(rig, false);
    this.updateSplashes(dt);
    this.updateLeaps(dt);
  }

  dispose(): void {
    const rigs = [this.local, ...this.remote.values(), ...this.spareRigs];
    for (const rig of rigs) {
      rig.float.removeFromParent();
      rig.line.removeFromParent();
      rig.line.geometry.dispose();
    }
    for (const part of this.floatParts) part.dispose();
    this.lineMaterial.dispose();
    for (const splash of this.splashes) {
      splash.dropMaterial.dispose();
      splash.ringMaterial.dispose();
      splash.drops.removeFromParent();
      splash.ring.removeFromParent();
    }
    this.dropGeometry.dispose();
    this.ringGeometry.dispose();
    for (const leap of this.leaps) {
      leap.material.dispose();
      leap.group.removeFromParent();
    }
    this.fishGeometry.dispose();
    this.bootGeometry.dispose();
  }

  // -------------------------------------------------------------------------
  // Floats and lines
  // -------------------------------------------------------------------------

  /**
   * Find who is fishing, and give each (up to the cap) a float. Reads the pose off the
   * figure — the packed anim channel is what says "fishing", for them as for everyone.
   */
  private scanAnglers(): void {
    for (const [id, rig] of this.remote) {
      if (this.host.characterOf(id)?.animState !== AnimState.Fish) this.retire(id, rig);
    }
    for (const view of this.players) {
      if (this.remote.size >= REMOTE_FLOATS) break;
      if (this.remote.has(view.id)) continue;
      const character = this.host.characterOf(view.id);
      const position = this.host.playerPosition(view.id);
      if (!character || !position || character.animState !== AnimState.Fish) continue;
      const rest = this.inFront(position, character.root.rotation.y, this.scratch, REMOTE_CAST);
      // Fishing into a hedge is a pose, not a line in the water.
      if (!rest) continue;
      const rig = this.spareRigs.pop() ?? this.makeRig();
      rig.rest.copy(rest);
      rig.owner = view.id;
      this.remote.set(view.id, rig);
    }
    this.remoteRigs = [...this.remote.values()];
  }

  /** Take a remote angler's float in and keep it for the next one. */
  private retire(id: PlayerId, rig: Rig): void {
    this.release(rig);
    this.remote.delete(id);
    this.spareRigs.push(rig);
    this.remoteRigs = [...this.remote.values()];
  }

  /** Place one float on the water and draw its line from the owner's rod tip. */
  private drawRig(rig: Rig, mine: boolean): void {
    if (!rig.owner) return;
    const t = this.now;

    // Where the float is: flying out, riding the swell, or pulled under.
    const onWater = this.floatAt(rig, this.floatTop);
    let casting = 0;
    if (mine) {
      casting = Math.max(0, 1 - (t - this.castAt) / CAST_SECONDS);
      if (this.phase === 'bite') {
        // Down, and tugged down again every so often — never a steady pulse.
        const since = t - this.biteAt;
        onWater.y -= 0.24 + 0.05 * Math.abs(Math.sin(since * 7.5)) * Math.min(1, since * 4);
      }
    }

    const character = this.host.characterOf(rig.owner);
    const tip = character?.rodTip(this.tip) ?? null;
    if (casting > 0 && tip) {
      // Out from the rod tip in a shallow arc, landing where it will rest.
      const u = 1 - casting;
      onWater.lerpVectors(tip, this.floatAt(rig, this.scratch), u);
      onWater.y += Math.sin(u * Math.PI) * 1.4;
    }
    rig.float.position.copy(onWater);
    rig.float.visible = true;

    if (!tip) {
      rig.line.visible = false;
      return;
    }
    // A slack line sags; a line with a fish on it does not, and it twitches.
    const bite = mine && this.phase === 'bite';
    const sag = casting > 0 ? 0.15 : bite ? 0.04 : 0.55;
    const twitch = bite ? Math.sin((t - this.biteAt) * 13) * 0.05 : 0;
    // To the antenna's tip, which is what stays above the water.
    const top = onWater.y + 0.36;
    const array = rig.positions.array as Float32Array;
    for (let i = 0; i < LINE_POINTS; i++) {
      const s = i / (LINE_POINTS - 1);
      const belly = 4 * s * (1 - s);
      array[i * 3] = tip.x + (onWater.x - tip.x) * s;
      array[i * 3 + 1] = tip.y + (top - tip.y) * s - sag * belly + twitch * belly;
      array[i * 3 + 2] = tip.z + (onWater.z - tip.z) * s;
    }
    rig.positions.needsUpdate = true;
    rig.line.visible = true;
  }

  /** The float's resting point on the water right now, bobbing. */
  private floatAt(rig: Rig, out: THREE.Vector3): THREE.Vector3 {
    const t = this.now;
    const swell = this.host.quality.animatedWater ? seaSurfaceAt(rig.rest.x, rig.rest.z, t) : 0;
    return out.set(rig.rest.x, swell + Math.sin(t * 2.3 + rig.seed) * 0.025, rig.rest.z);
  }

  /**
   * The water `distance` metres in front of someone, or null if it is not water. Their
   * own spot's bearing is not known for a remote player; their facing is, and an angler
   * faces their line.
   */
  private inFront(position: THREE.Vector3, yaw: number, out: THREE.Vector3, distance = REMOTE_CAST): THREE.Vector3 | null {
    out.set(position.x + Math.sin(yaw) * distance, 0, position.z + Math.cos(yaw) * distance);
    if (!openWater(out.x, out.z)) return null;
    out.y = this.host.quality.animatedWater ? seaSurfaceAt(out.x, out.z, this.now) : 0;
    return out;
  }

  private release(rig: Rig): void {
    rig.owner = null;
    rig.float.visible = false;
    rig.line.visible = false;
  }

  private makeRig(): Rig {
    const float = new THREE.Group();
    const top = new THREE.Mesh(this.floatParts[0], vermilion());
    const bottom = new THREE.Mesh(this.floatParts[1], whitewash());
    const antenna = new THREE.Mesh(this.floatParts[2], vermilion());
    float.add(top, bottom, antenna);
    float.scale.setScalar(1.35);
    float.visible = false;
    this.group.add(float);

    const positions = new THREE.BufferAttribute(new Float32Array(LINE_POINTS * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', positions);
    const line = new THREE.Line(geometry, this.lineMaterial);
    // The line is rewritten every frame; its bounds would be stale by the next one.
    line.frustumCulled = false;
    line.visible = false;
    line.renderOrder = 3;
    this.group.add(line);

    return { float, line, positions, rest: new THREE.Vector3(), owner: null, seed: Math.random() * 6 };
  }

  // -------------------------------------------------------------------------
  // Splashes
  // -------------------------------------------------------------------------

  private splash(at: THREE.Vector3, big: boolean): void {
    const splash = this.splashes.find((s) => !s.active) ?? this.splashes.reduce((a, b) => (a.age > b.age ? a : b));
    splash.active = true;
    splash.big = big;
    splash.age = 0;
    splash.dropMaterial.uniforms.uOrigin.value.copy(at);
    splash.dropMaterial.uniforms.uSpeed.value = big ? 1.25 : 0.8;
    splash.dropMaterial.uniforms.uSize.value = big ? 0.15 : 0.11;
    splash.ring.position.copy(at);
    splash.ring.position.y += 0.03;
    splash.ringMaterial.uniforms.uSeed.value = Math.random() * 10;
  }

  private updateSplashes(dt: number): void {
    // White water after dark would glow; take it down with the light.
    const dim = 1 - inkLighting.uNight.value * 0.5;
    for (const splash of this.splashes) {
      if (!splash.active) continue;
      splash.age += dt;
      if (splash.age >= SPLASH_SECONDS) {
        splash.active = false;
        splash.drops.visible = false;
        splash.ring.visible = false;
        continue;
      }
      const t = splash.age / SPLASH_SECONDS;
      splash.drops.visible = true;
      splash.dropMaterial.uniforms.uTime.value = splash.age;
      splash.dropMaterial.uniforms.uOpacity.value = 0.9 * dim;
      splash.ring.visible = true;
      splash.ringMaterial.uniforms.uRadius.value = 0.2 + (1 - (1 - t) * (1 - t)) * (splash.big ? 2.0 : 1.2);
      splash.ringMaterial.uniforms.uOpacity.value = 0.75 * (1 - t) * dim;
    }
  }

  private makeSplash(): Splash {
    const uniforms = ballisticUniforms();
    uniforms.uGravity.value = -9.8;
    uniforms.uDrag.value = 0.4;
    uniforms.uLife.value = 0.9;
    uniforms.uFade.value = 0.8;
    uniforms.uMaxLag.value = 0.035;
    uniforms.uColorA.value.setHex(SCENE_COLORS.waterFoam);
    uniforms.uColorB.value.setHex(SCENE_COLORS.waterFoam);
    const dropMaterial = fxMaterial({
      vertexShader: BALLISTIC_VERTEX,
      fragmentShader: BALLISTIC_FRAGMENT,
      uniforms,
      blend: 'over',
    });
    const drops = new THREE.Points(this.dropGeometry, dropMaterial);
    drops.frustumCulled = false;
    drops.visible = false;
    drops.renderOrder = 3;
    drops.onBeforeRender = trackViewport;
    this.group.add(drops);

    const ringMat = ringMaterial(SCENE_COLORS.waterFoam);
    ringMat.uniforms.uScale.value = 2.4;
    ringMat.uniforms.uWidth.value = 0.08;
    ringMat.uniforms.uWobble.value = 0.03;
    const ring = new THREE.Mesh(this.ringGeometry, ringMat);
    ring.scale.setScalar(2.4);
    ring.frustumCulled = false;
    ring.visible = false;
    ring.renderOrder = 3;
    this.group.add(ring);

    return { drops, dropMaterial, ring, ringMaterial: ringMat, age: 0, big: false, active: false };
  }

  private sound(at: THREE.Vector3, big: boolean): void {
    const sound = this.host.sfx();
    if (!sound) return;
    const input = placeSound(sound, at, this.host.camera, 60, 0.8);
    if (input) splashVoice(sound.ctx, input, big);
  }

  // -------------------------------------------------------------------------
  // Leaping fish
  // -------------------------------------------------------------------------

  /**
   * A fish breaks the surface at `from` and arcs toward the angler at `to`, rolling to
   * follow its path and beating its tail, then is gone into their hands.
   */
  private leap(fishId: string, sizeCm: number, from: THREE.Vector3, to: THREE.Vector3): void {
    const species = getFish(fishId);
    const leap = this.leaps.find((l) => !l.active) ?? this.leaps.reduce((a, b) => (a.age > b.age ? a : b));
    leap.active = true;
    leap.age = 0;
    leap.from.copy(from);
    leap.to.copy(to);
    leap.to.y += 1.2;
    // Exaggerated at the small end: a true-size goby at ten metres is a fleck.
    leap.length = Math.min(1.5, Math.max(0.3, 0.25 + (sizeCm / 100) * 0.9));
    leap.body.geometry = fishId === 'boot' ? this.bootGeometry : this.fishGeometry;
    const color = leap.material.uniforms.uColor.value as THREE.Color;
    color.setHex(species?.color ?? 0x9fb5c0);
    (leap.material.uniforms.uShadowColor.value as THREE.Color).copy(deriveShadow(color));
  }

  private updateLeaps(dt: number): void {
    for (const leap of this.leaps) {
      if (!leap.active) continue;
      leap.age += dt;
      const u = leap.age / LEAP_SECONDS;
      if (u >= 1.2) {
        leap.active = false;
        leap.group.visible = false;
        continue;
      }
      const s = Math.min(1, u);
      const apex = 2.4;
      const p = this.scratch.lerpVectors(leap.from, leap.to, s);
      p.y += apex * 4 * s * (1 - s);
      leap.group.position.copy(p);
      // Nose along the path: the derivative of the arc.
      const dy = leap.to.y - leap.from.y + apex * 4 * (1 - 2 * s);
      this.tip.set(p.x + (leap.to.x - leap.from.x), p.y + dy, p.z + (leap.to.z - leap.from.z));
      leap.group.lookAt(this.tip);
      leap.body.rotation.y = Math.sin(leap.age * 17) * 0.3;
      // In hand: gone over a fifth of a second.
      const shrink = u > 1 ? Math.max(0, 1 - (u - 1) * 5) : 1;
      leap.group.scale.setScalar(leap.length * shrink);
      leap.group.visible = true;
    }
  }

  private makeLeap(): Leap {
    // Its own material, so each fish in the air can wear its species' colour.
    const material = createInkMaterial({ color: 0x9fb5c0, matId: MAT_ID.metal, hatch: 0.3 });
    const body = new THREE.Mesh(this.fishGeometry, material);
    body.castShadow = true;
    body.customDepthMaterial = inkDepthMaterial();
    const group = new THREE.Group();
    group.add(body);
    group.visible = false;
    this.group.add(group);
    return { group, body, material, from: new THREE.Vector3(), to: new THREE.Vector3(), length: 1, age: 0, active: false };
  }
}

/**
 * Where a cast from `spot` lands: out along the spot's bearing, on open water — and further
 * out, a metre at a time, if the map's spot faces a few metres of shallows or rock first,
 * or a pier deck. The bearing is the map's to choose; this only makes sure that wherever it
 * points, the float ends up somewhere it can be seen.
 */
function restPointFor(spot: string): THREE.Vector3 | null {
  const interactable = getInteractable(spot);
  if (!interactable) return null;
  const from = interactablePosition(interactable);
  const yaw = interactable.view?.yaw ?? 0;
  for (let d = CAST_DISTANCE; d <= CAST_DISTANCE + 16; d += 1) {
    const x = from.x + Math.sin(yaw) * d;
    const z = from.z + Math.cos(yaw) * d;
    if (openWater(x, z)) return new THREE.Vector3(x, 0, z);
  }
  return new THREE.Vector3(from.x + Math.sin(yaw) * CAST_DISTANCE, 0, from.z + Math.cos(yaw) * CAST_DISTANCE);
}

/**
 * Water a float can be seen on: deep enough, and not under a pier. A pier's deck is not in
 * the height field — it stands on piles over the sea — so the ground alone says "water"
 * underneath one, and a float put there bobs out of sight beneath the planks.
 */
function openWater(x: number, z: number): boolean {
  if (heightAt(x, z) > WATER_BELOW) return false;
  for (const landmark of LANDMARKS) {
    if (landmark.kind !== 'pier') continue;
    const scale = landmark.scale ?? 1;
    const length = numberOpt(landmark.opts?.length, 36) * scale;
    const half = (numberOpt(landmark.opts?.width, 7) * scale) / 2 + 0.4;
    // A pier starts at its origin and runs along its local +z (see `props/structures.ts`).
    const dx = x - landmark.x;
    const dz = z - landmark.z;
    const along = dx * Math.sin(landmark.rot) + dz * Math.cos(landmark.rot);
    const across = dx * Math.cos(landmark.rot) - dz * Math.sin(landmark.rot);
    if (along > -0.5 && along < length + 0.5 && Math.abs(across) < half) return false;
  }
  return true;
}

function numberOpt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Twenty drops thrown up and out: two samples each, so a drop is a short streak. */
function dropletGeometry(): THREE.BufferGeometry {
  const velocity: number[] = [];
  const lag: number[] = [];
  const delay: number[] = [];
  const tone: number[] = [];
  for (let i = 0; i < 20; i++) {
    const angle = Math.random() * Math.PI * 2;
    const out = 0.6 + Math.random() * 1.2;
    const up = 1.8 + Math.random() * 1.8;
    for (const l of [0, 0.035]) {
      velocity.push(Math.cos(angle) * out, up, Math.sin(angle) * out);
      lag.push(l);
      delay.push(Math.random() * 0.06);
      tone.push(0);
    }
  }
  return ballisticGeometry({ velocity, lag, delay, tone });
}

/**
 * A fish one metre long, nose to +z: a slim body, a forked tail and a dorsal fin, merged
 * into one geometry so a leaping fish is one draw call. Flat-shaded and faceted, like
 * everything else that swims past a pier here.
 */
function fishShape(): THREE.BufferGeometry {
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 6));
  body.scale.set(0.2, 0.32, 1);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.3, 4));
  tail.rotation.x = Math.PI / 2;
  tail.scale.set(0.25, 1, 1);
  tail.position.z = -0.55;
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.16, 3));
  fin.scale.set(0.2, 1, 1);
  fin.position.set(0, 0.16, 0.02);
  const geometry = merge([body, tail, fin]);
  for (const part of [body, tail, fin]) part.geometry.dispose();
  return geometry;
}

/** And the one every angler catches eventually: an old boot, leg and foot. */
function bootShape(): THREE.BufferGeometry {
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.6, 0.3));
  leg.position.set(0, 0.2, -0.2);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.24, 0.62));
  foot.position.set(0, -0.2, 0.02);
  const geometry = merge([leg, foot]);
  for (const part of [leg, foot]) part.geometry.dispose();
  return geometry;
}
