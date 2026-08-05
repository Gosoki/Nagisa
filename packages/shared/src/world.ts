/**
 * Nagisa world layout — world model v2.
 * =====================================
 *
 * The island's *semantic* map: where the zones are, which of them can host an activity,
 * where players arrive, and what can be interacted with. Geometry lives in `terrain.ts`;
 * this file says what the geometry **means**, and lists every building on it.
 *
 * Both halves of the product read from here:
 *
 * - the **client** places landmarks, ambience, lanterns and stage props relative to zone
 *   anchors, and shows zone names as you walk into them;
 * - the **server** resolves which zone a player is standing in (occupancy counts,
 *   zone-scoped announcements), validates that an activity is being hosted somewhere it
 *   is allowed to be hosted, and picks spawn points.
 *
 * Adding a place to the island therefore means adding one entry here, not editing two
 * codebases.
 *
 * ### The shape of the island, in one paragraph
 *
 * You arrive by ferry at the **South Harbour**, the busiest place on Nagisa. The lane up
 * from the quay reaches the **Main Plaza** on the mountain's southern shoulder, with the
 * **Notice Board** on its upper terrace. From the plaza the coast road runs both ways
 * round the island: west past **Sunset Beach** to the **Shrine** on the western headland,
 * on round the north side to the working **North Harbour**, out to the **Lighthouse Cape**
 * on the north-east, then down the east coast through the **Teahouse** terrace and the
 * **Old Street** and back to the harbour. Three lanes climb inland from that ring, and all
 * three end at the **Summit**, where the inner shrine looks down on everything.
 */

import { PADS, heightAt, nearestWalkable, padById } from './terrain.js';

/**
 * Zone identifiers. Union rather than enum so they serialise as readable strings.
 *
 * These strings appear in the wire protocol (`zonePopulation`, activity records,
 * announcement scopes) and in persisted state, so renaming one is a protocol change.
 */
export type ZoneId =
  | 'south-harbor'
  | 'north-harbor'
  | 'plaza'
  | 'noticeboard'
  | 'village'
  | 'teahouse'
  | 'shrine'
  | 'summit'
  | 'lighthouse'
  | 'beach'
  | 'coast';

/** What a zone is *for*. Drives UI affordances and server-side validation. */
export type ZoneKind =
  /** Can host activities. Gets a stage anchor and audience space. */
  | 'venue'
  /** Somewhere to be, not somewhere to perform. Bench seating, quiet ambience. */
  | 'rest'
  /** Announcements are read here; the notice board's physical home. */
  | 'notice'
  /** A view. Camera widens, ambience thins out. */
  | 'scenic'
  /** Connective tissue between places. */
  | 'transit';

export interface Zone {
  readonly id: ZoneId;
  /** English display name, shown as you enter. */
  readonly name: string;
  /** Japanese name, shown smaller beneath. Flavour, never load-bearing. */
  readonly nameJa: string;
  readonly kind: ZoneKind;
  /** Anchor point on the ground plane. Y comes from the terrain field. */
  readonly x: number;
  readonly z: number;
  /** Players within this radius of the anchor are counted as "in" the zone. */
  readonly radius: number;
  /**
   * Where a performer/host stands, relative to the anchor. Venues only. The client puts
   * the stage geometry here and the server pins hosts to it during a live activity.
   */
  readonly stage?: { readonly dx: number; readonly dz: number; readonly facing: number };
  /** Suggested audience capacity. Advisory: informs activity defaults, not enforced here. */
  readonly softCapacity: number;
  /** Ambience loop played while inside. Keys map to files in the client audio manifest. */
  readonly ambience: 'waves' | 'harbor' | 'town' | 'forest' | 'wind' | 'shrine';
  /**
   * One sentence shown when the zone is first entered. Reference-product register:
   * observational, unhurried, never instructional.
   */
  readonly caption: string;
}

/**
 * Every named place on the island.
 *
 * Anchors are aligned with the flattening pads in `terrain.ts` — a venue whose anchor
 * drifts off its pad will end up on a slope, and `world-smoke` fails the build if one
 * does. `coast` is the exception: it is the fallback, and its anchor is nominal.
 */
