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
import { COAST_PATH, PADS, PATHS, heightAt, nearestWalkable, padById, pathAt, pathLength } from './terrain.js';

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
// How much room a landmark takes up
// ---------------------------------------------------------------------------

/**
 * Ground footprint of each landmark kind, metres, as `[width, depth]` in its own frame,
 * including the eaves where a roof oversails.
 *
 * ### Why this is here and not in the tool that needed it
 *
 * It was in two tools, written twice, and absent from the one place that had to act on it:
 * the client places a lantern every twenty-one metres along each road and had no idea what
 * else was there, so four of them stood *inside* buildings — one three metres into the main
 * pier and one one-and-a-bit into the harbour office, growing out of a wall.
 *
 * Sizes are the built extent rather than the wall line, because what matters to everything
 * that reads this is "may I put something here", and a metre of eave is a metre you cannot
 * stand under a lantern in. They are approximate on purpose: this answers a clearance
 * question, and a clearance answer is allowed to be generous.
 */
const LANDMARK_FOOTPRINTS: Readonly<Record<string, readonly [number, number]>> = {
  warehouse: [12.3, 10.3], machiya: [9.8, 11.8], minka: [12.5, 10.5], bathhouse: [15, 12],
  teahouse: [13.6, 11.1], 'keepers-house': [11.2, 8.7], boathouse: [8.4, 11.4], stage: [14.4, 11.4],
  'shrine-hall': [13.6, 11.6], lighthouse: [10.1, 10.1], 'market-stall': [3.9, 3.1],
  'beach-hut': [7.4, 6.4], 'net-rack': [2, 5.6], well: [3.4, 2.4], 'notice-board': [4.4, 1.6],
  'bell-tower': [4.4, 4.4], temizuya: [5.3, 4.7], torii: [6.6, 1.7], gate: [6.2, 1.9],
  komainu: [1.5, 1.2], 'stone-lantern': [1.4, 1.4], 'post-lantern': [0.8, 0.8], bench: [2.4, 0.8],
  'summit-marker': [1.6, 1.6], rock: [2, 2], boat: [2.4, 5.4], banner: [1.2, 1.2],
  pier: [4, 22], breakwater: [3, 34], 'sea-wall': [1.4, 14], rail: [0.4, 12], steps: [3, 3],
};

/** What a kind takes up when nothing more specific is known. */
const DEFAULT_FOOTPRINT: readonly [number, number] = [2.5, 2.5];

/**
 * The ground a landmark occupies, as half-extents in its own frame plus its yaw.
 *
 * An oriented rectangle rather than a circumscribed circle. The circle was tried and it is
 * too blunt to be useful: a warehouse's circle has an eight-metre radius, so a run of them
 * along a harbour front refuses a third of the road's lantern stations — and a pier's would
 * be a twenty-metre no-go zone around a jetty that is four metres wide.
 */
export function landmarkExtent(landmark: Landmark): { hw: number; hd: number; rot: number } {
  const [w, d] = LANDMARK_FOOTPRINTS[landmark.kind] ?? DEFAULT_FOOTPRINT;
  const scale = landmark.scale ?? 1;
  // An authored `w`/`d` is the wall line; the table's numbers already include the eaves, so
  // an authored one has to be given them back.
  const width = typeof landmark.opts?.w === 'number' ? landmark.opts.w + 2.3 : w;
  const depth = typeof landmark.opts?.d === 'number' ? landmark.opts.d + 2.3 : d;
  const length = typeof landmark.opts?.length === 'number' ? landmark.opts.length : null;
  return {
    hw: (width / 2) * scale,
    hd: ((length ?? depth) / 2) * scale,
    rot: landmark.rot,
  };
}

/**
 * Whether `(x, z)` is clear of every hand-placed landmark, with `extra` metres to spare.
 *
 * `extra` is the room the *new* thing needs on top of the landmark's own — a lantern is not
 * a point. Asked by anything choosing where to put something down; `scripts/placement-audit.ts`
 * asks the harder rectangle-versus-rectangle question about things already placed.
 */
