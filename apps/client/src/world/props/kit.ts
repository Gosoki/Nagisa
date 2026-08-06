/**
 * Japanese architecture kit.
 * ==========================
 *
 * The mid-level layer of the prop library: `geometry.ts` knows boxes and cylinders,
 * `buildings.ts` knows what a teahouse is, and this file knows the *components* that every
 * building on Nagisa is assembled from — a tiled roof, a timber frame, a veranda, a
 * plinth, a shoji wall.
 *
 * Having this layer is what makes the buildings look built rather than extruded. A machiya
 * and a warehouse are not two piles of boxes that happen to resemble each other; they are
 * the same eleven components in different arrangements, so they share a vocabulary the way
 * real vernacular architecture does. It is also the only way to afford the detail: the
 * layered tile courses on a roof are written once here and appear on nineteen buildings.
 *
 * ### The rules every component follows
 *
 * - **Base-centre origin.** Components are authored with their base at `y = 0`, centred on
 *   x/z, so a caller stacks them by setting `y` and nothing else.
 * - **Materials come from the caller.** Nothing here calls `materials.ts`; a component
 *   takes the materials it needs as arguments. That keeps the kit reusable for the shrine
 *   (vermilion and copper) and the fishing sheds (weathered board) without a flag for
 *   every combination.
 * - **Everything returns `THREE.Mesh[]`,** never a Group. Buildings collect the parts from
 *   several components and hand the whole pile to `mergeByMaterial()` once, which is what
 *   keeps a fifteen-component building at four draw calls.
 */

import * as THREE from 'three';
import { box, cyl, meshFrom, mulberry32 } from './geometry.js';

/**
 * Deterministic hash of a 3D position → [0, 1).
 *
 * Quantised before hashing so that vertices which *should* be the same point — the shared
 * corners a non-indexed polyhedron stores several times over — land in the same bucket
 * despite floating-point noise, and therefore get the same value.
 */
