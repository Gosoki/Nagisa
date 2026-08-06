// packages/shared/src/map/registry.ts
var packs = /* @__PURE__ */ new Map();
var listeners = /* @__PURE__ */ new Set();
var active = null;
function registerMap(pack) {
  packs.set(pack.id, pack);
  if (active?.id === pack.id) setActiveMap(pack.id);
}
function activeMap() {
  if (!active) throw new Error("no active map \u2014 import @nagisa/shared/maps or call setActiveMap() first");
  return active;
}
function activeMapId() {
  return active?.id ?? null;
}
function setActiveMap(id) {
  const pack = packs.get(id);
  if (!pack) {
    throw new Error(`unknown map "${id}" \u2014 registered: ${[...packs.keys()].join(", ") || "(none)"}`);
  }
  active = pack;
  for (const listener of listeners) listener(pack);
  return pack;
}
function onMapChange(listener) {
  listeners.add(listener);
  if (active) listener(active);
  return () => listeners.delete(listener);
}

// packages/shared/src/maps/lantern-atoll.ts
var RING_RADIUS = 62;
var LANTERN_ATOLL = {
  id: "lantern-atoll",
  name: "Lantern Atoll",
  nameJa: "\u706F\u7C60\u74B0\u7901",
  summary: "A ring of sand around a lagoon, and one lane all the way round.",
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
      { x: -74, z: -30, reach: 40, strength: 0.16 },
      // the west spit
      { x: 70, z: 40, reach: 38, strength: 0.14 }
      // the east bar
    ],
    bays: [
      // The lagoon. The mask at the centre of a disc island is 1.0, so a bay has to be
      // stronger than that to actually open water there rather than merely dish the ground —
      // at 0.62 this was a low island with a hollow, which is not an atoll.
      { x: 0, z: 0, reach: 50, strength: 1.35 },
      { x: 8, z: 84, reach: 30, strength: 0.3 }
      // the southern pass, where boats come in
    ],
    shelves: [],
    // A tenth of the island's relief, because it is a tenth of the island's height. Sand
    // does not have sea cliffs; the 2 m here is the low bank on the seaward side.
    relief: {
      rolling: 0.9,
      rollingVariation: 2.4,
      cliff: 2,
      detail: 0.3
    },
    // The southern pass and the landing behind it. The rest of the seaward edge keeps its
    // bank, which is what stops the ring reading as a flat washer.
    shelters: [{ x: 0, z: 78, reach: 46 }],
    pads: [
      { id: "landing", x: 0, z: 62, height: 1.8, inner: 17, outer: 28 },
      { id: "lantern-house", x: -RING_RADIUS, z: 0, height: 3.2, inner: 15, outer: 26 },
      { id: "north-camp", x: 0, z: -RING_RADIUS, height: 2.6, inner: 16, outer: 27 },
      { id: "east-market", x: RING_RADIUS, z: 0, height: 2.4, inner: 16, outer: 27 }
    ],
    paths: [
      {
        id: "coast",
        name: "Ring Lane",
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
          [0, 62]
          // repeated first point — this is what makes it a loop
        ],
        halfWidth: 3,
        shoulder: 3.4,
        carve: 0.9,
        surface: "boardwalk"
      }
    ]
  },
  world: {
    zones: [
      {
        id: "landing",
        name: "The Landing",
        nameJa: "\u8239\u7740\u304D",
        kind: "venue",
        x: 0,
        z: 62,
        radius: 30,
        stage: { dx: 0, dz: -6, facing: 0 },
        softCapacity: 24,
        ambience: "harbor",
        caption: "The boat leaves when it leaves. Until then, this is where everyone is."
      },
      {
        id: "lantern-house",
        name: "Lantern House",
        nameJa: "\u706F\u7C60\u5802",
        kind: "venue",
        x: -RING_RADIUS,
        z: 0,
        radius: 28,
        stage: { dx: 4, dz: 0, facing: Math.PI / 2 },
        softCapacity: 20,
        ambience: "wind",
        caption: "Someone lights it at dusk. Nobody has ever admitted to being that someone."
      },
      {
        id: "north-camp",
        name: "North Camp",
        nameJa: "\u5317\u306E\u5BBF",
        kind: "rest",
        x: 0,
        z: -RING_RADIUS,
        radius: 27,
        softCapacity: 16,
        ambience: "waves",
        caption: "Four windbreaks and a fire pit. It is enough."
      },
      {
        id: "east-market",
        name: "East Market",
        nameJa: "\u6771\u5E02",
        kind: "venue",
        x: RING_RADIUS,
        z: 0,
        radius: 27,
        stage: { dx: -5, dz: 0, facing: -Math.PI / 2 },
        softCapacity: 18,
        ambience: "town",
        caption: "Three stalls, and an argument about the price of rope that predates the stalls."
      },
      {
        id: "coast",
        name: "The Ring",
        nameJa: "\u74B0",
        kind: "transit",
        x: 0,
        z: 0,
        radius: 9999,
        softCapacity: 0,
        ambience: "waves",
        caption: "Sand on one side, lagoon on the other, all the way round."
      }
    ],
    landmarks: [
      // ── The landing ─────────────────────────────────────────────────────────
      // The pair of huts and the pair of lanterns are mirrored about the x = 0 lane, which
      // is the axis you arrive along: what you see first is symmetrical, and everything
      // further round the ring is not.
      { id: "at-pier", kind: "pier", x: 0, z: 76, rot: 0 },
      { id: "at-boat", kind: "boat", x: -7, z: 78, rot: 0.3 },
      { id: "at-hut-w", kind: "beach-hut", x: -13, z: 58, rot: Math.PI / 2 },
      { id: "at-hut-e", kind: "beach-hut", x: 13, z: 58, rot: -Math.PI / 2 },
      { id: "at-board", kind: "notice-board", x: 0, z: 54, rot: 0 },
      { id: "at-lantern-w", kind: "post-lantern", x: -5, z: 68, rot: 0 },
      { id: "at-lantern-e", kind: "post-lantern", x: 5, z: 68, rot: 0 },
      { id: "at-rock-w", kind: "rock", x: -21, z: 71, rot: 0.8, scale: 1.1 },
      { id: "at-rock-e", kind: "rock", x: 22, z: 69, rot: 2.1, scale: 0.9 },
      // ── Lantern house ───────────────────────────────────────────────────────
      // The tower, its keeper's house set back and to one side, and two stone lanterns
      // flanking the approach — mirrored about z = 0, which is the lane's axis here.
      { id: "at-tower", kind: "lighthouse", x: -RING_RADIUS, z: 0, rot: 0 },
      { id: "at-keeper", kind: "keepers-house", x: -RING_RADIUS + 12, z: -10, rot: -1.2 },
      { id: "at-stone-n", kind: "stone-lantern", x: -RING_RADIUS + 9, z: -5, rot: 0 },
      { id: "at-stone-s", kind: "stone-lantern", x: -RING_RADIUS + 9, z: 5, rot: 0 },
      { id: "at-wall-n", kind: "sea-wall", x: -RING_RADIUS - 6, z: -12, rot: 0.2 },
      { id: "at-wall-s", kind: "sea-wall", x: -RING_RADIUS - 6, z: 12, rot: -0.2 },
      // ── North camp ──────────────────────────────────────────────────────────
      // One-sided on purpose. A ring where every place is symmetrical reads as a diagram.
      { id: "at-shelter-a", kind: "beach-hut", x: -9, z: -RING_RADIUS - 3, rot: 0.2 },
      { id: "at-shelter-b", kind: "beach-hut", x: 2, z: -RING_RADIUS - 6, rot: -0.1 },
      { id: "at-net-rack", kind: "net-rack", x: 13, z: -RING_RADIUS - 2, rot: -0.6 },
      { id: "at-bench-n", kind: "bench", x: -2, z: -RING_RADIUS + 7, rot: Math.PI },
      { id: "at-well", kind: "well", x: 9, z: -RING_RADIUS + 5, rot: 0 },
      // ── East market ─────────────────────────────────────────────────────────
      // Two stalls facing each other across the lane, with a lantern at each end of the
      // gap between them: the one place on the atoll that is a street rather than a shore.
      { id: "at-stall-n", kind: "market-stall", x: RING_RADIUS - 9, z: -7, rot: -Math.PI / 2 },
      { id: "at-stall-s", kind: "market-stall", x: RING_RADIUS - 9, z: 7, rot: Math.PI / 2 },
      { id: "at-banner-n", kind: "banner", x: RING_RADIUS - 3, z: -11, rot: 0 },
      { id: "at-banner-s", kind: "banner", x: RING_RADIUS - 3, z: 11, rot: 0 },
      { id: "at-warehouse", kind: "warehouse", x: RING_RADIUS + 9, z: 2, rot: -Math.PI / 2 },
      { id: "at-market-bench", kind: "bench", x: RING_RADIUS - 14, z: 0, rot: -Math.PI / 2 }
    ],
    interactables: [
      {
        id: "at-board-main",
        zone: "landing",
        dx: 0,
        dz: -8,
        range: 3.2,
        kind: "use",
        label: "Read",
        effect: "read_announcements"
      },
      {
        id: "at-bench-north",
        zone: "north-camp",
        dx: -2,
        dz: 7,
        range: 2.4,
        kind: "sit",
        label: "Sit",
        effect: "none"
      },
      {
        id: "at-market-bench",
        zone: "east-market",
        dx: -14,
        dz: 0,
        range: 2.4,
        kind: "sit",
        label: "Sit",
        effect: "none"
      }
    ],
    activityTemplates: [
      {
        id: "atoll-gathering",
        title: "Gathering",
        blurb: "Whoever is here, is here.",
        zone: "landing",
        durationMin: 45,
        capacity: 24,
        checkinEnabled: true,
        formation: "gather"
      },
      {
        id: "atoll-lighting",
        title: "Lighting",
        blurb: "Dusk, at the tower. It takes about as long as it takes.",
        zone: "lantern-house",
        durationMin: 20,
        capacity: 20,
        checkinEnabled: false,
        formation: "procession"
      },
      {
        id: "atoll-market",
        title: "Market",
        blurb: "Three stalls and an argument about the price of rope.",
        zone: "east-market",
        durationMin: 60,
        capacity: 18,
        checkinEnabled: true,
        formation: "gather"
      }
    ],
    spawnPoints: [
      [-5, 64],
      [5, 64],
      [0, 70],
      [-9, 58],
      [9, 58],
      [0, 56]
    ],
    fallbackZone: "coast"
  }
};

