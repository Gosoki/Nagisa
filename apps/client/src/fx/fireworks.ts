/**
 * Fireworks.
 * ==========
 *
 * A shell goes up from the water, trailing a thin streak, and bursts: a peony (a sphere of
 * stars), a ring turned to face the island, a willow (gold trails that droop and hang), or
 * a double (a burst, then a smaller ring inside it). The boom arrives after the light, late
 * by however far away you are standing — at the speed of sound, which is the one detail
 * that makes a firework over the bay feel like it is over the bay.
 *
 * ### Cost
 *
 * Every spark's flight is a closed-form function of time evaluated in the vertex shader
 * (see `BALLISTIC_VERTEX`), so a burst is one draw call and a few uniform writes a frame,
 * whatever it holds. The four patterns are built once as geometry and shared; a launch
 * takes a slot from a fixed pool — sized by quality tier — and points it at one. Nothing
 * here allocates after construction.
 *
 * ### Through the ink pipeline
 *
 * Sparks are light: additive, never outlined, and invisible to the contour pass (see
 * `fx/materials.ts`). A hill in front of a burst still hides it, because depth testing
 * stays on.
 *
 * ### Time
 *
 * A firework event carries `at`, the server time it was launched. One that arrives late —
 * a delta held up on a slow connection, a burst of them after a resync — starts part-way
 * through rather than from the water; one more than four seconds old is not shown at all,
 * because a firework you missed is not one that is happening.
 */

import * as THREE from 'three';
import type { WorldEvent } from '@nagisa/shared';
import type { FxHost } from './index.js';
import { boomVoice, placeSound } from './audio.js';
import {
  BALLISTIC_FRAGMENT,
  BALLISTIC_VERTEX,
  ballisticGeometry,
  ballisticUniforms,
  fxMaterial,
  trackViewport,
} from './materials.js';

type FireworkEvent = Extract<WorldEvent, { k: 'firework' }>;

/** Seconds from the water to the burst. */
const RISE = 1.1;

/** Events older than this are skipped rather than shown, seconds. */
const STALE = 4;

/** A boom carries this far, metres; beyond it, fireworks are silent. */
const EARSHOT = 420;

/** Speed of sound, m/s. */
const SOUND_SPEED = 343;

/** How many shells can be in the air at once, by tier. A show sends one every 1.2–3 s. */
const SLOTS = { low: 3, medium: 6, high: 10 } as const;

/** Spark counts are scaled by tier; the patterns keep their shape at any count. */
const DENSITY = { low: 0.5, medium: 0.75, high: 1 } as const;

/** What each pattern's sparks do once the shell has burst. */
interface Pattern {
  /** Seconds a spark lives, from the moment it is released. */
  life: number;
  /** Seconds from the burst until the last spark is gone. */
  span: number;
  gravity: number;
  drag: number;
  /** Spark size, metres. */
  size: number;
  /** Exponent of the fade: higher fades sooner. */
  fade: number;
  /** Longest trail lag, seconds. */
  maxLag: number;
  /** Additive gain on the colour. */
  gain: number;
}

const PEONY = 0;
const RING = 1;
const WILLOW = 2;
const DOUBLE = 3;

const PATTERNS: readonly Pattern[] = [
  { life: 2.4, span: 2.4, gravity: -2.6, drag: 1.25, size: 0.75, fade: 1.6, maxLag: 0.16, gain: 1.25 },
  { life: 2.2, span: 2.2, gravity: -2.2, drag: 1.3, size: 0.7, fade: 1.5, maxLag: 0.12, gain: 1.25 },
  { life: 3.4, span: 3.4, gravity: -4.6, drag: 1.7, size: 0.55, fade: 1.1, maxLag: 0.8, gain: 1.1 },
  // The inner ring is released 0.5 s after the outer burst, so the pattern outlives either.
  { life: 2.3, span: 2.8, gravity: -2.6, drag: 1.25, size: 0.65, fade: 1.6, maxLag: 0.12, gain: 1.25 },
];

/**
 * Trail samples per spark and the lag between them, by pattern — `maxLag` above is the
 * product. Close enough together that a spark reads as a streak rather than a row of dots.
 */
const TRAILS: readonly [number, number][] = [
  [5, 0.04],
  [5, 0.03],
  [11, 0.08],
  [5, 0.03],
];

interface Slot {
  rocket: THREE.Points;
  burst: THREE.Points;
  rocketMaterial: THREE.ShaderMaterial;
  burstMaterial: THREE.ShaderMaterial;
  /** Local seconds (the fx clock) at launch. */
  launchedAt: number;
  pattern: number;
  active: boolean;
  /** The boom has been scheduled (or deliberately skipped). */
  heard: boolean;
  readonly burstPoint: THREE.Vector3;
}

export class Fireworks {
  private readonly slots: Slot[] = [];
  private readonly patterns: THREE.BufferGeometry[];
  private readonly rocketGeometry: THREE.BufferGeometry;
  private readonly basis = new THREE.Matrix4();
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();
  private readonly axisZ = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private now = 0;

