/**
 * 渚島 Nagisa Island — the shipped map.
 * ====================================
 *
 * Pure data. Every mechanism that turns these numbers into ground you can stand on lives in
 * `terrain.ts` and `world.ts`; this file only says *where things are*.
 *
 * ### The shape: a hexagon around a mountain
 *
 * ```
 *                     北港 North Harbour  2.4 m
 *                            (0, -74)
 *                         ╱            ╲
 *       灯台岬 Lighthouse                 町並み Old Street  ┐
 *          (-64, -37) 13 m                  (64, -37) 9 m   │ one shelf,
 *              │        ▲ 山頂 Summit          │            │ and the road
 *              │          (0, 0)  26 m         │            │ up the mountain
 *       神社 Shrine                       広場 Main Plaza    ┘
 *          (-64, 37) 11 m                   (64, 37) 8 m
 *                         ╲            ╱
 *                     南港 South Harbour  2.4 m
 *                            (0, 74)
 * ```
 *
 * Six places on a hexagon 74 m to a side, and the summit at the centre. Everything is a few
 * seconds from everything else: the ring road is 493 m and the climb from the eastern shelf
 * to the summit is 86 m, under ten seconds at a run.
 *
 * The heights say what each place is:
 *
 * - **Two harbours**, north and south, at sea level in their own bays.
 * - **Two high places** — the shrine on its headland and the lighthouse on its cape —
 *   raised above the ring so they read as somewhere you go *up* to.
 * - **Two that adjoin**: the plaza and the old street share one continuous eastern shelf
 *   with no dip between them, and the road up the mountain leaves from between them.
 * - **The summit**, highest, in the middle, visible from everywhere.
 *
 * ### History
 *
 * v1 and v2 are in `archive/`, with their own notes. v2's island was 480 m across with a
 * 1 289 m coast road and took over two minutes to cross — a world you explore. This is a
 * world you gather in, so the distances came down by half and the layout became a shape you
 * can learn in one visit. The relief then halved again: the climb was the longest thing you
 * did on an island whose whole point is that nothing is far.
 */

import type { MapPack } from '../map/types.js';

// ---------------------------------------------------------------------------
// Landform
// ---------------------------------------------------------------------------

/** Extent of the terrain grid the client meshes, metres from origin on each axis. */
const ISLAND_EXTENT = 175;

/** Radius beyond which there is nothing but open water. Used for camera + fog limits. */
const OCEAN_RADIUS = 2400;

/** Mean radius of the coastline, before capes, bays and wobble. */
const COAST_RADIUS = 122;

/**
 * Distance from the summit to each of the six zones — the hexagon's circumradius, which
 * for a regular hexagon is also its side length. 74 m is the whole design brief in one
 * number: about eight seconds at a run, so a neighbour is never a journey.
 */
const HEX_RADIUS = 74;

/** Summit of the central massif. Every other place on the island is described relative to it. */
const SUMMIT = { x: 0, z: 0, height: 26 } as const;

/**
 * Horizontal reach of the massif — beyond this the ground is coastal shelf.
 *
 * Height and radius are chosen together, not independently. A smoothstep cone's steepest
 * point is its midpoint, where the gradient is `1.5 · height / radius`; at 26 m over
 * 92 m that is 0.42, or 23°, well inside {@link MAX_WALKABLE_SLOPE}.
 *
 * The island's whole relief was halved from v3's first draft: the climb was the longest
 * thing you did on an island whose point is that nothing is far. Everything above sea
 * level came down by the same factor, so the *order* of the places is untouched — quays
 * lowest, plaza and old street above them, shrine and cape above those, summit highest —
 * while the summit road dropped from sixteen seconds to nine.
 *
 * The radius also has to reach past the hexagon (74 m) so the mountain's foot *is* the
 * ground the six zones stand on, rather than a cone dropped into the middle of a plain.
 */
const MASSIF_RADIUS = 92;

/**
 * Headlands. Each one carries something: the lighthouse stands on the north-east cape,
 * the shrine on the west headland, the beach runs off the south-west spit.
 */
const CAPES: MapPack['terrain']['capes'] = [
  { x: -104, z: -60, reach: 58, strength: 0.26 }, // north-west: the lighthouse cape
  { x: -104, z: 60, reach: 54, strength: 0.22 }, // south-west: the shrine headland
  { x: 104, z: -46, reach: 52, strength: 0.2 }, // east: the old street's shelf
  { x: 62, z: 104, reach: 50, strength: 0.18 }, // south-east: the beach spit
] as const;

/**
 * The two harbour bays. Both are deliberately generous — a harbour you cannot see across
 * does not read as a harbour, and boats need somewhere to be.
 */
