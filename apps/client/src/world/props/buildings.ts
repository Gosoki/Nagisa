/**
 * Buildings.
 * ==========
 *
 * Every inhabited structure on Nagisa. Each builder assembles components from `kit.ts`,
 * collects them into a flat list of meshes, and hands the whole pile to
 * `mergeByMaterial()` — so a machiya built from ninety primitives across five materials
 * arrives as five draw calls.
 *
 * ### What "high fidelity" means here, and what it does not
 *
 * There are no textures and no imported models. Everything is geometry, generated at load
 * time, because that is what keeps the island at zero asset bytes and lets the whole world
 * be edited by changing numbers. Detail therefore has to be spent where it *reads*:
 *
 * - **Roofs get the most.** They are the dominant mass of every Japanese building and the
 *   first thing the eye resolves. Stepped tile courses, a proper ridge cap, barge boards,
 *   deep eaves, exposed rafter tails.
 * - **The frame is visible.** Posts, sills and head beams stand proud of the infill, so a
 *   wall is a lattice of lines rather than a blank rectangle. The contour pass turns each
 *   of those into a drawn edge for free.
 * - **Ground contact is explicit.** Stone plinths, steps, a fascia at the veranda edge.
 *   Buildings that meet the terrain at a single hard line always look pasted on.
 * - **Interiors are not modelled.** Nobody goes inside. What matters is that a doorway
 *   reads as a doorway from ten metres, and that costs one recessed panel.
 *
 * ### Shared vocabulary
 *
 * - **Deep eaves.** Every roof here overhangs its walls by 0.6–1.5 m. Not decoration:
 *   traditional roofs shed rain clear of the plaster and shade the veranda, and visually
 *   it is the detail that reads "Japanese roof" rather than "shed with a triangle on it".
 * - **Raised floor.** Dwellings sit on a plinth, the shrine hall on posts. It keeps timber
 *   off damp ground and, for the shrine, marks a threshold.
 * - **Vermilion is rare.** Only `shrineHall` and `temizuya` and one band on the lighthouse
 *   touch it, exactly as the palette in `tokens.ts` intends.
 *
 * ### Reading a builder
 *
 * They all have the same shape: pull options with defaults, choose materials, build the
 * plinth, build the walls, build the roof, add the identifying details, merge. Where a
 * builder deviates from that order there is a comment saying why.
 */

import * as THREE from 'three';
import { BUILDING_FOOTPRINTS } from '@nagisa/shared';
import { box, boolOpt, cyl, mergeByMaterial, mulberry32, numOpt, randRange } from './geometry.js';
import { framedWalls, lattice, noren, paperLantern, plinth, stoneSteps, tiledRoof, veranda } from './kit.js';
import { cloth, glow, metal, plaster, roof as roofMaterial, shoji, stone, vermilion, whitewash, wood } from '../materials.js';

/** Options bag every builder accepts. Keys are read defensively — see `numOpt`. */
type Opts = Record<string, unknown> | undefined;

/** Wrap merged parts into a named group. */
function assemble(name: string, parts: THREE.Mesh[]): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  for (const mesh of mergeByMaterial(parts)) group.add(mesh);
  return group;
}

/**
 * A deterministic seed derived from a building's dimensions.
 *
 * Buildings need small random variations (which cloth an awning uses, where a crate sits)
 * that must be *stable*: the same building has to look the same on every reload and on
 * every machine, or the island shimmers when two players compare notes. Seeding from the
 * dimensions rather than from a counter means the seed does not depend on build order.
 */
function seedFrom(...numbers: number[]): number {
  let h = 0x811c9dc5;
  for (const n of numbers) h = Math.imul(h ^ Math.round(n * 97), 0x01000193);
  return h >>> 0;
}

