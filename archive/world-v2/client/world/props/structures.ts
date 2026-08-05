/**
 * Structures.
 * ===========
 *
 * Everything built on the island that is not a roofed building: the torii, the harbour
 * works, the stages, the gates, the bell towers, the railings and the signage.
 *
 * As with `buildings.ts`, every builder returns a base-centred `THREE.Group` and finishes
 * with `mergeByMaterial()`.
 *
 * ### Waterfront props have their own placement rule
 *
 * `pier`, `breakwater`, `boat` and a sea torii are placed at **sea level**, not at terrain
 * height — the island's scene assembly checks for these kinds and drops them at `y = 0`.
 * Their piles and hulls extend well below their origin so they still reach the seabed
 * wherever the water happens to be deep. See `world/island.ts` for the placement side of
 * that contract.
 */

import * as THREE from 'three';
import { box, boolOpt, cyl, mergeByMaterial, mulberry32, numOpt, randRange } from './geometry.js';
import { cappedPost, paperLantern, rope, stoneSteps, tiledRoof } from './kit.js';
import { cloth, glow, metal, plaster, roof as roofMaterial, shoji, stone, vermilion, wood } from '../materials.js';

type Opts = Record<string, unknown> | undefined;

function assemble(name: string, parts: THREE.Mesh[]): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  for (const mesh of mergeByMaterial(parts)) group.add(mesh);
  return group;
}

// ---------------------------------------------------------------------------
// Sacred markers
// ---------------------------------------------------------------------------

/**
 * A torii: the gate marking the approach to a shrine, and — at both harbours — the one
 * standing out in the water.
 *
 * Anatomy, bottom to top: two tapered pillars (*hashira*) on stone footings; the *nuki*,
 * a straight beam passing through both pillars and projecting past them; the *gakuzuka*
 * tablet on the centre-line; and the *kasagi*, the top lintel, which rises toward both
 * ends and carries a second, thinner *shimaki* beam under it.
 *
 * The upward sweep of the kasagi is the whole silhouette. It is built as five short
 * segments at increasing angles rather than as a true arc, because at this poly budget a
 * curve reads as a wobble while a stepped approximation reads as carved timber.
 *
 * Vermilion is correct here — this and one band on the lighthouse are the only places in
 * the entire prop library that use the accent.
 */
export function torii(opts?: Opts): THREE.Group {
  const inWater = boolOpt(opts, 'inWater', false);
  const height = numOpt(opts, 'height', 6.4);
  const span = numOpt(opts, 'span', 5.4);
  const parts: THREE.Mesh[] = [];
  const paint = vermilion();
  const dark = wood('dark');

  const pillarRadius = height * 0.055;
  // Sea torii stand in the water, so their pillars run a long way below the origin to
  // reach the seabed rather than ending at an invisible waterline.
  const submerged = inWater ? 8 : 0;

  for (const sx of [-1, 1] as const) {
    const x = (sx * span) / 2;
    // Pillars lean very slightly inward, which every real torii does and which stops the
    // gate from looking like two parallel posts.
    const pillar = cyl(pillarRadius * 0.88, pillarRadius, height + submerged, 10, paint, x, (height - submerged) / 2, 0);
    pillar.rotation.z = -sx * 0.018;
    parts.push(pillar);
    if (!inWater) parts.push(cyl(pillarRadius * 1.5, pillarRadius * 1.7, 0.42, 10, stone(), x, 0.21, 0));
  }

  // Nuki: a straight beam through the pillars, projecting past them on both sides.
  const nukiY = height * 0.72;
  parts.push(box(span + pillarRadius * 5, height * 0.055, pillarRadius * 1.9, paint, 0, nukiY, 0));
  parts.push(box(pillarRadius * 1.3, height * 0.13, pillarRadius * 2.1, dark, 0, nukiY + height * 0.06, 0));

  // Kasagi + shimaki, rising toward each end.
  const segments = 5;
  const half = span / 2 + pillarRadius * 4.2;
  for (const sx of [-1, 1] as const) {
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const x0 = sx * half * t0;
      const x1 = sx * half * t1;
      // Cubic rise: flat through the middle, kicking up hard at the very ends, which is
      // the actual profile of a kasagi.
      const y0 = height + Math.pow(t0, 3.2) * height * 0.1;
      const y1 = height + Math.pow(t1, 3.2) * height * 0.1;
      const midX = (x0 + x1) / 2;
      const midY = (y0 + y1) / 2;
      const length = Math.hypot(x1 - x0, y1 - y0);
      const angle = Math.atan2(y1 - y0, x1 - x0);

      const kasagi = box(length * 1.08, height * 0.05, pillarRadius * 2.9, paint, midX, midY + height * 0.045, 0);
      kasagi.rotation.z = angle;
      parts.push(kasagi);
      const shimaki = box(length * 1.08, height * 0.038, pillarRadius * 2.4, dark, midX, midY, 0);
      shimaki.rotation.z = angle;
      parts.push(shimaki);
    }
  }

  // A shimenawa rope slung between the pillars on land-based gates.
  if (!inWater) {
    parts.push(
      ...rope(
        new THREE.Vector3(-span / 2 + pillarRadius, nukiY - 0.3, 0),
        new THREE.Vector3(span / 2 - pillarRadius, nukiY - 0.3, 0),
        0.11,
        cloth(0xe4dcc6),
        0.5,
        6,
      ),
    );
  }

  return assemble('torii', parts);
}

