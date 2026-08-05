/**
 * Structure builders.
 * ====================
 *
 * Everything on the island that isn't a roofed building: the torii gates, the plaza's
 * plain wooden gate markers, the harbour pier, the fishing boats, performance stages,
 * the notice board, and the fence rail used at cliff edges. As with `buildings.ts`,
 * every builder returns a base-centred `THREE.Group` and finishes with
 * `mergeByMaterial()`.
 */

import * as THREE from 'three';
import { box, cyl, gableRoof, hippedRoof, mergeByMaterial, numOpt, boolOpt } from './geometry.js';
import { wood, vermilion, stone, shoji, roof } from '../materials.js';

type Opts = Record<string, unknown> | undefined;

// ---------------------------------------------------------------------------
// Torii
// ---------------------------------------------------------------------------

/**
 * A torii: the gate that marks the approach to the shrine (and, at the harbour, the one
 * standing in the sea). Vermilion is the correct colour here — this and the lighthouse
 * band are the only two places in the whole prop library that use it.
 *
 * Anatomy, bottom to top:
 * - two tapered pillars (hashira);
 * - **nuki**, the straight crossbeam that passes through both pillars;
 * - a small dark **gakuzuka** tablet where the nuki meets the centre-line, purely
 *   decorative but instantly recognisable;
 * - **shimaki**, a straight cap beam;
 * - **kasagi**, the top beam proper, built slightly longer than shimaki with its two
 *   ends kicked upward — the curved silhouette that makes a torii unmistakable even in
 *   silhouette. A true kasagi is one continuously curved timber; here it is
 *   approximated with a straight centre span plus two angled end pieces, which keeps it
 *   to 3 boxes instead of a curved-surface mesh and still reads correctly at the
 *   distances this game is viewed from.
 *
 * `opts.inWater` (used by the harbour's sea-standing torii) adds stone mounds at each
 * pillar's foot, their tops breaking the waterline while their bases run on down toward
 * the seabed — the group's own origin still stays at `y = 0` (sea level), exactly as the
 * base-centre convention requires; the mounds simply extend below it.
 */
