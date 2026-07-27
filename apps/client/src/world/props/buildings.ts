/**
 * Building builders.
 * ===================
 *
 * Every roofed structure a player can walk up to: the farmhouse, the townhouse, the
 * teahouse, the shrine hall, the warehouse and the lighthouse. Each function returns a
 * `THREE.Group` whose origin is the building's base centre at `y = 0` — the caller sets
 * `group.position.set(x, heightAt(x, z), z)` and is done.
 *
 * Shared vocabulary used throughout this file:
 *
 * - **Deep eaves.** Every roof here overhangs its walls by 0.9–1.8 m. This is not
 *   decoration — traditional Japanese roofs shed monsoon rain clear of the plaster
 *   walls and shade the veranda, and visually it is the single detail that reads
 *   "Japanese roof" rather than "shed with a triangle on it".
 * - **Raised floor.** Farmhouses, teahouses and especially the shrine hall lift their
 *   floor above grade (a plinth or full post-supported deck). It keeps timber off damp
 *   ground and, for the shrine, marks a threshold between the ordinary ground and a
 *   consecrated space — worth the extra step geometry even under a tight poly budget.
 * - **Vermilion is rare.** Of every builder below, only `shrineHall` and `lighthouse`
 *   touch `vermilion()` — a painted pillar and a tower band respectively — exactly as
 *   the palette in `tokens.ts` intends. Nowhere else in this file calls it.
 *
 * Every builder assembles its shape from many small `box()`/`cyl()` primitives (cheap to
 * reason about individually) and finishes with `mergeByMaterial()`, so a ~40-primitive
 * building costs only as many draw calls as it has distinct materials.
 */

import * as THREE from 'three';
import {
  box,
  cyl,
  cone,
  gableRoof,
  hippedRoof,
  curvedEaveRoof,
  mergeByMaterial,
  numOpt,
} from './geometry.js';
import { wood, roof, plaster, shoji, vermilion, stone, cloth, glow, whitewash } from '../materials.js';

type Opts = Record<string, unknown> | undefined;

// ---------------------------------------------------------------------------
// Minka — rural farmhouse
// ---------------------------------------------------------------------------

/**
 * A minka: the vernacular rural farmhouse. Thick thatched hipped roof, a timber frame
 * with plastered infill walls, and a veranda (engawa) wrapped around the front where the
 * household's outdoor life actually happens. Everything about the shape says "built by
 * hand, generations ago" rather than "designed" — irregular in massing, not in geometry
 * budget.
 *
 * `opts.w`/`opts.d` set the footprint in metres (defaults 12 × 9, consistent with the
 * `LANDMARKS` entries in `world.ts`).
 */
export function minka(opts: Opts = {}): THREE.Group {
  const w = numOpt(opts, 'w', 12);
  const d = numOpt(opts, 'd', 9);
  const wallH = 3.1;
  const plinthH = 0.35;
  const roofRise = 3.6;
  const overhang = 1.7;

  const parts: THREE.Mesh[] = [];

  // Stone foundation plinth — keeps the timber sill off wet ground.
  parts.push(box(w + 0.6, plinthH, d + 0.6, stone(), 0, plinthH / 2, 0));

  // Wall volume, simplified to a single box (the frame-and-infill detail lives in the
  // corner posts and lintel, not in extra wall geometry — that is where the polygon
  // budget is better spent).
  const wallY = plinthH + wallH / 2;
  parts.push(box(w, wallH, d, plaster(), 0, wallY, 0));

  // Exposed corner posts (daikoku-bashira vocabulary), proud of the wall face.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(box(0.32, wallH, 0.32, wood('beam'), (sx * w) / 2, wallY, (sz * d) / 2));
    }
  }

  // Veranda deck along the front (engawa), raised, with two support posts under the eave.
  const verandaDepth = 1.5;
  const verandaZ = -d / 2 - verandaDepth / 2;
  parts.push(box(w, 0.3, verandaDepth, wood('light'), 0, plinthH + 0.15, verandaZ));
  for (const sx of [-0.36, 0.36]) {
    parts.push(box(0.22, wallH, 0.22, wood('beam'), sx * w, wallY, verandaZ - verandaDepth / 2 + 0.15));
  }

  // Shoji accent panels either side of the entry — the only glimpse of the interior.
  parts.push(box(1.6, 1.7, 0.05, shoji(), -w * 0.22, plinthH + 1.1, -d / 2 - 0.02));
  parts.push(box(1.6, 1.7, 0.05, shoji(), w * 0.22, plinthH + 1.1, -d / 2 - 0.02));

  // Thick hipped thatch roof, deeply overhung.
  const roofY = plinthH + wallH;
  parts.push(hippedRoof(w, d, roofRise, overhang, roof('thatch')));
  parts[parts.length - 1].position.y = roofY;

  // Fascia trim under the eave line — a thin dark board that gives the roof edge visual
  // weight instead of ending in a knife edge.
  parts.push(box(w + overhang * 2 - 0.2, 0.22, 0.18, wood('dark'), 0, roofY + 0.11, -d / 2 - overhang + 0.1));
  parts.push(box(w + overhang * 2 - 0.2, 0.22, 0.18, wood('dark'), 0, roofY + 0.11, d / 2 + overhang - 0.1));

  const group = new THREE.Group();
  group.name = 'minka';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Machiya — townhouse