/** Offset a batch of parts in place and return it, for stacking components. */
function lift(parts: THREE.Mesh[], dy: number, dz = 0, dx = 0): THREE.Mesh[] {
  for (const part of parts) {
    part.position.y += dy;
    part.position.z += dz;
    part.position.x += dx;
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Townhouses and dwellings
// ---------------------------------------------------------------------------

/**
 * A machiya — the deep, narrow townhouse that forms the Old Street.
 *
 * Characteristic features, all of them modelled: a narrow street frontage with a much
 * greater depth, a slatted `kōshi` grille across the ground floor, a plastered band at the
 * floor line, an upper storey of paper screens, a deep tiled roof with exposed rafter
 * tails, and — where `sign` is set — a noren curtain, a hanging lantern and a signboard.
 *
 * The building faces −z; the caller rotates it to face the street.
 */
export function machiya(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', BUILDING_FOOTPRINTS['machiya']![0]);
  const d = numOpt(opts, 'd', BUILDING_FOOTPRINTS['machiya']![1]);
  const floors = Math.max(1, Math.round(numOpt(opts, 'floors', 2)));
  const hasSign = boolOpt(opts, 'sign', false);
  const rng = mulberry32(seedFrom(w, d, floors));

  const parts: THREE.Mesh[] = [];
  const timber = wood('dark');
  const beams = wood('beam');
  const walls = plaster();

  const plinthHeight = 0.42;
  parts.push(...plinth(w, d, plinthHeight, stone()));

  const groundHeight = 2.7;
  const upperHeight = 2.35;
  const totalWall = plinthHeight + groundHeight + (floors > 1 ? upperHeight : 0);

  parts.push(
    ...lift(
      framedWalls({ w, h: groundHeight, d, panel: walls, frame: timber, bay: 1.9, timber: 0.19 }),
      plinthHeight,
    ),
  );

  // The kōshi grille across the street face. Set proud of the wall so it casts its own
  // shadow — the depth is what makes it read as a grille and not as painted stripes.
  parts.push(...lift(lattice(w * 0.74, groundHeight * 0.62, timber, 0.15), plinthHeight + groundHeight * 0.2, -d / 2 - 0.11));

  // Doorway: a recessed dark panel with a raised stone threshold.
  const doorWidth = Math.min(2.0, w * 0.3);
  parts.push(box(doorWidth, groundHeight * 0.76, 0.14, wood('weathered'), -w * 0.24, plinthHeight + groundHeight * 0.38, -d / 2 - 0.02));
  parts.push(box(doorWidth + 0.3, 0.16, 0.36, stone(), -w * 0.24, plinthHeight + 0.08, -d / 2 - 0.16));

  if (floors > 1) {
    parts.push(
      ...lift(
        framedWalls({
          w: w - 0.1,
          h: upperHeight,
          d: d - 0.1,
          panel: walls,
          frame: timber,
          bay: 2.2,
          timber: 0.16,
          screens: 'front',
          screenMaterial: shoji(),
          screenBand: [0.22, 0.74],
        }),
        plinthHeight + groundHeight,
      ),
    );

    // The plastered band at floor level between the two storeys — the visual join a
    // machiya always has.
    parts.push(box(w + 0.24, 0.34, d + 0.24, walls, 0, plinthHeight + groundHeight + 0.1, 0));
    // A narrow balcony rail on the street side.
    parts.push(box(w * 0.8, 0.08, 0.08, timber, 0, plinthHeight + groundHeight + 0.95, -d / 2 - 0.16));
    parts.push(box(w * 0.8, 0.08, 0.08, timber, 0, plinthHeight + groundHeight + 0.5, -d / 2 - 0.16));
  }

  const roofRise = 1.5 + w * 0.09;
  parts.push(
    ...lift(
      tiledRoof({ w, d, rise: roofRise, overhang: 0.85, style: 'gable', courses: 6, material: roofMaterial('tile'), trimMaterial: beams }),
      totalWall,
    ),
  );

  // Exposed rafter tails under the eave — the row of blocks that tells you the roof is
  // carried by timber rather than floating.
  const rafters = Math.max(3, Math.round(d / 0.9));
  for (let i = 0; i < rafters; i++) {
    const z = -d / 2 + (i + 0.5) * (d / rafters);
    for (const sx of [-1, 1] as const) {
      parts.push(box(0.7, 0.12, 0.12, beams, sx * (w / 2 + 0.5), totalWall - 0.1, z));
    }
  }

  if (hasSign) {
    parts.push(
      ...lift(
        noren(w * 0.42, 1.0, cloth(rng() > 0.5 ? 0x3f5a6b : 0x8a4a3c), seedFrom(w, d)),
        plinthHeight + groundHeight * 0.62,
        -d / 2 - 0.2,
        w * 0.18,
      ),
    );
    parts.push(...lift(paperLantern(0.24, 0.6, shoji(), timber), plinthHeight + groundHeight * 0.52, -d / 2 - 0.3, -w * 0.4));
    parts.push(box(0.06, 0.5, 0.06, timber, -w * 0.4, plinthHeight + groundHeight * 0.92, -d / 2 - 0.3));
    parts.push(box(0.5, 1.5, 0.09, wood('weathered'), w * 0.36, plinthHeight + groundHeight * 0.55, -d / 2 - 0.09));
  }

  return assemble('machiya', parts);
}

/**
 * A minka — the rural farmhouse. Lower, wider and squarer than a machiya, with a steep
 * thatched roof and a hipped profile.
 *
 * The steep pitch is the whole character of the building: thatch has to shed water fast,
 * so a minka roof is often taller than the walls beneath it. Getting that proportion right
 * matters more than any amount of surface detail.
 */
export function minka(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', BUILDING_FOOTPRINTS['minka']![0]);
  const d = numOpt(opts, 'd', BUILDING_FOOTPRINTS['minka']![1]);
  const parts: THREE.Mesh[] = [];

  const timber = wood('dark');
  const plinthHeight = 0.35;
  parts.push(...plinth(w, d, plinthHeight, stone()));

  const wallHeight = 2.5;
  parts.push(
    ...lift(
      framedWalls({
        w,
        h: wallHeight,
        d,
        panel: plaster(),
        frame: timber,
        bay: 2.1,
        timber: 0.22,
        screens: 'front',
        screenMaterial: shoji(),
        screenBand: [0.2, 0.78],
      }),
      plinthHeight,
    ),
  );

  // Thatch: steep, deep-eaved, hipped. Fewer courses than a tiled roof because thatch has
  // none — the stepping here is only enough to keep the mass from reading as a flat plane.
  const roofRise = wallHeight * 1.5;
  parts.push(
    ...lift(
      tiledRoof({
        w,
        d,
        rise: roofRise,
        overhang: 1.25,
        style: 'hipped',
        courses: 4,
        material: roofMaterial('thatch'),
        trimMaterial: wood('beam'),
      }),
      plinthHeight + wallHeight,
    ),
  );

  // The ridge is capped and pinned with crossed poles — the detail that says "thatch"
  // rather than "brown roof".
  const ridgeY = plinthHeight + wallHeight + roofRise;
  parts.push(box(1.1, 0.3, Math.max(0.6, d - w) + 2, roofMaterial('board'), 0, ridgeY + 0.34, 0));
  for (let i = 0; i < 3; i++) {
    const z = -1 + i;
    for (const tilt of [0.42, -0.42]) {
      const pole = box(0.09, 1.5, 0.09, timber, 0, ridgeY + 0.5, z);
      pole.rotation.z = tilt;
      parts.push(pole);
    }
  }

  parts.push(...lift(veranda(w * 0.86, 1.5, plinthHeight + 0.3, wood('light'), timber), 0, -d / 2 - 0.6));
  parts.push(...lift(stoneSteps(2.0, plinthHeight + 0.3, stone()), 0, -d / 2 - 1.35 - 3 * 0.44));

  return assemble('minka', parts);
}

/**
 * A kura storehouse — the thick-walled, white-plastered warehouse found at both harbours
 * and behind the merchant houses.
 *
 * Its defining features are the near-windowless plaster mass, the black timber base course
 * protecting the render from splash, and a heavy hipped roof with an exaggerated overhang.
 * `floors: 2` makes the taller dockside variant.
 *
 * This is the one dwelling-scale building that does *not* use `framedWalls`: a kura's
 * walls are rammed earth rendered smooth, and showing a timber frame on one would be
 * architecturally wrong.
 */
export function warehouse(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', BUILDING_FOOTPRINTS['warehouse']![0]);
  const d = numOpt(opts, 'd', BUILDING_FOOTPRINTS['warehouse']![1]);
  const floors = Math.max(1, Math.round(numOpt(opts, 'floors', 1)));
  const parts: THREE.Mesh[] = [];

  const height = floors > 1 ? 6.2 : 4.2;
  const plinthHeight = 0.5;
  parts.push(...plinth(w, d, plinthHeight, stone('dark')));

  parts.push(box(w, height, d, plaster(), 0, plinthHeight + height / 2, 0));
  parts.push(box(w + 0.14, 1.1, d + 0.14, wood('dark'), 0, plinthHeight + 0.55, 0));
  if (floors > 1) {
    parts.push(box(w + 0.2, 0.22, d + 0.2, wood('dark'), 0, plinthHeight + height * 0.52, 0));
  }

  // A single heavy door and one small barred window per side of it.
  parts.push(box(2.2, 2.6, 0.2, wood('dark'), 0, plinthHeight + 1.3, -d / 2 - 0.06));
  parts.push(box(2.5, 0.2, 0.34, stone(), 0, plinthHeight + 2.66, -d / 2 - 0.12));
  for (const sx of [-1, 1] as const) {
    parts.push(box(0.9, 0.9, 0.16, wood('dark'), sx * w * 0.3, plinthHeight + height * 0.72, -d / 2 - 0.04));
    for (let i = 0; i < 3; i++) {
      parts.push(box(0.06, 0.9, 0.1, metal(), sx * w * 0.3 + (i - 1) * 0.25, plinthHeight + height * 0.72, -d / 2 - 0.12));
    }
  }

  parts.push(
    ...lift(
      tiledRoof({ w, d, rise: 1.7, overhang: 1.15, style: 'hipped', courses: 5, material: roofMaterial('tile'), trimMaterial: wood('dark') }),
      plinthHeight + height,
    ),
  );

  return assemble('warehouse', parts);
}

/**
 * The teahouse on the eastern terrace. Small, open, and the only building on the island
 * with a copper roof.
 *
 * Deliberately the least enclosed structure here: all four sides are paper screens
 * standing open and the veranda wraps the whole way round, because the point of the place
 * is sitting on the edge of it looking at the sea.
 */
export function teahouse(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', BUILDING_FOOTPRINTS['teahouse']![0]);
  const d = numOpt(opts, 'd', BUILDING_FOOTPRINTS['teahouse']![1]);
  const wrapVeranda = boolOpt(opts, 'veranda', true);
  const parts: THREE.Mesh[] = [];

  const timber = wood('light');
  const plinthHeight = 0.7;
  parts.push(...plinth(w, d, plinthHeight, stone()));

  const wallHeight = 2.5;
  parts.push(
    ...lift(
      framedWalls({
        w: w - 1.6,
        h: wallHeight,
        d: d - 1.6,
        panel: plaster(),
        frame: timber,
        bay: 1.8,
        timber: 0.15,
        screens: 'all',
        screenMaterial: shoji(),
        screenBand: [0.12, 0.82],
      }),
      plinthHeight,
    ),
  );

  if (wrapVeranda) {
    // Four decks, one per side, forming a continuous walkway.
    parts.push(...lift(veranda(w, 0.9, plinthHeight, timber, wood('dark')), 0, -(d / 2 - 0.45)));
    const back = veranda(w, 0.9, plinthHeight, timber, wood('dark'));
    for (const m of back) {
      m.position.z += d / 2 - 0.45;
      m.rotation.y = Math.PI;
    }
    parts.push(...back);
    for (const sx of [-1, 1] as const) {
      const side = veranda(d - 1.8, 0.9, plinthHeight, timber, wood('dark'));
      for (const m of side) {
        // Rotate the run **about the building's origin**, not each plank about its own centre.
        // `veranda` lays its boards out along local x; setting `rotation.y` alone turned each
        // board to face the right way but left the run still spread along x, so shifting it to
        // the flank produced a 6.7 m ribbon of decking sticking straight out of the side of the
        // building, 1.8 m clear of the roof, hanging in the air with no posts under it.
        const { x: px, z: pz } = m.position;
        m.rotation.y = (sx * Math.PI) / 2;
        m.position.x = pz * sx + sx * (w / 2 - 0.45);
        m.position.z = -px * sx;
      }
      parts.push(...side);
    }
  }

  parts.push(
    ...lift(
      tiledRoof({
        w,
        d,
        rise: 2.1,
        overhang: 1.3,
        style: 'sweeping',
        courses: 5,
        lift: 0.22,
        material: roofMaterial('copper'),
        trimMaterial: wood('dark'),
      }),
      plinthHeight + wallHeight,
    ),
  );

  for (const sx of [-1, 1] as const) {
    parts.push(...lift(paperLantern(0.22, 0.55, shoji(), wood('dark')), plinthHeight + 2.0, -d / 2 - 0.5, sx * w * 0.32));
  }
  parts.push(...lift(stoneSteps(2.2, plinthHeight, stone()), 0, -d / 2 - 3 * 0.44));

  return assemble('teahouse', parts);
}

/**
 * The village bathhouse. A wide hall with a tall gabled entrance porch and a brick
 * chimney — the chimney is the point, since it is the one vertical marker in the Old
 * Street's otherwise low roofline.
 */
export function bathhouse(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', BUILDING_FOOTPRINTS['bathhouse']![0]);
  const d = numOpt(opts, 'd', BUILDING_FOOTPRINTS['bathhouse']![1]);
  const parts: THREE.Mesh[] = [];

  const timber = wood('dark');
  const plinthHeight = 0.45;
  parts.push(...plinth(w, d, plinthHeight, stone()));

  const wallHeight = 3.4;
  parts.push(...lift(framedWalls({ w, h: wallHeight, d, panel: plaster(), frame: timber, bay: 2.4, timber: 0.2 }), plinthHeight));

  parts.push(
    ...lift(
      tiledRoof({ w, d, rise: 2.2, overhang: 1.0, style: 'hipped', courses: 6, material: roofMaterial('tile'), trimMaterial: wood('beam') }),
      plinthHeight + wallHeight,
    ),
  );

  // Entrance porch: a small gabled projection with its own roof.
  const porchW = w * 0.44;
  parts.push(box(porchW, 3.0, 1.6, plaster(), 0, plinthHeight + 1.5, -d / 2 - 0.7));
  parts.push(
    ...lift(
      tiledRoof({ w: porchW, d: 1.6, rise: 1.1, overhang: 0.6, style: 'gable', courses: 3, material: roofMaterial('tile'), trimMaterial: wood('beam') }),
      plinthHeight + 3.0,
      -d / 2 - 0.7,
    ),
  );
  parts.push(box(porchW * 0.55, 2.3, 0.16, wood('weathered'), 0, plinthHeight + 1.15, -d / 2 - 1.52));
  parts.push(...lift(noren(porchW * 0.6, 0.75, cloth(0x3f5a6b), 7), plinthHeight + 2.2, -d / 2 - 1.56));

  const chimneyH = 7.5;
  parts.push(box(1.3, chimneyH, 1.3, stone('dark'), w * 0.32, plinthHeight + chimneyH / 2, d * 0.3));
  parts.push(box(1.6, 0.35, 1.6, stone('dark'), w * 0.32, plinthHeight + chimneyH, d * 0.3));

  return assemble('bathhouse', parts);
}

/**
 * A funaya boat house — the north harbour's characteristic building, with its ground floor
 * open to the water so a boat can be pulled straight inside.
 *
 * Built facing −z, which is seaward at the north harbour. The open ground floor is why
 * this cannot reuse `framedWalls`: three sides are walled and the fourth is a pair of
 * posts and a lintel.
 */
export function boathouse(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', BUILDING_FOOTPRINTS['boathouse']![0]);
  const d = numOpt(opts, 'd', BUILDING_FOOTPRINTS['boathouse']![1]);
  const parts: THREE.Mesh[] = [];

  const board = wood('weathered');
  const timber = wood('dark');
  const openHeight = 2.6;
  const upperHeight = 2.3;

  parts.push(box(0.24, openHeight, d, board, -w / 2, openHeight / 2, 0));
  parts.push(box(0.24, openHeight, d, board, w / 2, openHeight / 2, 0));
  parts.push(box(w, openHeight, 0.24, board, 0, openHeight / 2, d / 2));
  for (const sx of [-1, 1] as const) {
    parts.push(box(0.28, openHeight, 0.28, timber, (sx * w) / 2, openHeight / 2, -d / 2));
  }
  parts.push(box(w + 0.3, 0.3, 0.28, timber, 0, openHeight - 0.15, -d / 2));

  // A slipway ramp running out of the open face toward the water.
  const ramp = box(w * 0.7, 0.2, 5, stone('dark'), 0, -0.55, -d / 2 - 2.4);
  ramp.rotation.x = -0.12;
  parts.push(ramp);

  parts.push(box(w, upperHeight, d, board, 0, openHeight + upperHeight / 2, 0));
  parts.push(box(w + 0.16, 0.2, d + 0.16, timber, 0, openHeight + 0.1, 0));
  parts.push(box(1.0, 0.9, 0.14, shoji(), 0, openHeight + upperHeight * 0.6, -d / 2 - 0.05));
  parts.push(box(1.16, 0.1, 0.24, timber, 0, openHeight + upperHeight * 0.6 - 0.5, -d / 2 - 0.1));

  parts.push(
    ...lift(
      tiledRoof({ w, d, rise: 1.5, overhang: 0.7, style: 'gable', courses: 5, material: roofMaterial('board'), trimMaterial: timber }),
      openHeight + upperHeight,
    ),
  );

  return assemble('boathouse', parts);
}

/** The lighthouse keeper's cottage: a small, sturdy, whitewashed house with a low roof. */
export function keepersHouse(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', BUILDING_FOOTPRINTS['keepers-house']![0]);
  const d = numOpt(opts, 'd', BUILDING_FOOTPRINTS['keepers-house']![1]);
  const parts: THREE.Mesh[] = [];

  const plinthHeight = 0.4;
  parts.push(...plinth(w, d, plinthHeight, stone('dark')));

  const wallHeight = 2.8;
  parts.push(box(w, wallHeight, d, whitewash(), 0, plinthHeight + wallHeight / 2, 0));
  // Corner quoins, which is what makes a rendered box read as masonry.
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      parts.push(box(0.4, wallHeight, 0.4, stone(), (sx * w) / 2, plinthHeight + wallHeight / 2, (sz * d) / 2));
    }
  }
  parts.push(box(1.1, 2.1, 0.16, wood('dark'), 0, plinthHeight + 1.05, -d / 2 - 0.04));
  parts.push(box(1.4, 0.16, 0.3, stone(), 0, plinthHeight + 2.18, -d / 2 - 0.1));
  for (const sx of [-1, 1] as const) {
    parts.push(box(1.0, 1.1, 0.12, shoji(), sx * w * 0.3, plinthHeight + wallHeight * 0.6, -d / 2 - 0.03));
    for (const dy of [0.6, -0.6]) {
      parts.push(box(1.2, 0.12, 0.24, stone(), sx * w * 0.3, plinthHeight + wallHeight * 0.6 + dy, -d / 2 - 0.08));
    }
  }

  parts.push(
    ...lift(
      tiledRoof({ w, d, rise: 1.5, overhang: 0.55, style: 'gable', courses: 5, material: roofMaterial('terracotta'), trimMaterial: wood('dark') }),
      plinthHeight + wallHeight,
    ),
  );

  parts.push(box(0.8, 2.0, 0.8, stone(), w * 0.28, plinthHeight + wallHeight + 1.4, 0));
  parts.push(box(1.0, 0.25, 1.0, stone('dark'), w * 0.28, plinthHeight + wallHeight + 2.4, 0));

  return assemble('keepers-house', parts);
}