function positionHash(x: number, y: number, z: number, seed: number): number {
  const q = 1e4;
  let h = Math.imul(Math.round(x * q) ^ 0x27d4eb2d, 0x165667b1);
  h = Math.imul(h ^ Math.round(y * q), 0x27d4eb2d);
  h = Math.imul(h ^ Math.round(z * q), 0x85ebca6b);
  h = Math.imul(h ^ seed, 0x2545f491);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Build-adjust-return in one expression.
 *
 * The roof builders below construct dozens of slabs that each need a rotation applied
 * immediately after construction; without this the alternative is a named temporary per
 * slab, which buries the geometry in bookkeeping.
 */
function tweak<T extends THREE.Object3D>(object: T, fn: (self: T) => void): T {
  fn(object);
  return object;
}

// ---------------------------------------------------------------------------
// Roofs
// ---------------------------------------------------------------------------

/** Where a roof's slopes fall away. */
export type RoofStyle =
  /** Two slopes, gable ends. The everyday roof. */
  | 'gable'
  /** Four slopes, no gable. Formal buildings, warehouses. */
  | 'hipped'
  /** Gable with the eave line curving up at the corners. Shrines only. */
  | 'sweeping';

export interface RoofOptions {
  /** Footprint the roof covers, before the overhang. */
  w: number;
  d: number;
  /** Ridge height above the eave line. */
  rise: number;
  /** How far the roof projects past the walls, on every side. */
  overhang: number;
  style: RoofStyle;
  /** Number of visible tile courses per slope. 0 disables the stepping. */
  courses?: number;
  /** Draw the raised ridge cap along the top. */
  ridge?: boolean;
  /** Upward curl at the gable corners, as a fraction of `rise`. `sweeping` only. */
  lift?: number;
  material: THREE.Material;
  /** Ridge cap and barge boards. Defaults to `material`. */
  trimMaterial?: THREE.Material;
}

/**
 * A tiled roof, built as **stepped courses** rather than as two flat planes.
 *
 * This is the single highest-value detail in the whole prop library. A Japanese roof is
 * the dominant mass of every building it sits on, and what reads at fifty metres is not
 * its colour but the horizontal banding of the tile courses catching the light. Two flat
 * quads give a building that looks like a cardboard model no matter how good the shading
 * is; six shallow steps give it a roof.
 *
 * Each course is a thin slab spanning the full depth, positioned along the slope and
 * rotated to lie on it, with the next course overlapping the one below — exactly how
 * kawara are actually laid. The steps also give the contour pass something to find: every
 * course boundary is a normal discontinuity, so the roof draws itself as a set of parallel
 * pen lines.
 */
export function tiledRoof(options: RoofOptions): THREE.Mesh[] {
  const {
    w,
    d,
    rise,
    overhang,
    style,
    courses = 6,
    ridge = true,
    lift = 0.18,
    material,
    trimMaterial = material,
  } = options;

  const parts: THREE.Mesh[] = [];
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;

  if (style === 'hipped') {
    parts.push(...hippedCourses(hw, hd, rise, courses, material));
  } else {
    parts.push(...gableCourses(hw, hd, rise, courses, material, style === 'sweeping' ? lift * rise : 0));
    // Barge boards: the vertical timber closing each gable end. Without them the roof
    // looks like it has been sliced with a knife.
    const gableDepth = 0.16;
    for (const sign of [-1, 1]) {
      parts.push(...gableEndBoard(hw, rise, gableDepth, trimMaterial, sign * hd));
    }
  }

  if (ridge) {
    // The ridge cap: a raised bar running the length of the roof, capped at each end.
    const ridgeLength = style === 'hipped' ? Math.max(0.4, d - w) + overhang : d + overhang * 2;
    parts.push(box(0.55, 0.42, ridgeLength, trimMaterial, 0, rise + 0.14, 0));
    parts.push(box(0.9, 0.2, ridgeLength, trimMaterial, 0, rise - 0.04, 0));
    // Ends: the small upturned block that terminates a ridge (a simplified onigawara).
    for (const sign of [-1, 1]) {
      const zEnd = (ridgeLength / 2) * sign;
      parts.push(box(0.7, 0.62, 0.34, trimMaterial, 0, rise + 0.24, zEnd));
    }
  }

  return parts;
}

/**
 * Stepped courses for a two-slope roof.
 *
 * Courses run from the eave up to the ridge. `lift` raises the eave corners, which is the
 * *sori* curve of a shrine roof; it is applied per course as a rotation about z so the
 * whole slope twists rather than only its outer edge moving.
 */
function gableCourses(
  hw: number,
  hd: number,
  rise: number,
  courses: number,
  material: THREE.Material,
  lift: number,
): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  const n = Math.max(1, courses);
  const slopeLength = Math.hypot(hw, rise);
  const angle = Math.atan2(rise, hw);
  const courseLength = slopeLength / n;
  // Each slab is slightly longer than its share of the slope so consecutive courses
  // overlap rather than leaving a hairline gap the sky shows through.
  const slabLength = courseLength * 1.16;
  const thickness = 0.16;

  for (const side of [-1, 1] as const) {
    for (let i = 0; i < n; i++) {
      // Midpoint of this course, measured along the slope from the eave.
      const s = (i + 0.5) * courseLength;
      const x = side * (hw - Math.cos(angle) * s);
      const y = Math.sin(angle) * s;
      // Lower courses sit slightly proud, which is what makes the stepping visible from
      // below and what a tile course physically does.
      const proud = (1 - i / n) * 0.06;

      const slab = box(slabLength, thickness + proud, hd * 2, material, x, y + thickness * 0.5, 0);
      slab.rotation.z = -side * angle;
      parts.push(slab);
    }

    // The eave edge itself: a thicker lip, which is the line you actually see against the
    // sky from the ground.
    const lip = box(0.42, 0.3, hd * 2 + 0.06, material, side * (hw - 0.1), 0.06, 0);
    lip.rotation.z = -side * angle;
    parts.push(lip);

    if (lift > 0) {
      // Corner curl: two short wedges lifting the ends of the eave, the visual signature
      // of a shrine roof. Kept as separate blocks rather than a curved sweep because at
      // this poly budget a curve reads as a wobble.
      for (const zSign of [-1, 1] as const) {
        const curl = box(1.5, 0.26, 1.4, material, side * (hw - 0.5), lift * 0.55, zSign * (hd - 0.7));
        curl.rotation.z = -side * (angle - 0.42);
        curl.rotation.x = zSign * 0.16;
        parts.push(curl);
        const tip = box(0.7, 0.22, 0.8, material, side * (hw + 0.28), lift, zSign * (hd - 0.1));
        tip.rotation.z = -side * (angle - 0.7);
        parts.push(tip);
      }
    }
  }

  return parts;
}