export function clearOfLandmarks(x: number, z: number, extra = 0): boolean {
  for (const l of LANDMARKS) {
    const { hw, hd, rot } = landmarkExtent(l);
    const dx = x - l.x;
    const dz = z - l.z;
    // Into the landmark's frame. Its entrance faces local −z; which face is which does not
    // matter here, only that the box is turned the same way the building is.
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    if (Math.abs(dx * cos - dz * sin) < hw + extra && Math.abs(dx * sin + dz * cos) < hd + extra) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Roadside lanterns
// ---------------------------------------------------------------------------

/** Half a lantern plus its plinth: the room the lamp itself needs, beyond the landmark's. */
const LAMP_RADIUS = 1.2;
/** Two lanterns closer than this read as one bad decision rather than as two lamps. */
const LAMP_SEPARATION = 9;
/**
 * Ground across the base, by what stands on it.
 *
 * A stone tōrō is a box on a plinth and shows every centimetre it is out of level. A timber
 * post lantern is a pole, and a pole on a sloping verge is what a mountain lane actually has
 * — holding it to the tōrō's standard left the shrine ascent unlit for a reason no player
 * could ever have seen.
 */
const LAMP_BASE_DROP = { stone: 0.3, post: 0.8 } as const;

/** How level the ground is under a lantern's base, metres across its 1.4 m footprint. */
function lampBaseDrop(x: number, z: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [ox, oz] of [
    [-0.7, -0.7],
    [0.7, -0.7],
    [-0.7, 0.7],
    [0.7, 0.7],
  ] as const) {
    const h = heightAt(x + ox, z + oz);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return hi - lo;
}

/** One roadside lantern: where it goes, which way it faces, and which kind it is. */
export interface RoadsideLantern {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** The coast road gets matched stone tōrō; the working lanes get timber posts. */
  readonly kind: 'stone' | 'post';
}

/**
 * Where the roads' lanterns stand.
 *
 * ### Why this is world knowledge and not the renderer's
 *
 * It used to live in the client, next to the Three.js that draws them, as "every `spacing`
 * metres, alternating verges". That is a rule about the *road*, and it knows nothing about
 * what the road runs past — so it put four lanterns inside buildings (one three metres into
 * the main pier, one growing out of the harbour office wall), left thirteen leaning on
 * embankments with up to 1.1 m of ground across their 1.4 m base, and stood two pairs two
 * metres apart where one lane meets another and both started counting from their own zero.
 *
 * Fixing it means consulting the world, and once it consults the world it belongs beside the
 * world. The audit that keeps it honest then tests the real function instead of a copy of it,
 * which matters more than it sounds: the copy is exactly the kind of thing that agrees with
 * the original right up until one of them is edited.
 *
 * Each station asks before it puts anything down, and when the answer is no it tries the
 * other verge, then a few metres either way along the road, before giving up. A road with a
 * lantern missing where a building meets it still reads as a lit road; a lantern inside the
 * building does not.
 */
export function roadsideLanterns(spacing: number): RoadsideLantern[] {
  const out: RoadsideLantern[] = [];
  for (const path of PATHS) {
    const steps = Math.floor(pathLength(path.id) / spacing);
    const offset = path.halfWidth + 1.3;
    const kind: RoadsideLantern['kind'] = path.id === COAST_PATH.id ? 'stone' : 'post';
    const maxDrop = LAMP_BASE_DROP[kind];

    for (let i = 0; i < steps; i++) {
      // Preferred first — the alternating verge at the exact station — then the other verge,
      // then either verge a few metres along. Ordered so an unobstructed road is lit exactly
      // as it was before any of this existed, and only an obstructed one moves.
      const preferred = i % 2 === 0 ? 1 : -1;
      let placed: RoadsideLantern | null = null;
      outer: for (const ds of [0, 4, -4, 8, -8]) {
        const { x, z, tx, tz } = pathAt(path.id, i * spacing + ds);
        for (const side of [preferred, -preferred]) {
          const px = x - tz * offset * side;
          const pz = z + tx * offset * side;
          if (!clearOfLandmarks(px, pz, LAMP_RADIUS)) continue;
          if (lampBaseDrop(px, pz) > maxDrop) continue;
          if (out.some((l) => Math.hypot(px - l.x, pz - l.z) < LAMP_SEPARATION)) continue;
          placed = { x: px, z: pz, yaw: Math.atan2(tx, tz), kind };
          break outer;
        }
      }
      if (placed) out.push(placed);
    }
  }
  return out;
}

/** How many stations `roadsideLanterns` considered. The denominator for "are the roads lit". */
export function roadsideLanternStations(spacing: number): number {
  let n = 0;
  for (const path of PATHS) n += Math.floor(pathLength(path.id) / spacing);
  return n;
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
