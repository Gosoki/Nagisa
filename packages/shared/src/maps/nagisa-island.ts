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

  /**
   * The saddle where the plaza's shelf runs into the old street's.
   *
   * The two are meant to be *one* shelf with no dip between them, and they are not: the
   * natural ground between their flats humps up to 10.4 m against the plaza's 8 and the
   * street's 9, so the ring road climbs two and a half metres and comes back down again
   * over twenty metres — a pointless little hill in the middle of the one stretch of the
   * island that is supposed to read as continuous.
   *
   * 8.6 m is the level the road wants at that station: a shade above the plaza, a shade
   * below the street, so it runs through as a grade rather than a bump.
   */
  { id: 'east-saddle', x: 79, z: -3, height: 8.6, inner: 9, outer: 22 },

  // — Inland ————————————————————————————————————————————————————————
  /** Notice-board terrace, one step up from the plaza floor. The one deliberate nesting. */
  { id: 'noticeboard', x: 48, z: 22, height: 8.4, inner: 8, outer: 12 },
  /**
   * The summit court: a flat terrace at the true peak, around the inner shrine.
   *
   * `inner` is 17 rather than 12 because the road runs straight through the middle of it, so
   * everything has to stand clear of a carriageway that takes eight of those metres. A hall
   * deep enough to have a veranda needs the rest of them before its back corners are off the
   * flat and onto the blend.
   *
   * `outer` stays at 30 even though widening it would smooth the last unwalkable band on the
   * mountain — the one at 40–50 m out, where the harbours' blends and this one meet. At 44
   * the ring grows far enough down the flank to reach the quays themselves and puts two
   * metres of fall under the harbour office and stage. A steep band halfway up a mountain is
   * a mountain; a tilted terrace is a defect.
   */
  { id: 'summit', x: SUMMIT.x, z: SUMMIT.z, height: SUMMIT.height, inner: 17, outer: 30 },
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
      // Straight to the peak, and the court is arranged around the fact rather than around
      // its absence. A detour that took the road *below* the summit did keep the terrace
      // clear, but it also meant the mountain road no longer reached the mountain: you
      // arrived at a junction and the last sixteen metres were not a road at all.
      //
      // So the road runs through, and the composition crosses it: gate and bell on the
      // approach side, hall and its court on the far side, everything on one axis square to
      // the carriageway. A road through a shrine's forecourt is ordinary; a shrine built
      // along a road is what most of them are.
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
      // The sandō, and the shrine's whole geometry, is this line: the hall stands at its head
      // facing back down it, the three torii sit on it, and the coast road crosses it at the
      // T where the two meet. Everything at the shrine is placed by station along this lane.
      [-64, 37], // shrine courtyard, at the T
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
      //
      // Pulled inland — (14, 52) and (32, 34), not (20, 60) and (40, 44) — because the two
      // ways from the quay to the plaza were running 12 to 20 m apart down the middle of the
      // same ground, which reads as one wide road that has been split rather than as a choice
      // between two. They are now 21 to 28 m apart: this one hugs the mountain's foot, the
      // ring road keeps the seaward side, and between them is somewhere rather than a median.
      [0, 74],
      [14, 52],
      [32, 34],
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
    // Where a crowd forms: at the stage, facing the way the stage does. Both follow
    // `sh-stage`, which moved inland when the quay road was cleared.
    stage: { dx: -8, dz: -19, facing: -0.073 },
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
    stage: { dx: 3, dz: 16.7, facing: -2.166 },
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
    stage: { dx: 0.5, dz: 12.8, facing: -3.068 },
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
    stage: { dx: 0, dz: -4, facing: 0 },
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
  // Offsets are from the zone anchor, and they follow the thing they belong to: every one of
  // these stands in front of a specific bell, board or bench, so a building that moves takes
  // its prompt with it. A prompt left behind is a "Ring" that rings nothing.
  { id: 'notice-board', zone: 'noticeboard', dx: -3.2, dz: 2.5, range: 4.5, kind: 'use', label: 'Read', effect: 'read_announcements' },
  { id: 'plaza-post', zone: 'plaza', dx: -13, dz: 7, range: 3.5, kind: 'use', label: 'Check in', effect: 'checkin_nearby' },
  { id: 'shrine-bell', zone: 'shrine', dx: -9.5, dz: -7, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'summit-bell', zone: 'summit', dx: 0, dz: 12.5, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'south-harbor-bell', zone: 'south-harbor', dx: 10.5, dz: 3.5, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'north-harbor-bell', zone: 'north-harbor', dx: 13.1, dz: -3.5, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'lighthouse-door', zone: 'lighthouse', dx: 0, dz: 3, range: 4, kind: 'use', label: 'Look', effect: 'none' },
  { id: 'summit-rail', zone: 'summit', dx: -21.5, dz: -7, range: 6, kind: 'use', label: 'Look', effect: 'none' },
  { id: 'teahouse-mat-a', zone: 'plaza', dx: 15.7, dz: -21.1, range: 2.5, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'teahouse-mat-b', zone: 'plaza', dx: 17.5, dz: -19.5, range: 2.5, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'beach-log', zone: 'beach', dx: 5, dz: 7, range: 3, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'plaza-bench', zone: 'plaza', dx: 3.6, dz: 9.9, range: 3, kind: 'sit', label: 'Sit', effect: 'none' },
] as const;