/** Stepped courses for a four-slope roof. The two hip ends are simple wedges. */
function hippedCourses(
  hw: number,
  hd: number,
  rise: number,
  courses: number,
  material: THREE.Material,
): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  const n = Math.max(1, courses);
  const angle = Math.atan2(rise, hw);
  const slopeLength = Math.hypot(hw, rise);
  const courseLength = slopeLength / n;
  const thickness = 0.16;

  for (const side of [-1, 1] as const) {
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * courseLength;
      const inset = Math.cos(angle) * s;
      const x = side * (hw - inset);
      const y = Math.sin(angle) * s;
      // The long slopes narrow as they climb, because the hips cut in from both ends.
      const depth = Math.max(0.4, (hd - inset) * 2);
      parts.push(tweak(box(courseLength * 1.16, thickness, depth, material, x, y + thickness * 0.5, 0), (m) => {
        m.rotation.z = -side * angle;
      }));
    }
    parts.push(tweak(box(0.4, 0.28, hd * 2, material, side * (hw - 0.1), 0.06, 0), (m) => {
      m.rotation.z = -side * angle;
    }));
  }

  // Hip ends: the same treatment on the z axis.
  const endAngle = Math.atan2(rise, hd);
  const endSlope = Math.hypot(hd, rise);
  const endCourse = endSlope / n;
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * endCourse;
      const inset = Math.cos(endAngle) * s;
      const z = side * (hd - inset);
      const y = Math.sin(endAngle) * s;
      const width = Math.max(0.4, (hw - inset) * 2);
      parts.push(tweak(box(width, thickness, endCourse * 1.16, material, 0, y + thickness * 0.5, z), (m) => {
        m.rotation.x = side * endAngle;
      }));
    }
    parts.push(tweak(box(hw * 2, 0.28, 0.4, material, 0, 0.06, side * (hd - 0.1)), (m) => {
      m.rotation.x = side * endAngle;
    }));
  }

  return parts;
}