const BAYS: MapPack['terrain']['bays'] = [
  { x: 0, z: 138, reach: 64, strength: 0.44 }, // south bay: the arrival port
  { x: 0, z: -138, reach: 60, strength: 0.4 }, // north bay: the fishing harbour
] as const;

const SHELVES: MapPack['terrain']['shelves'] = [
  // The eastern shelf, carrying both the plaza and the old street.
  { x: 70, z: 0, reach: 82, height: 7 },
  // The western headlands are raised too, but separately: the shrine and the lighthouse
  // are meant to read as two distinct high places, not one ridge.
  { x: -70, z: 40, reach: 46, height: 8 },
  { x: -70, z: -40, reach: 46, height: 9 },
] as const;

// ---------------------------------------------------------------------------
// Terraces and routes
// ---------------------------------------------------------------------------

/**
 * Terraces, in application order. Later pads win where they overlap, so a small pad may
 * be cut into a larger one (the notice-board terrace sits inside the plaza).
 *
 * Keep these in sync with `ZONES` in `world.ts` — the zone centres are anchored to them.
 * `scripts/world-smoke.ts` asserts that `heightAt(pad.x, pad.z) === pad.height`, which is
 * what catches a pad that has drifted off its zone or been swallowed by a later one.
 */
const PADS: MapPack['terrain']['pads'] = [
  // — The hexagon, clockwise from the south ——————————————————————————
  //
  // The six zones sit on the vertices of a regular hexagon of circumradius HEX_RADIUS.
  // Their heights are the design: two harbours at sea level, two high places, and two that
  // adjoin on the eastern shelf.
  //
  // Terraces must not overlap unless the nesting is deliberate — they are applied in order
  // and a later one wins, so a big pad whose `outer` reaches a small one downhill will
  // quietly drag it to the wrong height. At 74 m apart with `outer` at 34, the six have
  // 6 m of clearance between their blends.

  // Inner radii are sized by **what stands on them**, not by eye. A building is placed at
  // a single height sample, so any variation across its footprint puts one corner in the
  // air; the fix is for the whole footprint to be inside the terrace's flat part.
  // `tools/flatness.mjs` measures that directly and `world-smoke` fails the build on it.
  //
  // The ceiling on how wide these can get is the gap to the next terrace: two pads need
  // `heightDifference / walkableGradient` of clear ground between their flat parts, and
  // the hexagon gives 74 m of centre-to-centre to spend. The tightest pair is the north
  // harbour and the lighthouse cape — 22.6 m apart in height, so 27 m of that 74 has to
  // stay as slope.

  /** The arrival port. Barely above the water, so the boats read as boats. */
  { id: 'south-harbor', x: 0, z: 74, height: 2.4, inner: 28, outer: 40 },
  /** The main plaza, on the eastern shelf. */
  { id: 'plaza', x: 64, z: 37, height: 8.0, inner: 34, outer: 46 },
  /**
   * The old street, sharing that shelf — see SHELVES for why there is no dip between them.
   *
   * `inner` is 21 rather than 25 so the summit road's embankment has somewhere to land. The
   * flat was claiming four metres it had no building on, and those four metres were the
   * difference between a 56° bank across the north end of the street and no bank at all.
   * `npm run audit:terrain` is what measures it.
   */
  { id: 'village', x: 64, z: -37, height: 9.0, inner: 28, outer: 40 },
  /** Sunset beach, on the sand east of the south quay. */
  { id: 'beach', x: 46, z: 92, height: 1.6, inner: 18, outer: 26 },
  /** The working fishing harbour. */
  { id: 'north-harbor', x: 0, z: -74, height: 2.4, inner: 28, outer: 40 },
  /** Lighthouse cape: a flat clifftop, deliberately exposed and the higher of the two. */
  { id: 'lighthouse', x: -64, z: -37, height: 13.0, inner: 27, outer: 39 },
  /** The shrine, on its own headland. */
  { id: 'shrine', x: -64, z: 37, height: 11.0, inner: 26, outer: 38 },

  // — Inland ————————————————————————————————————————————————————————
  /** Notice-board terrace, one step up from the plaza floor. The one deliberate nesting. */
  { id: 'noticeboard', x: 48, z: 22, height: 8.4, inner: 8, outer: 12 },
  /** The summit court: a small flat terrace at the true peak, around the inner shrine. */
  { id: 'summit', x: SUMMIT.x, z: SUMMIT.z, height: SUMMIT.height, inner: 12, outer: 30 },
] as const;

/**
 * Every route on the island.
 *
 * The coast road is the spine: it touches all six inhabited places and closes into a
 * loop, so walking in one direction eventually brings you back. The three lanes climb
 * inland off it — one up the west ridge from the shrine, one up the southern shoulder
 * from the plaza, one along the eastern shelf linking the old street to the teahouse.
 */