/**
 * A plain timber gate, used at the plaza and the ends of the Old Street. Two posts, a
 * crossbeam, a small tiled cap. Deliberately much simpler than a torii — these mark a
 * threshold, not a sacred one.
 */
export function gate(opts?: Opts): THREE.Group {
  const height = numOpt(opts, 'height', 4.2);
  const span = numOpt(opts, 'span', 4.6);
  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');

  for (const sx of [-1, 1] as const) {
    parts.push(box(0.28, height, 0.28, timber, (sx * span) / 2, height / 2, 0));
    parts.push(box(0.52, 0.3, 0.52, stone(), (sx * span) / 2, 0.15, 0));
  }
  parts.push(box(span + 0.9, 0.3, 0.34, timber, 0, height - 0.2, 0));
  parts.push(box(span + 0.5, 0.2, 0.28, timber, 0, height - 0.75, 0));

  // A small tiled cap over the beam, which is what makes it read as built rather than as
  // scaffolding.
  const cap = tiledRoof({
    w: span + 1.1,
    d: 0.6,
    rise: 0.34,
    overhang: 0.28,
    style: 'gable',
    courses: 2,
    ridge: false,
    material: roofMaterial('tile'),
    trimMaterial: timber,
  });
  for (const part of cap) part.position.y += height;
  parts.push(...cap);

  return assemble('gate', parts);
}

/**
 * A bell tower: four splayed legs, a hipped tiled roof and a hanging bronze bell with its
 * striking beam. One at each harbour, one at the summit, one at the shrine.
 */
export function bellTower(opts?: Opts): THREE.Group {
  const height = numOpt(opts, 'height', 4.0);
  const width = numOpt(opts, 'width', 2.6);
  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      // Legs splay outward at the base, which is both structurally right and what stops
      // the tower reading as a table.
      const leg = cyl(0.13, 0.17, height, 8, timber, (sx * width) / 2, height / 2, (sz * width) / 2);
      leg.rotation.z = -sx * 0.05;
      leg.rotation.x = sz * 0.05;
      parts.push(leg);
      parts.push(cyl(0.26, 0.3, 0.24, 8, stone(), (sx * width) / 2, 0.12, (sz * width) / 2));
    }
  }
  for (const sz of [-1, 1] as const) {
    parts.push(box(width + 0.5, 0.2, 0.16, timber, 0, height - 0.25, (sz * width) / 2));
    parts.push(box(width * 0.9, 0.1, 0.1, timber, 0, height * 0.4, (sz * width) / 2));
  }

  const roofParts = tiledRoof({
    w: width + 0.4,
    d: width + 0.4,
    rise: 0.9,
    overhang: 0.7,
    style: 'hipped',
    courses: 3,
    material: roofMaterial('tile'),
    trimMaterial: timber,
  });
  for (const part of roofParts) part.position.y += height;
  parts.push(...roofParts);

  // The bell: a flared bronze body with a crown loop, and the striking beam on ropes.
  const bellY = height - 1.5;
  parts.push(cyl(0.42, 0.52, 1.1, 12, metal('bronze'), 0, bellY, 0));
  parts.push(cyl(0.52, 0.5, 0.12, 12, metal('bronze'), 0, bellY - 0.55, 0));
  parts.push(cyl(0.16, 0.16, 0.3, 8, metal('bronze'), 0, bellY + 0.65, 0));
  parts.push(cyl(0.1, 0.1, 1.9, 8, wood('light'), 0, bellY + 0.1, -width * 0.55, Math.PI / 2, 0, 0));
  for (const offset of [-0.5, 0.5] as const) {
    parts.push(
      ...rope(
        new THREE.Vector3(0, height - 0.4, -width * 0.55 + offset * 0.7),
        new THREE.Vector3(0, bellY + 0.1, -width * 0.55 + offset * 0.7),
        0.03,
        cloth(0xcfc4a8),
        0.02,
        2,
      ),
    );
  }

  return assemble('bell-tower', parts);
}

