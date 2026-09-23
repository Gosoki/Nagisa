/**
 * The ○× quiz arena.
 * ==================
 *
 * Two circles painted on the plaza, where the map's `quizArena` says: a vermilion ○ — the
 * ring *is* the circle — and an indigo × inside a thin indigo ring that marks where the ×
 * circle ends. Each has a small signpost on its outer side carrying its mark, so the answer
 * a circle stands for can be read from anywhere on the plaza, not only from above.
 *
 * The paint is ordinary ink material laid on the ground (conforming to it, a few
 * centimetres proud of it so the two never fight for the same depth), which means it takes
 * the day's light and people's shadows like the paving it is painted on, and the contour
 * pass draws its edges the way a person drawing the plaza would. Each circle owns its
 * material, so it can be lit without touching anything else.
 *
 * During a question both circles lift gently — one slow ease up, then held — and a thin
 * countdown arc around each empties toward the moment the server looks at where everyone
 * is standing. On the reveal the right circle brightens and the wrong one fades toward the
 * paving. Otherwise the arena is simply paint.
 */

import * as THREE from 'three';
import { QUIZ_ARENA, SCENE_COLORS, heightAt, type QuizView } from '@nagisa/shared';
import { createInkMaterial, inkDepthMaterial } from '../engine/ink/ink-material.js';
import { MAT_ID, stone, surface, vermilion, wood } from '../world/materials.js';
import { box, cyl, meshFrom, mergeByMaterial } from '../world/props/geometry.js';
import type { FxHost } from './index.js';
import { approach, ringMaterial, ringQuad } from './materials.js';

/** Aizome indigo for the ×: the island's other traditional dye, and nowhere near vermilion. */
const INDIGO = 0x4a6680;
const INDIGO_SHADOW = 0x3d566c;

/** The paint's height above the ground, metres. Clear of it, never visibly floating. */
const LIFT = 0.03;

/** Width of the ○'s ring and of the ×'s strokes, and of the ×'s boundary ring, metres. */
const STROKE = 0.42;
const EDGE = 0.13;

/**
 * How long a question lasts, ms, as GAMES.md specifies it. Only a *floor* on the arc's
 * span: the arc runs from when the question was first seen to `endsAt`, but someone who
 * arrives with three seconds left should see an arc that is mostly spent, not a full one
 * racing to empty.
 */
const QUESTION_MS = 15_000;

/** Glow strengths: asked, and the right answer revealed. */
const GLOW_ASKED = 0.26;
const GLOW_RIGHT = 0.6;

/** How quickly the paint eases between states, per second. Slow on purpose. */
const EASE_RATE = 1.6;

/** A circle: its paint material, where its paint and sign are, its countdown arc. */
interface Circle {
  material: THREE.ShaderMaterial;
  readonly base: THREE.Color;
  readonly baseShadow: THREE.Color;
  arc: THREE.Mesh;
  arcMaterial: THREE.ShaderMaterial;
  glow: number;
  dim: number;
}

export class QuizArena {
  private readonly root = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly circles: { o: Circle; x: Circle };
  /** The same two, for iterating without building an array every frame. */
  private readonly both: readonly [Circle, Circle];
  private readonly ringGeometry = ringQuad();
  /** Paving, roughly: what a losing circle fades toward. */
  private readonly faded = new THREE.Color(SCENE_COLORS.paving);
  private readonly fadedShadow = new THREE.Color(SCENE_COLORS.pavingShadow);

  private quiz: QuizView | null = null;
  /** Server time at which the current question was first seen. */
  private questionSeenAt = 0;
  private arcOpacity = 0;

  constructor(
    private readonly host: FxHost,
    group: THREE.Group,
  ) {
    const arena = QUIZ_ARENA!;
    this.root.name = 'quiz-arena';
    group.add(this.root);

    const o = this.makeCircle(SCENE_COLORS.vermilion, SCENE_COLORS.vermilionShadow, 0xffb296, arena.o.x, arena.o.z, arena.o.r);
    const x = this.makeCircle(INDIGO, INDIGO_SHADOW, 0xb8d2ee, arena.x.x, arena.x.z, arena.x.r);
    this.circles = { o, x };
    this.both = [o, x];

    // The ○: a single broad brush ring, which is the circle's edge.
    this.paint(ringStrip(arena.o.x, arena.o.z, arena.o.r - STROKE, arena.o.r, 1.3), o.material);

    // The ×: a thin ring for the circle's edge, and two strokes across it, turned 45° to
    // the line between the circles so the cross reads as an × from the crowd between them.
    this.paint(ringStrip(arena.x.x, arena.x.z, arena.x.r - EDGE, arena.x.r, 4.1), x.material);
    const axis = Math.atan2(arena.x.x - arena.o.x, arena.x.z - arena.o.z);
    const reach = arena.x.r - 0.75;
    for (const turn of [Math.PI / 4, -Math.PI / 4]) {
      const a = axis + turn;
      const dx = Math.sin(a) * reach;
      const dz = Math.cos(a) * reach;
      this.paint(barStrip(arena.x.x - dx, arena.x.z - dz, arena.x.x + dx, arena.x.z + dz, STROKE), x.material);
    }

    // Signposts, on the far side of each circle from the other, facing back across both.
    const ax = Math.sin(axis);
    const az = Math.cos(axis);
    this.sign('o', arena.o.x - ax * (arena.o.r + 0.9), arena.o.z - az * (arena.o.r + 0.9), axis);
    this.sign('x', arena.x.x + ax * (arena.x.r + 0.9), arena.x.z + az * (arena.x.r + 0.9), axis + Math.PI);
  }