export const ZONES: readonly Zone[] = [
  {
    id: 'south-harbor',
    name: 'South Harbour',
    nameJa: '南港',
    kind: 'venue',
    x: 16,
    z: 192,
    radius: 52,
    stage: { dx: -18, dz: -8, facing: Math.PI * 0.15 },
    softCapacity: 60,
    ambience: 'harbor',
    caption: 'The ferry ties up here. Everyone arrives at the south quay.',
  },
  {
    id: 'north-harbor',
    name: 'North Harbour',
    nameJa: '北港',
    kind: 'venue',
    x: -36,
    z: -198,
    radius: 46,
    stage: { dx: 14, dz: 6, facing: -Math.PI * 0.4 },
    softCapacity: 40,
    ambience: 'harbor',
    caption: 'Nets, ice, and boats that go out before anyone is awake.',
  },
  {
    id: 'plaza',
    name: 'Main Plaza',
    nameJa: '広場',
    kind: 'venue',
    x: 0,
    z: 108,
    radius: 56,
    stage: { dx: 0, dz: -20, facing: 0 },
    softCapacity: 140,
    ambience: 'town',
    caption: 'Halfway up the hill, facing the sea. Something is usually about to start.',
  },
  {
    id: 'noticeboard',
    name: 'Notice Board',
    nameJa: '掲示板',
    kind: 'notice',
    x: -26,
    z: 94,
    radius: 18,
    softCapacity: 20,
    ambience: 'town',
    caption: 'Paper slips, pinned and re-pinned. Today’s word is here.',
  },
  {
    id: 'village',
    name: 'Old Street',
    nameJa: '町並み',
    kind: 'transit',
    x: 176,
    z: 76,
    radius: 48,
    softCapacity: 50,
    ambience: 'town',
    caption: 'Wooden fronts, low eaves, a cat that has never moved.',
  },
  {
    id: 'teahouse',
    name: 'Teahouse',
    nameJa: '茶屋',
    kind: 'rest',
    x: 168,
    z: -62,
    radius: 38,
    stage: { dx: -8, dz: 8, facing: Math.PI * 0.8 },
    softCapacity: 24,
    ambience: 'forest',
    caption: 'Somewhere to sit, high above the east coast. The kettle is always about to boil.',
  },
  {
    id: 'shrine',
    name: 'Shrine',
    nameJa: '神社',
    kind: 'venue',
    x: -186,
    z: 20,
    radius: 44,
    stage: { dx: 0, dz: -16, facing: 0 },
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
    z: -14,
    radius: 40,
    softCapacity: 30,
    ambience: 'wind',
    caption: 'From up here the whole island fits between your hands.',
  },
  {
    id: 'lighthouse',
    name: 'Lighthouse Cape',
    nameJa: '灯台岬',
    kind: 'venue',
    x: 138,
    z: -190,
    radius: 40,
    stage: { dx: -14, dz: 12, facing: Math.PI * 0.75 },
    softCapacity: 50,
    ambience: 'wind',
    caption: 'The lamp turns whether anyone is watching or not.',
  },
  {
    id: 'beach',
    name: 'Sunset Beach',
    nameJa: '浜',
    kind: 'venue',
    x: -166,
    z: 146,
    radius: 50,
    stage: { dx: 16, dz: -6, facing: -Math.PI * 0.62 },
    softCapacity: 80,
    ambience: 'waves',
    caption: 'Flat sand, shallow water, and the long light.',
  },
  {
    id: 'coast',
    name: 'Coast Road',
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

/** Zones that may host activities. The server rejects activities anywhere else. */
export const VENUE_ZONES: readonly ZoneId[] = ZONES.filter((z) => z.kind === 'venue').map((z) => z.id);

const ZONE_INDEX = new Map<ZoneId, Zone>(ZONES.map((z) => [z.id, z]));

export function getZone(id: ZoneId): Zone | undefined {
  return ZONE_INDEX.get(id);
}

export function isVenue(id: ZoneId): boolean {
  return getZone(id)?.kind === 'venue';
}

/**
 * Zones ordered tightest-first, so {@link zoneAt} can return the most specific match.
 * Computed once; `ZONES` is frozen data.
 */
const ZONES_BY_SPECIFICITY: readonly Zone[] = [...ZONES].sort((a, b) => a.radius - b.radius);

/**
 * Which zone a world position belongs to.
 *
 * Resolution is *smallest containing zone wins*. Overlaps are intentional and nested —
 * the notice board (r=18) sits inside the plaza (r=56), which sits inside the coast
 * fallback (r=9999) — so ranking by radius yields the most specific place without any
 * explicit priority field to keep in sync.
 *
 * Ranking by *distance* instead would be wrong: the fallback zone's enormous radius
 * makes almost every point "deeply inside" it, and it would swallow every named place.
 */
export function zoneAt(x: number, z: number): ZoneId {
  for (const zone of ZONES_BY_SPECIFICITY) {
    if (Math.hypot(x - zone.x, z - zone.z) <= zone.radius) return zone.id;
  }
  return 'coast';
}

/** World-space stage position of a venue, with terrain height applied. */
export function stagePosition(id: ZoneId): { x: number; y: number; z: number; facing: number } | null {
  const zone = getZone(id);
  if (!zone?.stage) return null;
  const x = zone.x + zone.stage.dx;
  const z = zone.z + zone.stage.dz;
  return { x, y: heightAt(x, z), z, facing: zone.stage.facing };
}

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

/**
 * Where new visitors appear.
 *
 * All of them are on the south harbour quay, facing inland: you arrive by water, and the
 * walk up to the plaza is the island introducing itself. Several points, spread along the
 * quay, so a crowd arriving together does not stack into one body.
 */
export const SPAWN_POINTS: readonly (readonly [number, number])[] = [
  [10, 200],
  [22, 196],
  [0, 202],
  [28, 190],
  [-8, 194],
  [16, 206],
] as const;

/** A spawn position with terrain height and a facing that looks toward the island. */
export function spawnPoint(index: number): { pos: [number, number, number]; yaw: number } {
  const [sx, sz] = SPAWN_POINTS[index % SPAWN_POINTS.length];
  const [x, z] = nearestWalkable(sx, sz);
  // Face the mountain, which is due north (−z) of the south harbour.
  const yaw = Math.atan2(0 - x, -14 - z);
  return { pos: [x, heightAt(x, z), z], yaw };
}

// ---------------------------------------------------------------------------
// Interactables
// ---------------------------------------------------------------------------

/** Something a player can walk up to and use. Deliberately few, deliberately small. */
export interface Interactable {
  readonly id: string;
  readonly zone: ZoneId;
  /** Offset from the zone anchor. */
  readonly dx: number;
  readonly dz: number;
  /** How close you must be for the prompt to appear, metres. */
  readonly range: number;
  readonly kind: 'use' | 'sit';
  /** Verb shown in the prompt, e.g. "Read". Kept to one word wherever possible. */
  readonly label: string;
  /**
   * What the server does when it is used. `none` is a purely client-side flourish
   * (sitting down, ringing a bell) that is still broadcast so others can see it.
   */
  readonly effect: 'none' | 'read_announcements' | 'checkin_nearby';
}

export const INTERACTABLES: readonly Interactable[] = [
  { id: 'notice-board', zone: 'noticeboard', dx: 0, dz: -5, range: 4.5, kind: 'use', label: 'Read', effect: 'read_announcements' },
  { id: 'plaza-post', zone: 'plaza', dx: -22, dz: 10, range: 3.5, kind: 'use', label: 'Check in', effect: 'checkin_nearby' },
  { id: 'shrine-bell', zone: 'shrine', dx: 4, dz: -10, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'summit-bell', zone: 'summit', dx: 12, dz: 6, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'south-harbor-bell', zone: 'south-harbor', dx: 14, dz: 6, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'north-harbor-bell', zone: 'north-harbor', dx: -12, dz: -6, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'lighthouse-door', zone: 'lighthouse', dx: 0, dz: 4, range: 4, kind: 'use', label: 'Look', effect: 'none' },
  { id: 'summit-rail', zone: 'summit', dx: -2, dz: 16, range: 5, kind: 'use', label: 'Look', effect: 'none' },
  { id: 'teahouse-mat-a', zone: 'teahouse', dx: -7, dz: 3, range: 2.5, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'teahouse-mat-b', zone: 'teahouse', dx: -3, dz: 5, range: 2.5, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'beach-log', zone: 'beach', dx: 8, dz: 12, range: 3, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'plaza-bench', zone: 'plaza', dx: 20, dz: 12, range: 3, kind: 'sit', label: 'Sit', effect: 'none' },
] as const;

/** World-space position of an interactable, terrain height applied. */
export function interactablePosition(it: Interactable): { x: number; y: number; z: number } {
  const zone = getZone(it.zone)!;
  const x = zone.x + it.dx;
  const z = zone.z + it.dz;
  return { x, y: heightAt(x, z), z };
}

const INTERACTABLE_INDEX = new Map<string, Interactable>(INTERACTABLES.map((i) => [i.id, i]));

export function getInteractable(id: string): Interactable | undefined {
  return INTERACTABLE_INDEX.get(id);
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

/**
 * Generators available in the client's prop library. Adding a kind here without adding
 * the matching builder in `apps/client/src/world/props/` produces a landmark the island
 * silently skips (and `world-smoke` fails on), which is the intended failure mode: data
 * and code can be edited in either order.
 */
export type LandmarkKind =
  // — Waterfront ——————————————————————————————————————————————
  | 'pier'
  | 'boat'
  | 'breakwater'
  | 'boathouse'
  | 'net-rack'
  | 'sea-wall'
  | 'beach-hut'
  // — Buildings ————————————————————————————————————————————————
  | 'warehouse'
  | 'machiya'
  | 'minka'
  | 'bathhouse'
  | 'teahouse'
  | 'market-stall'
  | 'keepers-house'
  // — Sacred ————————————————————————————————————————————————————
  | 'torii'
  | 'shrine-hall'
  | 'temizuya'
  | 'komainu'
  | 'bell-tower'
  // — Civic ————————————————————————————————————————————————————
  | 'stage'
  | 'notice-board'
  | 'gate'
  | 'well'
  | 'banner'
  | 'lighthouse'
  // — Furniture ————————————————————————————————————————————————
  | 'stone-lantern'
  | 'post-lantern'
  | 'bench'
  | 'rail'
  | 'steps'
  | 'summit-marker'
  | 'rock';

/**
 * Fixed set-pieces the client builds. The server does not care about these, but they
 * live here so the world's contents are described in one place and so the client's scene
 * assembly is data-driven rather than a wall of hard-coded coordinates.
 *
 * `y` is always resolved from the terrain field at build time — never authored. A prop
 * whose base should sit *below* the terrain (a pier deck standing over water, a boat
 * floating) says so with `seaLevel: true` in `opts` and is placed at y = 0 instead.
 */
export interface Landmark {
  readonly id: string;
  readonly kind: LandmarkKind;
  readonly x: number;
  readonly z: number;
  /** Yaw in radians. */
  readonly rot: number;
  /** Uniform scale multiplier. 1 = the generator's natural size. */
  readonly scale?: number;
  /** Free-form generator options, e.g. roof colour index or building width. */
  readonly opts?: Readonly<Record<string, number | string | boolean>>;
}

/**
 * Hand-placed landmarks — every building on Nagisa.
 *
 * Grouped by zone, and within a zone roughly in the order you would meet them walking in.
 * The coast road's lanterns, mile-posts and railings are *not* here: those are placed by
 * arc length along the path at build time, because spacing them by hand would be busywork
 * that goes stale the moment the road is re-routed.
 */
export const LANDMARKS: readonly Landmark[] = [
  // ═══ South Harbour — the arrival port ═══════════════════════════════════
  // The ferry pier runs south into the bay; everything else lines the quay behind it.
  { id: 'sh-torii-sea', kind: 'torii', x: 18, z: 252, rot: 0.06, scale: 2.1, opts: { inWater: true } },
  { id: 'sh-pier-main', kind: 'pier', x: 16, z: 214, rot: 0, opts: { length: 46, width: 8, lamps: true } },
  { id: 'sh-pier-west', kind: 'pier', x: -12, z: 202, rot: Math.PI * 0.42, opts: { length: 28, width: 5 } },
  { id: 'sh-breakwater', kind: 'breakwater', x: 58, z: 224, rot: -0.5, opts: { length: 60, beacon: true } },
  { id: 'sh-boat-1', kind: 'boat', x: 34, z: 228, rot: 0.35, opts: { style: 'ferry', scale: 1.4 } },
  { id: 'sh-boat-2', kind: 'boat', x: -4, z: 226, rot: -0.8 },
  { id: 'sh-boat-3', kind: 'boat', x: -26, z: 216, rot: 2.2, scale: 0.85 },
  { id: 'sh-seawall-e', kind: 'sea-wall', x: 40, z: 202, rot: -0.35, opts: { length: 34 } },
  { id: 'sh-seawall-w', kind: 'sea-wall', x: -10, z: 194, rot: 0.9, opts: { length: 26 } },
  { id: 'sh-warehouse-1', kind: 'warehouse', x: 38, z: 180, rot: -0.28, opts: { w: 17, d: 11, floors: 2 } },
  { id: 'sh-warehouse-2', kind: 'warehouse', x: -8, z: 178, rot: 0.18, opts: { w: 13, d: 10 } },
  { id: 'sh-office', kind: 'machiya', x: 20, z: 174, rot: Math.PI, opts: { w: 11, d: 12, floors: 2, sign: true } },
  { id: 'sh-stall-1', kind: 'market-stall', x: -6, z: 194, rot: 0.1, opts: { cloth: 1 } },
  { id: 'sh-stall-2', kind: 'market-stall', x: 2, z: 196, rot: 0.1, opts: { cloth: 2 } },
  { id: 'sh-stall-3', kind: 'market-stall', x: 10, z: 198, rot: 0.1, opts: { cloth: 0 } },
  { id: 'sh-stage', kind: 'stage', x: -4, z: 186, rot: Math.PI * 0.15, opts: { w: 15, d: 11 } },
  { id: 'sh-bell', kind: 'bell-tower', x: 30, z: 196, rot: 0, scale: 0.8 },
  { id: 'sh-lantern-1', kind: 'post-lantern', x: 6, z: 190, rot: 0 },
  { id: 'sh-lantern-2', kind: 'post-lantern', x: 26, z: 186, rot: 0 },
  { id: 'sh-banner-1', kind: 'banner', x: -12, z: 196, rot: 0.2 },
  { id: 'sh-banner-2', kind: 'banner', x: 34, z: 190, rot: -0.3 },
  { id: 'sh-rock-1', kind: 'rock', x: 70, z: 200, rot: 0.4, scale: 1.6 },
  { id: 'sh-rock-2', kind: 'rock', x: -34, z: 198, rot: 1.1, scale: 1.2 },

  // ═══ Main Plaza — the island's civic centre ═════════════════════════════
  { id: 'pl-stage', kind: 'stage', x: 0, z: 88, rot: 0, opts: { w: 22, d: 15, roof: true, tiers: true } },
  { id: 'pl-gate-s', kind: 'gate', x: 4, z: 140, rot: 0.05, scale: 1.15 },
  { id: 'pl-gate-e', kind: 'gate', x: 40, z: 112, rot: Math.PI * 0.5 },
  { id: 'pl-well', kind: 'well', x: 22, z: 118, rot: 0.3 },
  { id: 'pl-lantern-1', kind: 'stone-lantern', x: -16, z: 92, rot: 0.3 },
  { id: 'pl-lantern-2', kind: 'stone-lantern', x: 16, z: 92, rot: -0.3 },
  { id: 'pl-lantern-3', kind: 'stone-lantern', x: -16, z: 124, rot: 0.1 },
  { id: 'pl-lantern-4', kind: 'stone-lantern', x: 16, z: 124, rot: -0.1 },
  { id: 'pl-bench-1', kind: 'bench', x: 20, z: 120, rot: -0.6 },
  { id: 'pl-bench-2', kind: 'bench', x: -20, z: 120, rot: 0.6 },
  { id: 'pl-banner-1', kind: 'banner', x: -8, z: 136, rot: 0 },
  { id: 'pl-banner-2', kind: 'banner', x: 16, z: 136, rot: 0 },
  { id: 'pl-minka-1', kind: 'minka', x: 44, z: 92, rot: -0.5, opts: { w: 14, d: 11 } },
  { id: 'pl-minka-2', kind: 'minka', x: -46, z: 108, rot: 0.7, opts: { w: 12, d: 10 } },
  { id: 'pl-banner-3', kind: 'banner', x: -30, z: 118, rot: 0.2 },
  { id: 'pl-lantern-5', kind: 'stone-lantern', x: -34, z: 100, rot: 0.2 },
  { id: 'pl-bench-3', kind: 'bench', x: 26, z: 96, rot: -1.2 },

  // — Notice-board terrace, one step above the plaza ——————————————————
  { id: 'nb-board', kind: 'notice-board', x: -26, z: 89, rot: 0.1, scale: 1.5 },
  { id: 'nb-lantern-1', kind: 'stone-lantern', x: -34, z: 96, rot: 0 },
  { id: 'nb-bench-1', kind: 'bench', x: -18, z: 98, rot: -0.4 },
  { id: 'nb-steps', kind: 'steps', x: -14, z: 100, rot: -0.9, opts: { width: 6, rise: 2.4 } },

  // ═══ Old Street — the village on the eastern shelf ═════════════════════
  // A real street: two facing rows with a gap you walk down, not a scattering of huts.
  { id: 'ov-machiya-1', kind: 'machiya', x: 160, z: 52, rot: Math.PI * 0.5, opts: { w: 10, d: 13, floors: 2, sign: true } },
  { id: 'ov-machiya-2', kind: 'machiya', x: 160, z: 66, rot: Math.PI * 0.5, opts: { w: 9, d: 12, floors: 2 } },
  { id: 'ov-machiya-3', kind: 'machiya', x: 160, z: 80, rot: Math.PI * 0.5, opts: { w: 10, d: 13, floors: 1, sign: true } },
  { id: 'ov-machiya-4', kind: 'machiya', x: 160, z: 94, rot: Math.PI * 0.5, opts: { w: 9, d: 12, floors: 2 } },
  { id: 'ov-machiya-5', kind: 'machiya', x: 192, z: 54, rot: -Math.PI * 0.5, opts: { w: 10, d: 12, floors: 2 } },
  { id: 'ov-machiya-6', kind: 'machiya', x: 192, z: 68, rot: -Math.PI * 0.5, opts: { w: 9, d: 13, floors: 1, sign: true } },
  { id: 'ov-machiya-7', kind: 'machiya', x: 192, z: 82, rot: -Math.PI * 0.5, opts: { w: 10, d: 12, floors: 2 } },
  { id: 'ov-machiya-8', kind: 'machiya', x: 192, z: 96, rot: -Math.PI * 0.5, opts: { w: 9, d: 11, floors: 2, sign: true } },
  { id: 'ov-bathhouse', kind: 'bathhouse', x: 176, z: 34, rot: Math.PI, opts: { w: 15, d: 12 } },
  { id: 'ov-warehouse', kind: 'warehouse', x: 208, z: 74, rot: -Math.PI * 0.5, opts: { w: 12, d: 9 } },
  { id: 'ov-minka', kind: 'minka', x: 148, z: 104, rot: 0.4, opts: { w: 13, d: 10 } },
  { id: 'ov-gate-s', kind: 'gate', x: 176, z: 110, rot: 0 },
  { id: 'ov-gate-n', kind: 'gate', x: 176, z: 42, rot: Math.PI },
  { id: 'ov-well', kind: 'well', x: 176, z: 74, rot: 0 },
  { id: 'ov-lantern-1', kind: 'post-lantern', x: 168, z: 60, rot: 0 },
  { id: 'ov-lantern-2', kind: 'post-lantern', x: 184, z: 74, rot: 0 },
  { id: 'ov-lantern-3', kind: 'post-lantern', x: 168, z: 88, rot: 0 },
  { id: 'ov-bench-1', kind: 'bench', x: 184, z: 62, rot: -1.4 },

  // ═══ Teahouse terrace — high on the east flank ═════════════════════════
  { id: 'th-main', kind: 'teahouse', x: 168, z: -68, rot: Math.PI * 0.8, opts: { w: 13, d: 10, veranda: true } },
  { id: 'th-lantern-1', kind: 'stone-lantern', x: 158, z: -56, rot: 0 },
  { id: 'th-lantern-2', kind: 'stone-lantern', x: 178, z: -54, rot: 0 },
  { id: 'th-bench-1', kind: 'bench', x: 160, z: -48, rot: 2.4 },
  { id: 'th-bench-2', kind: 'bench', x: 176, z: -46, rot: -2.6 },
  { id: 'th-rail', kind: 'rail', x: 176, z: -40, rot: 0.35, opts: { length: 22 } },
  { id: 'th-rock-1', kind: 'rock', x: 150, z: -70, rot: 0.9, scale: 1.1 },

  // ═══ Shrine — the western headland ═════════════════════════════════════
  // The approach runs east→west along the sando: three torii, then the hall.
  { id: 'sr-torii-1', kind: 'torii', x: -150, z: 14, rot: Math.PI * 0.5, scale: 1.5 },
  { id: 'sr-torii-2', kind: 'torii', x: -162, z: 16, rot: Math.PI * 0.5, scale: 1.4 },
  { id: 'sr-torii-3', kind: 'torii', x: -173, z: 18, rot: Math.PI * 0.5, scale: 1.3 },
  { id: 'sr-komainu-l', kind: 'komainu', x: -184, z: 10, rot: Math.PI * 0.5, opts: { side: 1 } },
  { id: 'sr-komainu-r', kind: 'komainu', x: -184, z: 30, rot: Math.PI * 0.5, opts: { side: -1 } },
  { id: 'sr-temizuya', kind: 'temizuya', x: -178, z: 34, rot: -0.4 },
  { id: 'sr-hall', kind: 'shrine-hall', x: -200, z: 20, rot: Math.PI * 0.5, opts: { w: 15, d: 12, honden: true } },
  { id: 'sr-bell', kind: 'bell-tower', x: -182, z: 10, rot: 0 },
  { id: 'sr-lantern-1', kind: 'stone-lantern', x: -192, z: 8, rot: 0, scale: 1.2 },
  { id: 'sr-lantern-2', kind: 'stone-lantern', x: -192, z: 32, rot: 0, scale: 1.2 },
  { id: 'sr-lantern-3', kind: 'stone-lantern', x: -166, z: 8, rot: 0 },
  { id: 'sr-lantern-4', kind: 'stone-lantern', x: -166, z: 28, rot: 0 },
  { id: 'sr-rock-1', kind: 'rock', x: -210, z: 44, rot: 0.5, scale: 1.7 },
  { id: 'sr-rock-2', kind: 'rock', x: -206, z: -6, rot: 2.1, scale: 1.3 },

  // ═══ Summit — the inner shrine, at the top of everything ═══════════════
  { id: 'su-torii', kind: 'torii', x: 0, z: 6, rot: 0, scale: 1.35 },
  { id: 'su-hall', kind: 'shrine-hall', x: 0, z: -22, rot: 0, opts: { w: 11, d: 9, honden: true, small: true } },
  { id: 'su-bell', kind: 'bell-tower', x: 12, z: -8, rot: -0.4 },
  { id: 'su-marker', kind: 'summit-marker', x: -8, z: -6, rot: 0.2 },
  { id: 'su-rail', kind: 'rail', x: -2, z: 4, rot: 0.1, opts: { length: 26 } },
  { id: 'su-lantern-1', kind: 'stone-lantern', x: -8, z: -18, rot: 0 },
  { id: 'su-lantern-2', kind: 'stone-lantern', x: 8, z: -18, rot: 0 },
  { id: 'su-bench-1', kind: 'bench', x: -14, z: 2, rot: 0.4 },
  { id: 'su-bench-2', kind: 'bench', x: 14, z: 2, rot: -0.4 },
  { id: 'su-rock-1', kind: 'rock', x: 16, z: -20, rot: 1.2, scale: 1.5 },
  { id: 'su-rock-2', kind: 'rock', x: -16, z: -24, rot: 0.3, scale: 1.8 },

  // ═══ Lighthouse Cape — the north-east headland ═════════════════════════
  { id: 'lh-tower', kind: 'lighthouse', x: 138, z: -190, rot: 0, scale: 1 },
  { id: 'lh-keepers', kind: 'keepers-house', x: 152, z: -176, rot: -0.7, opts: { w: 12, d: 9 } },
  { id: 'lh-store', kind: 'warehouse', x: 124, z: -172, rot: 0.5, opts: { w: 9, d: 7 } },
  { id: 'lh-rail', kind: 'rail', x: 140, z: -208, rot: 0.15, opts: { length: 32 } },
  { id: 'lh-bench-1', kind: 'bench', x: 126, z: -200, rot: 0.3 },
  { id: 'lh-lantern-1', kind: 'post-lantern', x: 148, z: -196, rot: 0 },
  { id: 'lh-rock-1', kind: 'rock', x: 160, z: -204, rot: 0.8, scale: 2.1 },
  { id: 'lh-rock-2', kind: 'rock', x: 116, z: -196, rot: 2.4, scale: 1.5 },

  // ═══ North Harbour — the working fishing harbour ═══════════════════════
  { id: 'nh-pier-e', kind: 'pier', x: -20, z: -214, rot: Math.PI * 0.02, opts: { length: 30, width: 6 } },
  { id: 'nh-pier-w', kind: 'pier', x: -52, z: -210, rot: -Math.PI * 0.12, opts: { length: 24, width: 5 } },
  { id: 'nh-boathouse-1', kind: 'boathouse', x: -58, z: -196, rot: -0.25, opts: { w: 9, d: 12 } },
  { id: 'nh-boathouse-2', kind: 'boathouse', x: -68, z: -188, rot: -0.45, opts: { w: 8, d: 11 } },
  { id: 'nh-shed', kind: 'warehouse', x: -18, z: -188, rot: 0.4, opts: { w: 14, d: 9 } },
  { id: 'nh-minka', kind: 'minka', x: -44, z: -180, rot: 0.15, opts: { w: 12, d: 10 } },
  { id: 'nh-netrack-1', kind: 'net-rack', x: -30, z: -190, rot: 0.3 },
  { id: 'nh-netrack-2', kind: 'net-rack', x: -24, z: -194, rot: 0.3 },
  { id: 'nh-boat-1', kind: 'boat', x: -34, z: -220, rot: 0.2, scale: 0.9 },
  { id: 'nh-boat-2', kind: 'boat', x: -48, z: -222, rot: -0.4, scale: 0.85 },
  { id: 'nh-torii-sea', kind: 'torii', x: -38, z: -244, rot: 0.1, scale: 1.5, opts: { inWater: true } },
  { id: 'nh-seawall', kind: 'sea-wall', x: -10, z: -200, rot: 1.3, opts: { length: 28 } },
  { id: 'nh-bell', kind: 'bell-tower', x: -46, z: -204, rot: 0.2, scale: 0.75 },
  { id: 'nh-stage', kind: 'stage', x: -26, z: -194, rot: -Math.PI * 0.4, opts: { w: 12, d: 9 } },
  { id: 'nh-rock-1', kind: 'rock', x: -70, z: -192, rot: 1.4, scale: 1.6 },

  // ═══ Sunset Beach — the south-west spit ════════════════════════════════
  { id: 'bh-hut-1', kind: 'beach-hut', x: -150, z: 130, rot: -0.6, opts: { w: 8, d: 6 } },
  { id: 'bh-hut-2', kind: 'beach-hut', x: -186, z: 134, rot: 0.5, opts: { w: 7, d: 6 } },
  { id: 'bh-stage', kind: 'stage', x: -150, z: 140, rot: -Math.PI * 0.62, opts: { w: 14, d: 10 } },
  { id: 'bh-bench-1', kind: 'bench', x: -158, z: 158, rot: 1.1 },
  { id: 'bh-bench-2', kind: 'bench', x: -176, z: 154, rot: -1.3 },
  { id: 'bh-boat-1', kind: 'boat', x: -196, z: 164, rot: 1.9, scale: 0.8 },
  { id: 'bh-rock-1', kind: 'rock', x: -200, z: 128, rot: 0.7, scale: 1.9 },
  { id: 'bh-rock-2', kind: 'rock', x: -134, z: 160, rot: 1.6, scale: 1.4 },
  { id: 'bh-lantern-1', kind: 'post-lantern', x: -168, z: 128, rot: 0 },
] as const;

// ---------------------------------------------------------------------------
// Activity templates
// ---------------------------------------------------------------------------

/**
 * The kinds of thing that happen on Nagisa.
 *
 * Templates exist so that a host does not fill in a form: they pick "Lantern Walk", the
 * server knows the venue, the shape and the defaults. This is the difference between a
 * calm product and an events dashboard.
 */
export interface ActivityTemplate {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  /** Venue it is normally held at. A host with admin rights may override. */
  readonly zone: ZoneId;
  /** Default run length, minutes. */
  readonly durationMin: number;
  /** 0 = uncapped. */
  readonly capacity: number;
  readonly checkinEnabled: boolean;
  /**
   * What participants physically do. The client uses this to choose crowd formation and
   * default animation: `gather` mills about, `seated` sits, `procession` follows the host.
   */
  readonly formation: 'gather' | 'seated' | 'procession';
}

export const ACTIVITY_TEMPLATES: readonly ActivityTemplate[] = [
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

export function getTemplate(id: string): ActivityTemplate | undefined {
  return ACTIVITY_TEMPLATES.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// Crowd placement
// ---------------------------------------------------------------------------

/**
 * Where the *n*th attendee of an activity should stand.
 *
 * Used by the client to suggest a spot when you join (you are walked there, never
 * teleported) and by the server to place NPC-less crowd markers. Rings rather than a
 * grid: crowds around a stage are round, and a round crowd hides population gaps, which
 * is what keeps a half-full plaza from feeling empty.
 */
export function crowdSlot(zoneId: ZoneId, index: number): { x: number; z: number; yaw: number } | null {
  const zone = getZone(zoneId);
  if (!zone) return null;
  const stage = zone.stage;
  const originX = zone.x + (stage ? stage.dx : 0);
  const originZ = zone.z + (stage ? stage.dz : 0);
  const facing = stage ? stage.facing : 0;

  // Ring 0 holds 8, each subsequent ring holds 6 more and sits 4 m further out.
  let ring = 0;
  let remaining = index;
  let capacity = 8;
  while (remaining >= capacity) {
    remaining -= capacity;
    ring++;
    capacity += 6;
  }
  const radius = 9 + ring * 4;
  // Spread over a 200° arc in front of the stage rather than a full circle — nobody
  // stands behind the performer.
  const spread = Math.PI * 1.1;
  const t = capacity === 1 ? 0.5 : remaining / (capacity - 1);
  const angle = facing + (t - 0.5) * spread;
  const x = originX + Math.sin(angle) * radius;
  const z = originZ + Math.cos(angle) * radius;
  const [wx, wz] = nearestWalkable(x, z, 12);
  return { x: wx, z: wz, yaw: Math.atan2(originX - wx, originZ - wz) };
}

/** Convenience: the flattening pad backing a zone, if it has one. */
export function zonePad(id: ZoneId) {
  return padById(id);
}

/** Every pad that has a zone of the same name. Used by `world-smoke` to check alignment. */
export function zonedPads() {
  return PADS.filter((pad) => ZONE_INDEX.has(pad.id as ZoneId));
}