// ---------------------------------------------------------------------------

/**
 * A machiya: the narrow-frontage wooden townhouse that lines the old street. Real
 * machiya are famously "eel's beds" — a tight street face and a long, deep plan — so the
 * gable roof is oriented with its *ridge* running front-to-back: the triangular gable
 * end faces the street, which is the single most recognisable silhouette cue for this
 * building type.
 *
 * `opts.w`/`opts.d` set the footprint (default 9 × 11); `opts.floors` (1 or 2, default 2)
 * controls height. A dark timber ground floor with lattice (koshi) and a lighter, more
 * enclosed upper floor is the traditional colour split, and is reproduced here with
 * `wood('dark')` below and `plaster()` above.
 */
export function machiya(opts: Opts = {}): THREE.Group {
  const w = numOpt(opts, 'w', 9);
  const d = numOpt(opts, 'd', 11);
  const floors = Math.max(1, Math.min(2, numOpt(opts, 'floors', 2)));
  const floorH = 2.6;
  const plinthH = 0.2;
  const overhang = 1.0;
  const roofRise = floors === 2 ? 2.6 : 2.1;

  const parts: THREE.Mesh[] = [];

  parts.push(box(w + 0.3, plinthH, d + 0.3, stone(), 0, plinthH / 2, 0));

  // Ground floor: dark timber, with a lattice (koshi) screen across the street face.
  const gfY = plinthH + floorH / 2;
  parts.push(box(w, floorH, d, wood('dark'), 0, gfY, 0));
  const latticeCount = 7;
  for (let i = 0; i < latticeCount; i++) {
    const x = -w / 2 + 0.4 + (i * (w - 0.8)) / (latticeCount - 1);
    parts.push(box(0.08, floorH * 0.62, 0.06, wood('beam'), x, plinthH + floorH * 0.5, -d / 2 - 0.05));
  }

  // Noren curtain over the entrance — a hung cloth panel, not vermilion (that accent is
  // reserved for the shrine and the lighthouse), a muted indigo instead.
  parts.push(box(1.5, 1.0, 0.06, cloth(0x3f4a5a), 0, plinthH + floorH * 0.62, -d / 2 - 0.09));

  let topY = plinthH + floorH;

  if (floors === 2) {
    // Mezzanine trim board marking the floor line.
    parts.push(box(w + 0.15, 0.14, d + 0.15, wood('beam'), 0, topY + 0.07, 0));
    topY += 0.14;
    const ufY = topY + floorH / 2;
    parts.push(box(w * 0.96, floorH, d * 0.96, plaster(), 0, ufY, 0));
    // A pair of small shoji windows on the upper floor facing the street.
    parts.push(box(1.1, 1.0, 0.05, shoji(), -w * 0.22, topY + floorH * 0.55, -d / 2 - 0.02));
    parts.push(box(1.1, 1.0, 0.05, shoji(), w * 0.22, topY + floorH * 0.55, -d / 2 - 0.02));
    topY += floorH;
  }

  parts.push(gableRoof(w, d, roofRise, overhang, roof('tile')));
  parts[parts.length - 1].position.y = topY;

  // Fascia along both eaves.
  parts.push(box(0.16, 0.2, d + overhang * 2 - 0.2, wood('dark'), -w / 2 - overhang + 0.08, topY + 0.1, 0));
  parts.push(box(0.16, 0.2, d + overhang * 2 - 0.2, wood('dark'), w / 2 + overhang - 0.08, topY + 0.1, 0));

  const group = new THREE.Group();
  group.name = 'machiya';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Teahouse
// ---------------------------------------------------------------------------

/**
 * A teahouse: small, open-sided, unhurried. Structurally the simplest building in the
 * library — a raised deck, a ring of slender posts holding up a low, generously
 * overhung roof, and (mostly) no walls at all, so the interior and exterior are really
 * one space with a roof over part of it. That openness is the point: `INTERACTABLES` in
 * `world.ts` places sit-down spots here, not stand-up ones.
 *
 * `opts.w`/`opts.d` set the footprint (default 7 × 5.5).
 */
export function teahouse(opts: Opts = {}): THREE.Group {
  const w = numOpt(opts, 'w', 7);
  const d = numOpt(opts, 'd', 5.5);
  const deckH = 0.45;
  const postH = 2.1;
  const roofRise = 1.4;
  const overhang = 1.3;

  const parts: THREE.Mesh[] = [];

  // Raised tatami deck.
  parts.push(box(w, deckH, d, wood('light'), 0, deckH / 2, 0));
  // Stone footing pads peeking out from under the deck corners.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(box(0.4, 0.18, 0.4, stone(), (sx * (w - 0.6)) / 2, 0.09, (sz * (d - 0.6)) / 2));
    }
  }

  // Perimeter posts — open-sided, so these (plus the low back screen) are the only
  // vertical mass in the building.
  const postY = deckH + postH / 2;
  const postsX = [-w / 2 + 0.15, 0, w / 2 - 0.15];
  const postsZ = [-d / 2 + 0.15, d / 2 - 0.15];
  for (const px of postsX) {
    for (const pz of postsZ) {
      parts.push(box(0.18, postH, 0.18, wood('beam'), px, postY, pz));
    }
  }
  for (const pz2 of [-d / 3, d / 3]) {
    parts.push(box(0.16, postH, 0.16, wood('beam'), -w / 2 + 0.15, postY, pz2));
    parts.push(box(0.16, postH, 0.16, wood('beam'), w / 2 - 0.15, postY, pz2));
  }

  // Low lattice half-wall along the back only, for a hint of enclosure.
  parts.push(box(w - 0.4, 0.85, 0.08, wood('beam'), 0, deckH + 0.42, d / 2 - 0.1));

  // Top wall-plate ring the roof sits on.
  parts.push(box(w, 0.14, 0.14, wood('beam'), 0, deckH + postH, -d / 2 + 0.15));
  parts.push(box(w, 0.14, 0.14, wood('beam'), 0, deckH + postH, d / 2 - 0.15));
  parts.push(box(0.14, 0.14, d, wood('beam'), -w / 2 + 0.15, deckH + postH, 0));
  parts.push(box(0.14, 0.14, d, wood('beam'), w / 2 - 0.15, deckH + postH, 0));

  const roofY = deckH + postH;
  parts.push(hippedRoof(w, d, roofRise, overhang, roof('thatch')));
  parts[parts.length - 1].position.y = roofY;

  const group = new THREE.Group();
  group.name = 'teahouse';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Shrine hall