  /** The `quiz` store changed. */
  setQuiz(next: QuizView | null): void {
    const before = this.quiz;
    this.quiz = next;
    if (
      next?.phase === 'question' &&
      (before?.phase !== 'question' || before.round !== next.round || before.questionId !== next.questionId)
    ) {
      this.questionSeenAt = this.host.serverNow();
    }
  }

  update(dt: number): void {
    const quiz = this.quiz;
    const asking = quiz?.phase === 'question';
    const revealed = quiz?.phase === 'reveal' && quiz.answer !== undefined ? (quiz.answer ? 'o' : 'x') : null;

    for (const circle of this.both) {
      const side = circle === this.circles.o ? 'o' : 'x';
      const glow = asking ? GLOW_ASKED : revealed === side ? GLOW_RIGHT : 0;
      const dim = revealed !== null && revealed !== side ? 1 : 0;
      circle.glow = approach(circle.glow, glow, dt, EASE_RATE);
      circle.dim = approach(circle.dim, dim, dt, EASE_RATE);
      const u = circle.material.uniforms;
      u.uGlowStrength.value = circle.glow;
      (u.uColor.value as THREE.Color).lerpColors(circle.base, this.faded, circle.dim * 0.55);
      (u.uShadowColor.value as THREE.Color).lerpColors(circle.baseShadow, this.fadedShadow, circle.dim * 0.55);
    }

    this.arcOpacity = approach(this.arcOpacity, asking ? 0.75 : 0, dt, EASE_RATE * 1.5);
    let fraction = 0;
    if (asking && quiz) {
      const now = this.host.serverNow();
      const span = Math.max(QUESTION_MS, quiz.endsAt - this.questionSeenAt);
      fraction = Math.min(1, Math.max(0, (quiz.endsAt - now) / span));
    }
    for (const circle of this.both) {
      circle.arc.visible = this.arcOpacity > 0.01;
      circle.arcMaterial.uniforms.uOpacity.value = this.arcOpacity;
      // Held where it was while fading out after the question, rather than snapping full.
      if (asking) circle.arcMaterial.uniforms.uArc.value = fraction;
    }
  }

  dispose(): void {
    for (const circle of this.both) {
      circle.material.dispose();
      circle.arcMaterial.dispose();
    }
    for (const geometry of this.geometries) geometry.dispose();
    this.ringGeometry.dispose();
    this.root.removeFromParent();
  }

  private makeCircle(color: number, shadow: number, glow: number, cx: number, cz: number, r: number): Circle {
    const material = createInkMaterial({ color, shadowColor: shadow, glowColor: glow, matId: MAT_ID.accent, hatch: 0.25 });
    material.name = 'quiz-paint';

    // The countdown: a thin ink arc just outside the circle, at the plaza's height there.
    const arcMaterial = ringMaterial(SCENE_COLORS.ink);
    const reach = r + 0.6;
    arcMaterial.uniforms.uScale.value = reach;
    arcMaterial.uniforms.uRadius.value = r + 0.32;
    arcMaterial.uniforms.uWidth.value = 0.12;
    arcMaterial.uniforms.uWobble.value = 0.02;
    arcMaterial.uniforms.uSeed.value = cx;
    // Emptying from the far side of the circle as seen from the south, where most people
    // come onto the plaza from.
    arcMaterial.uniforms.uArcStart.value = Math.PI / 2;
    const arc = new THREE.Mesh(this.ringGeometry, arcMaterial);
    arc.scale.setScalar(reach);
    arc.position.set(cx, heightAt(cx, cz) + LIFT + 0.02, cz);
    arc.visible = false;
    arc.renderOrder = 3;
    this.root.add(arc);

    return {
      material,
      base: new THREE.Color(color),
      baseShadow: new THREE.Color(shadow),
      arc,
      arcMaterial,
      glow: 0,
      dim: 0,
    };
  }