/** The triangular board closing a gable end, plus the two rafter tails either side of it. */
function gableEndBoard(hw: number, rise: number, thickness: number, material: THREE.Material, z: number): THREE.Mesh[] {
  const positions: number[] = [];
  const push = (a: THREE.Vector3Tuple, b: THREE.Vector3Tuple, c: THREE.Vector3Tuple): void => {
    positions.push(...a, ...b, ...c);
  };
  const front = z > 0 ? thickness : -thickness;

  // Two triangles, front and back face, so the board has thickness when seen edge-on.
  push([-hw, 0, z], [hw, 0, z], [0, rise, z]);
  push([hw, 0, z + front], [-hw, 0, z + front], [0, rise, z + front]);
  // Edge quads.
  const quad = (a: THREE.Vector3Tuple, b: THREE.Vector3Tuple, c: THREE.Vector3Tuple, dd: THREE.Vector3Tuple): void => {
    push(a, b, c);
    push(a, c, dd);
  };
  quad([-hw, 0, z], [0, rise, z], [0, rise, z + front], [-hw, 0, z + front]);
  quad([hw, 0, z + front], [0, rise, z + front], [0, rise, z], [hw, 0, z]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return [mesh];
}

// ---------------------------------------------------------------------------
// Walls and framing
// ---------------------------------------------------------------------------

export interface WallOptions {
  w: number;
  h: number;
  d: number;
  /** Infill panels. */
  panel: THREE.Material;
  /** Posts, sills and head beams. */
  frame: THREE.Material;
  /** Post spacing along each wall, metres. Real ken spacing is ~1.8 m. */
  bay?: number;
  /** Thickness of the exposed frame members. */
  timber?: number;
  /** Sides that get a shoji screen band instead of solid panel: 'front' | 'all' | 'none'. */
  screens?: 'front' | 'all' | 'none';
  screenMaterial?: THREE.Material;
  /** Height of the screen band above the sill, as a fraction of `h`. */
  screenBand?: [number, number];
}

/**
 * A timber-framed wall box: infill panels with the structural frame standing proud of
 * them, plus an optional band of paper screens along one or all faces.
 *
 * The frame standing *proud* is the point. Japanese vernacular architecture is
 * `shinkabe` — the posts are visible, not buried in the wall — and reproducing that is
 * what stops a building from being a painted cube. It also gives the contour pass a grid
 * of normal discontinuities, so the wall draws itself as a lattice of pen lines rather
 * than as a blank rectangle.
 */
export function framedWalls(options: WallOptions): THREE.Mesh[] {
  const {
    w,
    h,
    d,
    panel,
    frame,
    bay = 2.0,
    timber = 0.2,
    screens = 'none',
    screenMaterial = panel,
    screenBand = [0.18, 0.72],
  } = options;

  const parts: THREE.Mesh[] = [];

  // Infill: one box, slightly inset so the frame reads as standing in front of it.
  parts.push(box(w - timber, h, d - timber, panel, 0, h / 2, 0));

  // Corner posts.
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      parts.push(box(timber * 1.4, h, timber * 1.4, frame, (sx * w) / 2, h / 2, (sz * d) / 2));
    }
  }

  // Intermediate posts along each face.
  const postsAlong = (length: number, place: (t: number) => void): void => {
    const count = Math.max(0, Math.floor(length / bay) - 1);
    for (let i = 1; i <= count; i++) place(-length / 2 + (i * length) / (count + 1));
  };
  postsAlong(w, (x) => {
    for (const sz of [-1, 1] as const) parts.push(box(timber, h, timber, frame, x, h / 2, (sz * d) / 2));
  });
  postsAlong(d, (z) => {
    for (const sx of [-1, 1] as const) parts.push(box(timber, h, timber, frame, (sx * w) / 2, h / 2, z));
  });

  // Sill and head beam, running the whole way round.
  for (const y of [timber * 0.6, h - timber * 0.8]) {
    parts.push(box(w + timber * 0.6, timber * 1.2, timber, frame, 0, y, d / 2));
    parts.push(box(w + timber * 0.6, timber * 1.2, timber, frame, 0, y, -d / 2));
    parts.push(box(timber, timber * 1.2, d + timber * 0.6, frame, w / 2, y, 0));
    parts.push(box(timber, timber * 1.2, d + timber * 0.6, frame, -w / 2, y, 0));
  }

  // Paper screens.
  if (screens !== 'none') {
    const y0 = h * screenBand[0];
    const y1 = h * screenBand[1];
    const bandHeight = y1 - y0;
    const faces: Array<[number, number, number, number]> = [[0, d / 2 + 0.02, w * 0.78, 0]];
    if (screens === 'all') {
      faces.push([0, -d / 2 - 0.02, w * 0.78, Math.PI]);
      faces.push([w / 2 + 0.02, 0, d * 0.78, Math.PI / 2]);
      faces.push([-w / 2 - 0.02, 0, d * 0.78, -Math.PI / 2]);
    }
    for (const [fx, fz, span, rot] of faces) {
      const screen = box(span, bandHeight, 0.06, screenMaterial, fx, y0 + bandHeight / 2, fz);
      screen.rotation.y = rot;
      parts.push(screen);
      // Mullions: the paper is divided into panes, which is most of what makes a shoji
      // read as a shoji.
      const panes = Math.max(2, Math.round(span / 0.85));
      for (let i = 1; i < panes; i++) {
        const t = -span / 2 + (i * span) / panes;
        const mullion = box(0.05, bandHeight, 0.1, frame, fx, y0 + bandHeight / 2, fz);
        mullion.position.x += Math.cos(rot) * t;
        mullion.position.z -= Math.sin(rot) * t;
        mullion.rotation.y = rot;
        parts.push(mullion);
      }
      const rail = box(span, 0.06, 0.1, frame, fx, y0 + bandHeight * 0.55, fz);
      rail.rotation.y = rot;
      parts.push(rail);
    }
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Bases and verandas
// ---------------------------------------------------------------------------

/**
 * A stone plinth. Every serious building on the island stands on one — it lifts the timber
 * clear of the ground, which is both what actually happens and what stops a building from
 * looking like it was dropped onto the terrain.
 */
export function plinth(w: number, d: number, h: number, material: THREE.Material): THREE.Mesh[] {
  return [
    box(w + 0.5, h, d + 0.5, material, 0, h / 2, 0),
    // A slightly wider footing course at the bottom, which reads as masonry rather than
    // as a slab.
    box(w + 0.9, h * 0.35, d + 0.9, material, 0, h * 0.175, 0),
  ];
}

/**
 * An engawa: the covered timber walkway running along a building's face. Deck boards run
 * across the walkway and are modelled individually, because the line of the boards is what
 * gives the veranda its scale.
 */
export function veranda(
  w: number,
  depth: number,
  height: number,
  material: THREE.Material,
  postMaterial: THREE.Material,
): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  const boards = Math.max(3, Math.round(w / 0.42));
  for (let i = 0; i < boards; i++) {
    const x = -w / 2 + (i + 0.5) * (w / boards);
    parts.push(box((w / boards) * 0.9, 0.1, depth, material, x, height, 0));
  }
  // Fascia along the outer edge, and posts holding the whole thing up.
  parts.push(box(w, 0.16, 0.1, material, 0, height - 0.08, depth / 2));
  const posts = Math.max(2, Math.round(w / 2.2));
  for (let i = 0; i <= posts; i++) {
    const x = -w / 2 + (i * w) / posts;
    parts.push(box(0.14, height, 0.14, postMaterial, x, height / 2, depth / 2 - 0.14));
  }
  return parts;
}