/** A beach changing hut: driftwood boards on short piles, a shallow roof, an open front. */
export function beachHut(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', 8);
  const d = numOpt(opts, 'd', 6);
  const parts: THREE.Mesh[] = [];

  const board = wood('weathered');
  const height = 2.5;

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      parts.push(box(0.22, 0.7, 0.22, wood('dark'), sx * (w / 2 - 0.3), 0.35, sz * (d / 2 - 0.3)));
    }
  }
  parts.push(box(w, 0.16, d, board, 0, 0.72, 0));

  // Vertical boarding, individually placed so the gaps between planks read.
  const planks = Math.max(6, Math.round(w / 0.4));
  for (let i = 0; i < planks; i++) {
    const x = -w / 2 + (i + 0.5) * (w / planks);
    parts.push(box((w / planks) * 0.86, height, 0.1, board, x, 0.8 + height / 2, d / 2));
  }
  for (const sx of [-1, 1] as const) {
    parts.push(box(0.12, height, d, board, (sx * w) / 2, 0.8 + height / 2, 0));
    parts.push(box(0.2, height, 0.2, wood('dark'), sx * (w / 2 - 0.15), 0.8 + height / 2, -d / 2));
  }
  parts.push(box(w, 0.24, 0.2, wood('dark'), 0, 0.8 + height, -d / 2));

  parts.push(
    ...lift(
      tiledRoof({ w, d, rise: 0.9, overhang: 0.7, style: 'gable', courses: 4, ridge: false, material: roofMaterial('board'), trimMaterial: wood('dark') }),
      0.8 + height,
    ),
  );

  return assemble('beach-hut', parts);
}

