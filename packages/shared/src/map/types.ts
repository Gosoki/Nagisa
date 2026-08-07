/**
 * What a map *is*.
 * ================
 *
 * Nagisa's island is data, not code. Everything that makes it *this* island — the shape of
 * the coast, where the ground is flat, where the roads run, what buildings stand where, what
 * you can walk up to and use — lives in a {@link MapPack} and nothing else knows its
 * contents. The terrain field, the walkability rules, the renderer, the netcode and the
 * chat room are the *core*; they consume a pack and would consume a different one without
 * changing a line.
 *
 * That split is what makes maps swappable at runtime. `setActiveMap('atoll')` re-points the
 * engine at different data, drops every derived cache, and the next `heightAt` call is
 * answering about somewhere else.
 *
 * ### What belongs in a pack, and what does not
 *
 * In: the landform (capes, bays, shelves, terraces, the massif), the routes, the named
 * places, the buildings, the interactables, the activity templates, the spawn points.
 *
 * Out: how a terrace is applied, how a path's grade is surveyed, what counts as walkable,
 * how a building is modelled, how many players a room holds. Those are rules, and rules are
 * core. A pack that needed a new rule would be asking for an engine change, not a map.
 *
 * ### The contract a pack must satisfy
 *
 * `scripts/world-smoke.ts` enforces it for whichever pack is active, so a new map is
 * checked by exactly the checks the shipped one is:
 *
 * - every terrace's centre reaches its stated height;
 * - every route is walkable end to end, at a legal grade;
 * - every grounded landmark stands on ground level to within 0.45 m;
 * - every spawn point is walkable, and every zone anchor sits on its terrace.
 *
 * A pack that fails those is not a map, it is a bug with coordinates.
 */

/**
 * A lobe added to or bitten out of the coastline.
 *
 * `strength` is in mask units, where 1.0 ≈ the whole island radius, so a cape of 0.30
 * pushes the shore out by roughly 30% of `COAST_RADIUS` at its centre. Positive values
 * are handled by {@link CAPES} (land pushed seaward), negative by {@link BAYS} (sea cut
 * inland) — they are separate arrays only because reading them as two lists is clearer
 * than reading one list with signs in it.
 */
export interface CoastFeature {
  readonly x: number;
  readonly z: number;
  /** Radius over which the feature falls off to nothing. */
  readonly reach: number;
  readonly strength: number;
}

/**
 * A broad, gentle rise in the ground — a *shelf* rather than a terrace.
 *
 * Terraces (`PADS`) are flat and local; a shelf is landform. This is what makes the plaza
 * and the old street read as one continuous piece of high ground with the road up the
 * mountain leaving from between them, rather than as two separate platforms with a dip in
 * the middle. Height is added smoothly and the surrounding terrain still shows through, so
 * a shelf never produces the mesa edge a wide pad would.
 */
export interface Shelf {
  readonly x: number;
  readonly z: number;
  readonly reach: number;
  readonly height: number;
}

/**
 * A flat pad blended into the terrain. Everything people gather on gets one: an event
 * plaza on a natural slope is unusable, and characters sliding down a shrine courtyard
 * would break the calm instantly.
 *
 * `inner` is fully flat at `height`; between `inner` and `outer` the pad blends back
 * into the natural surface.
 */
export interface Pad {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly inner: number;
  readonly outer: number;
}

/** How a path is surfaced. Drives terrain vertex colour and the prop scatterer. */
export type PathSurface = 'stone' | 'gravel' | 'boardwalk';

/**
 * A walking route carved into the terrain.
 *
 * Paths do two jobs. Physically they hold a gentle grade across ground that would
 * otherwise be too steep to walk, which is what makes a 96 m mountain climbable without
 * any stair geometry. Visually they are the island's circulation diagram: if you can see
 * where a path goes, you know where you can go, and you never need a minimap.
 */
export interface WorldPath {
  readonly id: 'coast' | 'shrine-ascent' | 'south-approach' | 'east-lane';
  readonly name: string;
  /**
   * Waypoints, in order, as [x, z].
   *
   * **Repeat the first point at the end to close the route into a loop.** That repetition is
   * the only signal — the survey wraps its grade relaxation around a closed route and clamps
   * at the ends of an open one, so a ring whose last point merely lands *near* its first
   * comes out as a lane with a gap in it rather than a circuit.
   */
  readonly points: readonly (readonly [number, number])[];
  /** Half-width of the walkable surface, metres. */
  readonly halfWidth: number;
  /** Distance beyond `halfWidth` over which the carve blends back to natural ground. */
  readonly shoulder: number;
  /** How strongly the path flattens what is under it, 0–1. */
  readonly carve: number;
  readonly surface: PathSurface;
}

/**
 * A stretch of shore where the sea cliffs are suppressed.
 *
 * Cliffs are what make a coast dramatic, and a coast that is *entirely* dramatic is one you
 * can only ever look at the sea from — v2's first draft ringed the island in unwalkable rock
 * and you could never stand beside the water. So a pack names the shores that must stay
 * gentle: the harbours you arrive at, the beach you swim from, the pass the boats come
 * through. Cliff amplitude falls to zero within `reach × 0.4` of the centre and returns to
 * full at `reach`.
 */
