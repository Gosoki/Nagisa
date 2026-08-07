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
import {
  COAST_PATH,
  PADS,
  PATHS,
  heightAt,
  insideStructure,
  isWalkable,
  nearestWalkable,
  padById,
  pathAt,
  pathLength,
} from './terrain.js';

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

/** Places the map asks to have no roadside lantern. See `MapWorld.lanternVetoes`. */
export let LANTERN_VETOES: readonly (readonly [number, number])[] = [];

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

/**
 * Where a venue's stage is, as somewhere a person could actually be.
 *
 * Snapped to walkable ground, for the same reason `spawnPoint` and `crowdSlot` are: a stage
 * anchor is a place, and three of the six landed inside a stage deck once decks became
 * solid — a function that hands back a point inside a wall is a trap for whoever wires it up
 * to a walk. Snapping is a no-op wherever the anchor was already clear.
 */
export function stagePosition(id: ZoneId): { x: number; y: number; z: number; facing: number } | null {
  const zone = getZone(id);
  if (!zone?.stage) return null;
  const [x, z] = nearestWalkable(zone.x + zone.stage.dx, zone.z + zone.stage.dz, 14);
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
export const LAMP_RADIUS = 1.2;
/** Two lanterns closer than this read as one bad decision rather than as two lamps. */
const LAMP_SEPARATION = 9;

/**
 * How close a lantern may land to a veto before the veto applies, metres.
 *
 * A veto is not a point, it is a **closed patch of verge**. It was 2.5 m — generous for a note
 * written by somebody standing beside a lamp rather than on top of it — and that was too tight
 * by exactly the width of the placement ladder below, which shuffles a lamp up to eight metres
 * along the road to get it out of a building. A station nudged four metres lands outside a
 * 2.5 m veto, and the lamp a player deleted is back.
 *
 * 4.5 m is where every one of the fifteen notes in `dev-notes.jsonl` is honoured at **both**
 * quality tiers — the tiers place stations at different arc lengths, so a radius that works at
 * 21 m spacing can miss at 34. It was measured, not chosen: at 2.5 m one note's lamp survives
 * at each tier, at 3.5 m one survives at 21 m spacing, at 4.5 m none does.
 *
 * It costs two lamps on the default tier, 16 to 14. That is the price of the notes being right
 * rather than nearly right, and a player who asked for a lamp to be gone is owed the lamp being
 * gone. Still comfortably under {@link LAMP_SEPARATION}, so a veto cannot reach its neighbour.
 */
const LANTERN_VETO_RADIUS = 4.5;
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
  const vetoes = (x: number, z: number): boolean =>
    LANTERN_VETOES.some(([vx, vz]) => Math.hypot(x - vx, z - vz) <= LANTERN_VETO_RADIUS);
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
      // A veto drops the station rather than relocating it: somebody stood in front of this
      // lamp and said it should not be here, and putting it four metres further along the
      // same verge answers a different complaint. See `MapWorld.lanternVetoes`.
      //
      // Measured against the station's **own** verges as well as against wherever the ladder
      // finally put the lamp. Testing only the placed position asks the wrong question: the
      // ladder exists to shuffle a lamp out of a building, so a station that has moved four
      // metres is outside its own veto's radius — and the lamp a player deleted comes back the
      // moment anything near it moves. That is not hypothetical. Moving `nh-gatelamp-2b` three
      // metres in an unrelated commit freed the `ds = -4` rung of coast station 13, the lamp
      // slid from (−18.00, −67.97) to (−21.99, −67.68), and note 23's lamp stood there again
      // 3.9 m from where it had been deleted — with the audit still reporting fifteen vetoes
      // honoured, because it was counting the list rather than measuring the result.
      const home = pathAt(path.id, i * spacing);
      const vetoed =
        (placed !== null && vetoes(placed.x, placed.z)) ||
        [1, -1].some((side) => vetoes(home.x - home.tz * offset * side, home.z + home.tx * offset * side));
      if (placed && !vetoed) out.push(placed);
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
// Stage seating
// ---------------------------------------------------------------------------

/** One seat in a stage's front row: where it goes and which way it faces. */
export interface StageSeat {
  /** The stage it belongs to. A seat is not a thing in its own right. */
  readonly stage: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** −1 left flank, 0 centre, +1 right flank. */
  readonly place: -1 | 0 | 1;
}

/** Half a bench: 2.4 × 0.8 m, the same footprint `LANDMARK_FOOTPRINTS` gives one. */
const SEAT_HALF = [1.2, 0.4] as const;
/** Eave plus apron in front of a stage's `d`, the same numbers `scripts/placement-audit.ts` uses. */
const STAGE_APRON = 2.4;
/** Clear ground the front row wants between its backs and that apron. */
const SEAT_SETBACK = 3.4;
/** How close the arc may be pulled when a site refuses the nominal one. */
const SEAT_MIN_SETBACK = 1.2;
const SEAT_SPLAY_MIN = (26 * Math.PI) / 180;
const SEAT_SPLAY_MAX = (42 * Math.PI) / 180;
/** Room a seat wants beyond another landmark's extent — including its own stage's. */
const SEAT_CLEARANCE = 0.5;
/** Room beyond a lane's carriageway. Above placement-audit's own halfWidth + 1 m seat bar. */
const SEAT_LANE_MARGIN = 1.6;
/** Ground across the seat. The audit's bar, not world-smoke's looser 0.45. */
const SEAT_TILT = 0.25;
/** Two benches closer than this read as one long bench with a kink in it. */
const SEAT_ELBOW = 3.4;

function seatTilt(x: number, z: number, yaw: number): number {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [ox, oz] of [[-1.2, -0.4], [1.2, -0.4], [-1.2, 0.4], [1.2, 0.4]] as const) {
    const h = heightAt(x + ox * cos - oz * sin, z + ox * sin + oz * cos);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return hi - lo;
}

/** How far a point is outside the nearest lane's carriageway. Negative means on it. */
function laneClearance(x: number, z: number): number {
  let worst = Infinity;
  for (const path of PATHS) {
    const pts = path.points;
    for (let k = 1; k < pts.length; k++) {
      const [ax, az] = pts[k - 1]!;
      const [bx, bz] = pts[k]!;
      const vx = bx - ax;
      const vz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1)));
      const d = Math.hypot(x - (ax + vx * t), z - (az + vz * t)) - path.halfWidth;
      if (d < worst) worst = d;
    }
  }
  return worst;
}