// ---------------------------------------------------------------------------
// Sacred buildings
// ---------------------------------------------------------------------------

/**
 * A shrine hall. Used twice on the island at two scales: the main hall on the western
 * headland, and the small inner shrine at the summit (`small: true`).
 *
 * The features that make it read as a shrine rather than as a house, in order of how much
 * they matter: the sweeping roof with lifted corners, the *chigi* (crossed finials at each
 * gable) and *katsuogi* (the row of billets along the ridge), the vermilion frame, the
 * floor raised clear of the ground on posts, and the offering box at the foot of the steps.
 */
export function shrineHall(opts?: Opts): THREE.Group {
  const w = numOpt(opts, 'w', BUILDING_FOOTPRINTS['shrine-hall']![0]);
  const d = numOpt(opts, 'd', BUILDING_FOOTPRINTS['shrine-hall']![1]);
  const small = boolOpt(opts, 'small', false);
  const honden = boolOpt(opts, 'honden', true);
  const parts: THREE.Mesh[] = [];

  // Shrine timber is vermilion on a honden, plain dark wood on an unpainted hall.
  const accent = honden ? vermilion() : wood('dark');

  // Raised on posts rather than a plinth: a honden stands clear of the ground.
  const floorHeight = small ? 0.9 : 1.3;
  const postGrid = small ? 2 : 3;
  for (let i = 0; i <= postGrid; i++) {
    for (let j = 0; j <= postGrid; j++) {
      const x = -w / 2 + (i * w) / postGrid;
      const z = -d / 2 + (j * d) / postGrid;
      parts.push(cyl(0.19, 0.21, floorHeight, 8, accent, x, floorHeight / 2, z));
      parts.push(cyl(0.32, 0.34, 0.2, 8, stone(), x, 0.1, z));
    }
  }
  parts.push(box(w + 0.4, 0.26, d + 0.4, wood('light'), 0, floorHeight + 0.13, 0));

  const wallHeight = small ? 2.2 : 2.9;
  parts.push(
    ...lift(
      framedWalls({ w: w - 0.9, h: wallHeight, d: d - 0.9, panel: plaster(), frame: accent, bay: 1.9, timber: 0.2 }),
      floorHeight + 0.26,
    ),
  );

  // Doors: a pair of panels with the meeting stile between them.
  parts.push(box(w * 0.34, wallHeight * 0.8, 0.14, accent, 0, floorHeight + 0.26 + wallHeight * 0.4, -d / 2 + 0.36));
  parts.push(box(0.05, wallHeight * 0.8, 0.16, wood('dark'), 0, floorHeight + 0.26 + wallHeight * 0.4, -d / 2 + 0.3));

  parts.push(...lift(veranda(w, 1.4, floorHeight + 0.26, wood('light'), accent), 0, -d / 2 - 0.6));

  // The veranda rail: two runs either side of the stair opening, on posts.
  //
  // It used to be two bare horizontals spanning the whole frontage with nothing under them,
  // so from the steps you looked up at a pair of sticks hanging in the air across the front
  // of the shrine. A rail is posts first and rails second, and it has to *stop* where you
  // walk through it.
  const railY = floorHeight + 0.26;
  const railZ = -d / 2 - 1.28;
  const gap = w * 0.24;
  for (const sx of [-1, 1] as const) {
    const inner = sx * gap;
    const outer = sx * (w / 2);
    const run = Math.abs(outer - inner);
    for (const y of [0.45, 0.85]) {
      parts.push(box(run, 0.09, 0.09, accent, (inner + outer) / 2, railY + y, railZ));
    }
    const posts = Math.max(2, Math.round(run / 1.1));
    for (let i = 0; i <= posts; i++) {
      const x = inner + ((outer - inner) * i) / posts;
      parts.push(box(0.11, 0.95, 0.11, accent, x, railY + 0.475, railZ));
    }
  }

  const roofRise = wallHeight * 0.95;
  const roofY = floorHeight + 0.26 + wallHeight;
  parts.push(
    ...lift(
      tiledRoof({
        w: w + 0.6,
        d: d + 0.6,
        rise: roofRise,
        overhang: 1.5,
        style: 'sweeping',
        courses: 5,
        lift: 0.3,
        material: roofMaterial('copper'),
        trimMaterial: wood('dark'),
      }),
      roofY,
    ),
  );

  // Katsuogi: short billets lying across the ridge.
  const billets = small ? 3 : 5;
  for (let i = 0; i < billets; i++) {
    const z = -d / 2 + ((i + 0.5) * d) / billets;
    parts.push(cyl(0.19, 0.19, 1.5, 8, wood('light'), 0, roofY + roofRise + 0.5, z, 0, 0, Math.PI / 2));
  }
  // Chigi: the crossed finials at each gable.
  for (const sz of [-1, 1] as const) {
    for (const sx of [-1, 1] as const) {
      const fin = box(0.16, 3.0, 0.16, wood('light'), 0, roofY + roofRise + 0.9, sz * (d / 2 + 0.3));
      fin.rotation.z = sx * 0.3;
      fin.rotation.x = sz * 0.12;
      parts.push(fin);
    }
  }

  // The flight stands *in front of* the veranda rather than under it: four treads of 0.44
  // reach 1.76 m, so the top one has to start that far out for its full-height block to
  // finish level with the deck edge.
  const stairRun = 4 * 0.44;
  parts.push(...lift(stoneSteps(w * 0.3, floorHeight + 0.26, stone(), 4), 0, -d / 2 - 1.34 - stairRun));
  // The offering box, clear of the bottom tread instead of buried in the middle of it.
  const boxZ = -d / 2 - 2.0 - stairRun;
  parts.push(box(1.6, 0.9, 0.9, wood('dark'), 0, 0.45, boxZ));
  for (let i = 0; i < 5; i++) {
    parts.push(box(0.07, 0.12, 0.9, wood('light'), -0.6 + i * 0.3, 0.95, boxZ));
  }

  return assemble('shrine-hall', parts);
}