  constructor(
    private readonly host: FxHost,
    group: THREE.Group,
  ) {
    const density = DENSITY[host.quality.tier];
    this.patterns = [
      sparkGeometry(sphere(Math.round(84 * density), 11, 0.08), TRAILS[PEONY], 0, 0),
      sparkGeometry(circle(Math.round(64 * density), 10, 0.04), TRAILS[RING], 0, 0),
      sparkGeometry(sphere(Math.round(56 * density), 7.5, 0.12, 0.35), TRAILS[WILLOW], 0, 0),
      mergeSparks(
        sparkGeometry(sphere(Math.round(64 * density), 11, 0.08), TRAILS[DOUBLE], 0, 0),
        sparkGeometry(circle(Math.round(40 * density), 5.5, 0.04), TRAILS[DOUBLE], 0.5, 1),
      ),
    ];
    // The rising shell: one spark, drawn as a streak of fourteen samples.
    this.rocketGeometry = sparkGeometry([[0, 1, 0]], [14, 0.028], 0, 0);

    for (let i = 0; i < SLOTS[host.quality.tier]; i++) {
      const rocketMaterial = sparkMaterial();
      const burstMaterial = sparkMaterial();
      const rocket = new THREE.Points(this.rocketGeometry, rocketMaterial);
      const burst = new THREE.Points(this.patterns[0], burstMaterial);
      for (const points of [rocket, burst]) {
        // Positions are computed in the shader, so the geometry's bounds mean nothing.
        points.frustumCulled = false;
        points.visible = false;
        points.renderOrder = 4;
        points.onBeforeRender = trackViewport;
        group.add(points);
      }
      this.slots.push({
        rocket,
        burst,
        rocketMaterial,
        burstMaterial,
        launchedAt: 0,
        pattern: 0,
        active: false,
        heard: true,
        burstPoint: new THREE.Vector3(),
      });
    }
  }

  /** A firework went up somewhere. */
  launch(event: FireworkEvent): void {
    const late = (this.host.serverNow() - event.at) / 1000;
    if (late > STALE) return;

    const slot = this.slots.find((s) => !s.active) ?? this.oldest();
    slot.active = true;
    slot.heard = false;
    // Negative lateness (an event stamped a moment in our future, by clock skew) simply
    // waits; positive starts the shell part-way up.
    slot.launchedAt = this.now - late;
    slot.pattern = ((Math.floor(event.pattern) % PATTERNS.length) + PATTERNS.length) % PATTERNS.length || 0;
    slot.burstPoint.set(event.x, event.h, event.z);

    // The rocket: straight up from the water, decelerating to a stop at the burst height —
    // launched at 2h/RISE under a gravity that brings it to rest exactly at RISE.
    const speed = (2 * event.h) / RISE;
    const r = slot.rocketMaterial.uniforms;
    r.uOrigin.value.set(event.x, 0, event.z);
    r.uBasis.value.identity();
    r.uSpeed.value = speed;
    r.uGravity.value = -speed / RISE;
    r.uDrag.value = 0;
    r.uLife.value = RISE;
    r.uSize.value = 0.5;
    r.uFade.value = 0.25;
    r.uMaxLag.value = 14 * 0.028;
    r.uColorA.value.setHSL(0.1, 0.5, 0.78, THREE.SRGBColorSpace);
    r.uColorB.value.copy(r.uColorA.value);
    r.uCore.value = 0.4;
    r.uOpacity.value = 0.9;

    const pattern = PATTERNS[slot.pattern];
    const b = slot.burstMaterial.uniforms;
    slot.burst.geometry = this.patterns[slot.pattern];
    b.uOrigin.value.copy(slot.burstPoint);
    b.uBasis.value.setFromMatrix4(this.faceIsland(event.x, event.z));
    b.uSpeed.value = 1;
    b.uGravity.value = pattern.gravity;
    b.uDrag.value = pattern.drag;
    b.uLife.value = pattern.life;
    b.uSize.value = pattern.size;
    b.uFade.value = pattern.fade;
    b.uMaxLag.value = pattern.maxLag;
    b.uCore.value = 0.35;
    b.uOpacity.value = pattern.gain;

    // Colour from the event's hue, in sRGB terms so the hue means what it says on screen.
    // A willow is gold whatever was asked for — that is what a willow is — with only its
    // last sparks taking the hue.
    const hue = ((event.hue % 1) + 1) % 1;
    if (slot.pattern === WILLOW) {
      b.uColorA.value.setHSL(0.11, 0.78, 0.58, THREE.SRGBColorSpace);
      b.uColorB.value.setHSL(hue, 0.5, 0.7, THREE.SRGBColorSpace);
    } else {
      b.uColorA.value.setHSL(hue, 0.72, 0.62, THREE.SRGBColorSpace);
      // The double's inner ring is a paler cousin of the outer burst.
      b.uColorB.value.setHSL((hue + 0.08) % 1, 0.35, 0.82, THREE.SRGBColorSpace);
    }
  }