// packages/shared/src/maps/nagisa-island.ts
var ISLAND_EXTENT = 175;
var OCEAN_RADIUS = 2400;
var COAST_RADIUS = 122;
var SUMMIT = { x: 0, z: 0, height: 26 };
var MASSIF_RADIUS = 92;
var CAPES = [
  { x: -104, z: -60, reach: 58, strength: 0.26 },
  // north-west: the lighthouse cape
  { x: -104, z: 60, reach: 54, strength: 0.22 },
  // south-west: the shrine headland
  { x: 104, z: -46, reach: 52, strength: 0.2 },
  // east: the old street's shelf
  { x: 62, z: 104, reach: 50, strength: 0.18 }
  // south-east: the beach spit
];
var BAYS = [
  { x: 0, z: 138, reach: 64, strength: 0.44 },
  // south bay: the arrival port
  { x: 0, z: -138, reach: 60, strength: 0.4 }
  // north bay: the fishing harbour
];
var SHELVES = [
  // The eastern shelf, carrying both the plaza and the old street.
  { x: 70, z: 0, reach: 82, height: 7 },
  // The western headlands are raised too, but separately: the shrine and the lighthouse
  // are meant to read as two distinct high places, not one ridge.
  { x: -70, z: 40, reach: 46, height: 8 },
  { x: -70, z: -40, reach: 46, height: 9 }
];
var PADS = [
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
  { id: "south-harbor", x: 0, z: 74, height: 2.4, inner: 21, outer: 35 },
  /** The main plaza, on the eastern shelf. */
  { id: "plaza", x: 64, z: 37, height: 8, inner: 25, outer: 37 },
  /** The old street, sharing that shelf — see SHELVES for why there is no dip between them. */
  { id: "village", x: 64, z: -37, height: 9, inner: 25, outer: 37 },
  /** Sunset beach, on the sand east of the south quay. */
  { id: "beach", x: 46, z: 92, height: 1.6, inner: 16, outer: 28 },
  /** The working fishing harbour. */
  { id: "north-harbor", x: 0, z: -74, height: 2.4, inner: 20, outer: 33 },
  /** Lighthouse cape: a flat clifftop, deliberately exposed and the higher of the two. */
  { id: "lighthouse", x: -64, z: -37, height: 13, inner: 19, outer: 33 },
  /** The shrine, on its own headland. */
  { id: "shrine", x: -64, z: 37, height: 11, inner: 22, outer: 35 },
  // — Inland ————————————————————————————————————————————————————————
  /** Notice-board terrace, one step up from the plaza floor. The one deliberate nesting. */
  { id: "noticeboard", x: 48, z: 22, height: 8.8, inner: 8, outer: 15 },
  /** The summit court: a small flat terrace at the true peak, around the inner shrine. */
  { id: "summit", x: SUMMIT.x, z: SUMMIT.z, height: SUMMIT.height, inner: 12, outer: 30 }
];
var PATHS = [
  {
    id: "coast",
    name: "Ring Road",
    halfWidth: 3.4,
    shoulder: 6,
    carve: 0.95,
    surface: "stone",
    // Mid-points sit at radius 82 rather than on the hexagon's 74, so each leg is ~86 m
    // instead of 74. That extra twelve metres is not decoration: the north harbour to
    // lighthouse cape leg climbs 23 m, and over a straight 74 m that is a 32% grade —
    // past what the survey will hold with both ends pinned to their terraces.
    points: [
      [0, 74],
      // south harbour
      [41, 71],
      [64, 37],
      // plaza
      [82, 0],
      [64, -37],
      // old street
      [41, -71],
      [0, -74],
      // north harbour
      [-41, -71],
      [-64, -37],
      // lighthouse cape
      [-82, 0],
      [-64, 37],
      // shrine
      [-41, 71],
      [0, 74]
    ]
  },
  {
    id: "south-approach",
    name: "Summit Road",
    halfWidth: 3.2,
    shoulder: 5.5,
    carve: 0.95,
    surface: "stone",
    points: [
      // Leaves the ring from between the plaza and the old street — the point of putting
      // those two on one shelf is that the mountain road starts where they meet.
      //
      // No switchbacks any more. With the summit 18 m above the shelf rather than 33, a
      // near-direct line holds about 22%, and the four turns that used to be needed to keep
      // the grade legal only made the climb long.
      [82, 0],
      [58, -8],
      [36, -6],
      [16, 3],
      [0, 0]
      // summit
    ]
  },
  {
    id: "shrine-ascent",
    name: "Shrine Path",
    halfWidth: 2.6,
    shoulder: 5,
    carve: 0.94,
    surface: "gravel",
    points: [
      [-64, 37],
      // shrine courtyard
      [-46, 30],
      [-28, 20],
      [-12, 10],
      [0, 0]
      // summit
    ]
  },
  {
    id: "east-lane",
    name: "Harbour Lane",
    halfWidth: 2.8,
    shoulder: 5,
    carve: 0.94,
    surface: "gravel",
    points: [
      // A short cut across the middle of the island, from the south harbour up past the
      // notice board to the plaza. The one route that does not follow the ring.
      [0, 74],
      [20, 60],
      [40, 44],
      [48, 22],
      // notice-board terrace
      [64, 37]
      // plaza
    ]
  }
];
var ZONES = [
  {
    id: "south-harbor",
    name: "South Harbour",
    nameJa: "\u5357\u6E2F",
    kind: "venue",
    x: 0,
    z: 74,
    radius: 32,
    stage: { dx: -9, dz: -6, facing: Math.PI * 0.1 },
    softCapacity: 60,
    ambience: "harbor",
    caption: "The ferry ties up here. Everyone arrives at the south quay."
  },
  {
    id: "plaza",
    name: "Main Plaza",
    nameJa: "\u5E83\u5834",
    kind: "venue",
    x: 64,
    z: 37,
    radius: 32,
    stage: { dx: 4, dz: -12, facing: 0 },
    softCapacity: 140,
    ambience: "town",
    caption: "The middle of things, on the eastern shelf. Something is usually about to start."
  },
  {
    id: "noticeboard",
    name: "Notice Board",
    nameJa: "\u63B2\u793A\u677F",
    kind: "notice",
    x: 48,
    z: 22,
    radius: 11,
    softCapacity: 20,
    ambience: "town",
    caption: "Paper slips, pinned and re-pinned. Today\u2019s word is here."
  },
  {
    id: "village",
    name: "Old Street",
    nameJa: "\u753A\u4E26\u307F",
    kind: "transit",
    x: 64,
    z: -37,
    radius: 32,
    softCapacity: 50,
    ambience: "town",
    caption: "Wooden fronts, low eaves, a cat that has never moved."
  },
  {
    id: "north-harbor",
    name: "North Harbour",
    nameJa: "\u5317\u6E2F",
    kind: "venue",
    x: 0,
    z: -74,
    radius: 30,
    stage: { dx: 9, dz: 5, facing: -Math.PI * 0.35 },
    softCapacity: 40,
    ambience: "harbor",
    caption: "Nets, ice, and boats that go out before anyone is awake."
  },
  {
    id: "lighthouse",
    name: "Lighthouse Cape",
    nameJa: "\u706F\u53F0\u5CAC",
    kind: "venue",
    x: -64,
    z: -37,
    radius: 30,
    stage: { dx: 10, dz: 9, facing: Math.PI * 0.7 },
    softCapacity: 50,
    ambience: "wind",
    caption: "The lamp turns whether anyone is watching or not."
  },
  {
    id: "shrine",
    name: "Shrine",
    nameJa: "\u795E\u793E",
    kind: "venue",
    x: -64,
    z: 37,
    radius: 32,
    stage: { dx: 8, dz: -6, facing: Math.PI * 0.4 },
    softCapacity: 70,
    ambience: "shrine",
    caption: "Torii, one after another, on the headland above the water."
  },
  {
    id: "summit",
    name: "Summit",
    nameJa: "\u5C71\u9802",
    kind: "scenic",
    x: 0,
    z: 0,
    radius: 26,
    softCapacity: 30,
    ambience: "wind",
    caption: "From up here the whole island fits between your hands."
  },
  {
    id: "beach",
    name: "Sunset Beach",
    nameJa: "\u6D5C",
    kind: "venue",
    x: 46,
    z: 92,
    radius: 22,
    stage: { dx: -2, dz: -4, facing: -Math.PI * 0.75 },
    softCapacity: 60,
    ambience: "waves",
    caption: "Flat sand, shallow water, and the long light."
  },
  {
    id: "coast",
    name: "Ring Road",
    nameJa: "\u6E1A\u9053",
    kind: "transit",
    x: 0,
    z: 0,
    radius: 9999,
    // Fallback zone: matched last, catches anyone not inside a named place.
    softCapacity: 999,
    ambience: "waves",
    caption: "The road follows the water the whole way round."
  }
];
var SPAWN_POINTS = [
  [-6, 80],
  [6, 80],
  [-11, 74],
  [11, 74],
  [0, 84],
  [0, 68]
];
var INTERACTABLES = [
  { id: "notice-board", zone: "noticeboard", dx: 0, dz: -4, range: 4.5, kind: "use", label: "Read", effect: "read_announcements" },
  { id: "plaza-post", zone: "plaza", dx: -13, dz: 7, range: 3.5, kind: "use", label: "Check in", effect: "checkin_nearby" },
  { id: "shrine-bell", zone: "shrine", dx: 3, dz: -8, range: 3.5, kind: "use", label: "Ring", effect: "none" },
  { id: "summit-bell", zone: "summit", dx: 8, dz: 5, range: 3.5, kind: "use", label: "Ring", effect: "none" },
  { id: "south-harbor-bell", zone: "south-harbor", dx: 10, dz: 4, range: 3.5, kind: "use", label: "Ring", effect: "none" },
  { id: "north-harbor-bell", zone: "north-harbor", dx: -9, dz: -4, range: 3.5, kind: "use", label: "Ring", effect: "none" },
  { id: "lighthouse-door", zone: "lighthouse", dx: 0, dz: 3, range: 4, kind: "use", label: "Look", effect: "none" },
  { id: "summit-rail", zone: "summit", dx: -2, dz: 11, range: 5, kind: "use", label: "Look", effect: "none" },
  { id: "teahouse-mat-a", zone: "plaza", dx: 14, dz: 9, range: 2.5, kind: "sit", label: "Sit", effect: "none" },
  { id: "teahouse-mat-b", zone: "plaza", dx: 17, dz: 11, range: 2.5, kind: "sit", label: "Sit", effect: "none" },
  { id: "beach-log", zone: "beach", dx: 5, dz: 7, range: 3, kind: "sit", label: "Sit", effect: "none" },
  { id: "plaza-bench", zone: "plaza", dx: 13, dz: 8, range: 3, kind: "sit", label: "Sit", effect: "none" }
];
var LANDMARKS = [
  // ═══ South Harbour (0, 74) — the arrival port ═══════════════════════════
  // Waterfront props run out along +z into the bay; the quay buildings sit behind them,
  // all inside the terrace's flat inner radius so nothing stands on a slope.
  { id: "sh-torii-sea", kind: "torii", x: 0, z: 112, rot: 0.05, scale: 1.7, opts: { inWater: true } },
  { id: "sh-pier-main", kind: "pier", x: 0, z: 88, rot: 0, opts: { length: 30, width: 7, lamps: true } },
  { id: "sh-pier-west", kind: "pier", x: -20, z: 82, rot: Math.PI * 0.4, opts: { length: 18, width: 4.5 } },
  { id: "sh-breakwater", kind: "breakwater", x: 34, z: 98, rot: -0.55, opts: { length: 40, beacon: true } },
  { id: "sh-boat-1", kind: "boat", x: 16, z: 98, rot: 0.3, opts: { style: "ferry", scale: 1.25 } },
  { id: "sh-boat-2", kind: "boat", x: -12, z: 96, rot: -0.7 },
  { id: "sh-seawall", kind: "sea-wall", x: 19, z: 80, rot: -0.4, opts: { length: 22 } },
  { id: "sh-warehouse-1", kind: "warehouse", x: 11, z: 68, rot: -0.25, opts: { w: 12, d: 9, floors: 2 } },
  { id: "sh-warehouse-2", kind: "warehouse", x: -11, z: 68, rot: 0.2, opts: { w: 10, d: 8 } },
  { id: "sh-office", kind: "machiya", x: 1, z: 62, rot: Math.PI, opts: { w: 10, d: 10, floors: 2, sign: true } },
  { id: "sh-stall-1", kind: "market-stall", x: -8, z: 76, rot: 0.1, opts: { cloth: 1 } },
  { id: "sh-stall-2", kind: "market-stall", x: -2, z: 78, rot: 0.1, opts: { cloth: 2 } },
  { id: "sh-stall-3", kind: "market-stall", x: 4, z: 79, rot: 0.1, opts: { cloth: 0 } },
  { id: "sh-stage", kind: "stage", x: -9, z: 68, rot: Math.PI * 0.1, opts: { w: 12, d: 9 } },
  { id: "sh-bell", kind: "bell-tower", x: 10, z: 78, rot: 0, scale: 0.8 },
  { id: "sh-lantern-1", kind: "post-lantern", x: -5, z: 70, rot: 0 },
  { id: "sh-lantern-2", kind: "post-lantern", x: 9, z: 70, rot: 0 },
  { id: "sh-banner-1", kind: "banner", x: -14, z: 78, rot: 0.2 },
  { id: "sh-banner-2", kind: "banner", x: 14, z: 72, rot: -0.3 },
  { id: "sh-rock-1", kind: "rock", x: -26, z: 92, rot: 1.1, scale: 1.3 },
  // ═══ Sunset Beach (46, 92) — the sand east of the quay ══════════════════
  { id: "bh-hut-1", kind: "beach-hut", x: 40, z: 86, rot: -0.7, opts: { w: 7, d: 5.5 } },
  { id: "bh-hut-2", kind: "beach-hut", x: 54, z: 88, rot: 0.4, opts: { w: 6, d: 5 } },
  { id: "bh-stage", kind: "stage", x: 44, z: 88, rot: -Math.PI * 0.75, opts: { w: 11, d: 8 } },
  { id: "bh-bench-1", kind: "bench", x: 51, z: 99, rot: 1 },
  { id: "bh-boat-1", kind: "boat", x: 58, z: 102, rot: 1.8, scale: 0.75 },
  { id: "bh-rock-1", kind: "rock", x: 64, z: 92, rot: 0.7, scale: 1.5 },
  { id: "bh-lantern-1", kind: "post-lantern", x: 38, z: 96, rot: 0 },
  // ═══ Main Plaza (64, 37) — the civic centre ═════════════════════════════
  { id: "pl-stage", kind: "stage", x: 68, z: 25, rot: 0, opts: { w: 16, d: 11, roof: true, tiers: true } },
  { id: "pl-gate-s", kind: "gate", x: 66, z: 54, rot: 0.05, scale: 1.1 },
  { id: "pl-gate-w", kind: "gate", x: 48, z: 40, rot: Math.PI * 0.5 },
  { id: "pl-well", kind: "well", x: 76, z: 44, rot: 0.3 },
  { id: "pl-lantern-1", kind: "stone-lantern", x: 58, z: 27, rot: 0.3 },
  { id: "pl-lantern-2", kind: "stone-lantern", x: 75, z: 28, rot: -0.3 },
  { id: "pl-lantern-3", kind: "stone-lantern", x: 53, z: 48, rot: 0.1 },
  { id: "pl-lantern-4", kind: "stone-lantern", x: 75, z: 48, rot: -0.1 },
  { id: "pl-bench-1", kind: "bench", x: 77, z: 45, rot: -0.6 },
  { id: "pl-bench-2", kind: "bench", x: 51, z: 45, rot: 0.6 },
  { id: "pl-banner-1", kind: "banner", x: 58, z: 52, rot: 0 },
  { id: "pl-banner-2", kind: "banner", x: 71, z: 52, rot: 0 },
  // The teahouse: a v2 zone kept as a building, on the quiet side of the plaza.
  { id: "pl-teahouse", kind: "teahouse", x: 79, z: 34, rot: Math.PI * 0.55, opts: { w: 11, d: 8.5, veranda: true } },
  { id: "pl-minka", kind: "minka", x: 50, z: 20, rot: -0.5, opts: { w: 11, d: 9 } },
  // — Notice-board terrace (48, 22), one step up from the plaza ————————
  { id: "nb-board", kind: "notice-board", x: 48, z: 18, rot: 0.1, scale: 1.4 },
  { id: "nb-lantern-1", kind: "stone-lantern", x: 42, z: 24, rot: 0 },
  { id: "nb-bench-1", kind: "bench", x: 53, z: 25, rot: -0.4 },
  // ═══ Old Street (64, -37) — two rows facing each other ══════════════════
  { id: "ov-machiya-1", kind: "machiya", x: 54, z: -48, rot: Math.PI * 0.5, opts: { w: 8, d: 10, floors: 2, sign: true } },
  { id: "ov-machiya-2", kind: "machiya", x: 54, z: -37, rot: Math.PI * 0.5, opts: { w: 8, d: 10, floors: 2 } },
  { id: "ov-machiya-3", kind: "machiya", x: 54, z: -26, rot: Math.PI * 0.5, opts: { w: 8, d: 10, floors: 1, sign: true } },
  { id: "ov-machiya-4", kind: "machiya", x: 75, z: -48, rot: -Math.PI * 0.5, opts: { w: 8, d: 10, floors: 2 } },
  { id: "ov-machiya-5", kind: "machiya", x: 75, z: -37, rot: -Math.PI * 0.5, opts: { w: 8, d: 10, floors: 1, sign: true } },
  { id: "ov-machiya-6", kind: "machiya", x: 75, z: -26, rot: -Math.PI * 0.5, opts: { w: 8, d: 10, floors: 2 } },
  { id: "ov-bathhouse", kind: "bathhouse", x: 64, z: -53, rot: Math.PI, opts: { w: 13, d: 10 } },
  { id: "ov-warehouse", kind: "warehouse", x: 76, z: -22, rot: -0.3, opts: { w: 10, d: 8 } },
  { id: "ov-gate-s", kind: "gate", x: 64, z: -22, rot: 0 },
  { id: "ov-gate-n", kind: "gate", x: 64, z: -57, rot: Math.PI },
  { id: "ov-well", kind: "well", x: 64, z: -37, rot: 0 },
  { id: "ov-lantern-1", kind: "post-lantern", x: 60, z: -44, rot: 0 },
  { id: "ov-lantern-2", kind: "post-lantern", x: 69, z: -37, rot: 0 },
  { id: "ov-lantern-3", kind: "post-lantern", x: 60, z: -30, rot: 0 },
  { id: "ov-bench-1", kind: "bench", x: 69, z: -44, rot: -1.4 },
  // ═══ North Harbour (0, -74) — the working fishery ═══════════════════════
  { id: "nh-torii-sea", kind: "torii", x: 0, z: -110, rot: 0.1, scale: 1.4, opts: { inWater: true } },
  { id: "nh-pier-e", kind: "pier", x: 8, z: -86, rot: Math.PI, opts: { length: 20, width: 5 } },
  { id: "nh-pier-w", kind: "pier", x: -16, z: -84, rot: Math.PI * 1.1, opts: { length: 16, width: 4.5 } },
  { id: "nh-boathouse-1", kind: "boathouse", x: -24, z: -74, rot: Math.PI * 0.85, opts: { w: 7, d: 10 } },
  { id: "nh-boathouse-2", kind: "boathouse", x: -27, z: -62, rot: Math.PI * 0.7, opts: { w: 6.5, d: 9 } },
  { id: "nh-shed", kind: "warehouse", x: 10, z: -66, rot: 0.35, opts: { w: 10, d: 8 } },
  { id: "nh-minka", kind: "minka", x: -6, z: -60, rot: 0.15, opts: { w: 10, d: 8 } },
  { id: "nh-netrack-1", kind: "net-rack", x: 4, z: -78, rot: 0.3 },
  { id: "nh-netrack-2", kind: "net-rack", x: -3, z: -81, rot: 0.3 },
  { id: "nh-boat-1", kind: "boat", x: -8, z: -94, rot: 0.2, scale: 0.85 },
  { id: "nh-boat-2", kind: "boat", x: 16, z: -96, rot: -0.4, scale: 0.8 },
  { id: "nh-seawall", kind: "sea-wall", x: 18, z: -78, rot: 1.2, opts: { length: 18 } },
  { id: "nh-bell", kind: "bell-tower", x: -9, z: -78, rot: 0.2, scale: 0.75 },
  { id: "nh-stage", kind: "stage", x: 9, z: -69, rot: -Math.PI * 0.35, opts: { w: 11, d: 8 } },
  { id: "nh-rock-1", kind: "rock", x: -32, z: -88, rot: 1.4, scale: 1.4 },
  // ═══ Lighthouse Cape (-64, -37) — the exposed high cape ═════════════════
  { id: "lh-tower", kind: "lighthouse", x: -64, z: -37, rot: 0, scale: 0.92 },
  { id: "lh-keepers", kind: "keepers-house", x: -53, z: -28, rot: -0.7, opts: { w: 10, d: 7.5 } },
  { id: "lh-store", kind: "warehouse", x: -74, z: -28, rot: 0.5, opts: { w: 8, d: 6.5 } },
  { id: "lh-rail", kind: "rail", x: -64, z: -46, rot: 0.15, opts: { length: 16 } },
  { id: "lh-bench-1", kind: "bench", x: -74, z: -45, rot: 0.3 },
  { id: "lh-lantern-1", kind: "post-lantern", x: -55, z: -42, rot: 0 },
  { id: "lh-rock-1", kind: "rock", x: -78, z: -52, rot: 0.8, scale: 1.7 },
  { id: "lh-rock-2", kind: "rock", x: -50, z: -50, rot: 2.4, scale: 1.2 },
  // ═══ Shrine (-64, 37) — the western headland ════════════════════════════
  // The approach runs east→west along the sando: three torii, then the hall.
  { id: "sr-torii-1", kind: "torii", x: -46, z: 34, rot: Math.PI * 0.5, scale: 1.35 },
  { id: "sr-torii-2", kind: "torii", x: -54, z: 35, rot: Math.PI * 0.5, scale: 1.25 },
  { id: "sr-torii-3", kind: "torii", x: -60, z: 36, rot: Math.PI * 0.5, scale: 1.15 },
  { id: "sr-komainu-l", kind: "komainu", x: -66, z: 30, rot: Math.PI * 0.5, opts: { side: 1 } },
  { id: "sr-komainu-r", kind: "komainu", x: -66, z: 44, rot: Math.PI * 0.5, opts: { side: -1 } },
  { id: "sr-temizuya", kind: "temizuya", x: -62, z: 47, rot: -0.4 },
  { id: "sr-hall", kind: "shrine-hall", x: -78, z: 37, rot: Math.PI * 0.5, opts: { w: 12, d: 10, honden: true } },
  { id: "sr-bell", kind: "bell-tower", x: -61, z: 29, rot: 0 },
  { id: "sr-lantern-1", kind: "stone-lantern", x: -72, z: 29, rot: 0, scale: 1.15 },
  { id: "sr-lantern-2", kind: "stone-lantern", x: -72, z: 45, rot: 0, scale: 1.15 },
  { id: "sr-lantern-3", kind: "stone-lantern", x: -54, z: 29, rot: 0 },
  { id: "sr-lantern-4", kind: "stone-lantern", x: -54, z: 45, rot: 0 },
  { id: "sr-rock-1", kind: "rock", x: -86, z: 48, rot: 0.5, scale: 1.5 },
  { id: "sr-rock-2", kind: "rock", x: -84, z: 24, rot: 2.1, scale: 1.2 },
  // ═══ Summit (0, 0) — the inner shrine, at the top of everything ═════════
  { id: "su-torii", kind: "torii", x: 0, z: 9, rot: 0, scale: 1.2 },
  { id: "su-hall", kind: "shrine-hall", x: 0, z: -9, rot: 0, opts: { w: 9, d: 7.5, honden: true, small: true } },
  { id: "su-bell", kind: "bell-tower", x: 8, z: 5, rot: -0.4, scale: 0.85 },
  { id: "su-marker", kind: "summit-marker", x: -7, z: -3, rot: 0.2 },
  { id: "su-rail", kind: "rail", x: -3, z: 6, rot: 0.1, opts: { length: 8 } },
  { id: "su-lantern-1", kind: "stone-lantern", x: -7, z: -8, rot: 0 },
  { id: "su-lantern-2", kind: "stone-lantern", x: 7, z: -8, rot: 0 },
  { id: "su-bench-1", kind: "bench", x: -11, z: 3, rot: 0.4 },
  { id: "su-bench-2", kind: "bench", x: 9, z: 3, rot: -0.4 },
  { id: "su-rock-1", kind: "rock", x: 14, z: -12, rot: 1.2, scale: 1.2 },
  { id: "su-rock-2", kind: "rock", x: -14, z: -13, rot: 0.3, scale: 1.4 }
];
var ACTIVITY_TEMPLATES = [
  {
    id: "morning-assembly",
    title: "Morning Assembly",
    blurb: "Everyone on the island, in one place, briefly.",
    zone: "plaza",
    durationMin: 15,
    capacity: 0,
    checkinEnabled: true,
    formation: "gather"
  },
  {
    id: "lantern-walk",
    title: "Lantern Walk",
    blurb: "Up the shrine path, one lantern each.",
    zone: "shrine",
    durationMin: 20,
    capacity: 60,
    checkinEnabled: true,
    formation: "procession"
  },
  {
    id: "harbor-market",
    title: "Harbour Market",
    blurb: "Stalls on the south quay until the light goes.",
    zone: "south-harbor",
    durationMin: 45,
    capacity: 0,
    checkinEnabled: false,
    formation: "gather"
  },
  {
    id: "beach-concert",
    title: "Beach Concert",
    blurb: "Sit on the sand. Someone is playing.",
    zone: "beach",
    durationMin: 30,
    capacity: 70,
    checkinEnabled: true,
    formation: "seated"
  },
  {
    id: "lamp-lighting",
    title: "Lamp Lighting",
    blurb: "The cape at dusk, when the lamp comes round.",
    zone: "lighthouse",
    durationMin: 10,
    capacity: 50,
    checkinEnabled: true,
    formation: "gather"
  },
  {
    id: "morning-catch",
    title: "Morning Catch",
    blurb: "The north boats come back in. Everyone helps.",
    zone: "north-harbor",
    durationMin: 25,
    capacity: 40,
    checkinEnabled: true,
    formation: "gather"
  }
];
var NAGISA_ISLAND = {
  id: "nagisa-island",
  name: "Nagisa Island",
  nameJa: "\u6E1A\u5CF6",
  summary: "A hexagon of six places around one mountain, and the sea on every side.",
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
      detail: 1.8
    },
    // The two harbours and the beach spit. Everywhere else on the ring gets cliffs.
    shelters: [
      { x: 0, z: 128, reach: 84 },
      // south bay — where you arrive
      { x: 0, z: -128, reach: 80 },
      // north bay — the fishing harbour
      { x: 62, z: 100, reach: 70 }
      // the beach
    ],
    pads: PADS,
    paths: PATHS
  },
  world: {
    zones: ZONES,
    landmarks: LANDMARKS,
    interactables: INTERACTABLES,
    activityTemplates: ACTIVITY_TEMPLATES,
    spawnPoints: SPAWN_POINTS,
    fallbackZone: "coast"
  }
};

