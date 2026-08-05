/**
 * Nagisa world layout — world model v3.
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
 * Six places on a hexagon 74 m to a side, with the summit in the middle. You arrive by
 * ferry at the **South Harbour**. The ring road runs both ways from there — east past the
 * **Main Plaza** and the **Old Street**, which share one shelf, or west past the **Shrine**
 * on its headland and the **Lighthouse Cape**, meeting again at the working **North
 * Harbour**. The **Summit Road** leaves the ring between the plaza and the old street and
 * switchbacks up to the inner shrine; the **Shrine Path** climbs the west flank to the same
 * place. Every neighbour is about eight seconds away at a run, and the whole ring is under
 * a minute.
 *
 * Places that were zones of their own in v2 are still here as *buildings*: the teahouse
 * stands on the plaza, and the beach huts on the sand west of the south harbour. Six zones
 * plus a summit is as many named places as an island this size can hold without them
 * running into each other.
 */

import { onMapChange } from './map/registry.js';
import type {
  ActivityTemplate,
  Interactable,
  Landmark,
  LandmarkKind,
  Zone,
  ZoneId,
  ZoneKind,
} from './map/types.js';
import { PADS, heightAt, nearestWalkable, padById } from './terrain.js';

export type { ActivityTemplate, Interactable, Landmark, LandmarkKind, Zone, ZoneId, ZoneKind };

/**
 * The active pack's inhabited half, republished as live module bindings.
 *
 * Same mechanism and same rule as `terrain.ts`: `let` plus a subscriber, so the fifteen
 * modules that import `ZONES` or `LANDMARKS` need no changes and no subscription — but must
 * not snapshot them into their own module-scope constants.
 */

/** Every named place on the active map. */
export let ZONES: readonly Zone[] = [];

/** Every building and prop the client places. */
export let LANDMARKS: readonly Landmark[] = [];

/** Everything a player can walk up to and use. */
export let INTERACTABLES: readonly Interactable[] = [];

/** The kinds of thing that can be scheduled here. */
export let ACTIVITY_TEMPLATES: readonly ActivityTemplate[] = [];

/** Arrival points, as [x, z]. {@link spawnPoint} snaps each to walkable ground. */
export let SPAWN_POINTS: readonly (readonly [number, number])[] = [];

/** Zone reported for a position inside none of the others. */
let FALLBACK_ZONE: ZoneId = 'coast';

export let VENUE_ZONES: readonly ZoneId[] = [];

let ZONE_INDEX = new Map<ZoneId, Zone>();

export function getZone(id: ZoneId): Zone | undefined {
  return ZONE_INDEX.get(id);
}

export function isVenue(id: ZoneId): boolean {
  return getZone(id)?.kind === 'venue';
}

/**
 * Zones ordered tightest-first, so {@link zoneAt} can return the most specific match.
 * Rebuilt on every map change; within one map, `ZONES` is frozen data.
 */
let ZONES_BY_SPECIFICITY: readonly Zone[] = [];

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
  return FALLBACK_ZONE;
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

/** A spawn position with terrain height and a facing that looks toward the island. */
export function spawnPoint(index: number): { pos: [number, number, number]; yaw: number } {
  const [sx, sz] = SPAWN_POINTS[index % SPAWN_POINTS.length];
  const [x, z] = nearestWalkable(sx, sz);
  // Face the mountain, which is due north (−z) of the south harbour.
  const yaw = Math.atan2(0 - x, 0 - z);
  return { pos: [x, heightAt(x, z), z], yaw };
}

// ---------------------------------------------------------------------------
// Interactables
// ---------------------------------------------------------------------------

/** World-space position of an interactable, terrain height applied. */
export function interactablePosition(it: Interactable): { x: number; y: number; z: number } {
  const zone = getZone(it.zone)!;
  const x = zone.x + it.dx;
  const z = zone.z + it.dz;
  return { x, y: heightAt(x, z), z };
}

let INTERACTABLE_INDEX = new Map<string, Interactable>();

export function getInteractable(id: string): Interactable | undefined {
  return INTERACTABLE_INDEX.get(id);
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Activity templates
// ---------------------------------------------------------------------------

/** Rebuilt on every map change, alongside the bindings at the top of the file. */
let TEMPLATE_INDEX = new Map<string, ActivityTemplate>();

export function getTemplate(id: string): ActivityTemplate | undefined {
  return TEMPLATE_INDEX.get(id);
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

// ---------------------------------------------------------------------------
// Binding to the active map
// ---------------------------------------------------------------------------

/**
 * Republish the active pack's world data and rebuild every lookup keyed to it.
 *
 * Last statement in the file for the same reason as its twin in `terrain.ts`: the listener
 * runs the moment it is registered, so everything it assigns must already be initialised.
 */
onMapChange((pack) => {
  const w = pack.world;
  ZONES = w.zones;
  LANDMARKS = w.landmarks;
  INTERACTABLES = w.interactables;
  ACTIVITY_TEMPLATES = w.activityTemplates;
  SPAWN_POINTS = w.spawnPoints;
  FALLBACK_ZONE = w.fallbackZone;

  VENUE_ZONES = w.zones.filter((z) => z.kind === 'venue').map((z) => z.id);
  ZONE_INDEX = new Map(w.zones.map((z) => [z.id, z]));
  ZONES_BY_SPECIFICITY = [...w.zones].sort((a, b) => a.radius - b.radius);
  TEMPLATE_INDEX = new Map(w.activityTemplates.map((t) => [t.id, t]));
  INTERACTABLE_INDEX = new Map(w.interactables.map((i) => [i.id, i]));
});