/**
 * Hand-placed landmarks — every building on Nagisa.
 *
 * Grouped by zone, and within a zone roughly in the order you would meet them walking in.
 * The coast road's lanterns, mile-posts and railings are *not* here: those are placed by
 * arc length along the path at build time, because spacing them by hand would be busywork
 * that goes stale the moment the road is re-routed.
 *
 * ### Everything here is placed *from a road*
 *
 * Almost every coordinate below was solved rather than eyeballed — see
 * `scripts/layout-solve.mjs`. A building beside a lane is authored as *this far along that
 * lane, this far off its centreline, facing the traffic*, and the script converts that to an
 * `x`, a `z` and a yaw. Two things come out right for free that were persistently wrong when
 * they were typed by hand:
 *
 * - **The setback clears what the building actually occupies.** A machiya's eaves reach
 *   0.9 m past its plaster, a minka's veranda and steps 2.4 m past its front wall, a funaya's
 *   slipway 4.3 m past its. Nineteen buildings were standing in a carriageway while every
 *   wall line was clear of it.
 * - **The door is on the street.** Every builder in `props/buildings.ts` models its entrance
 *   on the local −z face, so a yaw is a statement about which way a building is *turned* and
 *   not merely how it is squared up. Both rows of the Old Street had their backs to it.
 *
 * The rule the layout is held to — and `npm run audit:placement` enforces — is that a
 * frontage may address the road or stand side-on to it, but never turn away from it. The one
 * exemption is a frontage that opens onto water instead, which is what a boat house, a beach
 * hut and a quay stage are *for*.
 */