/** Separating-axis test of a seat's footprint, grown by {@link SEAT_CLEARANCE}, against a landmark's extent. */
function seatFouls(x: number, z: number, yaw: number, l: Landmark): boolean {
  const e = landmarkExtent(l);
  const boxes = [
    { x, z, hw: SEAT_HALF[0] + SEAT_CLEARANCE, hd: SEAT_HALF[1] + SEAT_CLEARANCE, rot: yaw },
    { x: l.x, z: l.z, hw: e.hw, hd: e.hd, rot: e.rot },
  ];
  for (const box of boxes) {
    const s = Math.sin(box.rot);
    const c = Math.cos(box.rot);
    for (const [nx, nz] of [[s, c], [c, -s]] as const) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const o of boxes) {
        const centre = o.x * nx + o.z * nz;
        const os = Math.sin(o.rot);
        const oc = Math.cos(o.rot);
        const radius = Math.abs(o.hd * (os * nx + oc * nz)) + Math.abs(o.hw * (oc * nx - os * nz));
        lo = Math.min(lo, centre + radius);
        hi = Math.max(hi, centre - radius);
      }
      if (lo <= hi) return false; // a separating axis exists
    }
  }
  return true;
}

/** Every bar a seat has to clear. The same questions `placement-audit` asks a hand-placed bench. */
function seatFits(x: number, z: number, yaw: number): boolean {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  if (!isWalkable(x, z) || insideStructure(x, z)) return false;
  for (const [ox, oz] of [[-1.2, -0.4], [1.2, -0.4], [-1.2, 0.4], [1.2, 0.4]] as const) {
    if (!isWalkable(x + ox * cos - oz * sin, z + ox * sin + oz * cos)) return false;
  }
  if (seatTilt(x, z, yaw) > SEAT_TILT) return false;
  if (laneClearance(x, z) < SEAT_LANE_MARGIN) return false;
  // You have to be able to stand in front of a bench to sit on it. Its front is local −z.
  for (const r of [1.0, 1.6]) if (!isWalkable(x - sin * r, z - cos * r)) return false;
  for (const l of LANDMARKS) if (seatFouls(x, z, yaw, l)) return false;
  return true;
}