/**
 * A temizuya — the open pavilion over the purification basin at a shrine entrance. Four
 * posts, a sweeping roof, a stone trough and a row of bamboo dippers.
 */
export function temizuya(_opts?: Opts): THREE.Group {
  const parts: THREE.Mesh[] = [];
  const w = 3.6;
  const d = 3.0;
  const postHeight = 2.5;

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      parts.push(cyl(0.15, 0.17, postHeight, 8, vermilion(), (sx * w) / 2, postHeight / 2, (sz * d) / 2));
      parts.push(cyl(0.26, 0.28, 0.24, 8, stone(), (sx * w) / 2, 0.12, (sz * d) / 2));
    }
  }
  for (const sz of [-1, 1] as const) {
    parts.push(box(w + 0.4, 0.18, 0.16, vermilion(), 0, postHeight - 0.2, (sz * d) / 2));
  }

  parts.push(
    ...lift(
      tiledRoof({ w, d, rise: 1.1, overhang: 0.85, style: 'sweeping', courses: 4, lift: 0.28, material: roofMaterial('copper'), trimMaterial: wood('dark') }),
      postHeight,
    ),
  );

  parts.push(box(2.2, 0.7, 1.4, stone('dark'), 0, 0.35, 0));
  parts.push(box(1.9, 0.12, 1.1, stone(), 0, 0.72, 0));
  for (let i = 0; i < 3; i++) {
    parts.push(cyl(0.05, 0.05, 0.9, 6, wood('light'), -0.6 + i * 0.6, 0.82, 0, 0, 0, Math.PI / 2));
    parts.push(cyl(0.11, 0.11, 0.1, 8, wood('light'), -0.6 + i * 0.6, 0.86, 0.42));
  }

  return assemble('temizuya', parts);
}

