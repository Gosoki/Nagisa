/**
 * Nagisa world layout.
 * ====================
 *
 * The island's *semantic* map: where the zones are, which of them can host an activity,
 * where players arrive, and what can be interacted with. Geometry lives in `terrain.ts`;
 * this file says what the geometry **means**.
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
 */

import { heightAt, nearestWalkable, padById } from './terrain.js';

/** Zone identifiers. Union rather than enum so they serialise as readable strings. */
export type ZoneId =
  | 'harbor'
  | 'plaza'
  | 'noticeboard'
  | 'village'
  | 'teahouse'
  | 'shrine'
  | 'viewpoint'
  | 'lighthouse'
  | 'beach'
  | 'promenade';

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
 * drifts off its pad will end up on a slope. `promenade` is the exception: it is a
 * polyline, and its anchor is only a nominal midpoint.
 */
export const ZONES: readonly Zone[] = [
  {
    id: 'harbor',
    name: 'Harbour',
    nameJa: '港',
    kind: 'venue',
    x: -96,
    z: 104,
    radius: 46,
    stage: { dx: 8, dz: -12, facing: Math.PI * 0.25 },
    softCapacity: 40,
    ambience: 'harbor',
    caption: 'Boats knock against the pier. This is where everyone arrives.',
  },
  {
    id: 'plaza',
    name: 'Main Plaza',
    nameJa: '広場',
    kind: 'venue',
    x: 0,
    z: 0,
    radius: 50,
    stage: { dx: 0, dz: -18, facing: 0 },
    softCapacity: 120,
    ambience: 'town',
    caption: 'The middle of the island. Something is usually about to start.',
  },
  {
    id: 'noticeboard',
    name: 'Notice Board',
    nameJa: '掲示板',
    kind: 'notice',
    x: 6,
    z: -34,
    radius: 16,
    softCapacity: 20,
    ambience: 'town',
    caption: 'Paper slips, pinned and re-pinned. Today’s word is here.',
  },
  {
    id: 'village',
    name: 'Old Street',
    nameJa: '町並み',
    kind: 'transit',
    x: 46,
    z: 10,
    radius: 34,
    softCapacity: 40,
    ambience: 'town',
    caption: 'Wooden fronts, low eaves, a cat that has never moved.',
  },
  {
    id: 'teahouse',
    name: 'Teahouse',
    nameJa: '茶屋',
    kind: 'rest',
    x: 78,
    z: 44,
    radius: 28,
    stage: { dx: -6, dz: 6, facing: Math.PI },
    softCapacity: 24,
    ambience: 'forest',
    caption: 'Somewhere to sit. The kettle is always about to boil.',
  },
  {
    id: 'shrine',
    name: 'Shrine Path',
    nameJa: '神社',
    kind: 'venue',
    x: -58,
    z: -62,
    radius: 34,
    stage: { dx: 0, dz: -14, facing: 0 },
    softCapacity: 60,
    ambience: 'shrine',
    caption: 'Torii, one after another, going up the hill.',
  },
  {
    id: 'viewpoint',
    name: 'Lookout',
    nameJa: '見晴台',
    kind: 'scenic',
    x: -14,
    z: -84,
    radius: 22,
    softCapacity: 20,
    ambience: 'wind',
    caption: 'From up here the whole island fits between your hands.',
  },
  {
    id: 'lighthouse',
    name: 'Lighthouse Cape',
    nameJa: '灯台岬',
    kind: 'venue',
    x: 112,
    z: -78,
    radius: 32,
    stage: { dx: -10, dz: 10, facing: Math.PI * 0.75 },
    softCapacity: 50,
    ambience: 'wind',
    caption: 'The lamp turns whether anyone is watching or not.',
  },
  {
    id: 'beach',
    name: 'Sunset Beach',
    nameJa: '浜',
    kind: 'venue',
    x: -122,
    z: 22,
    radius: 42,
    stage: { dx: 14, dz: 0, facing: -Math.PI * 0.5 },
    softCapacity: 70,
    ambience: 'waves',
    caption: 'Flat sand, shallow water, and the long light.',
  },
  {
    id: 'promenade',
    name: 'Seaside Path',
    nameJa: '渚道',
    kind: 'transit',
    x: -52,
    z: 44,
    radius: 999, // Fallback zone: matched last, catches anyone not inside a named place.
    softCapacity: 999,
    ambience: 'waves',
    caption: 'The path follows the water the whole way round.',
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
 * the notice board (r=16) sits inside the plaza (r=50), which sits inside the promenade
 * fallback (r=999) — so ranking by radius yields the most specific place without any
 * explicit priority field to keep in sync.
 *
 * Ranking by *distance* instead would be wrong: the fallback zone's enormous radius
 * makes almost every point "deeply inside" it, and it would swallow every named place.
 */
export function zoneAt(x: number, z: number): ZoneId {
  for (const zone of ZONES_BY_SPECIFICITY) {
    if (Math.hypot(x - zone.x, z - zone.z) <= zone.radius) return zone.id;
  }
  return 'promenade';
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
 * All of them are on the harbour quay, facing inland: you arrive by water, and the walk
 * up to the plaza is the island introducing itself. Several points, spread out, so a
 * crowd arriving together does not stack into one body.
 */
export const SPAWN_POINTS: readonly (readonly [number, number])[] = [
  [-92, 96],
  [-100, 100],
  [-88, 104],
  [-98, 90],
  [-84, 98],
  [-104, 94],
] as const;

/** A spawn position with terrain height and a facing that looks toward the island. */
export function spawnPoint(index: number): { pos: [number, number, number]; yaw: number } {
  const [sx, sz] = SPAWN_POINTS[index % SPAWN_POINTS.length];
  const [x, z] = nearestWalkable(sx, sz);
  // Face the plaza, which is roughly north-east of the harbour.
  const yaw = Math.atan2(0 - x, 0 - z);
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
  {
    id: 'notice-board',
    zone: 'noticeboard',
    dx: 0,
    dz: -6,
    range: 4.5,
    kind: 'use',
    label: 'Read',
    effect: 'read_announcements',
  },
  { id: 'shrine-bell', zone: 'shrine', dx: 0, dz: -12, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'harbor-bell', zone: 'harbor', dx: -14, dz: -4, range: 3.5, kind: 'use', label: 'Ring', effect: 'none' },
  { id: 'lighthouse-door', zone: 'lighthouse', dx: 0, dz: 0, range: 4, kind: 'use', label: 'Look', effect: 'none' },
  { id: 'teahouse-mat-a', zone: 'teahouse', dx: -8, dz: 2, range: 2.5, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'teahouse-mat-b', zone: 'teahouse', dx: -4, dz: 4, range: 2.5, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'lookout-rail', zone: 'viewpoint', dx: 0, dz: -10, range: 5, kind: 'use', label: 'Look', effect: 'none' },
  { id: 'beach-log', zone: 'beach', dx: 6, dz: 10, range: 3, kind: 'sit', label: 'Sit', effect: 'none' },
  { id: 'plaza-post', zone: 'plaza', dx: -20, dz: 8, range: 3.5, kind: 'use', label: 'Check in', effect: 'checkin_nearby' },
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
 * Fixed set-pieces the client builds. The server does not care about these, but they
 * live here so the world's contents are described in one place and so the client's scene
 * assembly is data-driven rather than a wall of hard-coded coordinates.
 *
 * `y` is always resolved from the terrain field at build time — never authored.
 */
export interface Landmark {
  readonly id: string;
  /** Generator to call in the client's prop library. */
  readonly kind:
    | 'lighthouse'
    | 'torii'
    | 'shrine-hall'
    | 'minka'
    | 'machiya'
    | 'teahouse'
    | 'pier'
    | 'boat'
    | 'warehouse'
    | 'notice-board'
    | 'stage'
    | 'lantern'
    | 'bench'
    | 'stone-lantern'
    | 'gate'
    | 'rail';
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
 * Hand-placed landmarks. Everything else on the island — vegetation, promenade lanterns,
 * rocks — is scattered procedurally by the client from the terrain field, because those
 * are texture, not architecture.
 */
export const LANDMARKS: readonly Landmark[] = [
  // — Harbour ————————————————————————————————————————————————
  { id: 'pier-main', kind: 'pier', x: -96, z: 118, rot: 0, opts: { length: 40, width: 7 } },
  { id: 'pier-west', kind: 'pier', x: -118, z: 104, rot: Math.PI / 2, opts: { length: 26, width: 5 } },
  { id: 'boat-1', kind: 'boat', x: -108, z: 122, rot: 0.4 },
  { id: 'boat-2', kind: 'boat', x: -84, z: 126, rot: -0.9, scale: 1.2 },
  { id: 'boat-3', kind: 'boat', x: -122, z: 96, rot: 2.1, scale: 0.85 },
  { id: 'warehouse-1', kind: 'warehouse', x: -78, z: 98, rot: -0.3, opts: { w: 16, d: 10 } },
  { id: 'warehouse-2', kind: 'warehouse', x: -112, z: 88, rot: 0.2, opts: { w: 12, d: 9 } },
  { id: 'torii-sea', kind: 'torii', x: -96, z: 140, rot: 0, scale: 1.8, opts: { inWater: true } },
  { id: 'harbor-stage', kind: 'stage', x: -88, z: 92, rot: Math.PI * 0.25, opts: { w: 14, d: 10 } },

  // — Plaza ——————————————————————————————————————————————————
  { id: 'plaza-stage', kind: 'stage', x: 0, z: -18, rot: 0, opts: { w: 20, d: 14, roof: true } },
  { id: 'plaza-gate-s', kind: 'gate', x: 0, z: 30, rot: 0 },
  { id: 'plaza-gate-e', kind: 'gate', x: 30, z: 2, rot: Math.PI / 2 },
  { id: 'notice-board', kind: 'notice-board', x: 6, z: -40, rot: 0, scale: 1.4 },
  { id: 'plaza-lantern-1', kind: 'stone-lantern', x: -14, z: -8, rot: 0.3 },
  { id: 'plaza-lantern-2', kind: 'stone-lantern', x: 14, z: -8, rot: -0.3 },
  { id: 'plaza-bench-1', kind: 'bench', x: -18, z: 10, rot: 0.6 },
  { id: 'plaza-bench-2', kind: 'bench', x: 18, z: 10, rot: -0.6 },

  // — Old street ——————————————————————————————————————————————
  { id: 'machiya-1', kind: 'machiya', x: 32, z: 2, rot: 0, opts: { w: 9, d: 12, floors: 2 } },
  { id: 'machiya-2', kind: 'machiya', x: 32, z: 18, rot: 0, opts: { w: 8, d: 11, floors: 2 } },
  { id: 'machiya-3', kind: 'machiya', x: 60, z: 2, rot: Math.PI, opts: { w: 10, d: 12, floors: 1 } },
  { id: 'machiya-4', kind: 'machiya', x: 60, z: 18, rot: Math.PI, opts: { w: 9, d: 10, floors: 2 } },
  { id: 'minka-1', kind: 'minka', x: 46, z: 34, rot: 0.2, opts: { w: 13, d: 10 } },
  { id: 'minka-2', kind: 'minka', x: 22, z: 28, rot: -0.5, opts: { w: 11, d: 9 } },

  // — Teahouse ————————————————————————————————————————————————
  { id: 'teahouse-main', kind: 'teahouse', x: 78, z: 38, rot: Math.PI, opts: { w: 12, d: 9 } },
  { id: 'teahouse-lantern-1', kind: 'stone-lantern', x: 70, z: 48, rot: 0 },
  { id: 'teahouse-bench-1', kind: 'bench', x: 84, z: 50, rot: Math.PI * 0.8 },

  // — Shrine ——————————————————————————————————————————————————
  { id: 'shrine-hall', kind: 'shrine-hall', x: -58, z: -76, rot: 0, opts: { w: 14, d: 11 } },
  { id: 'shrine-torii-1', kind: 'torii', x: -58, z: -40, rot: 0, scale: 1.3 },
  { id: 'shrine-torii-2', kind: 'torii', x: -58, z: -48, rot: 0, scale: 1.25 },
  { id: 'shrine-torii-3', kind: 'torii', x: -58, z: -56, rot: 0, scale: 1.2 },
  { id: 'shrine-lantern-1', kind: 'stone-lantern', x: -66, z: -66, rot: 0 },
  { id: 'shrine-lantern-2', kind: 'stone-lantern', x: -50, z: -66, rot: 0 },

  // — Lookout ——————————————————————————————————————————————————
  { id: 'lookout-rail', kind: 'rail', x: -14, z: -94, rot: 0, opts: { length: 24 } },
  { id: 'lookout-bench-1', kind: 'bench', x: -22, z: -88, rot: 0.2 },
  { id: 'lookout-bench-2', kind: 'bench', x: -6, z: -88, rot: -0.2 },

  // — Lighthouse cape ——————————————————————————————————————————
  { id: 'lighthouse-main', kind: 'lighthouse', x: 112, z: -78, rot: 0, scale: 1 },
  { id: 'lighthouse-keep', kind: 'minka', x: 124, z: -68, rot: -0.6, opts: { w: 10, d: 8 } },
  { id: 'cape-rail', kind: 'rail', x: 112, z: -94, rot: 0.2, opts: { length: 30 } },

  // — Beach ————————————————————————————————————————————————————
  { id: 'beach-stage', kind: 'stage', x: -108, z: 22, rot: -Math.PI * 0.5, opts: { w: 12, d: 9 } },
  { id: 'beach-bench-1', kind: 'bench', x: -112, z: 34, rot: 1.2 },
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
    blurb: 'Stalls on the quay until the light goes.',
    zone: 'harbor',
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
    id: 'tea-sitting',
    title: 'Tea Sitting',
    blurb: 'Nothing happens here on purpose.',
    zone: 'teahouse',
    durationMin: 60,
    capacity: 24,
    checkinEnabled: false,
    formation: 'seated',
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