  update(elapsed: number): void {
    this.now = elapsed;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const age = elapsed - slot.launchedAt;
      const sinceBurst = age - RISE;
      const pattern = PATTERNS[slot.pattern];

      if (age < 0 || sinceBurst > pattern.span + pattern.maxLag) {
        slot.rocket.visible = false;
        slot.burst.visible = false;
        if (age >= 0) slot.active = false;
        continue;
      }

      slot.rocket.visible = age <= RISE;
      slot.rocketMaterial.uniforms.uTime.value = age;
      slot.burst.visible = sinceBurst >= 0;
      slot.burstMaterial.uniforms.uTime.value = sinceBurst;

      if (sinceBurst >= 0 && !slot.heard) {
        slot.heard = true;
        this.boom(slot, sinceBurst);
      }
    }
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.rocketMaterial.dispose();
      slot.burstMaterial.dispose();
      slot.rocket.removeFromParent();
      slot.burst.removeFromParent();
    }
    for (const geometry of this.patterns) geometry.dispose();
    this.rocketGeometry.dispose();
  }

  /**
   * Schedule the report, late by the distance over the speed of sound — less however long
   * ago the burst actually was, for a shell that arrived late. One whose sound would already
   * have passed is not heard.
   */
  private boom(slot: Slot, sinceBurst: number): void {
    const sound = this.host.sfx();
    if (!sound) return;
    const distance = slot.burstPoint.distanceTo(this.host.camera.position);
    const delay = distance / SOUND_SPEED - sinceBurst;
    if (delay < -0.1) return;
    const input = placeSound(sound, slot.burstPoint, this.host.camera, EARSHOT, 1.4);
    if (!input) return;
    boomVoice(sound.ctx, input, sound.ctx.currentTime + Math.max(0, delay), slot.pattern !== RING);
  }

  private oldest(): Slot {
    return this.slots.reduce((a, b) => (a.launchedAt < b.launchedAt ? a : b));
  }

  /**
   * The orientation for flat patterns: a ring's plane turned to face the island (the middle
   * of it, where everyone watching is), leaning back a little so it is not a perfect
   * edge-on disc to anyone standing below it.
   */
  private faceIsland(x: number, z: number): THREE.Matrix4 {
    const length = Math.hypot(x, z) || 1;
    const lean = 0.26;
    this.axisZ.set((-x / length) * Math.cos(lean), Math.sin(lean), (-z / length) * Math.cos(lean));
    this.axisX.crossVectors(this.up, this.axisZ).normalize();
    this.axisY.crossVectors(this.axisZ, this.axisX);
    return this.basis.makeBasis(this.axisX, this.axisY, this.axisZ);
  }
}

// ---------------------------------------------------------------------------
// Pattern geometry
// ---------------------------------------------------------------------------

function sparkMaterial(): THREE.ShaderMaterial {
  return fxMaterial({
    vertexShader: BALLISTIC_VERTEX,
    fragmentShader: BALLISTIC_FRAGMENT,
    uniforms: ballisticUniforms(),
    blend: 'add',
  });
}

/**
 * Launch velocities spread evenly over a sphere (a Fibonacci lattice, so there are no
 * poles and no seams), at `speed` ± `jitter`. `lift` pushes directions upward — a willow
 * throws most of its stars up so they have somewhere to fall from.
 */
function sphere(count: number, speed: number, jitter: number, lift = 0): number[][] {
  const out: number[][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const direction = new THREE.Vector3(Math.cos(theta) * radius, y + lift, Math.sin(theta) * radius).normalize();
    direction.multiplyScalar(speed * (1 + (Math.random() * 2 - 1) * jitter));
    out.push([direction.x, direction.y, direction.z]);
  }
  return out;
}

/** Launch velocities round a circle in the local xy plane; the basis turns it to the island. */
function circle(count: number, speed: number, jitter: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const s = speed * (1 + (Math.random() * 2 - 1) * jitter);
    out.push([Math.cos(angle) * s, Math.sin(angle) * s, 0]);
  }
  return out;
}

/** One vertex per trail sample per spark. */
function sparkGeometry(
  velocities: number[][],
  [samples, step]: readonly [number, number],
  delay: number,
  tone: number,
): THREE.BufferGeometry {
  const velocity: number[] = [];
  const lag: number[] = [];
  const delays: number[] = [];
  const tones: number[] = [];
  for (const v of velocities) {
    for (let s = 0; s < samples; s++) {
      velocity.push(v[0], v[1], v[2]);
      lag.push(s * step);
      delays.push(delay);
      tones.push(tone);
    }
  }
  return ballisticGeometry({ velocity, lag, delay: delays, tone: tones });
}

/** Two spark sets as one geometry — one draw call for a double burst. */
function mergeSparks(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const joined = (name: string): number[] => [
    ...(a.getAttribute(name).array as Float32Array),
    ...(b.getAttribute(name).array as Float32Array),
  ];
  const merged = ballisticGeometry({
    velocity: joined('position'),
    lag: joined('aLag'),
    delay: joined('aDelay'),
    tone: joined('aTone'),
  });
  a.dispose();
  b.dispose();
  return merged;
}