// ---------------------------------------------------------------------------
// The lighthouse
// ---------------------------------------------------------------------------

/**
 * The lighthouse on the north-east cape. The tallest thing on the island after the
 * mountain, and visible from most of the coast road, so it carries more detail than
 * anything else here.
 *
 * The tower is built as a stack of **drums** rather than as one tapered cylinder. A smooth
 * cone gives the contour pass a single continuous gradient and therefore no line at all,
 * so the tower would render as a flat white shape against the sky; stepping the taper
 * puts a horizontal band at every drum join and the tower draws itself.
 *
 * The optic is a **separate child named `lamp`**, not merged into the tower: the scene
 * director rotates it every frame. Merging it would save a draw call and lose the one
 * moving landmark on the island.
 */
export function lighthouse(opts?: Opts): THREE.Group {
  const height = numOpt(opts, 'height', 20);
  const baseRadius = numOpt(opts, 'radius', 3.0);
  const group = new THREE.Group();
  group.name = 'lighthouse';

  const parts: THREE.Mesh[] = [];
  const white = whitewash();
  const accent = vermilion();
  const dark = metal();

  parts.push(cyl(baseRadius * 1.25, baseRadius * 1.55, 1.6, 12, stone('dark'), 0, 0.8, 0));
  parts.push(cyl(baseRadius * 1.18, baseRadius * 1.25, 0.3, 12, stone(), 0, 1.7, 0));

  const drums = 7;
  const towerHeight = height - 1.85;
  for (let i = 0; i < drums; i++) {
    const t0 = i / drums;
    const t1 = (i + 1) / drums;
    const r0 = baseRadius * (1 - t0 * 0.34);
    const r1 = baseRadius * (1 - t1 * 0.34);
    const y = 1.85 + t0 * towerHeight;
    const h = towerHeight / drums;
    parts.push(cyl(r1, r0, h, 14, white, 0, y + h / 2, 0));
    if (i > 0) parts.push(cyl(r0 * 1.03, r0 * 1.03, 0.12, 14, i % 2 === 0 ? accent : white, 0, y, 0));
  }

  const topRadius = baseRadius * 0.66;
  const galleryY = 1.85 + towerHeight;

  // Gallery: a projecting deck with a railing.
  parts.push(cyl(topRadius * 1.5, topRadius * 1.5, 0.28, 16, dark, 0, galleryY + 0.14, 0));
  parts.push(cyl(topRadius * 1.45, topRadius * 1.5, 0.5, 16, dark, 0, galleryY - 0.2, 0));
  const balusters = 16;
  for (let i = 0; i < balusters; i++) {
    const a = (i / balusters) * Math.PI * 2;
    parts.push(box(0.07, 1.0, 0.07, dark, Math.cos(a) * topRadius * 1.42, galleryY + 0.78, Math.sin(a) * topRadius * 1.42));
  }
  parts.push(cyl(topRadius * 1.48, topRadius * 1.48, 0.09, 16, dark, 0, galleryY + 1.26, 0));

  // Lantern room: glazed drum, conical cap, finial.
  const roomHeight = 2.6;
  parts.push(cyl(topRadius, topRadius, roomHeight, 12, glow(0xfff0d0), 0, galleryY + 0.28 + roomHeight / 2, 0));
  // Astragals — the vertical glazing bars. Without them the lantern room is a glowing
  // cylinder; with them it is a lighthouse.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    parts.push(box(0.1, roomHeight, 0.1, dark, Math.cos(a) * topRadius, galleryY + 0.28 + roomHeight / 2, Math.sin(a) * topRadius));
  }
  parts.push(cyl(topRadius * 1.08, topRadius * 1.08, 0.16, 12, dark, 0, galleryY + 0.28 + roomHeight, 0));
  parts.push(cyl(0.12, topRadius * 1.12, 1.5, 12, accent, 0, galleryY + 1.2 + roomHeight, 0));
  parts.push(cyl(0.06, 0.06, 0.9, 6, dark, 0, galleryY + 2.3 + roomHeight, 0));
  parts.push(box(1.2, 2.2, 0.2, wood('dark'), 0, 1.95, -baseRadius * 1.02));

  for (const mesh of mergeByMaterial(parts)) group.add(mesh);

  const lamp = new THREE.Group();
  lamp.name = 'lamp';
  lamp.position.y = galleryY + 0.28 + roomHeight * 0.5;
  lamp.add(box(1.1, 1.0, 5.0, glow(0xfff3c8), 0, 0, 1.6));
  lamp.add(cyl(0.5, 0.5, 1.3, 8, glow(0xffffff), 0, 0, 0));
  group.add(lamp);

  return group;
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