/**
 * A short flight of stone steps, as loose parts.
 *
 * Named `stoneSteps` rather than `steps` because `structures.ts` exports a landmark
 * builder of that name which wraps this one and adds cheek walls; both are re-exported
 * from `props/index.ts`, and two `steps` would collide there.
 */
export function stoneSteps(width: number, rise: number, material: THREE.Material, count = 3): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  const stepRise = rise / count;
  const tread = 0.44;
  for (let i = 0; i < count; i++) {
    // Rising with `z`: the shallowest tread at the foot and the full-height one against
    // whatever the flight serves. It used to be the other way round — `count - i` — so every
    // set of steps on the island climbed the wrong way, presenting its tallest block to
    // anyone walking up and tucking the low one under the deck. Nothing else needs changing:
    // callers that face the other way already mirror the whole flight (see `stage`), so the
    // one reversal here fixes the shrine halls, the minka, the teahouse and the stages at
    // once.
    const h = stepRise * (i + 1);
    parts.push(box(width, h, tread, material, 0, h / 2, tread * (i + 0.5)));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/**
 * A lattice panel — the wooden grille across a machiya's street front (*kōshi*). Built as
 * individual slats: at this scale the gaps between them are the detail, and a texture
 * would need alpha testing, which the contour pass cannot see through.
 */
export function lattice(w: number, h: number, material: THREE.Material, spacing = 0.16): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  const count = Math.max(2, Math.floor(w / spacing));
  for (let i = 0; i < count; i++) {
    const x = -w / 2 + (i + 0.5) * (w / count);
    parts.push(box(0.045, h, 0.06, material, x, h / 2, 0));
  }
  // Two horizontal rails tying the slats together.
  parts.push(box(w, 0.06, 0.08, material, 0, h * 0.08, 0));
  parts.push(box(w, 0.06, 0.08, material, 0, h * 0.94, 0));
  return parts;
}

/**
 * A noren — the split curtain hanging in a shop doorway. Double-sided cloth, with the
 * panels at slightly different angles so it reads as fabric rather than as card.
 */
