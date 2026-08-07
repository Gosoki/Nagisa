/**
 * 灯籠環礁 Lantern Atoll — the second map.
 * =======================================
 *
 * A ring of sand around a shallow lagoon, one lane all the way round, four places on it,
 * and no mountain at all.
 *
 * This map exists to keep the decoupling honest. A "swappable map system" with one map in it
 * is an untested claim: any coupling that survived the refactor stays invisible until
 * something with different numbers is loaded through the same code. The atoll is
 * deliberately unlike Nagisa Island in the ways most likely to expose a leak —
 *
 * - **No massif.** `summit.height` is 3.5 m, so anything that assumed a tall centre, banded
 *   terrain colours by absolute height, or sized a camera to a 26 m peak, shows it here.
 * - **A different footprint.** 118 m extent against 175 m, which resizes the meshing grid
 *   and the path segment index.
 * - **One route, closed.** No branches, so the junction-pinning code path is exercised by
 *   its absence rather than its presence.
 * - **Four zones, not nine**, with different ids — which catches anything that hard-coded
 *   `'plaza'` or indexed a zone list by position.
 *
 * It is a real place you can walk around, not a fixture: it satisfies the same `world-smoke`
 * contract as the island, and `npm run test:world -- --map lantern-atoll` proves it.
 */

import type { MapPack } from '../map/types.js';

/** Distance from the lagoon centre to the ring of sand. */
const RING_RADIUS = 62;