export function torii(opts: Opts = {}): THREE.Group {
  const span = numOpt(opts, 'span', 3.8); // Distance between pillar centres.
  const pillarH = numOpt(opts, 'height', 4.3);
  const inWater = boolOpt(opts, 'inWater', false);

  const parts: THREE.Mesh[] = [];
  const halfSpan = span / 2;
  const outset = 0.55; // How far the beams project past the pillars.

  // Pillars, gently tapered.
  for (const sx of [-1, 1]) {
    parts.push(cyl(0.15, 0.22, pillarH, 8, vermilion(), sx * halfSpan, pillarH / 2, 0));
  }

  // Nuki — straight through-beam.
  const nukiY = pillarH * 0.62;
  parts.push(box(span + outset * 1.4, 0.26, 0.26, vermilion(), 0, nukiY, 0));
  // Gakuzuka — small dark tablet centred on the nuki.
  parts.push(box(0.32, 0.5, 0.1, wood('dark'), 0, nukiY + 0.5, 0));

  // Shimaki — straight cap beam just under the kasagi.
  const shimakiY = pillarH + 0.05;
  parts.push(box(span + outset * 1.8, 0.2, 0.34, vermilion(), 0, shimakiY, 0));

  // Kasagi — centre span plus two upward-kicked end pieces.
  const kasagiY = shimakiY + 0.28;
  const kasagiSpan = span + outset * 2.2;
  parts.push(box(kasagiSpan, 0.34, 0.44, vermilion(), 0, kasagiY, 0));
  const tipLen = 1.0;
  const tipAngle = 0.42;
  for (const sx of [-1, 1]) {
    const baseX = (sx * kasagiSpan) / 2;
    parts.push(
      box(
        tipLen,
        0.3,
        0.4,
        vermilion(),
        baseX + sx * (Math.cos(tipAngle) * tipLen) / 2,
        kasagiY + (Math.sin(tipAngle) * tipLen) / 2,
        0,
        0,
        0,
        -sx * tipAngle,
      ),
    );
  }

  if (inWater) {
    for (const sx of [-1, 1]) {
      parts.push(cyl(1.0, 1.3, 2.6, 8, stone('dark'), sx * halfSpan, -1.0, 0));
    }
  }

  const group = new THREE.Group();
  group.name = 'torii';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * A plain wooden post-and-lintel gate — not a torii, no religious weight, just a marker
 * that says "you are now entering the plaza". Two square posts and a straight lintel;
 * the absence of a curved kasagi or any vermilion is the point, it visually
 * de-emphasises itself next to the shrine's torii.
 */
export function gate(opts: Opts = {}): THREE.Group {
  const span = numOpt(opts, 'span', 4.2);
  const postH = numOpt(opts, 'height', 3.0);

  const parts: THREE.Mesh[] = [];
  const halfSpan = span / 2;
  for (const sx of [-1, 1]) {
    parts.push(box(0.32, postH, 0.32, wood('dark'), sx * halfSpan, postH / 2, 0));
  }
  parts.push(box(span + 0.6, 0.3, 0.3, wood('dark'), 0, postH + 0.15, 0));
  parts.push(box(span + 0.2, 0.1, 0.42, wood('beam'), 0, postH - 0.05, 0));

  const group = new THREE.Group();
  group.name = 'gate';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Pier
// ---------------------------------------------------------------------------

/**
 * A harbour pier: decking on piles. Piles are spaced every ~5.5 m along the length and
 * planted in pairs across the width; each pile's geometry runs from just under the deck
 * down to well below `y = 0` (the sea surface, per the terrain field's convention) so it
 * visibly disappears into the water rather than floating above it. Piles are built
 * `openEnded` — both ends are permanently hidden (one in the deck, one in the seabed) so
 * their end caps would be pure wasted triangles.
 *
 * `opts.length`/`opts.width` size the deck; both default to a modest jetty.
 */
export function pier(opts: Opts = {}): THREE.Group {
  const length = numOpt(opts, 'length', 24);
  const width = numOpt(opts, 'width', 5);
  const deckY = 1.1;
  const pileDepth = 4.5;

  const parts: THREE.Mesh[] = [];
  parts.push(box(width, 0.28, length, wood('light'), 0, deckY, 0));

  const spacing = 5.5;
  const count = Math.max(2, Math.round(length / spacing) + 1);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const z = -length / 2 + 0.6 + t * (length - 1.2);
    for (const sx of [-1, 1]) {
      const x = sx * (width / 2 - 0.5);
      const pileH = deckY + pileDepth;
      parts.push(cyl(0.24, 0.3, pileH, 6, wood('dark'), x, deckY - pileH / 2, z, 0, 0, 0, true));
    }
  }

  // Low edge rail along both long sides: a post at every other pile plus a top rail.
  const railY = deckY + 0.6;
  parts.push(box(0.1, 0.1, length - 1.0, wood('beam'), -width / 2 + 0.5, railY, 0));
  parts.push(box(0.1, 0.1, length - 1.0, wood('beam'), width / 2 - 0.5, railY, 0));
  const postSpacing = 5.5;
  const postCount = Math.max(2, Math.round(length / postSpacing) + 1);
  for (let i = 0; i < postCount; i++) {
    const t = postCount === 1 ? 0 : i / (postCount - 1);
    const z = -length / 2 + 0.6 + t * (length - 1.2);
    for (const sx of [-1, 1]) {
      parts.push(box(0.1, 0.6, 0.1, wood('beam'), sx * (width / 2 - 0.5), deckY + 0.3, z));
    }
  }

  const group = new THREE.Group();
  group.name = 'pier';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Boat
// ---------------------------------------------------------------------------

/**
 * A small wooden fishing boat: hull, a tiny cabin, a mast. The hull is three overlapping
 * boxes — stern, midships, bow — each a little narrower than the last, which fakes a
 * tapered hull without needing a hand-tapered/skinned mesh. It reads as "small wooden
 * boat" at a glance, which is all a set-dressing prop needs to do; nobody boards it.
 */
export function boat(opts: Opts = {}): THREE.Group {
  const length = numOpt(opts, 'length', 5.2);
  const beam = numOpt(opts, 'beam', 1.7);
  const hullH = 0.62;

  const parts: THREE.Mesh[] = [];
  const waterline = hullH * 0.35; // How much of the hull sits above the waterline.
  const hullY = waterline;

  parts.push(box(beam, hullH, length * 0.5, wood('dark'), 0, hullY, 0)); // midships
  parts.push(box(beam * 0.72, hullH * 0.85, length * 0.3, wood('dark'), 0, hullY + 0.03, length * 0.4)); // bow
  parts.push(box(beam * 0.8, hullH * 0.9, length * 0.24, wood('dark'), 0, hullY + 0.02, -length * 0.38)); // stern
  // Gunwale trim.
  parts.push(box(beam + 0.06, 0.08, length * 0.86, wood('beam'), 0, hullY + hullH / 2, 0));

  // Cabin, set toward the stern.
  const cabinW = beam * 0.7;
  const cabinH = 0.85;
  parts.push(box(cabinW, cabinH, 1.0, wood('light'), 0, hullY + hullH / 2 + cabinH / 2, -length * 0.18));

  // Mast and a short yard.
  const mastH = 2.6;
  parts.push(cyl(0.05, 0.07, mastH, 6, wood('beam'), 0, hullY + hullH / 2 + mastH / 2, length * 0.05));
  parts.push(
    box(1.4, 0.05, 0.05, wood('beam'), 0, hullY + hullH / 2 + mastH * 0.72, length * 0.05, 0, 0, Math.PI / 2),
  );

  const group = new THREE.Group();
  group.name = 'boat';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

/**
 * A raised wooden performance platform — where a venue's host stands (see `Zone.stage`
 * in `world.ts`). Always a raised deck on short legs with a front step; `opts.roof`
 * additionally raises four corner posts and caps them with a hipped roof, for venues
 * that want the stage itself to read as a small building rather than just a platform.
 */
export function stage(opts: Opts = {}): THREE.Group {
  const w = numOpt(opts, 'w', 10);
  const d = numOpt(opts, 'd', 7);
  const hasRoof = boolOpt(opts, 'roof', false);
  const deckH = 0.65;

  const parts: THREE.Mesh[] = [];
  parts.push(box(w, deckH, d, wood('light'), 0, deckH / 2, 0));

  // Short corner legs, visible below the deck edge.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(box(0.3, deckH, 0.3, wood('dark'), (sx * (w - 0.4)) / 2, deckH / 2, (sz * (d - 0.4)) / 2));
    }
  }

  // Front step.
  parts.push(box(2.2, deckH / 2, 0.7, stone(), 0, deckH / 4, d / 2 + 0.35));

  if (hasRoof) {
    const postH = 3.4;
    const roofRise = 1.6;
    const overhang = 1.1;
    const postY = deckH + postH / 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box(0.26, postH, 0.26, wood('beam'), (sx * (w - 0.6)) / 2, postY, (sz * (d - 0.6)) / 2));
      }
    }
    parts.push(hippedRoof(w, d, roofRise, overhang, roof('tile')));
    parts[parts.length - 1].position.y = deckH + postH;
  }

  const group = new THREE.Group();
  group.name = 'stage';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Notice board