  private paint(geometry: THREE.BufferGeometry, material: THREE.Material): void {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    this.root.add(mesh);
  }

  /**
   * A signpost: a post, a board, and the circle's mark on both faces of it. Library
   * materials throughout, merged per material, so the pair costs a handful of draw calls.
   */
  private sign(side: 'o' | 'x', x: number, z: number, facing: number): void {
    const parts: THREE.Mesh[] = [];
    const postHeight = 1.55;
    parts.push(box(0.11, postHeight, 0.11, wood('dark'), 0, postHeight / 2, 0));
    parts.push(box(0.78, 0.66, 0.06, wood('light'), 0, postHeight + 0.25, 0));
    parts.push(box(0.86, 0.06, 0.1, wood('dark'), 0, postHeight + 0.6, 0));
    for (const face of [1, -1]) {
      const zOffset = face * 0.045;
      if (side === 'o') {
        parts.push(meshFrom(new THREE.TorusGeometry(0.2, 0.045, 5, 18), vermilion(), 0, postHeight + 0.25, zOffset));
      } else {
        const mark = surface('quiz-indigo', { color: INDIGO, shadowColor: INDIGO_SHADOW, matId: MAT_ID.cloth, hatch: 0.4 });
        for (const turn of [Math.PI / 4, -Math.PI / 4]) {
          parts.push(box(0.5, 0.085, 0.03, mark, 0, postHeight + 0.25, zOffset, 0, 0, turn));
        }
      }
    }
    // A stone footing, as a real post set in paving would have.
    parts.push(cyl(0.12, 0.14, 0.12, 6, stone(), 0, 0.06, 0));

    const sign = new THREE.Group();
    sign.name = `quiz-sign-${side}`;
    for (const mesh of mergeByMaterial(parts)) {
      mesh.customDepthMaterial = inkDepthMaterial();
      this.geometries.push(mesh.geometry);
      sign.add(mesh);
    }
    for (const part of parts) part.geometry.dispose();
    sign.position.set(x, heightAt(x, z), z);
    sign.rotation.y = facing;
    this.root.add(sign);
  }
}

// ---------------------------------------------------------------------------
// Paint geometry
// ---------------------------------------------------------------------------

/**
 * A strip of paint following the ground: pairs of points, left and right of a path, each
 * dropped onto `heightAt` and lifted by {@link LIFT}. Wound so the paint faces up.
 */
function groundStrip(left: number[][], right: number[][]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let i = 0; i < left.length; i++) {
    for (const [x, z] of [left[i], right[i]]) positions.push(x, heightAt(x, z) + LIFT, z);
  }
  const indices: number[] = [];
  for (let i = 0; i < left.length - 1; i++) {
    const l = i * 2;
    const r = l + 1;
    indices.push(l, r, l + 2, r, r + 2, l + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A painted ring, `inner` to `outer`, with a brush's unevenness: the radius wanders a few
 * centimetres and the stroke swells and thins as it goes round. `seed` makes the two
 * circles different hands.
 */
function ringStrip(cx: number, cz: number, inner: number, outer: number, seed: number): THREE.BufferGeometry {
  const segments = 72;
  const left: number[][] = [];
  const right: number[][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const wander = Math.sin(a * 3 + seed) * 0.05 + Math.sin(a * 5 + seed * 2.7) * 0.025;
    const swell = (outer - inner) * 0.12 * Math.sin(a * 2 + seed * 1.3);
    const ro = outer + wander + swell * 0.5;
    const ri = inner + wander - swell * 0.5;
    left.push([cx + Math.cos(a) * ro, cz + Math.sin(a) * ro]);
    right.push([cx + Math.cos(a) * ri, cz + Math.sin(a) * ri]);
  }
  return groundStrip(left, right);
}

/** A painted stroke from one point to another, tapering slightly at both ends. */
function barStrip(x0: number, z0: number, x1: number, z1: number, width: number): THREE.BufferGeometry {
  const steps = 16;
  const length = Math.hypot(x1 - x0, z1 - z0);
  const ux = (x1 - x0) / length;
  const uz = (z1 - z0) / length;
  // Left of the direction of travel, so the strip's winding faces up.
  const px = uz;
  const pz = -ux;
  const left: number[][] = [];
  const right: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const half = (width / 2) * (0.8 + 0.2 * Math.sin(s * Math.PI));
    const x = x0 + (x1 - x0) * s;
    const z = z0 + (z1 - z0) * s;
    left.push([x + px * half, z + pz * half]);
    right.push([x - px * half, z - pz * half]);
  }
  return groundStrip(left, right);
}