/**
 * A market stall on the harbour quay: four poles, a striped awning, a counter and a
 * scatter of crates. Small, but there are three of them side by side and they are what
 * makes the quay look like somewhere business happens.
 */
export function marketStall(opts?: Opts): THREE.Group {
  const clothIndex = Math.round(numOpt(opts, 'cloth', 0));
  const parts: THREE.Mesh[] = [];
  const rng = mulberry32(seedFrom(clothIndex, 17));

  const w = 3.2;
  const d = 2.4;
  const postHeight = 2.4;
  const timber = wood('light');

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      parts.push(box(0.11, postHeight, 0.11, timber, (sx * w) / 2, postHeight / 2, (sz * d) / 2));
    }
  }

  const colors = [0x4e6e7c, 0xc4503a, 0xe8e2d4];
  const awning = cloth(colors[clothIndex % colors.length]);
  for (const sx of [-1, 1] as const) {
    const panel = box(w * 0.62, 0.05, d + 0.7, awning, sx * w * 0.28, postHeight + 0.28, 0);
    panel.rotation.z = -sx * 0.3;
    parts.push(panel);
  }
  parts.push(box(0.12, 0.12, d + 0.7, timber, 0, postHeight + 0.48, 0));

  parts.push(box(w, 0.12, d * 0.7, timber, 0, 1.0, -d * 0.12));
  parts.push(box(w, 0.1, d * 0.6, wood('weathered'), 0, 0.5, -d * 0.12));
  parts.push(box(w, 0.7, 0.08, wood('weathered'), 0, 0.65, -d * 0.44));

  for (let i = 0; i < 3; i++) {
    const size = randRange(rng, 0.42, 0.62);
    const crate = box(size, size, size, wood('weathered'), randRange(rng, -w * 0.4, w * 0.4), size / 2, randRange(rng, d * 0.15, d * 0.45));
    crate.rotation.y = randRange(rng, -0.5, 0.5);
    parts.push(crate);
  }

  parts.push(...lift(paperLantern(0.2, 0.5, shoji(), wood('dark')), postHeight - 0.75, -d * 0.5, w * 0.4));

  return assemble('market-stall', parts);
}