export const LANTERN_ATOLL: MapPack = {
  id: 'lantern-atoll',
  name: 'Lantern Atoll',
  nameJa: '灯籠環礁',
  summary: 'A ring of sand around a lagoon, and one lane all the way round.',

  terrain: {
    extent: 118,
    oceanRadius: 2400,
    // The ring itself. The lagoon inside it is cut back out by the central bay below, which
    // is how an atoll is made: a disc, minus its middle.
    coastRadius: 88,
    // Not a summit so much as the highest dune. Kept above zero so the massif code has
    // something to do and the ground is not perfectly level.
    summit: { x: 0, z: 0, height: 3.5 },
    massifRadius: 96,

    capes: [
      { x: -74, z: -30, reach: 40, strength: 0.16 }, // the west spit
      { x: 70, z: 40, reach: 38, strength: 0.14 }, // the east bar
    ],

    bays: [
      // The lagoon. The mask at the centre of a disc island is 1.0, so a bay has to be
      // stronger than that to actually open water there rather than merely dish the ground —
      // at 0.62 this was a low island with a hollow, which is not an atoll.
      { x: 0, z: 0, reach: 50, strength: 1.35 },
      { x: 8, z: 84, reach: 30, strength: 0.3 }, // the southern pass, where boats come in
    ],

    shelves: [],

    // A tenth of the island's relief, because it is a tenth of the island's height. Sand
    // does not have sea cliffs; the 2 m here is the low bank on the seaward side.
    relief: {
      rolling: 0.9,
      rollingVariation: 2.4,
      cliff: 2.0,
      detail: 0.3,
    },

    // The southern pass and the landing behind it. The rest of the seaward edge keeps its
    // bank, which is what stops the ring reading as a flat washer.
    shelters: [{ x: 0, z: 78, reach: 46 }],

    pads: [
      // `inner` 24, not 20: the terraces now meet the ground with a cut face rather than a
      // smoothstep ring (see `paddedHeight`), and the two landing huts sit with their
      // corners a couple of metres past the old flat — which the old ring barely noticed and
      // a face does. The atoll's whole relief is 3.5 m, so a wider flat costs it nothing.
      { id: 'landing', x: 0, z: 62, height: 1.8, inner: 24, outer: 32 },
      { id: 'lantern-house', x: -RING_RADIUS, z: 0, height: 3.2, inner: 20, outer: 32 },
      { id: 'north-camp', x: 0, z: -RING_RADIUS, height: 2.6, inner: 20, outer: 32 },
      { id: 'east-market', x: RING_RADIUS, z: 0, height: 2.4, inner: 20, outer: 32 },
    ],

    paths: [
      {
        id: 'coast',
        name: 'Ring Lane',
        // Eight points around a circle of RING_RADIUS. Written out rather than generated so
        // the pack stays what it claims to be: data you can read and edit.
        points: [
          [0, 62],
          [44, 44],
          [62, 0],
          [44, -44],
          [0, -62],
          [-44, -44],
          [-62, 0],
          [-44, 44],
          [0, 62], // repeated first point — this is what makes it a loop
        ],
        halfWidth: 3.0,
        shoulder: 3.4,
        carve: 0.9,
        surface: 'boardwalk',
      },
    ],
  },

  world: {
    zones: [
      {
        id: 'landing',
        name: 'The Landing',
        nameJa: '船着き',
        kind: 'venue',
        x: 0,
        z: 62,
        radius: 30,
        stage: { dx: 0, dz: -6, facing: 0 },
        softCapacity: 24,
        ambience: 'harbor',
        caption: 'The boat leaves when it leaves. Until then, this is where everyone is.',
      },
      {
        id: 'lantern-house',
        name: 'Lantern House',
        nameJa: '灯籠堂',
        kind: 'venue',
        x: -RING_RADIUS,
        z: 0,
        radius: 28,
        stage: { dx: 4, dz: 0, facing: Math.PI / 2 },
        softCapacity: 20,
        ambience: 'wind',
        caption: 'Someone lights it at dusk. Nobody has ever admitted to being that someone.',
      },
      {
        id: 'north-camp',
        name: 'North Camp',
        nameJa: '北の宿',
        kind: 'rest',
        x: 0,
        z: -RING_RADIUS,
        radius: 27,
        softCapacity: 16,
        ambience: 'waves',
        caption: 'Four windbreaks and a fire pit. It is enough.',
      },
      {
        id: 'east-market',
        name: 'East Market',
        nameJa: '東市',
        kind: 'venue',
        x: RING_RADIUS,
        z: 0,
        radius: 27,
        stage: { dx: -5, dz: 0, facing: -Math.PI / 2 },
        softCapacity: 18,
        ambience: 'town',
        caption: 'Three stalls, and an argument about the price of rope that predates the stalls.',
      },
      {
        id: 'coast',
        name: 'The Ring',
        nameJa: '環',
        kind: 'transit',
        x: 0,
        z: 0,
        radius: 9999,
        softCapacity: 0,
        ambience: 'waves',
        caption: 'Sand on one side, lagoon on the other, all the way round.',
      },
    ],

    landmarks: [
      // ── The landing ─────────────────────────────────────────────────────────
      // The pair of huts and the pair of lanterns are mirrored about the x = 0 lane, which
      // is the axis you arrive along: what you see first is symmetrical, and everything
      // further round the ring is not. Both huts open onto the lane rather than away from it.
      { id: 'at-pier', kind: 'pier', x: 0, z: 87, rot: 0 },
      { id: 'at-boat', kind: 'boat', x: -7, z: 92, rot: 0.3 },
      { id: 'at-hut-w', kind: 'beach-hut', x: -18.7, z: 62.7, rot: -0.388 },
      { id: 'at-hut-e', kind: 'beach-hut', x: 18.6, z: 62.7, rot: 0.388 },
      { id: 'at-board', kind: 'notice-board', x: 0, z: 54, rot: 0 },
      { id: 'at-lantern-w', kind: 'post-lantern', x: -5, z: 68, rot: 0 },
      { id: 'at-lantern-e', kind: 'post-lantern', x: 5, z: 68, rot: 0 },
      { id: 'at-rock-w', kind: 'rock', x: -21, z: 71, rot: 0.8, scale: 1.1 },
      { id: 'at-rock-e', kind: 'rock', x: 22, z: 69, rot: 2.1, scale: 0.9 },

      // ── Lantern house ───────────────────────────────────────────────────────
      // The tower and the keeper's house both stand on the seaward side of the lane and both
      // address it; the stone lanterns flank the approach, mirrored about z = 0. The two sea
      // walls are out on the bank where the sand actually drops to the water — they used to
      // stand on the flat of the terrace, twenty metres short of anything to hold back.
      { id: 'at-tower', kind: 'lighthouse', x: -70.4, z: -3.7, rot: -1.959 },
      { id: 'at-keeper', kind: 'keepers-house', x: -65.2, z: -15.6, rot: -1.959 },
      { id: 'at-stone-n', kind: 'stone-lantern', x: -RING_RADIUS + 9, z: -5, rot: 0 },
      { id: 'at-stone-s', kind: 'stone-lantern', x: -RING_RADIUS + 9, z: 5, rot: 0 },
      { id: 'at-wall-n', kind: 'sea-wall', x: -91, z: -23, rot: -0.2, opts: { length: 16 } },
      { id: 'at-wall-s', kind: 'sea-wall', x: -92, z: 9, rot: 0.35, opts: { length: 16 } },

      // ── North camp ──────────────────────────────────────────────────────────
      // One-sided on purpose. A ring where every place is symmetrical reads as a diagram.
      { id: 'at-shelter-a', kind: 'beach-hut', x: 14.2, z: -64.5, rot: 2.753 },
      { id: 'at-shelter-b', kind: 'beach-hut', x: -13.9, z: -64.6, rot: -2.753 },
      { id: 'at-net-rack', kind: 'net-rack', x: 19.6, z: -61.9, rot: 2.753 },
      { id: 'at-bench-n', kind: 'bench', x: -2, z: -RING_RADIUS + 7, rot: Math.PI },
      { id: 'at-well', kind: 'well', x: 7.1, z: -52.4, rot: 0 },

      // ── East market ─────────────────────────────────────────────────────────
      // A row rather than two facing rows: both stalls on the seaward side of the lane with
      // the kura behind them, all three turned to the traffic. The stalls are mirrored about
      // z = 0, so the market still reads as composed from the lane you arrive on.
      { id: 'at-stall-n', kind: 'market-stall', x: 65.0, z: -8.7, rot: 1.959 },
      { id: 'at-stall-s', kind: 'market-stall', x: 64.9, z: 8.8, rot: 1.182 },
      { id: 'at-banner-n', kind: 'banner', x: 62.3, z: -15.2, rot: 1.959 },
      { id: 'at-banner-s', kind: 'banner', x: 62.2, z: 15.3, rot: 1.182 },
      { id: 'at-warehouse', kind: 'warehouse', x: 75.0, z: 1.0, rot: 1.494 },
      { id: 'at-market-bench', kind: 'bench', x: RING_RADIUS - 14, z: 0, rot: -Math.PI / 2 },
    ],

    interactables: [
      {
        id: 'at-board-main',
        zone: 'landing',
        dx: 0,
        dz: -8,
        range: 3.2,
        kind: 'use',
        label: 'Read',
        effect: 'read_announcements',
      },
      {
        id: 'at-bench-north',
        zone: 'north-camp',
        dx: -2,
        dz: 7,
        range: 2.4,
        kind: 'sit',
        label: 'Sit',
        effect: 'none',
      },
      {
        id: 'at-market-bench',
        zone: 'east-market',
        dx: -14,
        dz: 0,
        range: 2.4,
        kind: 'sit',
        label: 'Sit',
        effect: 'none',
      },
    ],

    activityTemplates: [
      {
        id: 'atoll-gathering',
        title: 'Gathering',
        blurb: 'Whoever is here, is here.',
        zone: 'landing',
        durationMin: 45,
        capacity: 24,
        checkinEnabled: true,
        formation: 'gather',
      },
      {
        id: 'atoll-lighting',
        title: 'Lighting',
        blurb: 'Dusk, at the tower. It takes about as long as it takes.',
        zone: 'lantern-house',
        durationMin: 20,
        capacity: 20,
        checkinEnabled: false,
        formation: 'procession',
      },
      {
        id: 'atoll-market',
        title: 'Market',
        blurb: 'Three stalls and an argument about the price of rope.',
        zone: 'east-market',
        durationMin: 60,
        capacity: 18,
        checkinEnabled: true,
        formation: 'gather',
      },
    ],

    spawnPoints: [
      [-5, 64],
      [5, 64],
      [0, 70],
      [-9, 58],
      [9, 58],
      [0, 56],
    ],

    fallbackZone: 'coast',
  },
};