// ---------------------------------------------------------------------------

/**
 * A shrine hall (honden/haiden fused into one modest building, appropriate for a small
 * island shrine rather than a grand precinct). This is the one building in the library
 * that spends the vermilion accent: painted round-section pillars and a railing, the
 * palette's single loudest architectural gesture, used exactly once.
 *
 * Distinguishing shrine-roof vocabulary, both included:
 * - **chigi** — the forked finials that cross at the roof's gable-end ridge points.
 * - **katsuogi** — the short horizontal logs laid across the ridge between them.
 *
 * The roof uses `curvedEaveRoof()` rather than a plain gable — the *sori* upward curl at
 * the eave corners is reserved for this one building, per the doc comment on that
 * function in `geometry.ts`.
 */
export function shrineHall(opts: Opts = {}): THREE.Group {
  const w = numOpt(opts, 'w', 14);
  const d = numOpt(opts, 'd', 11);
  const floorH = 1.1; // Raised well above grade — the threshold into a consecrated space.
  const postH = 2.6;
  const roofRise = 3.2;
  const overhang = 1.9;

  const parts: THREE.Mesh[] = [];

  parts.push(box(w + 0.5, 0.4, d + 0.5, stone(), 0, 0.2, 0));
  const deckY = 0.4 + floorH / 2;
  parts.push(box(w, floorH, d, wood('light'), 0, deckY, 0));

  // Steps up the front, centred.
  for (let i = 0; i < 3; i++) {
    const sh = floorH / 3;
    parts.push(box(2.4, sh, 0.4, stone(), 0, sh / 2 + i * sh, -d / 2 - 0.25 - i * 0.4));
  }

  // Vermilion round pillars, the shrine's defining colour note.
  const postY = 0.4 + floorH + postH / 2;
  const postsX = [-w / 2 + 0.25, -w / 6, w / 6, w / 2 - 0.25];
  const postsZ = [-d / 2 + 0.25, d / 2 - 0.25];
  for (const px of postsX) {
    for (const pz of postsZ) {
      parts.push(cyl(0.22, 0.22, postH, 6, vermilion(), px, postY, pz));
    }
  }

  // Rear wall panel (wood, not vermilion — the accent stays on the structural members).
  parts.push(box(w - 0.6, postH, 0.16, wood('dark'), 0, postY, d / 2 - 0.2));

  // Vermilion railing along the veranda front.
  parts.push(box(w - 0.4, 0.1, 0.1, vermilion(), 0, 0.4 + floorH + 0.55, -d / 2 + 0.2));
  const balusterCount = 7;
  for (let i = 0; i < balusterCount; i++) {
    const x = -w / 2 + 0.5 + (i * (w - 1)) / (balusterCount - 1);
    parts.push(box(0.08, 0.55, 0.08, vermilion(), x, 0.4 + floorH + 0.275, -d / 2 + 0.2));
  }

  const roofY = 0.4 + floorH + postH;
  parts.push(curvedEaveRoof(w, d, roofRise, overhang, roof('copper')));
  parts[parts.length - 1].position.y = roofY;

  // Katsuogi — short logs laid across the ridge.
  const ridgeCount = 4;
  for (let i = 0; i < ridgeCount; i++) {
    const z = -d * 0.3 + (i * (d * 0.6)) / (ridgeCount - 1);
    parts.push(cyl(0.14, 0.14, 1.6, 6, wood('dark'), 0, roofY + roofRise + 0.15, z, 0, 0, Math.PI / 2));
  }

  // Chigi — crossed forked finials at each gable end.
  for (const sz of [-1, 1]) {
    const z = sz * (d / 2 + overhang - 0.1);
    parts.push(box(0.16, 1.3, 0.16, wood('dark'), 0, roofY + roofRise, z, 0.5, 0, 0));
    parts.push(box(0.16, 1.3, 0.16, wood('dark'), 0, roofY + roofRise, z, -0.5, 0, 0));
  }

  const group = new THREE.Group();
  group.name = 'shrine-hall';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Warehouse — kura
// ---------------------------------------------------------------------------

/**
 * A kura: the storehouse type found at the harbour. Thick whitewashed-plaster walls
 * (fire resistance was the original point — a kura was where a household's valuables
 * survived a burning town), a heavy tiled hipped roof, and only small, high windows —
 * storage, not living space, and the massing should read that way: blockier and more
 * closed than every other building here.
 *
 * `opts.w`/`opts.d` set the footprint (default 12 × 9).
 */
export function warehouse(opts: Opts = {}): THREE.Group {
  const w = numOpt(opts, 'w', 12);
  const d = numOpt(opts, 'd', 9);
  const wallH = 4.2;
  const plinthH = 0.4;
  const roofRise = 2.6;
  const overhang = 1.1;

  const parts: THREE.Mesh[] = [];

  parts.push(box(w + 0.4, plinthH, d + 0.4, stone(), 0, plinthH / 2, 0));
  const wallY = plinthH + wallH / 2;
  parts.push(box(w, wallH, d, plaster(), 0, wallY, 0));

  // Dark corner quoins — visual armour at the vulnerable edges.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(box(0.5, wallH, 0.5, wood('dark'), (sx * (w - 0.25)) / 2, wallY, (sz * (d - 0.25)) / 2));
    }
  }

  // Small high windows — storage, not living space.
  parts.push(box(0.7, 0.6, 0.1, wood('dark'), -w * 0.25, wallY + wallH * 0.28, -d / 2 - 0.03));
  parts.push(box(0.7, 0.6, 0.1, wood('dark'), w * 0.25, wallY + wallH * 0.28, -d / 2 - 0.03));

  // Heavy plank door with a stone step.
  parts.push(box(1.8, 2.3, 0.12, wood('dark'), 0, plinthH + 1.15, -d / 2 - 0.04));
  parts.push(box(2.2, 0.15, 0.5, stone(), 0, 0.075, -d / 2 - 0.35));

  const roofY = plinthH + wallH;
  parts.push(hippedRoof(w, d, roofRise, overhang, roof('tile')));
  parts[parts.length - 1].position.y = roofY;
  parts.push(box(w + overhang * 2 - 0.2, 0.2, 0.16, wood('dark'), 0, roofY + 0.1, -d / 2 - overhang + 0.08));
  parts.push(box(w + overhang * 2 - 0.2, 0.2, 0.16, wood('dark'), 0, roofY + 0.1, d / 2 + overhang - 0.08));

  const group = new THREE.Group();
  group.name = 'warehouse';
  group.add(...mergeByMaterial(parts));
  return group;
}