/**
 * One of the guardian lions flanking a shrine approach. `side: 1` is the open-mouthed *a*
 * form, `side: -1` the closed-mouthed *un*.
 *
 * Built from blocks rather than sculpted: at the distance these are seen, the silhouette —
 * a crouched mass on a tall pedestal with its head turned outward — is the whole read, and
 * a carefully sculpted face would be four hundred triangles nobody ever resolves.
 */
export function komainu(opts?: Opts): THREE.Group {
  const side = numOpt(opts, 'side', 1) >= 0 ? 1 : -1;
  const parts: THREE.Mesh[] = [];
  const rock = stone();

  parts.push(box(1.3, 1.5, 1.0, rock, 0, 0.75, 0));
  parts.push(box(1.5, 0.18, 1.2, rock, 0, 1.58, 0));
  parts.push(box(1.5, 0.2, 1.2, rock, 0, 0.1, 0));

  const baseY = 1.67;
  parts.push(box(0.66, 0.72, 1.0, rock, 0, baseY + 0.36, 0.05));
  parts.push(box(0.78, 0.5, 0.5, rock, 0, baseY + 0.25, 0.42));
  for (const sx of [-1, 1] as const) {
    parts.push(box(0.18, 0.72, 0.2, rock, sx * 0.22, baseY + 0.36, -0.36));
    parts.push(box(0.24, 0.16, 0.34, rock, sx * 0.22, baseY + 0.08, -0.44));
    parts.push(box(0.14, 0.2, 0.12, rock, sx * 0.22, baseY + 1.2, -0.24));
  }

  const head = box(0.56, 0.5, 0.56, rock, 0, baseY + 0.95, -0.28);
  head.rotation.y = side * 0.42;
  parts.push(head);
  const muzzle = box(0.3, 0.26, 0.3, rock, side * 0.11, baseY + 0.88, -0.52);
  muzzle.rotation.y = side * 0.42;
  parts.push(muzzle);

  // A mane of blocks round the head, and a tail of stacked curls.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(box(0.2, 0.2, 0.2, rock, Math.cos(a) * 0.3, baseY + 0.95 + Math.sin(a) * 0.3, -0.02));
  }
  for (let i = 0; i < 3; i++) {
    parts.push(box(0.22 - i * 0.03, 0.22, 0.22, rock, 0, baseY + 0.75 + i * 0.22, 0.52 + i * 0.06));
  }

  return assemble('komainu', parts);
}

// ---------------------------------------------------------------------------
// Harbour works
// ---------------------------------------------------------------------------

/**
 * A pier: a plank deck on piles, running out into the water along +z.
 *
 * Planks are individual boxes with visible gaps. That is a lot of primitives for a walking
 * surface, but the line of the planks is what gives the harbour its scale, and they all
 * merge into one draw call. The piles run 11 m so the pier reaches the seabed whatever the
 * bathymetry does under it.
 */