// ---------------------------------------------------------------------------

/**
 * The island's notice board (kōsatsu): a wooden board on two posts with its own small
 * roof cap keeping rain off the paper, and a handful of pinned paper slips. The slips
 * use `shoji()` rather than plain wood/plaster specifically so they pick up the same
 * warm night-time glow as paper screens — a lit notice board reads as "still tended"
 * after dark, which matters for the one landmark whose entire job is being read.
 */
export function noticeBoard(opts: Opts = {}): THREE.Group {
  const w = numOpt(opts, 'w', 2.2);
  const h = numOpt(opts, 'h', 1.6);
  const postH = 1.9;

  const parts: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    parts.push(box(0.16, postH, 0.16, wood('dark'), (sx * (w - 0.3)) / 2, postH / 2, 0));
  }
  const boardY = postH - h / 2 - 0.15;
  parts.push(box(w, h, 0.08, wood('beam'), 0, boardY, 0.05));

  // Paper slips, slightly proud of the board face.
  const slipCols = 3;
  for (let i = 0; i < slipCols; i++) {
    const x = -w / 2 + 0.35 + (i * (w - 0.7)) / (slipCols - 1);
    parts.push(box(0.42, 0.58, 0.02, shoji(), x, boardY + 0.15, 0.1));
  }

  // Small gable roof cap. gableRoof()'s ridge runs along its local z; rotating 90°
  // about y swaps local z/x into world x/z, so the *second* argument (the local "ridge
  // length" axis) is what ends up spanning the board's width in world space.
  parts.push(gableRoof(0.6, w + 0.1, 0.42, 0.3, roof('tile')));
  parts[parts.length - 1].rotation.y = Math.PI / 2;
  parts[parts.length - 1].position.y = postH;

  const group = new THREE.Group();
  group.name = 'notice-board';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

/**
 * A run of simple wooden fence, used at cliff edges and lookouts (see `lookout-rail` /
 * `cape-rail` in `LANDMARKS`). `opts.length` sets the run length in metres; posts are
 * spaced every ~2 m along it with two horizontal rails.
 */
export function rail(opts: Opts = {}): THREE.Group {
  const length = numOpt(opts, 'length', 12);
  const postH = 0.95;
  const spacing = 2.0;
  const count = Math.max(2, Math.round(length / spacing) + 1);

  const parts: THREE.Mesh[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const x = -length / 2 + t * length;
    parts.push(box(0.12, postH, 0.12, wood('dark'), x, postH / 2, 0));
  }
  parts.push(box(length, 0.08, 0.08, wood('beam'), 0, postH * 0.55, 0));
  parts.push(box(length, 0.08, 0.08, wood('beam'), 0, postH * 0.95, 0));

  const group = new THREE.Group();
  group.name = 'rail';
  group.add(...mergeByMaterial(parts));
  return group;
}