const PATHS: MapPack['terrain']['paths'] = [
  {
    id: 'coast',
    name: 'Ring Road',
    halfWidth: 3.4,
    shoulder: 6,
    carve: 0.95,
    surface: 'stone',
    // Mid-points sit at radius 82 rather than on the hexagon's 74, so each leg is ~86 m
    // instead of 74. That extra twelve metres is not decoration: the north harbour to
    // lighthouse cape leg climbs 23 m, and over a straight 74 m that is a 32% grade —
    // past what the survey will hold with both ends pinned to their terraces.
    points: [
      [0, 74], // south harbour
      [41, 71],
      [64, 37], // plaza
      [82, 0],
      [64, -37], // old street
      [41, -71],
      [0, -74], // north harbour
      [-41, -71],
      [-64, -37], // lighthouse cape
      [-82, 0],
      [-64, 37], // shrine
      [-41, 71],
      [0, 74],
    ],
  },
  {
    id: 'south-approach',
    name: 'Summit Road',
    halfWidth: 3.2,
    shoulder: 5.5,
    carve: 0.95,
    surface: 'stone',
    points: [
      // Leaves the ring from between the plaza and the old street — the point of putting
      // those two on one shelf is that the mountain road starts where they meet.
      //
      // No switchbacks any more. With the summit 18 m above the shelf rather than 33, a
      // near-direct line holds about 22%, and the four turns that used to be needed to keep
      // the grade legal only made the climb long.
      [82, 0],
      // z = -5, not -8. At -8 this waypoint ran thirty metres from the old street's terrace
      // while sitting five and a half metres above it, and no embankment shape can absorb
      // that much drop across that little ground — the bank across the north end of the
      // street came out at 56°, which is a wall you cannot climb in the middle of a village.
      // Three metres of clearance is the whole fix. See `npm run audit:terrain`.
      [58, -5],
      [36, -6],
      [16, 3],
      [0, 0], // summit
    ],
  },
  {
    id: 'shrine-ascent',
    name: 'Shrine Path',
    halfWidth: 2.6,
    shoulder: 5,
    carve: 0.94,
    surface: 'gravel',
    points: [
      [-64, 37], // shrine courtyard
      [-46, 30],
      [-28, 20],
      [-12, 10],
      [0, 0], // summit
    ],
  },
  {
    id: 'east-lane',
    name: 'Harbour Lane',
    halfWidth: 2.8,
    shoulder: 5,
    carve: 0.94,
    surface: 'gravel',
    points: [
      // A short cut across the middle of the island, from the south harbour up past the
      // notice board to the plaza. The one route that does not follow the ring.
      [0, 74],
      [20, 60],
      [40, 44],
      [48, 22], // notice-board terrace
      [64, 37], // plaza
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Places, buildings, and what you can do
// ---------------------------------------------------------------------------

/**
 * Every named place on the island.
 *
 * Anchors are aligned with the flattening pads in `terrain.ts` — a venue whose anchor
 * drifts off its pad will end up on a slope, and `world-smoke` fails the build if one
 * does. `coast` is the exception: it is the fallback, and its anchor is nominal.
 */
const ZONES: MapPack['world']['zones'] = [
  {
    id: 'south-harbor',
    name: 'South Harbour',
    nameJa: '南港',
    kind: 'venue',
    x: 0,
    z: 74,
    radius: 32,
    stage: { dx: -9, dz: -6, facing: Math.PI * 0.1 },
    softCapacity: 60,
    ambience: 'harbor',
    caption: 'The ferry ties up here. Everyone arrives at the south quay.',
  },
  {
    id: 'plaza',
    name: 'Main Plaza',
    nameJa: '広場',
    kind: 'venue',
    x: 64,
    z: 37,
    radius: 32,
    stage: { dx: 4, dz: -12, facing: 0 },
    softCapacity: 140,
    ambience: 'town',
    caption: 'The middle of things, on the eastern shelf. Something is usually about to start.',
  },
  {
    id: 'noticeboard',
    name: 'Notice Board',
    nameJa: '掲示板',
    kind: 'notice',
    x: 48,
    z: 22,
    radius: 11,
    softCapacity: 20,
    ambience: 'town',
    caption: 'Paper slips, pinned and re-pinned. Today’s word is here.',
  },
  {
    id: 'village',
    name: 'Old Street',
    nameJa: '町並み',
    kind: 'transit',
    x: 64,
    z: -37,
    radius: 32,
    softCapacity: 50,
    ambience: 'town',
    caption: 'Wooden fronts, low eaves, a cat that has never moved.',
  },
  {
    id: 'north-harbor',
    name: 'North Harbour',
    nameJa: '北港',
    kind: 'venue',
    x: 0,
    z: -74,
    radius: 30,
    stage: { dx: 9, dz: 5, facing: -Math.PI * 0.35 },
    softCapacity: 40,
    ambience: 'harbor',
    caption: 'Nets, ice, and boats that go out before anyone is awake.',
  },
  {
    id: 'lighthouse',
    name: 'Lighthouse Cape',
    nameJa: '灯台岬',
    kind: 'venue',
    x: -64,
    z: -37,
    radius: 30,
    stage: { dx: 10, dz: 9, facing: Math.PI * 0.7 },
    softCapacity: 50,
    ambience: 'wind',
    caption: 'The lamp turns whether anyone is watching or not.',
  },
  {
    id: 'shrine',
    name: 'Shrine',
    nameJa: '神社',
    kind: 'venue',
    x: -64,
    z: 37,
    radius: 32,
    stage: { dx: 8, dz: -6, facing: Math.PI * 0.4 },
    softCapacity: 70,
    ambience: 'shrine',
    caption: 'Torii, one after another, on the headland above the water.',
  },
  {
    id: 'summit',
    name: 'Summit',
    nameJa: '山頂',
    kind: 'scenic',
    x: 0,
    z: 0,
    radius: 26,
    softCapacity: 30,
    ambience: 'wind',
    caption: 'From up here the whole island fits between your hands.',
  },
  {
    id: 'beach',
    name: 'Sunset Beach',
    nameJa: '浜',
    kind: 'venue',
    x: 46,
    z: 92,
    radius: 22,
    stage: { dx: -2, dz: -4, facing: -Math.PI * 0.75 },
    softCapacity: 60,
    ambience: 'waves',
    caption: 'Flat sand, shallow water, and the long light.',
  },
  {
    id: 'coast',
    name: 'Ring Road',
    nameJa: '渚道',
    kind: 'transit',
    x: 0,
    z: 0,
    radius: 9999, // Fallback zone: matched last, catches anyone not inside a named place.
    softCapacity: 999,
    ambience: 'waves',
    caption: 'The road follows the water the whole way round.',
  },
] as const;

/**
 * Where new visitors appear.
 *
 * All of them are on the south harbour quay, facing inland: you arrive by water, and the
 * walk up to the plaza is the island introducing itself. Several points, spread along the
 * quay, so a crowd arriving together does not stack into one body.
 */
const SPAWN_POINTS: MapPack['world']['spawnPoints'] = [
  [-6, 80],
  [6, 80],
  [-11, 74],
  [11, 74],
  [0, 84],
  [0, 68],
] as const;

const INTERACTABLES: MapPack['world']['interactables'] = [
  { id: 'notice-board', zone: 'noticeboard', dx: 0, dz: -4, range: 4.5, kind: 'use', label: 'Read', effect: 'read_announcements' },
  { id: 'plaza-post', zone: 'plaza', dx: -13, dz: 7, range: 3.5, kind: 'use', label: 'Check in', effect: 'checkin_nearby' },
  { id: 'shrine-bell', zone: 'shrine', dx: 3, dz: -8, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'summit-bell', zone: 'summit', dx: 8, dz: 5, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'south-harbor-bell', zone: 'south-harbor', dx: 10, dz: 4, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'north-harbor-bell', zone: 'north-harbor', dx: -9, dz: -4, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'lighthouse-door', zone: 'lighthouse', dx: 0, dz: 3, range: 4, kind: 'use', label: 'Look', effect: 'none' },
  { id: 'summit-rail', zone: 'summit', dx: -2, dz: 11, range: 5, kind: 'use', label: 'Look', effect: 'none' },
  { id: 'teahouse-mat-a', zone: 'plaza', dx: 14, dz: 9, range: 2.5, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'teahouse-mat-b', zone: 'plaza', dx: 17, dz: 11, range: 2.5, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'beach-log', zone: 'beach', dx: 5, dz: 7, range: 3, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'plaza-bench', zone: 'plaza', dx: 13, dz: 8, range: 3, kind: 'sit', label: 'Sit', effect: 'none' },
] as const;

/**
 * Hand-placed landmarks — every building on Nagisa.
 *
 * Grouped by zone, and within a zone roughly in the order you would meet them walking in.
 * The coast road's lanterns, mile-posts and railings are *not* here: those are placed by
 * arc length along the path at build time, because spacing them by hand would be busywork
 * that goes stale the moment the road is re-routed.
 */
const LANDMARKS: MapPack['world']['landmarks'] = [
  // ═══ South Harbour (0, 74) — the arrival port ═══════════════════════════
  // Waterfront props run out along +z into the bay; the quay buildings sit behind them,
  // all inside the terrace's flat inner radius so nothing stands on a slope.
  { id: 'sh-torii-sea', kind: 'torii', x: 0, z: 112, rot: 0.05, scale: 1.7, opts: { inWater: true } },
  { id: 'sh-pier-main', kind: 'pier', x: 0, z: 88, rot: 0, opts: { length: 30, width: 7, lamps: true } },
  { id: 'sh-pier-west', kind: 'pier', x: -20, z: 82, rot: Math.PI * 0.4, opts: { length: 18, width: 4.5 } },
  { id: 'sh-breakwater', kind: 'breakwater', x: 34, z: 98, rot: -0.55, opts: { length: 40, beacon: true } },
  { id: 'sh-boat-1', kind: 'boat', x: 16, z: 98, rot: 0.3, opts: { style: 'ferry', scale: 1.25 } },
  { id: 'sh-boat-2', kind: 'boat', x: -12, z: 96, rot: -0.7 },
  { id: 'sh-seawall', kind: 'sea-wall', x: 19, z: 80, rot: -0.4, opts: { length: 22 } },
  { id: 'sh-warehouse-1', kind: 'warehouse', x: 18.8, z: 82.9, rot: -0.2, opts: { w: 10, d: 8, floors: 2 } },
  { id: 'sh-warehouse-2', kind: 'warehouse', x: -18.8, z: 82.9, rot: 0.2, opts: { w: 10, d: 8 } },
  { id: 'sh-office', kind: 'machiya', x: 2.2, z: 58.6, rot: 3.142, opts: { w: 10, d: 10, floors: 2, sign: true } },
  { id: 'sh-stall-1', kind: 'market-stall', x: -8.3, z: 79.9, rot: 0.1, opts: { cloth: 1 } },
  { id: 'sh-stall-2', kind: 'market-stall', x: -2.2, z: 80.3, rot: 0.1, opts: { cloth: 2 } },
  { id: 'sh-stall-3', kind: 'market-stall', x: 4.1, z: 80, rot: 0.1, opts: { cloth: 0 } },
  { id: 'sh-stage', kind: 'stage', x: -10.4, z: 61.9, rot: 1.571, opts: { w: 12, d: 9 } },
  { id: 'sh-bell', kind: 'bell-tower', x: 10.1, z: 79.7, rot: 0, scale: 0.8 },
  { id: 'sh-lantern-1', kind: 'post-lantern', x: -8, z: 72, rot: 0 },
  { id: 'sh-lantern-2', kind: 'post-lantern', x: 8, z: 72, rot: 0 },
  { id: 'sh-banner-1', kind: 'banner', x: -14, z: 78, rot: 0.2 },
  { id: 'sh-banner-2', kind: 'banner', x: 14, z: 72, rot: -0.3 },
  { id: 'sh-rock-1', kind: 'rock', x: -26, z: 92, rot: 1.1, scale: 1.3 },

  // ═══ Sunset Beach (46, 92) — the sand east of the quay ══════════════════
  { id: 'bh-hut-1', kind: 'beach-hut', x: 37, z: 93, rot: -0.4, opts: { w: 6, d: 5 } },
  { id: 'bh-hut-2', kind: 'beach-hut', x: 55, z: 93, rot: 0.4, opts: { w: 6, d: 5 } },
  { id: 'bh-stage', kind: 'stage', x: 46, z: 86, rot: 0, opts: { w: 11, d: 8 } },
  { id: 'bh-bench-1', kind: 'bench', x: 51, z: 99, rot: 0.62 },
  { id: 'bh-boat-1', kind: 'boat', x: 58, z: 102, rot: 1.8, scale: 0.75 },
  { id: 'bh-rock-1', kind: 'rock', x: 64, z: 92, rot: 0.7, scale: 1.5 },
  { id: 'bh-lantern-1', kind: 'post-lantern', x: 38, z: 96, rot: 0 },

  // ═══ Main Plaza (64, 37) — the civic centre ═════════════════════════════
  { id: 'pl-stage', kind: 'stage', x: 76, z: 46, rot: -2.21, opts: { w: 12, d: 9, roof: true, tiers: true } },
  { id: 'pl-gate-s', kind: 'gate', x: 66, z: 54, rot: 0.05, scale: 1.1 },
  { id: 'pl-gate-w', kind: 'gate', x: 60.0, z: 34.0, rot: 0.821},
  { id: 'pl-minka', kind: 'minka', x: 62.0, z: 12.0, rot: -3.054, opts: { w: 11, d: 9 } },
  { id: 'pl-well', kind: 'well', x: 71, z: 54, rot: 0.3},
  { id: 'pl-lantern-1', kind: 'stone-lantern', x: 58, z: 27, rot: 0.3 },
  { id: 'pl-lantern-2', kind: 'stone-lantern', x: 75, z: 28, rot: -0.3 },
  { id: 'pl-lantern-3', kind: 'stone-lantern', x: 53, z: 48, rot: 0.1 },
  { id: 'pl-lantern-4', kind: 'stone-lantern', x: 75, z: 48, rot: -0.1 },
  { id: 'pl-bench-1', kind: 'bench', x: 77, z: 45, rot: -0.6 },
  { id: 'pl-bench-2', kind: 'bench', x: 51, z: 45, rot: 0.6 },
  { id: 'pl-banner-1', kind: 'banner', x: 58, z: 52, rot: 0 },
  { id: 'pl-banner-2', kind: 'banner', x: 71, z: 52, rot: 0 },
  // The teahouse: a v2 zone kept as a building, on the quiet side of the plaza.
  { id: 'pl-teahouse', kind: 'teahouse', x: 80.2, z: 30.1, rot: -1.44, opts: { w: 11, d: 8.5, veranda: true } },

  // — Notice-board terrace (48, 22), one step up from the plaza ————————
  { id: 'nb-board', kind: 'notice-board', x: 48, z: 16.9, rot: 0.1, scale: 1.4 },
  { id: 'nb-lantern-1', kind: 'stone-lantern', x: 42, z: 24, rot: 0 },
  { id: 'nb-bench-1', kind: 'bench', x: 53, z: 25, rot: -0.4 },

  // ═══ Old Street (64, -37) — two rows facing each other ══════════════════
  // Two rows of row houses, laid out **along the ring road** rather than along the z axis.
  //
  // The road crosses this terrace diagonally — tangent (-0.44, -0.90) — so rows squared to
  // the world met it at 26° and their end houses stood in the carriageway. A street beside a
  // road runs with the road: both rows are offset 10.5 m either side of the centreline and
  // spaced 11 m apart along it, which is the same street it always was, turned to face the
  // traffic it is beside. Their yaws follow: each row faces across at the other.
  { id: 'ov-machiya-1', kind: 'machiya', x: 48.5, z: -41.5, rot: 2.026, opts: { w: 8, d: 10, floors: 2, sign: true } },
  { id: 'ov-machiya-2', kind: 'machiya', x: 54.5, z: -32.3, rot: 2.026, opts: { w: 8, d: 10, floors: 2 } },
  { id: 'ov-machiya-3', kind: 'machiya', x: 59.4, z: -22.5, rot: 2.026, opts: { w: 8, d: 10, floors: 1, sign: true } },
  { id: 'ov-machiya-4', kind: 'machiya', x: 67.4, z: -50.7, rot: -1.115, opts: { w: 8, d: 10, floors: 2 } },
  { id: 'ov-machiya-5', kind: 'machiya', x: 73.4, z: -41.5, rot: -1.115, opts: { w: 8, d: 10, floors: 1, sign: true } },
  { id: 'ov-machiya-6', kind: 'machiya', x: 78.3, z: -31.7, rot: -1.115, opts: { w: 8, d: 10, floors: 2 } },
  // Back on the terrace now that it is wide enough: behind the east row, off the road.
  { id: 'ov-warehouse', kind: 'warehouse', x: 84.0, z: -47.0, rot: -1.115, opts: { w: 10, d: 8 } },
  { id: 'ov-bathhouse', kind: 'bathhouse', x: 59.8, z: -61.9, rot: -2.68, opts: { w: 10, d: 8 } },
  { id: 'ov-gate-s', kind: 'gate', x: 69.0, z: -24.5, rot: -2.68},
  { id: 'ov-gate-n', kind: 'gate', x: 52.0, z: -60.0, rot: -2.68},
  { id: 'ov-well', kind: 'well', x: 63.5, z: -17.0, rot: 0},
  { id: 'ov-lantern-1', kind: 'post-lantern', x: 60, z: -44, rot: 0 },
  { id: 'ov-lantern-2', kind: 'post-lantern', x: 69, z: -37, rot: 0 },
  { id: 'ov-lantern-3', kind: 'post-lantern', x: 60, z: -30, rot: 0 },
  { id: 'ov-bench-1', kind: 'bench', x: 69, z: -44, rot: -1.047},

  // ═══ North Harbour (0, -74) — the working fishery ═══════════════════════
  { id: 'nh-torii-sea', kind: 'torii', x: 0, z: -110, rot: 0.1, scale: 1.4, opts: { inWater: true } },
  { id: 'nh-pier-e', kind: 'pier', x: 8, z: -86, rot: Math.PI, opts: { length: 20, width: 5 } },
  { id: 'nh-pier-w', kind: 'pier', x: -16, z: -84, rot: Math.PI * 1.1, opts: { length: 16, width: 4.5 } },
  { id: 'nh-boathouse-1', kind: 'boathouse', x: -24.7, z: -83.3, rot: Math.PI * 0.85, opts: { w: 7, d: 10 } },
  { id: 'nh-boathouse-2', kind: 'boathouse', x: -27, z: -61.9, rot: Math.PI * 0.7, opts: { w: 6.5, d: 9 } },
  { id: 'nh-shed', kind: 'warehouse', x: 11.7, z: -63.5, rot: -0.2, opts: { w: 10, d: 8 } },
  { id: 'nh-minka', kind: 'minka', x: -11.7, z: -63.5, rot: 0.2, opts: { w: 10, d: 8 } },
  { id: 'nh-netrack-1', kind: 'net-rack', x: 6, z: -82, rot: -0.2 },
  { id: 'nh-netrack-2', kind: 'net-rack', x: -6, z: -82, rot: 0.2 },
  { id: 'nh-boat-1', kind: 'boat', x: -8, z: -94, rot: 0.2, scale: 0.85 },
  { id: 'nh-boat-2', kind: 'boat', x: 16, z: -96, rot: -0.4, scale: 0.8 },
  { id: 'nh-seawall', kind: 'sea-wall', x: 22, z: -77, rot: 1.2, opts: { length: 18 } },
  { id: 'nh-bell', kind: 'bell-tower', x: -13.1, z: -79.4, rot: 0, scale: 0.75 },
  { id: 'nh-stage', kind: 'stage', x: 0, z: -62, rot: Math.PI, opts: { w: 11, d: 8 } },
  { id: 'nh-rock-1', kind: 'rock', x: -32, z: -88, rot: 1.4, scale: 1.4 },

  // ═══ Lighthouse Cape (-64, -37) — the exposed high cape ═════════════════
  { id: 'lh-tower', kind: 'lighthouse', x: -72, z: -43, rot: -0.524, scale: 0.92 },
  { id: 'lh-keepers', kind: 'keepers-house', x: -49.0, z: -30.0, rot: -0.7, opts: { w: 10, d: 7.5 } },
  { id: 'lh-store', kind: 'warehouse', x: -79.0, z: -30.0, rot: 1.047, opts: { w: 10, d: 7.5 } },
  { id: 'lh-rail', kind: 'rail', x: -64, z: -46, rot: 0.15, opts: { length: 16 } },
  { id: 'lh-bench-1', kind: 'bench', x: -74, z: -45, rot: 0.896 },
  { id: 'lh-lantern-1', kind: 'post-lantern', x: -55, z: -42, rot: 0 },
  { id: 'lh-rock-1', kind: 'rock', x: -78, z: -52, rot: 0.8, scale: 1.7 },
  { id: 'lh-rock-2', kind: 'rock', x: -50, z: -50, rot: 2.4, scale: 1.2 },

  // ═══ Shrine (-64, 37) — the western headland ════════════════════════════
  // The approach runs east→west along the sando: three torii, then the hall.
  { id: 'sr-torii-1', kind: 'torii', x: -46, z: 34, rot: Math.PI * 0.5, scale: 1.35 },
  { id: 'sr-torii-2', kind: 'torii', x: -54, z: 35, rot: Math.PI * 0.5, scale: 1.25 },
  { id: 'sr-torii-3', kind: 'torii', x: -60, z: 36, rot: Math.PI * 0.5, scale: 1.15 },
  { id: 'sr-komainu-l', kind: 'komainu', x: -66, z: 30, rot: Math.PI * 0.5, opts: { side: 1 } },
  { id: 'sr-komainu-r', kind: 'komainu', x: -66, z: 44, rot: Math.PI * 0.5, opts: { side: -1 } },
  { id: 'sr-temizuya', kind: 'temizuya', x: -62.8, z: 51.1, rot: 0},
  { id: 'sr-hall', kind: 'shrine-hall', x: -78, z: 37, rot: Math.PI * 0.5, opts: { w: 12, d: 10, honden: true } },
  { id: 'sr-bell', kind: 'bell-tower', x: -62.8, z: 22.9, rot: 0},
  { id: 'sr-lantern-1', kind: 'stone-lantern', x: -72, z: 29, rot: 0, scale: 1.15 },
  { id: 'sr-lantern-2', kind: 'stone-lantern', x: -72, z: 45, rot: 0, scale: 1.15 },
  { id: 'sr-lantern-3', kind: 'stone-lantern', x: -54, z: 29, rot: 0 },
  { id: 'sr-lantern-4', kind: 'stone-lantern', x: -54, z: 45, rot: 0 },
  { id: 'sr-rock-1', kind: 'rock', x: -86, z: 48, rot: 0.5, scale: 1.5 },
  { id: 'sr-rock-2', kind: 'rock', x: -84, z: 24, rot: 2.1, scale: 1.2 },

  // ═══ Summit (0, 0) — the inner shrine, at the top of everything ═════════
  { id: 'su-torii', kind: 'torii', x: 0, z: 9, rot: 0, scale: 1.2 },
  { id: 'su-hall', kind: 'shrine-hall', x: 0, z: -9, rot: 0, opts: { w: 9, d: 7.5, honden: true, small: true } },
  { id: 'su-bell', kind: 'bell-tower', x: 10.9, z: -4.6, rot: 0, scale: 0.85 },
  // The bell tower's mirror. A shrine court reads as a court because the approach is flanked;
  // with the bell alone on one side, the summit was symmetric everywhere except at eye level.
  { id: 'su-temizuya', kind: 'temizuya', x: -10.9, z: -4.6, rot: 0 },
  { id: 'su-marker', kind: 'summit-marker', x: -7, z: -3, rot: 0 },
  { id: 'su-rail', kind: 'rail', x: -3, z: 6, rot: 0, opts: { length: 8 } },
  { id: 'su-lantern-1', kind: 'stone-lantern', x: -7, z: -8, rot: 0 },
  { id: 'su-lantern-2', kind: 'stone-lantern', x: 7, z: -8, rot: 0 },
  { id: 'su-bench-1', kind: 'bench', x: -10, z: 3, rot: 0.4 },
  { id: 'su-bench-2', kind: 'bench', x: 10, z: 3, rot: -0.4 },
  { id: 'su-rock-1', kind: 'rock', x: 14, z: -12, rot: 1.2, scale: 1.2 },
  { id: 'su-rock-2', kind: 'rock', x: -14, z: -13, rot: 0.3, scale: 1.4 },
] as const;

const ACTIVITY_TEMPLATES: MapPack['world']['activityTemplates'] = [
  {
    id: 'morning-assembly',
    title: 'Morning Assembly',
    blurb: 'Everyone on the island, in one place, briefly.',
    zone: 'plaza',
    durationMin: 15,
    capacity: 0,
    checkinEnabled: true,
    formation: 'gather',
  },
  {
    id: 'lantern-walk',
    title: 'Lantern Walk',
    blurb: 'Up the shrine path, one lantern each.',
    zone: 'shrine',
    durationMin: 20,
    capacity: 60,
    checkinEnabled: true,
    formation: 'procession',
  },
  {
    id: 'harbor-market',
    title: 'Harbour Market',
    blurb: 'Stalls on the south quay until the light goes.',
    zone: 'south-harbor',
    durationMin: 45,
    capacity: 0,
    checkinEnabled: false,
    formation: 'gather',
  },
  {
    id: 'beach-concert',
    title: 'Beach Concert',
    blurb: 'Sit on the sand. Someone is playing.',
    zone: 'beach',
    durationMin: 30,
    capacity: 70,
    checkinEnabled: true,
    formation: 'seated',
  },
  {
    id: 'lamp-lighting',
    title: 'Lamp Lighting',
    blurb: 'The cape at dusk, when the lamp comes round.',
    zone: 'lighthouse',
    durationMin: 10,
    capacity: 50,
    checkinEnabled: true,
    formation: 'gather',
  },
  {
    id: 'morning-catch',
    title: 'Morning Catch',
    blurb: 'The north boats come back in. Everyone helps.',
    zone: 'north-harbor',
    durationMin: 25,
    capacity: 40,
    checkinEnabled: true,
    formation: 'gather',
  },
] as const;

export const NAGISA_ISLAND: MapPack = {
  id: 'nagisa-island',
  name: 'Nagisa Island',
  nameJa: '渚島',
  summary: 'A hexagon of six places around one mountain, and the sea on every side.',
  terrain: {
    extent: ISLAND_EXTENT,
    oceanRadius: OCEAN_RADIUS,
    coastRadius: COAST_RADIUS,
    summit: SUMMIT,
    massifRadius: MASSIF_RADIUS,
    capes: CAPES,
    bays: BAYS,
    shelves: SHELVES,
    relief: {
      rolling: 3.5,
      rollingVariation: 15,
      cliff: 16,
      detail: 1.8,
    },
    // The two harbours and the beach spit. Everywhere else on the ring gets cliffs.
    shelters: [
      { x: 0, z: 128, reach: 84 }, // south bay — where you arrive
      { x: 0, z: -128, reach: 80 }, // north bay — the fishing harbour
      { x: 62, z: 100, reach: 70 }, // the beach
    ],
    pads: PADS,
    paths: PATHS,
  },
  world: {
    zones: ZONES,
    landmarks: LANDMARKS,
    interactables: INTERACTABLES,
    activityTemplates: ACTIVITY_TEMPLATES,
    spawnPoints: SPAWN_POINTS,
    fallbackZone: 'coast',
  },
};

/** The hexagon's circumradius, re-exported for callers that lay things out on it. */
export { HEX_RADIUS };