export function pier(opts?: Opts): THREE.Group {
  const length = numOpt(opts, 'length', 36);
  const width = numOpt(opts, 'width', 7);
  const lamps = boolOpt(opts, 'lamps', false);
  const deckHeight = numOpt(opts, 'deckHeight', 1.9);
  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');
  const board = wood('weathered');

  const planks = Math.max(4, Math.round(length / 0.75));
  for (let i = 0; i < planks; i++) {
    const z = (i + 0.5) * (length / planks);
    parts.push(box(width, 0.14, (length / planks) * 0.88, board, 0, deckHeight, z));
  }
  for (const sx of [-1, 0, 1] as const) {
    parts.push(box(0.24, 0.3, length, timber, sx * (width / 2 - 0.3), deckHeight - 0.22, length / 2));
  }

  // Piles, in pairs with a cross-brace, every ~4 m.
  const bays = Math.max(2, Math.round(length / 4));
  for (let i = 0; i <= bays; i++) {
    const z = (i * length) / bays;
    for (const sx of [-1, 1] as const) {
      parts.push(cyl(0.2, 0.24, 11, 8, timber, sx * (width / 2 - 0.35), deckHeight - 5.6, z, 0, 0, 0, true));
    }
    parts.push(box(width, 0.22, 0.22, timber, 0, deckHeight - 0.5, z));
  }

  // Mooring bollards along both edges.
  const bollards = Math.max(2, Math.round(length / 7));
  for (let i = 1; i <= bollards; i++) {
    const z = (i * length) / (bollards + 1);
    for (const sx of [-1, 1] as const) {
      parts.push(cyl(0.16, 0.18, 0.85, 8, timber, sx * (width / 2 - 0.25), deckHeight + 0.42, z));
      parts.push(cyl(0.22, 0.22, 0.14, 8, timber, sx * (width / 2 - 0.25), deckHeight + 0.85, z));
    }
  }

  // Post lamps at the seaward end of the main pier.
  if (lamps) {
    for (const sx of [-1, 1] as const) {
      const x = sx * (width / 2 - 0.6);
      for (const mesh of cappedPost(2.6, 0.14, timber)) {
        mesh.position.set(mesh.position.x + x, mesh.position.y + deckHeight + 0.07, mesh.position.z + length - 1.4);
        parts.push(mesh);
      }
      for (const mesh of paperLantern(0.24, 0.55, shoji(), timber)) {
        mesh.position.set(mesh.position.x + x, mesh.position.y + deckHeight + 1.82, mesh.position.z + length - 1.4);
        parts.push(mesh);
      }
    }
  }

  return assemble('pier', parts);
}

/**
 * A breakwater: a rubble mound with a capping walkway, sheltering the harbour mouth.
 * `beacon: true` puts a small green light on the seaward end.
 *
 * The stones are individually placed blocks at varied angles rather than one long prism —
 * a breakwater is riprap, and a smooth one reads as a concrete wall.
 */
export function breakwater(opts?: Opts): THREE.Group {
  const length = numOpt(opts, 'length', 50);
  const beacon = boolOpt(opts, 'beacon', false);
  const parts: THREE.Mesh[] = [];
  const rng = mulberry32(Math.round(length * 31));
  const rock = stone('dark');

  const blocks = Math.max(8, Math.round(length / 2.2));
  for (let i = 0; i < blocks; i++) {
    const z = -length / 2 + (i + 0.5) * (length / blocks);
    // The mound tapers toward the seaward end.
    const scale = 1 - (i / blocks) * 0.25;
    for (const sx of [-1, 0, 1] as const) {
      const size = randRange(rng, 1.5, 2.6) * scale;
      const block = box(
        size,
        size * 1.5,
        size,
        rock,
        sx * randRange(rng, 1.4, 2.2),
        randRange(rng, -0.9, 0.3),
        z + randRange(rng, -0.5, 0.5),
      );
      block.rotation.set(randRange(rng, -0.2, 0.2), randRange(rng, 0, Math.PI), randRange(rng, -0.2, 0.2));
      parts.push(block);
    }
  }
  parts.push(box(3.0, 0.4, length, stone(), 0, 1.5, 0));
  parts.push(box(3.6, 0.3, length, stone(), 0, 1.2, 0));

  if (beacon) {
    const z = length / 2 - 1.5;
    parts.push(cyl(0.7, 0.9, 3.2, 10, plaster(), 0, 3.3, z));
    parts.push(cyl(0.85, 0.85, 0.2, 10, metal(), 0, 5.0, z));
    parts.push(cyl(0.5, 0.5, 1.0, 8, glow(0x9fe8c0), 0, 5.6, z));
    parts.push(cyl(0.06, 0.6, 0.7, 8, metal(), 0, 6.4, z));
  }

  return assemble('breakwater', parts);
}

/**
 * A sea wall: a low stone parapet along the quay edge, with the coping laid as individual
 * blocks so the joints read.
 */