export function noren(w: number, h: number, material: THREE.Material, seed = 1): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  const rng = mulberry32(seed);
  const panels = 3;
  for (let i = 0; i < panels; i++) {
    const pw = (w / panels) * 0.92;
    const x = -w / 2 + (i + 0.5) * (w / panels);
    const panel = box(pw, h, 0.02, material, x, h / 2, 0);
    panel.rotation.y = (rng() - 0.5) * 0.12;
    panel.rotation.z = (rng() - 0.5) * 0.05;
    parts.push(panel);
  }
  return parts;
}

/**
 * A hanging paper lantern (*chōchin*): a ribbed cylinder with dark caps. Two materials,
 * so the caller can make the body glow at night.
 */
export function paperLantern(
  radius: number,
  height: number,
  body: THREE.Material,
  trim: THREE.Material,
): THREE.Mesh[] {
  return [
    cyl(radius * 0.72, radius * 0.72, height * 0.78, 8, body, 0, height * 0.5, 0),
    cyl(radius, radius, height * 0.34, 8, body, 0, height * 0.5, 0),
    cyl(radius * 0.55, radius * 0.55, height * 0.1, 8, trim, 0, height * 0.94, 0),
    cyl(radius * 0.55, radius * 0.55, height * 0.1, 8, trim, 0, height * 0.06, 0),
  ];
}

/**
 * A capped post — the ubiquitous timber upright with a small roof over it, used for
 * signposts, mooring bollards and gate pillars.
 */
export function cappedPost(height: number, thickness: number, material: THREE.Material): THREE.Mesh[] {
  return [
    box(thickness, height, thickness, material, 0, height / 2, 0),
    box(thickness * 1.7, thickness * 0.5, thickness * 1.7, material, 0, height + thickness * 0.2, 0),
  ];
}

/**
 * A rope — a thin, slightly sagging cylinder between two points. Used for mooring lines,
 * shrine shimenawa and the net racks in the north harbour.
 */
export function rope(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  sag = 0.25,
  segments = 5,
): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = from.clone().lerp(to, t);
    // A parabola, which is close enough to a catenary at these spans that nobody could
    // tell the difference and much cheaper to evaluate.
    p.y -= sag * 4 * t * (1 - t);
    points.push(p);
  }
  for (let i = 0; i < segments; i++) {
    const a = points[i];
    const b = points[i + 1];
    const mid = a.clone().lerp(b, 0.5);
    const length = a.distanceTo(b);
    const segment = cyl(radius, radius, length, 5, material, mid.x, mid.y, mid.z, 0, 0, 0, true);
    // Orient the cylinder (which is built along +Y) onto the segment direction.
    const dir = b.clone().sub(a).normalize();
    segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    parts.push(segment);
  }
  return parts;
}

/**
 * An irregular boulder — a squashed, randomly-displaced icosahedron.
 *
 * Deterministic from `seed`, so the same rock is the same rock on every machine and after
 * every reload.
 */
export function boulder(radius: number, material: THREE.Material, seed = 1): THREE.Mesh {
  // `detail: 0` — twenty faces, not eighty. The contour pass draws a line at every normal
  // discontinuity, so a finely subdivided rock arrives as a ball of wireframe rather than
  // as a rock. Twenty large facets give the handful of lines a person would actually draw.
  const geo = new THREE.IcosahedronGeometry(radius, 0);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Displacement is a function of **where the vertex is**, not of which vertex it is.
    //
    // `IcosahedronGeometry` is non-indexed: every face carries its own three vertices, so
    // each corner of the solid appears in the buffer three to five times over. Pulling a
    // fresh random number per vertex therefore moves those copies to different places and
    // the rock splits open along every edge — which is exactly what it looked like.
    // Hashing the position instead gives every copy of a shared corner the same answer, so
    // the faces stay welded while the silhouette still comes out irregular.
    const jitter = positionHash(v.x, v.y, v.z, seed);
    v.multiplyScalar(0.8 + jitter * 0.38);
    v.y *= 0.62;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const mesh = meshFrom(geo, material, 0, radius * 0.42, 0);
  // A whole-object rotation is fine to draw from the seed — it moves every vertex together
  // and so cannot split anything.
  mesh.rotation.y = mulberry32(seed)() * Math.PI * 2;
  return mesh;
}