const LANDMARKS: MapPack['world']['landmarks'] = [
  // ═══ South Harbour (0, 74) — the arrival port ═══════════════════════════
  // The quay road runs east–west across the terrace. Warehouses, stalls and the bell stand
  // on the seaward side facing back at it; the office and the stage are behind it inland.
  { id: 'sh-torii-sea', kind: 'torii', x: 0, z: 112, rot: 0.05, scale: 1.7, opts: { inWater: true } },
  { id: 'sh-pier-main', kind: 'pier', x: 0, z: 88, rot: 0, opts: { length: 30, width: 7, lamps: true } },
  // Moved 4 m west and 2 m inland: its seaward tip used to end inside the main pier's deck.
  { id: 'sh-pier-west', kind: 'pier', x: -24, z: 80, rot: Math.PI * 0.4, opts: { length: 18, width: 4.5 } },
  // Turned to run north–south and pulled in toward the quay. It used to lie across the top of
  // the beach at 32°, so the mole that shelters the harbour also ran between the beach huts
  // and the stage — which from the sand reads as a stone path nobody can walk on.
  { id: 'sh-breakwater', kind: 'breakwater', x: 28, z: 100, rot: -0.25, opts: { length: 34, beacon: true } },
  { id: 'sh-boat-1', kind: 'boat', x: 16, z: 98, rot: 0.3, opts: { style: 'ferry', scale: 1.25 } },
  { id: 'sh-boat-2', kind: 'boat', x: -12, z: 96, rot: -0.7 },
  // On the quay *edge*, twenty-three metres further out. It used to stand in the middle of
  // the flat with 2.4 m of terrace on both sides of it, holding nothing back at all.
  { id: 'sh-seawall', kind: 'sea-wall', x: 14, z: 108, rot: 1.75, opts: { length: 14 } },
  { id: 'sh-warehouse-1', kind: 'warehouse', x: 16.7, z: 86.6, rot: 0.073, opts: { w: 10, d: 8, floors: 2 } },
  { id: 'sh-warehouse-2', kind: 'warehouse', x: -19.5, z: 82.6, rot: -0.073, opts: { w: 10, d: 8 } },
  { id: 'sh-office', kind: 'machiya', x: 20.0, z: 62.0, rot: 1.004, opts: { w: 10, d: 10, floors: 2, sign: true } },
  { id: 'sh-stall-1', kind: 'market-stall', x: -9.7, z: 79.8, rot: -0.073, opts: { cloth: 1 } },
  { id: 'sh-stall-2', kind: 'market-stall', x: -3.7, z: 80.2, rot: -0.073, opts: { cloth: 2 } },
  { id: 'sh-stall-3', kind: 'market-stall', x: 3.5, z: 80.2, rot: 0.073, opts: { cloth: 0 } },
  { id: 'sh-stage', kind: 'stage', x: -8.0, z: 55.0, rot: 3.069, opts: { w: 12, d: 9 } },
  { id: 'sh-bell', kind: 'bell-tower', x: 10.5, z: 79.9, rot: 0.073, scale: 0.8 },
  { id: 'sh-lantern-1', kind: 'post-lantern', x: -7.6, z: 79.5, rot: -0.073 },
  { id: 'sh-lantern-2', kind: 'post-lantern', x: 7.4, z: 79.5, rot: 0.073 },
  { id: 'sh-banner-1', kind: 'banner', x: -13.7, z: 79.5, rot: -0.073 },
  { id: 'sh-banner-2', kind: 'banner', x: 13.4, z: 79.5, rot: 0.073 },
  { id: 'sh-rock-1', kind: 'rock', x: -26, z: 92, rot: 1.1, scale: 1.3 },

  // ═══ Sunset Beach (46, 92) — the sand east of the quay ══════════════════
  // The one place on the island that faces *away* from its road on purpose: the huts open
  // onto the sand and the stage plays to a crowd sitting on it, with the water behind them.
  //
  // Squared to the **shoreline**, which here runs east-north-east — sampled where the ground
  // crosses sea level, from (34, 115) to (58, 126). Everything used to be square to the world
  // instead, so three buildings on a beach met the water at eleven degrees and read as having
  // been dropped rather than built, and the west hut stood in the middle of the breakwater.
  { id: 'bh-hut-1', kind: 'beach-hut', x: 37.3, z: 88.1, rot: 2.712, opts: { w: 6, d: 5 } },
  { id: 'bh-hut-2', kind: 'beach-hut', x: 60.1, z: 98.5, rot: 2.712, opts: { w: 6, d: 5 } },
  { id: 'bh-stage', kind: 'stage', x: 48.7, z: 93.3, rot: 2.712, opts: { w: 11, d: 8 } },
  { id: 'bh-bench-1', kind: 'bench', x: 51, z: 99, rot: 0.62 },
  { id: 'bh-boat-1', kind: 'boat', x: 58, z: 102, rot: 1.8, scale: 0.75 },
  { id: 'bh-rock-1', kind: 'rock', x: 66, z: 90, rot: 0.7, scale: 1.5 },

  // ═══ Main Plaza (64, 37) — the civic centre ═════════════════════════════
  // The stage on the seaward side of the ring road with the farmhouse across from it, and
  // the teahouse further south where the road bends away — the quiet corner it was always
  // meant to be, rather than a building wedged against the carriageway.
  { id: 'pl-stage', kind: 'stage', x: 74.6, z: 58.8, rot: 0.976, opts: { w: 12, d: 9, roof: true, tiers: true } },
  { id: 'pl-gate-s', kind: 'gate', x: 48.2, z: 60.3, rot: 2.547, scale: 1.1 },
  { id: 'pl-gate-w', kind: 'gate', x: 58.6, z: 32.0, rot: 0.818 },
  { id: 'pl-minka', kind: 'minka', x: 85.4, z: 38.7, rot: 1.118, opts: { w: 11, d: 9 } },
  { id: 'pl-well', kind: 'well', x: 64.8, z: 64.3, rot: 0.976 },
  { id: 'pl-bench-1', kind: 'bench', x: 68.0, z: 47.1, rot: 0.976 },
  { id: 'pl-bench-2', kind: 'bench', x: 53.1, z: 37.1, rot: -2.166 },
  { id: 'pl-banner-1', kind: 'banner', x: 77.3, z: 30.3, rot: 1.118 },
  { id: 'pl-banner-2', kind: 'banner', x: 61.1, z: 22.4, rot: -2.024 },
  // The teahouse: a v2 zone kept as a building, on the quiet side of the plaza.
  { id: 'pl-teahouse', kind: 'teahouse', x: 88.0, z: 23.0, rot: 1.118, opts: { w: 11, d: 8.5, veranda: true } },

  // — Notice-board terrace (48, 22), one step up from the plaza ————————
  { id: 'nb-board', kind: 'notice-board', x: 44.0, z: 18.0, rot: -2.498, scale: 1.4 },
  { id: 'nb-bench-2', kind: 'bench', x: 52.0, z: 18.0, rot: 2.388 },
  { id: 'nb-bench-1', kind: 'bench', x: 44.6, z: 27.6, rot: -2.498 },

  // ═══ Old Street (64, -37) — two rows facing each other ══════════════════
  // Two rows of row houses laid out **along the ring road**, at eleven metres either side of
  // its centreline, each row turned to face across at the other.
  //
  // Both rows used to be turned the other way — facing outward, backs to the street, which is
  // the one arrangement a street cannot survive. The yaws below are the same two angles as
  // before with the rows swapped, which is all it took; the sign of a yaw is the difference
  // between a village and the back of a stage set.
  //
  // Spaced eleven metres along the road, which is the eight-metre frontage plus its eaves
  // plus a metre of daylight. They were at eight and nine, which let the audit's party-wall
  // tolerance carry them — correct for a 町屋 terrace on paper, and from the street a row of
  // roofs growing through each other. A terrace shares *walls*; it does not share eaves.
  { id: 'ov-machiya-1', kind: 'machiya', x: 61.5, z: -17.5, rot: -1.118, opts: { w: 8, d: 10, floors: 2, sign: true } },
  { id: 'ov-machiya-2', kind: 'machiya', x: 56.7, z: -27.4, rot: -1.118, opts: { w: 8, d: 10, floors: 2 } },
  { id: 'ov-machiya-3', kind: 'machiya', x: 51.0, z: -36.9, rot: -0.976, opts: { w: 8, d: 10, floors: 1, sign: true } },
  // The bathhouse is on a back lane behind the east row rather than at the end of the west
  // one. Its old place was out at the terrace rim, where the ground has a fall to it now that
  // the blend ring widens on the uphill side — and a bathhouse is the widest building on the
  // street, so it was the one that noticed.
  { id: 'ov-bathhouse', kind: 'bathhouse', x: 85.7, z: -47.3, rot: 2.014, opts: { w: 10, d: 8 } },
  // The kura anchors the far end of the east row, where the street meets its north gate.
  { id: 'ov-warehouse', kind: 'warehouse', x: 81.8, z: -25.1, rot: 2.024, opts: { w: 10, d: 8 } },
  { id: 'ov-machiya-4', kind: 'machiya', x: 76.4, z: -36.3, rot: 2.024, opts: { w: 8, d: 10, floors: 2 } },
  { id: 'ov-machiya-5', kind: 'machiya', x: 71.0, z: -45.9, rot: 2.166, opts: { w: 8, d: 10, floors: 1, sign: true } },
  { id: 'ov-machiya-6', kind: 'machiya', x: 64.8, z: -55.0, rot: 2.166, opts: { w: 8, d: 10, floors: 2 } },
  // The west row runs out three houses short of the street's south gate, because the
  // bathhouse that used to close it moved to the back lane. A notice board fills the gap:
  // a village needs somewhere the village reads things, and it belongs on the street.
  { id: 'ov-board', kind: 'notice-board', x: 48.7, z: -45.4, rot: -0.976, scale: 1.3 },
  { id: 'ov-bench-2', kind: 'bench', x: 45.3, z: -50.4, rot: -0.976 },
  { id: 'ov-gate-s', kind: 'gate', x: 72.9, z: -18.6, rot: -2.689 },
  { id: 'ov-gate-n', kind: 'gate', x: 49.7, z: -58.2, rot: -2.547 },
  { id: 'ov-well', kind: 'well', x: 60.9, z: -60.9, rot: 2.166 },
  { id: 'ov-lantern-1', kind: 'post-lantern', x: 61.4, z: -26.3, rot: -1.118 },
  { id: 'ov-lantern-2', kind: 'post-lantern', x: 70.9, z: -38.8, rot: 2.024 },
  { id: 'ov-bench-1', kind: 'bench', x: 57.9, z: -33.5, rot: -1.118 },

  // ═══ North Harbour (0, -74) — the working fishery ═══════════════════════
  // Both funaya now face the bay, which is the only direction a boat house can face: the
  // ground floor is open so a boat can be pulled up the slipway straight into it, and the
  // pair of them used to have that slipway pointing at the coast road.
  { id: 'nh-torii-sea', kind: 'torii', x: 0, z: -110, rot: 0.1, scale: 1.4, opts: { inWater: true } },
  { id: 'nh-pier-e', kind: 'pier', x: 8, z: -86, rot: Math.PI, opts: { length: 20, width: 5 } },
  { id: 'nh-pier-w', kind: 'pier', x: -16, z: -84, rot: Math.PI * 1.1, opts: { length: 16, width: 4.5 } },
  { id: 'nh-boathouse-1', kind: 'boathouse', x: -22.1, z: -83.0, rot: 0.073, opts: { w: 7, d: 10 } },
  { id: 'nh-boathouse-2', kind: 'boathouse', x: -6.1, z: -83.7, rot: 0.073, opts: { w: 6.5, d: 9 } },
  { id: 'nh-shed', kind: 'warehouse', x: 15.8, z: -61.8, rot: -0.073, opts: { w: 10, d: 8 } },
  { id: 'nh-minka', kind: 'minka', x: -13.5, z: -60.7, rot: 0.073, opts: { w: 10, d: 8 } },
  { id: 'nh-netrack-1', kind: 'net-rack', x: 7.1, z: -81.0, rot: 3.069 },
  { id: 'nh-netrack-2', kind: 'net-rack', x: 3.1, z: -81.3, rot: 3.069 },
  { id: 'nh-boat-1', kind: 'boat', x: -10, z: -95, rot: 0.2, scale: 0.85 },
  { id: 'nh-boat-2', kind: 'boat', x: 16, z: -96, rot: -0.4, scale: 0.8 },
  { id: 'nh-seawall', kind: 'sea-wall', x: 23, z: -107.8, rot: 1.63, opts: { length: 14 } },
  { id: 'nh-bell', kind: 'bell-tower', x: 13.1, z: -79.6, rot: 3.069, scale: 0.75 },
  { id: 'nh-stage', kind: 'stage', x: 0.5, z: -61.2, rot: 0.073, opts: { w: 11, d: 8 } },
  { id: 'nh-rock-1', kind: 'rock', x: -32, z: -88, rot: 1.4, scale: 1.4 },

  // ═══ Lighthouse Cape (-64, -37) — the exposed high cape ═════════════════
  // The keeper's cottage and the store are a mirrored pair across the coast road, both
  // addressing it. The railing is on the seaward rim of the terrace where the ground
  // genuinely falls away — it used to stand on flat grass in the middle of the cape.
  { id: 'lh-tower', kind: 'lighthouse', x: -72, z: -43, rot: -0.524, scale: 0.92 },
  { id: 'lh-keepers', kind: 'keepers-house', x: -60.6, z: -22.9, rot: 1.118, opts: { w: 10, d: 7.5 } },
  { id: 'lh-store', kind: 'warehouse', x: -77.7, z: -31.2, rot: -2.024, opts: { w: 10, d: 7.5 } },
  { id: 'lh-rail', kind: 'rail', x: -85.2, z: -54.9, rot: 2.452, opts: { length: 16 } },
  { id: 'lh-bench-1', kind: 'bench', x: -68.2, z: -43.2, rot: -2.166 },
  { id: 'lh-rock-1', kind: 'rock', x: -78, z: -52, rot: 0.8, scale: 1.7 },
  { id: 'lh-rock-2', kind: 'rock', x: -50, z: -50, rot: 2.4, scale: 1.2 },

  // ═══ Shrine (-64, 37) — the western headland ════════════════════════════
  // The whole composition is one line: the **sandō**, which is `shrine-ascent`'s first leg
  // running east-south-east from the T where it meets the coast road at (-64, 37).
  //
  // It was previously drawn approximately. The three torii sat one, two and four metres off
  // that line at yaws 21° from square to it, so the gates you walk through were neither on the
  // path nor across it; and the hall stood at the far end facing *west*, with its back to its
  // own approach and its doors looking out to sea.
  //
  // Now every one of these is placed by station along the sandō and squared to it: the hall at
  // its head fourteen metres west of the T, exactly where the road crosses, facing back down
  // the approach; the three gates on the centreline at 6, 13 and 20 m, growing as they go out;
  // the guardian dogs, the bell and the basin in mirrored pairs either side.
  { id: 'sr-torii-1', kind: 'torii', x: -45.4, z: 29.7, rot: 2.078, scale: 1.35 },
  { id: 'sr-torii-2', kind: 'torii', x: -49.6, z: 31.4, rot: 1.942, scale: 1.25 },
  { id: 'sr-torii-3', kind: 'torii', x: -53.7, z: 33.0, rot: 1.942, scale: 1.15 },
  { id: 'sr-komainu-l', kind: 'komainu', x: -55.4, z: 38.9, rot: -1.200, opts: { side: 1 } },
  { id: 'sr-komainu-r', kind: 'komainu', x: -58.6, z: 29.7, rot: -1.200, opts: { side: -1 } },
  { id: 'sr-temizuya', kind: 'temizuya', x: -67.2, z: 51.1, rot: -1.203 },
  { id: 'sr-hall', kind: 'shrine-hall', x: -77.0, z: 42.1, rot: -1.203, opts: { w: 11, d: 9, honden: true } },
  { id: 'sr-bell', kind: 'bell-tower', x: -75.9, z: 28.7, rot: -1.203 },
  { id: 'sr-rock-1', kind: 'rock', x: -88, z: 52, rot: 0.5, scale: 1.5 },
  { id: 'sr-rock-2', kind: 'rock', x: -84, z: 24, rot: 2.1, scale: 1.2 },

  // ═══ Summit (0, 0) — the inner shrine, at the top of everything ═════════
  // The road runs straight through the court, so the court is built **across** it rather
  // than around it: one axis at right angles to the carriageway, with the approach on the
  // south side and the shrine proper on the north.
  //
  // South of the road, in the order you meet them coming up: the torii, then the bell. North
  // of it: the hall facing back across at the gate, the basin and the summit stone flanking
  // it, benches at the rim. Nothing stands within five metres of the centreline, so the road
  // is a road the whole way to the top instead of ending at a junction below the terrace.
  { id: 'su-torii', kind: 'torii', x: 0, z: 15, rot: 0, scale: 1.2 },
  { id: 'su-bell', kind: 'bell-tower', x: 0, z: 9.5, rot: 0, scale: 0.85 },
  // — north of the road ————————————————————————————————————————————
  { id: 'su-hall', kind: 'shrine-hall', x: 0, z: -11, rot: 3.142, opts: { w: 7.5, d: 6, honden: true, small: true } },
  { id: 'su-temizuya', kind: 'temizuya', x: -8.5, z: -9, rot: 3.142 },
  // The summit's own pair. The road crosses this court through the middle rather than at
  // its edge, so the threshold here is the torii and not a terrace rim — these flank it.
  { id: 'su-lantern-1', kind: 'stone-lantern', x: -4.2, z: 15.5, rot: 0 },
  { id: 'su-lantern-2', kind: 'stone-lantern', x: 4.2, z: 15.5, rot: 0 },
  { id: 'su-marker', kind: 'summit-marker', x: 8.5, z: -9, rot: 0 },
  { id: 'su-bench-1', kind: 'bench', x: -11, z: -12, rot: 0.4 },
  { id: 'su-bench-2', kind: 'bench', x: 11, z: -12, rot: -0.4 },
  // The belvedere, out on the western rim where the mountain actually starts to fall away.
  // A railing is a statement that there is a drop here; on the flat of the court it was
  // fencing off nothing at all.
  { id: 'su-rail', kind: 'rail', x: -23.8, z: -7.7, rot: -0.398, opts: { length: 12 } },
  { id: 'su-rock-1', kind: 'rock', x: 19, z: -16, rot: 1.2, scale: 1.2 },
  { id: 'su-rock-2', kind: 'rock', x: -18, z: -17, rot: 0.3, scale: 1.4 },

  // ═══ Zone entrances ═════════════════════════════════════════════════════
  // A pair of stone tōrō either side of the lane at every point where it crosses into a
  // terrace's flat — which is where a place actually begins, and the only threshold on the
  // island that was not marked.
  //
  // These replace twelve lanterns that stood in front of buildings: two flanking the shrine
  // hall, two more up its sandō, four around the plaza, four at the summit. In front of a
  // building a lantern says nothing the building was not already saying, and half of them
  // had no partner, so they read as clutter rather than as composition. At a threshold a
  // pair says *you are arriving somewhere*, which is the one thing a lantern is for.
  { id: 'sh-gatelamp-1a', kind: 'stone-lantern', x: 23.4, z: 78.1, rot: -1.498 },
  { id: 'sh-gatelamp-1b', kind: 'stone-lantern', x: 22.5, z: 66.5, rot: -1.498 },
  { id: 'sh-gatelamp-2a', kind: 'stone-lantern', x: -23.3, z: 78.1, rot: -1.644 },
  { id: 'sh-gatelamp-2b', kind: 'stone-lantern', x: -22.5, z: 66.5, rot: -1.644 },
  { id: 'pl-gatelamp-1a', kind: 'stone-lantern', x: 57.8, z: 56.5, rot: -0.595 },
  { id: 'pl-gatelamp-1b', kind: 'stone-lantern', x: 48.2, z: 50.0, rot: -0.595 },
  { id: 'pl-gatelamp-2a', kind: 'stone-lantern', x: 81.9, z: 13.4, rot: -0.453 },
  { id: 'pl-gatelamp-2b', kind: 'stone-lantern', x: 71.5, z: 8.3, rot: -0.453 },
  { id: 'ov-gatelamp-1a', kind: 'stone-lantern', x: 79.3, z: -18.9, rot: 0.453 },
  { id: 'ov-gatelamp-1b', kind: 'stone-lantern', x: 68.8, z: -13.8, rot: 0.453 },
  { id: 'ov-gatelamp-2a', kind: 'stone-lantern', x: 55.9, z: -59.3, rot: 0.595 },
  { id: 'ov-gatelamp-2b', kind: 'stone-lantern', x: 46.3, z: -52.8, rot: 0.595 },
  { id: 'nh-gatelamp-1a', kind: 'stone-lantern', x: 23.2, z: -78.1, rot: 1.498 },
  { id: 'nh-gatelamp-1b', kind: 'stone-lantern', x: 22.4, z: -66.5, rot: 1.498 },
  { id: 'nh-gatelamp-2a', kind: 'stone-lantern', x: -23.5, z: -78.1, rot: 1.644 },
  { id: 'nh-gatelamp-2b', kind: 'stone-lantern', x: -22.7, z: -66.5, rot: 1.644 },
  { id: 'lh-gatelamp-1a', kind: 'stone-lantern', x: -56.6, z: -58.3, rot: 2.547 },
  { id: 'lh-gatelamp-1b', kind: 'stone-lantern', x: -47.0, z: -51.8, rot: 2.547 },
  { id: 'lh-gatelamp-2a', kind: 'stone-lantern', x: -78.9, z: -19.5, rot: 2.689 },
  { id: 'lh-gatelamp-2b', kind: 'stone-lantern', x: -68.5, z: -14.5, rot: 2.689 },
  { id: 'sr-gatelamp-1a', kind: 'stone-lantern', x: -78.3, z: 20.8, rot: -2.689 },
  { id: 'sr-gatelamp-1b', kind: 'stone-lantern', x: -67.9, z: 15.8, rot: -2.689 },
  { id: 'sr-gatelamp-2a', kind: 'stone-lantern', x: -56.9, z: 57.8, rot: -2.547 },
  { id: 'sr-gatelamp-2b', kind: 'stone-lantern', x: -47.3, z: 51.3, rot: -2.547 },
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