export function seaWall(opts?: Opts): THREE.Group {
  const length = numOpt(opts, 'length', 30);
  const height = numOpt(opts, 'height', 1.1);
  const parts: THREE.Mesh[] = [];
  const rng = mulberry32(Math.round(length * 17 + height * 5));

  parts.push(box(0.8, height, length, stone('dark'), 0, height / 2, 0));
  const copes = Math.max(4, Math.round(length / 1.4));
  for (let i = 0; i < copes; i++) {
    const z = -length / 2 + (i + 0.5) * (length / copes);
    const cope = box(1.05, 0.24 + rng() * 0.05, (length / copes) * 0.92, stone(), 0, height + 0.12, z);
    cope.rotation.y = randRange(rng, -0.014, 0.014);
    parts.push(cope);
  }
  parts.push(box(1.2, 0.3, length, stone('dark'), 0, 0.15, 0));

  return assemble('sea-wall', parts);
}

/**
 * A boat. `style: 'ferry'` builds the larger, cabined vessel that ties up at the south
 * harbour's main pier; everything else is an open working boat.
 *
 * The hull is a stack of four tapered courses rather than a lofted shape: the taper toward
 * bow and stern is what makes a boat a boat, and four steps give the contour pass four
 * clean lines to draw along the sheer.
 */
export function boat(opts?: Opts): THREE.Group {
  const isFerry = String(opts?.style ?? '') === 'ferry';
  const scale = numOpt(opts, 'scale', 1);
  const parts: THREE.Mesh[] = [];
  const hull = wood('dark');
  const board = wood('weathered');

  const length = (isFerry ? 11 : 7) * scale;
  const beam = (isFerry ? 3.4 : 2.2) * scale;

  const courses = 4;
  for (let i = 0; i < courses; i++) {
    const t = i / (courses - 1);
    parts.push(
      box(
        beam * (0.62 + t * 0.38),
        0.34 * scale,
        length * (0.72 + t * 0.28),
        i === courses - 1 ? board : hull,
        0,
        -0.5 * scale + i * 0.33 * scale,
        0,
      ),
    );
  }
  parts.push(box(beam * 0.3, 1.1 * scale, 1.2 * scale, hull, 0, 0.4 * scale, -length * 0.48));
  parts.push(box(beam * 0.4, 0.8 * scale, 1.0 * scale, hull, 0, 0.3 * scale, length * 0.46));
  for (const sx of [-1, 1] as const) {
    parts.push(box(0.14 * scale, 0.16 * scale, length * 0.96, board, sx * beam * 0.49, 0.52 * scale, 0));
  }
  for (let i = 0; i < 3; i++) {
    parts.push(box(beam * 0.9, 0.1 * scale, 0.4 * scale, board, 0, 0.36 * scale, -length * 0.2 + i * length * 0.2));
  }

  if (isFerry) {
    const cabinW = beam * 0.72;
    const cabinH = 1.9 * scale;
    parts.push(box(cabinW, cabinH, length * 0.34, plaster(), 0, 0.52 * scale + cabinH / 2, length * 0.06));
    for (const sx of [-1, 1] as const) {
      for (let i = 0; i < 3; i++) {
        parts.push(
          box(0.06, 0.5 * scale, 0.7 * scale, shoji(), (sx * cabinW) / 2, 0.52 * scale + cabinH * 0.62, length * 0.06 - 0.9 + i * 0.9),
        );
      }
    }
    const roofParts = tiledRoof({
      w: cabinW + 0.4,
      d: length * 0.38,
      rise: 0.34 * scale,
      overhang: 0.3,
      style: 'gable',
      courses: 2,
      ridge: false,
      material: roofMaterial('board'),
      trimMaterial: hull,
    });
    for (const part of roofParts) {
      part.position.y += 0.52 * scale + cabinH;
      part.position.z += length * 0.06;
    }
    parts.push(...roofParts);
    parts.push(cyl(0.09 * scale, 0.11 * scale, 6 * scale, 8, hull, 0, 3.2 * scale, -length * 0.24));
    parts.push(cyl(0.2 * scale, 0.2 * scale, 3.2 * scale, 8, cloth(0xe8e2d4), 0, 4.6 * scale, -length * 0.24, 0, 0, Math.PI / 2));
  } else {
    parts.push(cyl(0.07 * scale, 0.09 * scale, 4.2 * scale, 6, hull, 0, 2.2 * scale, -length * 0.12));
    parts.push(box(0.05, 0.5 * scale, 0.9 * scale, cloth(0xc4503a), 0, 3.9 * scale, -length * 0.12 + 0.5 * scale));
    parts.push(box(beam * 0.6, 0.4 * scale, 1.2 * scale, cloth(0x8a8a72), 0, 0.6 * scale, length * 0.26));
  }

  return assemble('boat', parts);
}