// ---------------------------------------------------------------------------
// Lighthouse
// ---------------------------------------------------------------------------

/**
 * The lighthouse at the cape. The tallest thing on the island (~22 m to the top of the
 * lamp room), so it doubles as a navigation landmark for the player as much as for the
 * boats it is fictionally guiding.
 *
 * The tower body is a single tapered cylinder — one primitive gives the whole tower its
 * silhouette for almost no polygon cost. A vermilion band (the second and last permitted
 * use of that colour in the whole prop library) marks the traditional day-mark stripe.
 * The lamp itself is built as a **separate, unmerged** mesh named `'lamp'` so the scene
 * director can find it (`group.getObjectByName('lamp')`) and spin it independently —
 * every other part of this builder is folded into `mergeByMaterial()`, but a mesh that
 * needs its own per-frame transform cannot be merged away.
 */
export function lighthouse(opts: Opts = {}): THREE.Group {
  const baseR = numOpt(opts, 'baseRadius', 2.3);
  const topR = numOpt(opts, 'topRadius', 1.35);
  const shaftH = numOpt(opts, 'shaftHeight', 16.5);
  const galleryY = shaftH;
  const lampRoomH = 2.6;

  const parts: THREE.Mesh[] = [];

  // Tapered tower shaft.
  parts.push(cyl(topR, baseR, shaftH, 12, whitewash(), 0, shaftH / 2, 0));

  // Vermilion day-mark band, roughly two-thirds up the shaft.
  const bandY = shaftH * 0.62;
  const bandR = topR + ((baseR - topR) * (shaftH - bandY)) / shaftH + 0.04;
  parts.push(cyl(bandR, bandR, shaftH * 0.14, 12, vermilion(), 0, bandY, 0));

  // Gallery deck at the top of the shaft, with a railing.
  parts.push(cyl(topR + 0.5, topR + 0.5, 0.25, 12, stone(), 0, galleryY + 0.125, 0));
  parts.push(cyl(topR + 0.5, topR + 0.5, 0.12, 12, wood('dark'), 0, galleryY + 1.1, 0));
  const balusters = 10;
  for (let i = 0; i < balusters; i++) {
    const a = (i / balusters) * Math.PI * 2;
    parts.push(
      box(0.08, 1.0, 0.08, wood('dark'), Math.cos(a) * (topR + 0.5), galleryY + 0.6, Math.sin(a) * (topR + 0.5)),
    );
  }

  // Glazed lamp room: slender corner mullions plus a conical copper roof.
  const roomR = topR + 0.15;
  const roomH = lampRoomH;
  const mullions = 8;
  for (let i = 0; i < mullions; i++) {
    const a = (i / mullions) * Math.PI * 2;
    parts.push(
      box(0.1, roomH, 0.1, wood('dark'), Math.cos(a) * roomR, galleryY + 0.25 + roomH / 2, Math.sin(a) * roomR),
    );
  }
  parts.push(cone(roomR + 0.35, 1.1, 10, roof('copper'), 0, galleryY + 0.25 + roomH + 0.55, 0));
  // Finial ball on top.
  parts.push(cyl(0.12, 0.12, 0.5, 6, wood('dark'), 0, galleryY + 0.25 + roomH + 1.35, 0));

  // Attached keeper's base — a small single-storey room built onto the tower's foot.
  const kw = 3.2;
  const kd = 2.6;
  const kh = 2.4;
  const kx = baseR + kw / 2 - 0.3;
  parts.push(box(kw, kh, kd, plaster(), kx, kh / 2, 0));
  parts.push(box(1.1, 2.0, 0.1, wood('dark'), kx - kw / 2 + 0.05, 1.0, 0));
  parts.push(gableRoof(kd, kw, 1.1, 0.6, roof('tile')));
  const keeperRoof = parts[parts.length - 1];
  keeperRoof.rotation.y = Math.PI / 2;
  keeperRoof.position.set(kx, kh, 0);

  const group = new THREE.Group();
  group.name = 'lighthouse';
  group.add(...mergeByMaterial(parts));

  // The lamp: an unmerged, independently animatable emissive mesh at the centre of the
  // glazed room.
  const lamp = cyl(0.35, 0.35, 1.4, 10, glow(0xffe2a6, 1.4), 0, galleryY + 0.25 + roomH / 2, 0);
  lamp.name = 'lamp';
  lamp.castShadow = false;
  group.add(lamp);

  return group;
}