/**
 * Three seats in front of every stage, in a shallow arc turned in toward it.
 *
 * ### Why this is a rule and not thirty-six numbers in the map file
 *
 * A stage's seating is a *function* of the stage: the arc's radius comes from its depth, its
 * splay from its width, and every yaw from its own. Written by hand it is that function
 * evaluated once and then left to go stale — which is what the plaza already shows.
 * `pl-bench-1` stands 13.4 m in front of `pl-stage` in the middle of its forecourt with its
 * back turned, 153.5° away from the thing it is pointed at, and nothing in the repo could say
 * so. Derived, the seats follow the stage when it moves and the next stage anyone adds
 * arrives with its own.
 *
 * ### The shape
 *
 * A stage's front is its local −z, like every other building's. The centre seat sits square on
 * that axis; the flanks sit on the same circle, turned out by `splay` and yawed to look back
 * at the stage — the `\ _ /` the note draws. `splay` is derived so the flanks stand off the
 * stage's front corners: a wider stage gets a wider arc without anyone choosing a number.
 *
 * ### When a site refuses
 *
 * The same ladder `roadsideLanterns` uses, for the same reason: pull the arc in 0.1 m at a
 * time, and at each radius narrow the splay, until every seat clears. Three of the island's
 * four stages take the nominal arc untouched. `nh-stage` does not — the coast road crosses its
 * forecourt 12.73 m out, so there are only six metres of usable ground between the stage's
 * apron and the carriageway, and its arc comes in to 7.8 m at 28°. A stage with a road across
 * its front and a tight row of seats still reads as a stage with seats; three benches in the
 * road do not.
 */
export function stageSeating(): StageSeat[] {
  const out: StageSeat[] = [];
  for (const stage of LANDMARKS) {
    if (stage.kind !== 'stage') continue;
    const scale = stage.scale ?? 1;
    const w = (typeof stage.opts?.w === 'number' ? stage.opts.w : 16) * scale;
    const d = (typeof stage.opts?.d === 'number' ? stage.opts.d : 11) * scale;
    const nominal = d / 2 + STAGE_APRON * scale + SEAT_SETBACK;
    const floor = d / 2 + STAGE_APRON * scale + SEAT_MIN_SETBACK;
    const splay = Math.min(SEAT_SPLAY_MAX, Math.max(SEAT_SPLAY_MIN, Math.asin(Math.min(1, w / 2 / nominal))));

    let row: StageSeat[] | null = null;
    // Integer-stepped so the floor is reached exactly rather than one accumulated epsilon short.
    search: for (let i = 0; nominal - i * 0.1 >= floor - 1e-9; i++) {
      const r = nominal - i * 0.1;
      for (let a = splay; a >= SEAT_SPLAY_MIN - 1e-9; a -= (2 * Math.PI) / 180) {
        if (2 * r * Math.sin(a / 2) < SEAT_ELBOW) continue;
        const seats: StageSeat[] = [];
        for (const [place, off] of [[-1, -a], [0, 0], [1, a]] as const) {
          const u = stage.rot + off;
          seats.push({
            stage: stage.id,
            x: stage.x - Math.sin(u) * r,
            z: stage.z - Math.cos(u) * r,
            // Turned to look back down the radius it stands on.
            yaw: u + Math.PI,
            place,
          });
        }
        if (seats.every((s) => seatFits(s.x, s.z, s.yaw))) {
          row = seats;
          break search;
        }
      }
    }
    if (row) out.push(...row);
  }
  return out;
}

/** How many seats there would be if every stage's forecourt accepted an arc. The denominator. */
export function stageSeatingStations(): number {
  return LANDMARKS.filter((l) => l.kind === 'stage').length * 3;
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
  LANTERN_VETOES = w.lanternVetoes ?? [];
  FALLBACK_ZONE = w.fallbackZone;

  VENUE_ZONES = w.zones.filter((z) => z.kind === 'venue').map((z) => z.id);
  ZONE_INDEX = new Map(w.zones.map((z) => [z.id, z]));
  ZONES_BY_SPECIFICITY = [...w.zones].sort((a, b) => a.radius - b.radius);
  TEMPLATE_INDEX = new Map(w.activityTemplates.map((t) => [t.id, t]));
  INTERACTABLE_INDEX = new Map(w.interactables.map((i) => [i.id, i]));
});