/**
 * A net-drying rack: two A-frames with a top rail and nets hung over it. Only at the north
 * harbour, where it is most of what makes the place read as a working fishery.
 */
export function netRack(opts?: Opts): THREE.Group {
  const width = numOpt(opts, 'width', 5);
  const height = numOpt(opts, 'height', 2.8);
  const parts: THREE.Mesh[] = [];
  const timber = wood('weathered');

  for (const sz of [-1, 1] as const) {
    for (const sx of [-1, 1] as const) {
      const leg = cyl(0.08, 0.1, height, 6, timber, sx * 0.6, height / 2, (sz * width) / 2);
      leg.rotation.z = -sx * 0.22;
      parts.push(leg);
    }
    parts.push(box(1.5, 0.08, 0.08, timber, 0, height * 0.55, (sz * width) / 2));
  }
  parts.push(cyl(0.07, 0.07, width + 0.6, 6, timber, 0, height, 0, Math.PI / 2));

  const net = cloth(0x8f9280);
  for (let i = 0; i < 3; i++) {
    const panel = box(1.9, height * 0.72, 0.03, net, 0, height * 0.6, -width * 0.3 + i * width * 0.3);
    panel.rotation.x = Math.PI / 2;
    panel.rotation.z = 0.1 - i * 0.1;
    parts.push(panel);
  }
  for (let i = 0; i < 4; i++) {
    parts.push(cyl(0.22, 0.22, 0.3, 8, cloth(0xc4a25e), -1.4 + i * 0.8, 0.15, width * 0.4));
  }

  return assemble('net-rack', parts);
}

// ---------------------------------------------------------------------------
// Civic
// ---------------------------------------------------------------------------

/**
 * A performance stage. `roof: true` adds the covered yagura form used at the plaza;
 * `tiers: true` adds a step down at the front, which gives a crowd somewhere to sit and a
 * host somewhere to stand above them.
 *
 * The plaza stage is the single most-looked-at object on the island — it is where every
 * activity happens — so it carries a full deck of planks, a boarded skirt, corner posts, a
 * tiled roof and a row of lanterns under the front eave.
 */
export function stage(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', 16);
  const d = numOpt(opts, 'd', 11);
  const covered = boolOpt(opts, 'roof', false);
  const tiers = boolOpt(opts, 'tiers', false);
  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');
  const board = wood('light');

  const deckHeight = 0.85;
  parts.push(box(w, deckHeight, d, timber, 0, deckHeight / 2, 0));
  // Boarded apron, so the deck reads as a built platform rather than a slab floating
  // above the ground.
  const skirtBoards = Math.max(6, Math.round(w / 0.7));
  for (let i = 0; i < skirtBoards; i++) {
    const x = -w / 2 + (i + 0.5) * (w / skirtBoards);
    parts.push(box((w / skirtBoards) * 0.86, deckHeight * 0.9, 0.1, board, x, deckHeight / 2, -d / 2 - 0.03));
  }

  const planks = Math.max(6, Math.round(d / 0.6));
  for (let i = 0; i < planks; i++) {
    const z = -d / 2 + (i + 0.5) * (d / planks);
    parts.push(box(w, 0.1, (d / planks) * 0.9, board, 0, deckHeight + 0.05, z));
  }
  for (const sz of [-1, 1] as const) {
    parts.push(box(w + 0.2, 0.14, 0.16, timber, 0, deckHeight + 0.02, sz * (d / 2 + 0.08)));
  }

  if (tiers) {
    const stepDepth = 2.2;
    parts.push(box(w * 0.7, deckHeight * 0.5, stepDepth, timber, 0, deckHeight * 0.25, -d / 2 - stepDepth / 2));
    parts.push(box(w * 0.7, 0.09, stepDepth, board, 0, deckHeight * 0.5 + 0.05, -d / 2 - stepDepth / 2));
  }

  if (covered) {
    const postHeight = 3.9;
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        parts.push(cyl(0.17, 0.19, postHeight, 8, timber, sx * (w / 2 - 0.7), deckHeight + postHeight / 2, sz * (d / 2 - 0.7)));
      }
    }
    for (const sz of [-1, 1] as const) {
      parts.push(box(w - 0.8, 0.24, 0.2, timber, 0, deckHeight + postHeight - 0.2, sz * (d / 2 - 0.7)));
      parts.push(box(w - 1.0, 0.3, 0.08, board, 0, deckHeight + postHeight - 0.55, sz * (d / 2 - 0.75)));
    }

    const roofParts = tiledRoof({
      w: w - 0.4,
      d: d - 0.4,
      rise: 1.8,
      overhang: 1.2,
      style: 'hipped',
      courses: 5,
      material: roofMaterial('tile'),
      trimMaterial: timber,
    });
    for (const part of roofParts) part.position.y += deckHeight + postHeight;
    parts.push(...roofParts);

    // A row of lanterns under the front eave — the detail that makes the stage read as
    // "something happens here" even when nothing is.
    const lanterns = 5;
    for (let i = 0; i < lanterns; i++) {
      const x = -w * 0.34 + (i * w * 0.68) / (lanterns - 1);
      for (const mesh of paperLantern(0.26, 0.62, shoji(), timber)) {
        mesh.position.set(mesh.position.x + x, mesh.position.y + deckHeight + postHeight - 1.0, mesh.position.z - d / 2 + 0.2);
        parts.push(mesh);
      }
    }
  }

  // Steps up at the back, out of the audience's way.
  for (const mesh of stoneSteps(2.4, deckHeight, stone())) {
    mesh.rotation.y = Math.PI;
    mesh.position.z = d / 2 + 0.5 - mesh.position.z;
    parts.push(mesh);
  }

  return assemble('stage', parts);
}