export interface Shelter {
  readonly x: number;
  readonly z: number;
  readonly reach: number;
}

/**
 * Vertical scale of the natural, un-terraced ground.
 *
 * These were literals inside `naturalHeight` until a second map was loaded through it, at
 * which point a 3.5 m atoll came out with 23 m hills: amplitudes tuned for one island's
 * relief are not a rule, they are that island's data. Everything here is metres, and a pack
 * whose summit is a tenth the height wants roughly a tenth of these.
 */
export interface MapRelief {
  /** Base height of the rolling coastal ground the whole island sits on. */
  readonly rolling: number;
  /** Peak-to-trough variation added to it by noise. */
  readonly rollingVariation: number;
  /** Height of the sea cliffs, on shores that are not sheltered. */
  readonly cliff: number;
  /** Amplitude of the fine surface detail laid over everything. */
  readonly detail: number;
}

/**
 * The landform half of a pack: everything {@link heightAt} needs to answer.
 *
 * Order matters and is the engine's, not the pack's — shelves, then the massif, then
 * terraces, then paths — but *what* is in each list is entirely the pack's business.
 */
export interface MapTerrain {
  /** Extent of the terrain grid the client meshes, metres from origin on each axis. */
  readonly extent: number;
  /** Radius beyond which there is nothing but open water. Camera and fog limits. */
  readonly oceanRadius: number;
  /** Mean radius of the coastline, before capes, bays and wobble. */
  readonly coastRadius: number;
  /** Summit of the central massif, and the height everything else is described against. */
  readonly summit: { readonly x: number; readonly z: number; readonly height: number };
  /** Horizontal reach of the massif. See the note on grade in `terrain.ts`. */
  readonly massifRadius: number;
  /** Headlands: land pushed seaward. */
  readonly capes: readonly CoastFeature[];
  /** Bays: sea cut inland. */
  readonly bays: readonly CoastFeature[];
  /** Broad landform rises. Applied before terraces. */
  readonly shelves: readonly Shelf[];
  /** Vertical scale of the natural ground. */
  readonly relief: MapRelief;
  /** Shores where cliffs are suppressed. */
  readonly shelters: readonly Shelter[];
  /** Flattened building ground, in application order. */
  readonly pads: readonly Pad[];
  /** Surveyed routes. The first one is the spine; branches may pin to it. */
  readonly paths: readonly WorldPath[];
}

/**
 * Zone identifiers. Union rather than enum so they serialise as readable strings.
 *
 * These strings appear in the wire protocol (`zonePopulation`, activity records,
 * announcement scopes) and in persisted state, so renaming one is a protocol change.
 */
export type ZoneId = KnownZoneId | (string & {});

/**
 * The zone ids the shipped island uses.
 *
 * {@link ZoneId} is deliberately open — a map pack names its own places, and a closed union
 * would mean every new map required an edit to this file. The `(string & {})` arm is the
 * standard idiom for "any string, but keep autocompleting these": TypeScript preserves the
 * literal members for suggestions instead of collapsing the whole union to `string`.
 *
 * Zone ids appear in the wire protocol (`zonePopulation`, activity records, announcement
 * scopes) and in persisted state, so within one pack, renaming one is a protocol change.
 */
export type KnownZoneId =
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

/**
 * The inhabited half of a pack: what is on the land, and what you can do with it.
 */
export interface MapWorld {
  readonly zones: readonly Zone[];
  readonly landmarks: readonly Landmark[];
  readonly interactables: readonly Interactable[];
  readonly activityTemplates: readonly ActivityTemplate[];
  /** Arrival points, as [x, z]. The engine snaps each to walkable ground. */
  readonly spawnPoints: readonly (readonly [number, number])[];
  /** Zone returned when a position is inside none of the others. */
  readonly fallbackZone: ZoneId;
  /**
   * Places where the road's own lanterns are not wanted, as [x, z].
   *
   * The roadside lanterns are the only props on the island nobody positions by hand — they
   * are dealt out along each lane by rule. The rule is a good one and it is still wrong
   * about individual spots: a lamp that lands where two lanes nearly meet, or in front of a
   * view, is one a person looking at it wants gone, and there is no line in a map file to
   * delete because there was never a line that put it there.
   *
   * So this is the line. A vetoed station is dropped rather than moved: the point is that
   * there should be no lamp *there*, and shuffling it four metres along answers a different
   * complaint. See `roadsideLanterns`.
   */
  readonly lanternVetoes?: readonly (readonly [number, number])[];
}

/** A complete, self-contained world. */
export interface MapPack {
  /** Stable identifier. Appears in URLs (`?map=`), env vars and the wire protocol. */
  readonly id: string;
  /** English display name. */
  readonly name: string;
  /** Japanese display name. Flavour. */
  readonly nameJa: string;
  /** One line, shown on the loading screen. */
  readonly summary: string;
  readonly terrain: MapTerrain;
  readonly world: MapWorld;
}