// packages/shared/src/maps/index.ts
var DEFAULT_MAP_ID = NAGISA_ISLAND.id;
registerMap(NAGISA_ISLAND);
registerMap(LANTERN_ATOLL);
if (activeMapId() === null) setActiveMap(DEFAULT_MAP_ID);

// packages/shared/src/terrain.ts
function hash2(ix, iy) {
  let h = Math.imul(ix, 668265261) ^ Math.imul(iy, 2246822507);
  h = Math.imul(h ^ h >>> 15, 625341585);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function valueNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}
function fbm(x, y, octaves, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
    const nx = fx * 0.8 - fy * 0.6;
    const ny = fx * 0.6 + fy * 0.8;
    fx = nx;
    fy = ny;
  }
  return sum / norm;
}
function ridge(x, y, octaves) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(fx, fy) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.1;
    fy *= 2.1;
  }
  return sum / norm;
}
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
var ISLAND_EXTENT2 = 0;
var OCEAN_RADIUS2 = 0;
var SUMMIT2 = { x: 0, z: 0, height: 0 };
var PADS2 = [];
var PATHS2 = [];
var COAST_RADIUS2 = 0;
var MASSIF_RADIUS2 = 1;
var CAPES2 = [];
var BAYS2 = [];
var SHELVES2 = [];
var RELIEF = { rolling: 0, rollingVariation: 0, cliff: 0, detail: 0 };
var SHELTERS = [];
function shelfHeight(x, z) {
  let total = 0;
  for (const shelf of SHELVES2) {
    const d = Math.hypot(x - shelf.x, z - shelf.z);
    if (d >= shelf.reach) continue;
    total += shelf.height * (1 - smoothstep(shelf.reach * 0.35, shelf.reach, d));
  }
  return total;
}
function islandMask(x, z) {
  let d = Math.hypot(x, z) / COAST_RADIUS2;
  const ang = Math.atan2(z, x);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const wobble = (fbm(ca * 2.1 + 11.3, sa * 2.1 + 7.1, 4) - 0.5) * 0.17 + (fbm(ca * 5.6 + 3.7, sa * 5.6 + 19.4, 3) - 0.5) * 0.07;
  d -= wobble;
  for (const cape of CAPES2) {
    d -= smoothstep(cape.reach, 0, Math.hypot(x - cape.x, z - cape.z)) * cape.strength;
  }
  for (const bay of BAYS2) {
    d += smoothstep(bay.reach, 0, Math.hypot(x - bay.x, z - bay.z)) * bay.strength;
  }
  return 1 - d;
}
function isLand(x, z) {
  return islandMask(x, z) > 0;
}
function massif(x, z) {
  const dx = x - SUMMIT2.x;
  const dz = z - SUMMIT2.z;
  const r = Math.hypot(dx, dz);
  if (r > MASSIF_RADIUS2) return 0;
  const t = 1 - r / MASSIF_RADIUS2;
  const profile = t * t * (3 - 2 * t);
  const ang = Math.atan2(dz, dx);
  const warp = (fbm(Math.cos(ang) * 1.6 + 21.7, Math.sin(ang) * 1.6 + 5.2, 3) - 0.5) * 2.4;
  const spur = 0.5 + 0.5 * Math.cos(ang * 6 + warp + r * 4e-3);
  const spurWeight = 0.2 * smoothstep(MASSIF_RADIUS2 * 0.11, MASSIF_RADIUS2 * 0.5, r) * (1 - smoothstep(MASSIF_RADIUS2 * 0.78, MASSIF_RADIUS2, r));
  const shaped = profile * (1 - spurWeight + spurWeight * spur);
  const rough = ridge(x * 0.019 + 5.5, z * 0.019 + 2.2, 4) - 0.42;
  const detailMask = smoothstep(0, 0.3, profile) * (1 - smoothstep(0.86, 1, profile));
  return SUMMIT2.height * (shaped + rough * 0.23 * detailMask);
}
var COAST_PATH;
var PROMENADE_HALF_WIDTH = 0;
var PATH_CELL = 32;
var PATH_GRID_HALF = 1;
var PATH_GRID_SIZE = 3;
var pathGrid = null;
var pathLengths = /* @__PURE__ */ new Map();
function cellIndex(cx, cz) {
  return (cz + PATH_GRID_HALF) * PATH_GRID_SIZE + (cx + PATH_GRID_HALF);
}
function buildPathIndex() {
  const grid2 = new Array(PATH_GRID_SIZE * PATH_GRID_SIZE);
  for (const path of PATHS2) {
    const reach = path.halfWidth + path.shoulder * MAX_BLEND_GROWTH;
    let acc = 0;
    for (let i = 0; i < path.points.length - 1; i++) {
      const [ax, az] = path.points[i];
      const [bx, bz] = path.points[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      if (lenSq === 0) continue;
      const length = Math.sqrt(lenSq);
      const segment = { path, ax, az, dx, dz, invLenSq: 1 / lenSq, length, s0: acc };
      acc += length;
      const minX = Math.min(ax, bx) - reach;
      const maxX = Math.max(ax, bx) + reach;
      const minZ = Math.min(az, bz) - reach;
      const maxZ = Math.max(az, bz) + reach;
      const cx0 = clamp(Math.floor(minX / PATH_CELL), -PATH_GRID_HALF, PATH_GRID_HALF);
      const cx1 = clamp(Math.floor(maxX / PATH_CELL), -PATH_GRID_HALF, PATH_GRID_HALF);
      const cz0 = clamp(Math.floor(minZ / PATH_CELL), -PATH_GRID_HALF, PATH_GRID_HALF);
      const cz1 = clamp(Math.floor(maxZ / PATH_CELL), -PATH_GRID_HALF, PATH_GRID_HALF);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cellIndex(cx, cz);
          (grid2[key] ??= []).push(segment);
        }
      }
    }
    pathLengths.set(path.id, acc);
  }
  return grid2;
}
function segmentsNear(x, z) {
  pathGrid ??= buildPathIndex();
  const cx = Math.floor(x / PATH_CELL);
  const cz = Math.floor(z / PATH_CELL);
  if (cx < -PATH_GRID_HALF || cx > PATH_GRID_HALF || cz < -PATH_GRID_HALF || cz > PATH_GRID_HALF) return void 0;
  return pathGrid[cellIndex(cx, cz)];
}
var NO_PATH = { path: null, dist: Infinity, s: 0, blend: 0 };
function nearestPath(x, z, excludeId) {
  const segments = segmentsNear(x, z);
  if (!segments) return NO_PATH;
  let best = Infinity;
  let bestPath = null;
  let bestS = 0;
  for (const seg of segments) {
    if (excludeId !== void 0 && seg.path.id === excludeId) continue;
    const t = clamp(((x - seg.ax) * seg.dx + (z - seg.az) * seg.dz) * seg.invLenSq, 0, 1);
    const px = seg.ax + seg.dx * t;
    const pz = seg.az + seg.dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bestPath = seg.path;
      bestS = seg.s0 + seg.length * t;
    }
  }
  if (!bestPath) return NO_PATH;
  const blend = blendWidth(bestPath, bestS);
  if (best > bestPath.halfWidth + blend) return NO_PATH;
  return { path: bestPath, dist: best, s: bestS, blend };
}
function pathLength(id) {
  pathGrid ??= buildPathIndex();
  return pathLengths.get(id) ?? 0;
}
var PROFILE_STEP = 4;
var MAX_PATH_GRADE = 0.3;
var PROFILE_SMOOTH_PASSES = 10;
var PROFILE_GRADE_PASSES = 40;
var SELF_PROXIMITY_MIN_GAP = 6;
var PATH_MIN_HEIGHT = 1.2;
var pathProfiles = /* @__PURE__ */ new Map();
var profilesUnderConstruction = /* @__PURE__ */ new Set();
function buildProfile(path) {
  const total = pathLengths.get(path.id) ?? 0;
  const count = Math.max(2, Math.ceil(total / PROFILE_STEP));
  const closed = isClosedLoop(path);
  const profile = new Float64Array(count);
  const pinned = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const { x, z } = pathAt(path.id, i * PROFILE_STEP);
    const pad = padContaining(x, z);
    if (pad) {
      profile[i] = pad.height;
      pinned[i] = 1;
      continue;
    }
    profile[i] = Math.max(
      PATH_MIN_HEIGHT,
      (paddedHeight(x, z) * 2 + paddedHeight(x + 5, z) + paddedHeight(x - 5, z) + paddedHeight(x, z + 5) + paddedHeight(x, z - 5)) / 6
    );
  }
  if (!closed) {
    for (const i of [0, count - 1]) {
      if (pinned[i]) continue;
      const { x, z } = pathAt(path.id, i * PROFILE_STEP);
      const junction = nearestPath(x, z, path.id);
      const joinsAnother = junction.path && junction.dist < junction.path.halfWidth + junction.path.shoulder * 0.5;
      profile[i] = Math.max(
        PATH_MIN_HEIGHT,
        joinsAnother && !profilesUnderConstruction.has(junction.path.id) ? profileHeight(junction.path, junction.s) : paddedHeight(x, z)
      );
      pinned[i] = 1;
    }
  }
  const at = (i) => closed ? profile[(i % count + count) % count] : profile[clamp(i, 0, count - 1) | 0];
  const scratch = new Float64Array(count);
  for (let pass = 0; pass < PROFILE_SMOOTH_PASSES; pass++) {
    for (let i = 0; i < count; i++) {
      scratch[i] = pinned[i] ? profile[i] : (at(i - 1) + profile[i] * 2 + at(i + 1)) * 0.25;
    }
    profile.set(scratch);
  }
  const maxStep = MAX_PATH_GRADE * PROFILE_STEP;
  const relax = (lo, hi) => {
    const delta = profile[hi] - profile[lo];
    const excess = Math.abs(delta) - maxStep;
    if (excess <= 0) return false;
    const signed = excess * Math.sign(delta);
    if (pinned[lo] && pinned[hi]) return false;
    if (pinned[lo]) profile[hi] -= signed;
    else if (pinned[hi]) profile[lo] += signed;
    else {
      profile[hi] -= signed * 0.5;
      profile[lo] += signed * 0.5;
    }
    return true;
  };
  const influence = (path.halfWidth + path.shoulder) * 2;
  const positions = Array.from({ length: count }, (_, i) => pathAt(path.id, i * PROFILE_STEP));
  const relaxSelfProximity = () => {
    let moved = false;
    for (let i = 0; i < count; i++) {
      for (let j = i + SELF_PROXIMITY_MIN_GAP; j < count; j++) {
        if (closed && count - (j - i) < SELF_PROXIMITY_MIN_GAP) continue;
        const d = Math.hypot(positions[i].x - positions[j].x, positions[i].z - positions[j].z);
        if (d >= influence) continue;
        const delta = profile[j] - profile[i];
        if (Math.abs(delta) < 0.01) continue;
        const strength = (1 - d / influence) * 0.5;
        if (pinned[i] && pinned[j]) continue;
        if (pinned[i]) profile[j] -= delta * strength;
        else if (pinned[j]) profile[i] += delta * strength;
        else {
          profile[i] += delta * strength * 0.5;
          profile[j] -= delta * strength * 0.5;
        }
        moved = true;
      }
    }
    return moved;
  };
  for (let pass = 0; pass < PROFILE_GRADE_PASSES; pass++) {
    let moved = false;
    for (let i = 1; i < count; i++) moved = relax(i - 1, i) || moved;
    for (let i = count - 2; i >= 0; i--) moved = relax(i, i + 1) || moved;
    if (closed) moved = relax(count - 1, 0) || moved;
    moved = relaxSelfProximity() || moved;
    if (!moved) break;
  }
  for (let i = 0; i < count; i++) profile[i] = Math.max(PATH_MIN_HEIGHT, profile[i]);
  return profile;
}
function padContaining(x, z) {
  for (let i = PADS2.length - 1; i >= 0; i--) {
    const pad = PADS2[i];
    if (Math.hypot(x - pad.x, z - pad.z) <= pad.inner) return pad;
  }
  return void 0;
}
function isClosedLoop(path) {
  const first = path.points[0];
  const last = path.points[path.points.length - 1];
  return Math.hypot(first[0] - last[0], first[1] - last[1]) < 1;
}
var MAX_BLEND_GROWTH = 3;
var MAX_EMBANKMENT_GRADIENT = Math.tan(0.86 * 0.86);
var SMOOTHSTEP_PEAK = 1.5;
var pathCuts = /* @__PURE__ */ new Map();
function blendWidth(path, s) {
  const cut = cutDepth(path, s) * path.carve;
  const needed = SMOOTHSTEP_PEAK * cut / MAX_EMBANKMENT_GRADIENT;
  return Math.min(path.shoulder * MAX_BLEND_GROWTH, Math.max(path.shoulder, needed));
}
function cutDepth(path, s) {
  let cuts = pathCuts.get(path.id);
  if (!cuts) {
    const profile = ensureProfile(path);
    cuts = new Float64Array(profile.length);
    pathCuts.set(path.id, cuts);
    for (let i = 0; i < profile.length; i++) {
      const { x, z } = pathAt(path.id, i * PROFILE_STEP);
      cuts[i] = Math.abs(profile[i] - paddedHeight(x, z));
    }
  }
  return sampleStations(path, cuts, s);
}
function profileHeight(path, s) {
  return sampleStations(path, ensureProfile(path), s);
}
function ensureProfile(path) {
  let profile = pathProfiles.get(path.id);
  if (!profile) {
    profilesUnderConstruction.add(path.id);
    profile = buildProfile(path);
    profilesUnderConstruction.delete(path.id);
    pathProfiles.set(path.id, profile);
  }
  return profile;
}
function sampleStations(path, stations, s) {
  const count = stations.length;
  const closed = isClosedLoop(path);
  const t = s / PROFILE_STEP;
  const i0 = Math.floor(t);
  const frac = t - i0;
  const wrap = (i) => closed ? (i % count + count) % count : clamp(i, 0, count - 1) | 0;
  return lerp(stations[wrap(i0)], stations[wrap(i0 + 1)], frac);
}
function pathAt(id, s) {
  const path = PATHS2.find((p) => p.id === id) ?? COAST_PATH;
  const total = pathLength(path.id);
  if (total <= 0) return { x: path.points[0][0], z: path.points[0][1], tx: 1, tz: 0 };
  let rem = isClosedLoop(path) ? (s % total + total) % total : clamp(s, 0, total);
  for (let i = 0; i < path.points.length - 1; i++) {
    const [ax, az] = path.points[i];
    const [bx, bz] = path.points[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    if (rem <= len) {
      const t = rem / len;
      return { x: ax + dx * t, z: az + dz * t, tx: dx / len, tz: dz / len };
    }
    rem -= len;
  }
  const [lx, lz] = path.points[path.points.length - 1];
  return { x: lx, z: lz, tx: 1, tz: 0 };
}
function naturalHeight(x, z) {
  const mask = islandMask(x, z);
  if (mask <= 0) {
    return -2.2 + mask * 52 - fbm(x * 6e-3 + 4.2, z * 6e-3 + 1.7, 3) * 5;
  }
  const inland = smoothstep(0, 0.16, mask);
  const mountain = massif(x, z);
  const rollingWeight = 1 - smoothstep(SUMMIT2.height * 0.19, SUMMIT2.height * 1.08, mountain);
  const rolling = (RELIEF.rolling + (fbm(x * 0.013 + 2.1, z * 0.013 + 9.4, 5) - 0.42) * RELIEF.rollingVariation) * rollingWeight;
  const shelf = rolling + shelfHeight(x, z) * rollingWeight;
  const coastal = smoothstep(0.015, 0.26, mask) * (1 - smoothstep(0.24, 0.52, mask));
  const ang2 = Math.atan2(z, x);
  const cliffiness = clamp(fbm(Math.cos(ang2) * 1.8 + 41.2, Math.sin(ang2) * 1.8 + 13.9, 3) * 2.1 - 0.5, 0, 1);
  let sheltered = 1;
  for (const s of SHELTERS) {
    sheltered *= 1 - smoothstep(s.reach, s.reach * 0.4, Math.hypot(x - s.x, z - s.z));
  }
  const cliff = coastal * RELIEF.cliff * cliffiness * sheltered;
  const detail = (fbm(x * 0.062 + 17, z * 0.062 + 31, 3) - 0.5) * RELIEF.detail;
  return inland * (shelf + cliff + mountain) + detail * inland + mask * 2.5;
}
function paddedHeight(x, z) {
  let h = naturalHeight(x, z);
  for (const pad of PADS2) {
    const dx = x - pad.x;
    const dz = z - pad.z;
    const dSq = dx * dx + dz * dz;
    if (dSq > pad.outer * pad.outer) continue;
    const w = 1 - smoothstep(pad.inner, pad.outer, Math.sqrt(dSq));
    h = lerp(h, pad.height, w);
  }
  return h;
}
function heightAt(x, z) {
  const h = paddedHeight(x, z);
  const hit = nearestPath(x, z);
  if (!hit.path) return h;
  const w = 1 - smoothstep(hit.path.halfWidth, hit.path.halfWidth + hit.blend, hit.dist);
  return lerp(h, profileHeight(hit.path, hit.s), w * hit.path.carve);
}
function normalAt(x, z, eps = 0.6) {
  const hL = heightAt(x - eps, z);
  const hR = heightAt(x + eps, z);
  const hD = heightAt(x, z - eps);
  const hU = heightAt(x, z + eps);
  const nx = hL - hR;
  const nz = hD - hU;
  const ny = 2 * eps;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}
function slopeAt(x, z) {
  return Math.acos(clamp(normalAt(x, z)[1], -1, 1));
}
var FOOTING_RADIUS = 1.15;
var FOOTING_TAPS = 8;
var FOOTING_RING = Array.from(
  { length: FOOTING_TAPS },
  (_, k) => {
    const a = k / FOOTING_TAPS * Math.PI * 2;
    return [Math.cos(a) * FOOTING_RADIUS, Math.sin(a) * FOOTING_RADIUS];
  }
);
function footingSlopeAt(x, z) {
  let gx = 0;
  let gz = 0;
  for (const [dx, dz] of FOOTING_RING) {
    const h = heightAt(x + dx, z + dz);
    gx += h * dx;
    gz += h * dz;
  }
  const norm = FOOTING_TAPS * FOOTING_RADIUS * FOOTING_RADIUS / 2;
  return Math.atan(Math.hypot(gx / norm, gz / norm));
}
var MAX_WALKABLE_SLOPE = 0.86;
var MAX_WADE_DEPTH = 0.9;
function isWalkable(x, z) {
  if (Math.abs(x) > ISLAND_EXTENT2 || Math.abs(z) > ISLAND_EXTENT2) return false;
  const h = heightAt(x, z);
  if (h < -MAX_WADE_DEPTH) return false;
  return footingSlopeAt(x, z) <= MAX_WALKABLE_SLOPE;
}
function illegality(x, z) {
  const depth = Math.max(0, -heightAt(x, z) - MAX_WADE_DEPTH);
  const steep = Math.max(0, footingSlopeAt(x, z) - MAX_WALKABLE_SLOPE);
  return depth + steep * 10;
}
onMapChange((pack) => {
  const t = pack.terrain;
  ISLAND_EXTENT2 = t.extent;
  OCEAN_RADIUS2 = t.oceanRadius;
  SUMMIT2 = t.summit;
  PADS2 = t.pads;
  PATHS2 = t.paths;
  COAST_RADIUS2 = t.coastRadius;
  MASSIF_RADIUS2 = t.massifRadius;
  CAPES2 = t.capes;
  BAYS2 = t.bays;
  SHELVES2 = t.shelves;
  RELIEF = t.relief;
  SHELTERS = t.shelters;
  COAST_PATH = t.paths[0];
  PROMENADE_HALF_WIDTH = COAST_PATH?.halfWidth ?? 0;
  PATH_GRID_HALF = Math.ceil((ISLAND_EXTENT2 + PATH_CELL) / PATH_CELL);
  PATH_GRID_SIZE = PATH_GRID_HALF * 2 + 1;
  pathGrid = null;
  pathLengths.clear();
  pathProfiles.clear();
  pathCuts.clear();
  profilesUnderConstruction.clear();
});

// packages/shared/src/movement.ts
var MOVE_SPEED = {
  walk: 4.2,
  run: 9,
  /** Wading through shallow water. Slow enough to be a decision, not an obstacle. */
  wade: 2
};
var MAX_CLIENT_SPEED = MOVE_SPEED.run;
var MAX_SERVER_SPEED = MAX_CLIENT_SPEED + 2.5;

// packages/shared/src/world.ts
var ZONES2 = [];
var LANDMARKS2 = [];
var INTERACTABLES2 = [];
var ACTIVITY_TEMPLATES2 = [];
var SPAWN_POINTS2 = [];
var FALLBACK_ZONE = "coast";
var VENUE_ZONES = [];
var ZONE_INDEX = /* @__PURE__ */ new Map();
var ZONES_BY_SPECIFICITY = [];
var INTERACTABLE_INDEX = /* @__PURE__ */ new Map();
var TEMPLATE_INDEX = /* @__PURE__ */ new Map();
onMapChange((pack) => {
  const w = pack.world;
  ZONES2 = w.zones;
  LANDMARKS2 = w.landmarks;
  INTERACTABLES2 = w.interactables;
  ACTIVITY_TEMPLATES2 = w.activityTemplates;
  SPAWN_POINTS2 = w.spawnPoints;
  FALLBACK_ZONE = w.fallbackZone;
  VENUE_ZONES = w.zones.filter((z) => z.kind === "venue").map((z) => z.id);
  ZONE_INDEX = new Map(w.zones.map((z) => [z.id, z]));
  ZONES_BY_SPECIFICITY = [...w.zones].sort((a, b) => a.radius - b.radius);
  TEMPLATE_INDEX = new Map(w.activityTemplates.map((t) => [t.id, t]));
  INTERACTABLE_INDEX = new Map(w.interactables.map((i) => [i.id, i]));
});

// scripts/terrain-audit.ts
var CELL = 1;
var PINHOLE_NEIGHBOURS = 6;
var map = activeMap();
var half = Math.ceil(ISLAND_EXTENT2 / CELL);
var size = half * 2 + 1;
var toWorld = (i) => (i - half) * CELL;
var toGrid = (w) => Math.round(w / CELL) + half;
process.stdout.write(`terrain audit \u2014 ${map.name} (${map.id}), ${size}\xD7${size} cells @ ${CELL} m

`);
var grid = new Uint8Array(size * size);
var land = 0;
var walkable = 0;
var slopes = [];
for (let j = 0; j < size; j++) {
  const z = toWorld(j);
  for (let i = 0; i < size; i++) {
    const x = toWorld(i);
    const h = heightAt(x, z);
    if (h < -0.9 || !isLand(x, z)) continue;
    land++;
    const ok = isWalkable(x, z);
    grid[j * size + i] = ok ? 1 : 2;
    if (ok) walkable++;
    if ((i + j) % 7 === 0) slopes.push(slopeAt(x, z));
  }
}
slopes.sort((a, b) => a - b);
var pct = (p) => ((slopes[Math.floor(slopes.length * p)] ?? 0) * (180 / Math.PI)).toFixed(1);
process.stdout.write(
  `land cells        ${land}
walkable          ${walkable} (${(walkable / land * 100).toFixed(1)}%)
slope p50/p90/p99 ${pct(0.5)}\xB0 / ${pct(0.9)}\xB0 / ${pct(0.99)}\xB0

`
);
var pinholes = [];
for (let j = 1; j < size - 1; j++) {
  for (let i = 1; i < size - 1; i++) {
    if (grid[j * size + i] !== 2) continue;
    let open = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        if (grid[(j + dj) * size + (i + di)] === 1) open++;
      }
    }
    if (open >= PINHOLE_NEIGHBOURS) {
      pinholes.push([toWorld(i), toWorld(j), open]);
    }
  }
}
process.stdout.write(
  `pinholes (blocked cell, \u2265${PINHOLE_NEIGHBOURS}/8 neighbours open): ${pinholes.length}
`
);
for (const [x, z, open] of pinholes.slice(0, 8)) {
  process.stdout.write(
    `    (${x.toFixed(0).padStart(5)}, ${z.toFixed(0).padStart(5)})  ${open}/8 open  point ${(slopeAt(x, z) * 180 / Math.PI).toFixed(1)}\xB0  footing ${(footingSlopeAt(x, z) * 180 / Math.PI).toFixed(1)}\xB0  h ${heightAt(x, z).toFixed(2)}
`
  );
}
if (pinholes.length > 8) process.stdout.write(`    \u2026 and ${pinholes.length - 8} more
`);
process.stdout.write("\n");
var STEP = MOVE_SPEED.run / 60;
var canOccupy = (fromX, fromZ, x, z) => {
  if (isWalkable(x, z)) return true;
  const here = illegality(fromX, fromZ);
  return here > 0 && illegality(x, z) < here;
};
var snags = [];
function walkLine(label, ax, az, bx, bz) {
  const span = Math.hypot(bx - ax, bz - az);
  const steps = Math.ceil(span / STEP);
  if (!steps) return;
  const ux = (bx - ax) / span;
  const uz = (bz - az) / span;
  let x = ax;
  let z = az;
  for (let i = 0; i < steps; i++) {
    const nx = x + ux * STEP;
    const nz = z + uz * STEP;
    if (!canOccupy(x, z, nx, nz) && heightAt(nx, nz) >= -MAX_WADE_DEPTH) {
      snags.push([label, nx, nz]);
    }
    x = nx;
    z = nz;
  }
}
for (const path of PATHS2) {
  const pts = path.points;
  for (let k = 1; k < pts.length; k++) {
    walkLine(`lane ${path.id}`, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
  }
}
for (const pad of PADS2) {
  for (let a = 0; a < 16; a++) {
    const angle = a / 16 * Math.PI * 2;
    walkLine(
      `pad ${pad.id}`,
      pad.x,
      pad.z,
      pad.x + Math.cos(angle) * pad.inner,
      pad.z + Math.sin(angle) * pad.inner
    );
  }
}
var laneSnags = snags.filter(([label]) => label.startsWith("lane"));
process.stdout.write(
  `snags \u2014 straight-ahead steps the contract refused, walking the routes
  on lane centrelines  ${laneSnags.length}
  inside terraces      ${snags.length - laneSnags.length}
`
);
var shown = /* @__PURE__ */ new Set();
for (const [label, x, z] of snags) {
  const key = `${label}@${Math.round(x / 4)},${Math.round(z / 4)}`;
  if (shown.has(key)) continue;
  shown.add(key);
  if (shown.size > 12) break;
  process.stdout.write(
    `    ${label.padEnd(22)} (${x.toFixed(0).padStart(5)}, ${z.toFixed(0).padStart(5)})  footing ${(footingSlopeAt(x, z) * 180 / Math.PI).toFixed(1)}\xB0  h ${heightAt(x, z).toFixed(2)}
`
  );
}
process.stdout.write("\n");
var region = new Int32Array(size * size).fill(-1);
var [spawnX, spawnZ] = SPAWN_POINTS2[0];
var start = toGrid(spawnZ) * size + toGrid(spawnX);
if (grid[start] !== 1) throw new Error(`spawn (${spawnX}, ${spawnZ}) is not on a walkable cell`);
var stack = [start];
region[start] = 0;
var mainRegion = 0;
while (stack.length) {
  const at = stack.pop();
  const i = at % size;
  const j = (at - i) / size;
  mainRegion++;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= size || nj >= size) continue;
      const n = nj * size + ni;
      if (region[n] !== -1 || grid[n] !== 1) continue;
      region[n] = 0;
      stack.push(n);
    }
  }
}
var stranded = walkable - mainRegion;
process.stdout.write(
  `main region       ${mainRegion} cells (${(mainRegion / walkable * 100).toFixed(1)}% of walkable)
stranded          ${stranded} cells in pockets you cannot walk to

`
);
var reachable = (x, z) => {
  const i = toGrid(x);
  const j = toGrid(z);
  if (i < 0 || j < 0 || i >= size || j >= size) return false;
  return region[j * size + i] === 0;
};
var problems = 0;
for (const zone of ZONES2) {
  if (zone.radius > 500) continue;
  if (!reachable(zone.x, zone.z)) {
    problems++;
    process.stdout.write(`  UNREACHABLE zone   ${zone.id} (${zone.x}, ${zone.z})
`);
  }
}
for (const path of PATHS2) {
  for (const [x, z] of path.points) {
    if (!reachable(x, z)) {
      problems++;
      process.stdout.write(`  UNREACHABLE lane   ${path.id} waypoint (${x}, ${z})
`);
    }
  }
}
for (const lm of LANDMARKS2) {
  if (lm.opts?.inWater === true) continue;
  let approachable = reachable(lm.x, lm.z);
  for (let r = 2; r <= 6 && !approachable; r += 2) {
    for (let i = 0; i < 12 && !approachable; i++) {
      const a = i / 12 * Math.PI * 2;
      approachable = reachable(lm.x + Math.cos(a) * r, lm.z + Math.sin(a) * r);
    }
  }
  if (!approachable) {
    problems++;
    process.stdout.write(
      `  UNREACHABLE mark   ${lm.id} (${lm.kind}) at (${lm.x.toFixed(0)}, ${lm.z.toFixed(0)})
`
    );
  }
}
process.stdout.write(
  problems === 0 ? "  every zone, lane waypoint and landmark is reachable on foot\n" : `
  ${problems} unreachable
`
);
process.stdout.write("\n");
var verdicts = [
  ["lane centrelines are snag-free", laneSnags.length === 0, `${laneSnags.length} refused steps`],
  ["terraces are snag-free", snags.length - laneSnags.length === 0, `${snags.length - laneSnags.length} refused steps`],
  ["pinholes are rare overall", pinholes.length <= land * 1e-3, `${pinholes.length} over ${land} land cells`],
  ["nothing important is cut off", problems === 0, `${problems} unreachable`],
  ["stranded pockets are small", stranded <= walkable * 0.02, `${stranded} of ${walkable}`],
  ["the island is not simply flat", walkable < land * 0.98, `${(walkable / land * 100).toFixed(1)}% walkable`]
];
var bad = 0;
for (const [name, ok, detail] of verdicts) {
  if (!ok) bad++;
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${name} \u2014 ${detail}
`);
}
process.stdout.write(bad === 0 ? "\nterrain audit passed\n" : `
terrain audit failed (${bad})
`);
process.exit(bad === 0 ? 0 : 1);