/**
 * The notice board: a roofed panel on two posts with paper slips pinned to it. The one
 * piece of world geometry that is also a piece of interface — walking up to it is how
 * announcements are read.
 */
export function noticeBoard(opts?: Opts): THREE.Group {
  const width = numOpt(opts, 'width', 3.2);
  const height = numOpt(opts, 'height', 2.4);
  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');
  const rng = mulberry32(0x51ce);

  for (const sx of [-1, 1] as const) {
    parts.push(box(0.2, height, 0.2, timber, (sx * width) / 2, height / 2, 0));
    parts.push(box(0.4, 0.24, 0.4, stone(), (sx * width) / 2, 0.12, 0));
  }
  parts.push(box(width, height * 0.62, 0.1, wood('light'), 0, height * 0.58, 0));
  for (const sy of [1, -1] as const) {
    parts.push(box(width + 0.16, 0.12, 0.16, timber, 0, height * 0.58 + sy * height * 0.31, 0));
  }

  // Pinned slips, at slight angles.
  for (let i = 0; i < 6; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const slip = box(width * 0.24, height * 0.2, 0.02, shoji(), -width * 0.3 + col * width * 0.3, height * 0.68 - row * height * 0.24, -0.07);
    slip.rotation.z = randRange(rng, -0.06, 0.06);
    parts.push(slip);
  }

  const roofParts = tiledRoof({
    w: width + 0.5,
    d: 0.9,
    rise: 0.45,
    overhang: 0.35,
    style: 'gable',
    courses: 2,
    ridge: false,
    material: roofMaterial('board'),
    trimMaterial: timber,
  });
  for (const part of roofParts) part.position.y += height;
  parts.push(...roofParts);

  return assemble('notice-board', parts);
}

/** A stone well head with a timber windlass, a bucket and a small board roof. */
export function well(_opts?: Opts): THREE.Group {
  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');

  parts.push(cyl(1.15, 1.25, 1.0, 12, stone(), 0, 0.5, 0));
  parts.push(cyl(1.25, 1.25, 0.16, 12, stone('dark'), 0, 1.0, 0));
  parts.push(cyl(0.95, 0.95, 0.9, 12, stone('dark'), 0, 0.5, 0));
  for (const sx of [-1, 1] as const) {
    parts.push(box(0.14, 2.2, 0.14, timber, sx * 1.0, 1.9, 0));
  }
  parts.push(cyl(0.12, 0.12, 2.2, 8, timber, 0, 2.9, 0, 0, 0, Math.PI / 2));
  parts.push(box(0.1, 0.5, 0.1, timber, 1.15, 2.7, 0));
  parts.push(...rope(new THREE.Vector3(0, 2.8, 0), new THREE.Vector3(0, 1.5, 0), 0.03, cloth(0xcfc4a8), 0, 2));
  parts.push(cyl(0.28, 0.24, 0.4, 8, timber, 0, 1.3, 0));

  const roofParts = tiledRoof({
    w: 2.6,
    d: 1.4,
    rise: 0.5,
    overhang: 0.4,
    style: 'gable',
    courses: 2,
    ridge: false,
    material: roofMaterial('board'),
    trimMaterial: timber,
  });
  for (const part of roofParts) part.position.y += 3.0;
  parts.push(...roofParts);

  return assemble('well', parts);
}

/**
 * A banner post: a tall pole with a vertical cloth *nobori* hung from a cross-arm. Used to
 * mark a venue that has no building on it.
 */
export function banner(opts?: Opts): THREE.Group {
  const height = numOpt(opts, 'height', 5.2);
  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');

  parts.push(cyl(0.09, 0.12, height, 8, timber, 0, height / 2, 0));
  parts.push(cyl(0.28, 0.32, 0.3, 8, stone(), 0, 0.15, 0));
  parts.push(cyl(0.06, 0.06, 1.1, 6, timber, 0.5, height - 0.25, 0, 0, 0, Math.PI / 2));

  const flag = box(0.03, height * 0.62, 0.9, cloth(0xe8e2d4), 0.12, height * 0.6, 0.44);
  flag.rotation.y = Math.PI / 2;
  parts.push(flag);
  // A vermilion band at the head of the banner: the one accent.
  const band = box(0.035, height * 0.08, 0.9, cloth(0xc4503a), 0.12, height * 0.86, 0.44);
  band.rotation.y = Math.PI / 2;
  parts.push(band);

  return assemble('banner', parts);
}

/** A flight of stone steps cut into a terrace edge, with cheek walls either side. */
export function steps(opts?: Opts): THREE.Group {
  const width = numOpt(opts, 'width', 6);
  const rise = numOpt(opts, 'rise', 2.4);
  const count = Math.max(2, Math.round(rise / 0.35));
  const parts: THREE.Mesh[] = [...stoneSteps(width, rise, stone(), count)];
  // Without the cheeks a flight of steps looks like a stack of slabs dropped on a hill.
  for (const sx of [-1, 1] as const) {
    parts.push(box(0.5, rise + 0.5, count * 0.44 + 0.4, stone('dark'), (sx * (width + 0.5)) / 2, rise * 0.5, (count * 0.44) / 2));
  }
  return assemble('steps', parts);
}

/**
 * A timber railing along a cliff edge or terrace. Posts, two rails, and a slight sag in
 * each span so it reads as timber rather than as extruded aluminium.
 */
export function rail(opts?: Opts): THREE.Group {
  const length = numOpt(opts, 'length', 20);
  const height = numOpt(opts, 'height', 1.1);
  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');

  const posts = Math.max(2, Math.round(length / 2.4));
  for (let i = 0; i <= posts; i++) {
    const z = -length / 2 + (i * length) / posts;
    parts.push(box(0.16, height, 0.16, timber, 0, height / 2, z));
    parts.push(box(0.28, 0.16, 0.28, stone(), 0, 0.08, z));
  }
  for (let i = 0; i < posts; i++) {
    const z0 = -length / 2 + (i * length) / posts;
    const z1 = -length / 2 + ((i + 1) * length) / posts;
    for (const [y, sag] of [
      [height, 0.03],
      [height * 0.55, 0.02],
    ] as const) {
      parts.push(box(0.12, 0.1, (z1 - z0) * 1.02, timber, 0, y - sag, (z0 + z1) / 2));
    }
  }
  return assemble('rail', parts);
}

/**
 * The summit marker: a standing stone with a carved band. Deliberately plain — it is the
 * last thing you reach and it should feel like an arrival, not a monument.
 */
export function summitMarker(_opts?: Opts): THREE.Group {
  const parts: THREE.Mesh[] = [];
  const rock = stone();

  parts.push(box(1.5, 0.3, 1.5, stone('dark'), 0, 0.15, 0));
  parts.push(box(1.1, 0.24, 1.1, rock, 0, 0.42, 0));
  for (const [mesh] of [[box(0.62, 2.4, 0.5, rock, 0, 1.74, 0)], [box(0.72, 0.22, 0.6, stone('dark'), 0, 2.99, 0)], [box(0.66, 0.5, 0.54, stone('dark'), 0, 2.1, 0)]]) {
    mesh.rotation.y = 0.12;
    parts.push(mesh);
  }

  return assemble('summit-marker', parts);
}
