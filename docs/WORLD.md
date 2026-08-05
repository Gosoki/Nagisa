# The island — world model v2

Nagisa is one small Japanese island, about 480 m across, surrounded by open water on every
side. A single mountain stands at its centre; everything people built stands around the
mountain's foot. You can walk the coast road all the way round in a little under five
minutes, or climb to the summit from any of three directions in about ninety seconds.

That scale is deliberate. The island has to be small enough to hold in your head after one
visit, and large enough that arriving somewhere feels like arriving.

> The previous world — an ellipse with one harbour and the plaza on the origin — is kept in
> [`archive/world-v1/`](../archive/world-v1/README.md), with a table of what changed and why.

---

## 1. Geography

```
                                    N  (−z)
                     北港 North Harbour        灯台岬 Lighthouse Cape
                        (−36, −198)                (138, −190)
                              ╲                        ╱
                               ╲    ▲ 山頂 Summit     ╱
          神社 Shrine ──────────  ╲  (0, −14) 88 m  ╱  ────────── 茶屋 Teahouse
           (−186, 20)              ╲      ▲       ╱                (168, −62)
                                    ╲    ╱ ╲     ╱
   W (−x)                            ╲  ╱   ╲   ╱                            E (+x)
                                      ╲╱     ╲ ╱
          浜 Sunset Beach          広場 Main Plaza          町並み Old Street
             (−166, 146)              (0, 108)                 (176, 76)
                              ╲                        ╱
                                 南港 South Harbour  ╱
                                     (16, 192)
                                    S  (+z)
```

Heights run from the two harbour quays at ~2.5 m to the summit court at 88 m. Sea cliffs
appear on the exposed north and east coasts and around the capes; the south-west and both
bays are sheltered and shelve gently, so the beach and the harbours are walkable right down
to the water.

`−z` is north and `+x` is east — the three.js convention, used consistently everywhere in
this codebase including in every coordinate in this document.

### Zones

| Zone | 日本語 | Kind | Venue | Anchor | Ground | What it is |
|---|---|---|---|---|---|---|
| South Harbour | 南港 | venue | ✓ | (16, 192) | 2.6 m | The arrival port. Ferry pier, breakwater, warehouses, market stalls, a torii standing in the bay. Everyone spawns here. |
| Main Plaza | 広場 | venue | ✓ | (0, 108) | 22 m | The civic centre, on the mountain's southern shoulder. Roofed stage, gates, well, benches. Highest capacity on the island. |
| Notice Board | 掲示板 | notice | | (−26, 94) | 24.4 m | A terrace one step up from the plaza floor. Announcements are read here. |
| Old Street | 町並み | transit | | (176, 76) | 18 m | Eight machiya facing each other across a street, plus a bathhouse and a kura. The densest built place. |
| Teahouse | 茶屋 | rest | ✓ | (168, −62) | 33 m | High on the east flank, open on all four sides, looking down at the water. Seated activities only. |
| Shrine | 神社 | venue | ✓ | (−186, 20) | 26 m | The western headland. Three torii along the approach, komainu, temizuya, the main hall. Processions start here. |
| Summit | 山頂 | scenic | | (0, −14) | 88 m | The inner shrine and a railing. The camera widens automatically. |
| Lighthouse Cape | 灯台岬 | venue | ✓ | (138, −190) | 32 m | Exposed clifftop on the north-east. The lamp turns day and night. |
| North Harbour | 北港 | venue | ✓ | (−36, −198) | 2.4 m | The working fishery. Funaya boat houses, net racks, an Ebisu torii offshore. |
| Sunset Beach | 浜 | venue | ✓ | (−166, 146) | 1.2 m | Flat sand and shallow water on the south-west spit. Seated concerts. |
| Coast Road | 渚道 | transit | | fallback | — | Catches anyone not inside a named place. |

Zone membership resolves as **smallest containing zone wins**. Overlaps are intentional and
nested — the notice board (r=18) sits inside the plaza (r=56), which sits inside the coast
fallback (r=9999) — so ranking by radius yields the most specific place without any priority
field to maintain.

---

## 2. The terrain field

The island's surface is **an analytic function**, not a mesh. `heightAt(x, z)` in
[`packages/shared/src/terrain.ts`](../packages/shared/src/terrain.ts) *is* the terrain. The
client meshes it into a 400 × 400 grid in a worker at load time; the server calls the same
function to validate every position a player reports.

Three consequences, all of them the reason for the choice:

- **Client and server agree by construction.** No collision data to ship, no second
  artefact to keep in sync.
- **The landmass costs zero bytes.** The whole island is a few hundred lines of maths.
- **It is editable by anyone.** Moving the shrine 20 m east is a number change.

### Composition, in evaluation order

```
islandMask(x, z)          circle, angular wobble, four capes, two harbour bays
   ↓
naturalHeight(x, z)       seabed offshore; onshore: coastal shelf + sea cliffs + massif
   ↓
paddedHeight(x, z)        ten gathering terraces blended in
   ↓
heightAt(x, z)            paths cut to their surveyed grade
```

The order is load-bearing and the comments in `terrain.ts` say why at each step. The one
worth repeating here: **pads are applied before paths**, so a lane crossing a terrace is
graded against the flat plaza rather than against the hillside underneath it. Cutting paths
first (as v1 did) meant the summit pad's own blend ring added its 30-odd degrees on top of
the lane's gradient, and the last ten metres of every ascent were steeper than the mountain
the lane existed to make climbable.

### The massif

One cone with three layers: a smoothstep profile, six radial spurs with valleys between
them, and ridged rock detail faded out at the very top and at the foot.

Height and radius are chosen **together**. A smoothstep cone's steepest point is its
midpoint, where the gradient is `1.5 · height / radius`; at 88 m over 182 m that is 36°,
comfortably inside the 49° walkable limit once the spurs and the rock detail have added
their share. Raising the peak without widening the base is the quickest way to make the
whole mountain unclimbable.

### Terraces

Ten flat pads, listed in `PADS`. Everything people gather on gets one — an event plaza on a
natural slope is unusable, and characters sliding down a shrine courtyard would break the
calm instantly.

Two rules the layout has to respect, both enforced by `scripts/world-smoke.ts`:

- A pad's centre must resolve to exactly its authored height. Pads apply in order and a
  later one wins, so a big terrace whose `outer` reaches a small one downhill will quietly
  drag it to the wrong level.
- Two pads must not be closer than the height between them divided by the walkable
  gradient. The plaza sits 91 m from the harbour quay for exactly this reason: 19.4 m of
  height needs about 23 m of run.

Harbour pads are kept deliberately tight (26/46 and 22/42). A pad's blend raises the ground
all the way out to `outer`, and the ground it raises at a harbour is *seabed* — an
over-generous quay does not make a bigger harbour, it fills the bay in and leaves the piers
standing on a beach.

---

## 3. Paths

| Path | Length | Half-width | Surface | Route |
|---|---|---|---|---|
| Coast Road | 1289 m | 3.6 m | stone | A closed loop touching all six inhabited places |
| Plaza Steps | 262 m | 3.2 m | stone | South harbour → plaza → notice board → summit |
| Shrine Path | 267 m | 2.8 m | gravel | Shrine → two switchbacks up the west flank → summit |
| East Lane | 352 m | 3.0 m | gravel | Old Street → teahouse → summit |

Paths do two jobs. Physically they hold a gentle grade across ground that would otherwise be
too steep to walk, which is what makes a 88 m mountain climbable without a single piece of
stair geometry. Visually they are the island's circulation diagram: if you can see where a
path goes, you know where you can go, and you never need a minimap.

### Surveyed grades

Flattening the ground *across* a path is not enough. A lane that is level side to side but
follows every gully along its length still throws 70° pitches at you.

So each path is surveyed like a real road. Its height is sampled every 4 m along its arc
length, smoothed, and then **grade-limited** by a relaxation pass that clamps the rise
between neighbouring samples until no step exceeds 30%. `heightAt` reads that profile
instead of the raw terrain under the path, and the ground is cut or banked either side.

Samples that fall on a terrace are **pinned** and neither the smoothing nor the limiter may
move them. Terraces are the island's fixed levels — the quay is at 2.6 m because boats tie
up to it — so they are the survey's control points and the lane between them is what gets
graded. Pinning also silently fixes junctions: every place two routes meet is a terrace
centre, so both profiles are pinned to the same height there and the step that would
otherwise appear where `nearestPath` switches routes cannot exist.

Every metre of all four paths is walkable. `world-smoke` checks it.

### Spatial index

`heightAt` is called ~160 000 times to mesh the terrain and again on every position the
server validates, and a naive nearest-point search over four polylines is 90-odd segment
tests per call. Segments are therefore bucketed into a 32 m uniform grid on first use, so a
lookup tests only the segments whose influence reaches the query cell — typically zero,
which is the case worth making fast.

---

## 4. What is built on it

126 hand-placed landmarks, listed in `LANDMARKS` in
[`packages/shared/src/world.ts`](../packages/shared/src/world.ts) and built by the prop
library in [`apps/client/src/world/props/`](../apps/client/src/world/props/).

```
9 × machiya      6 × torii        5 × warehouse    4 × pier / stage / gate / minka / bell-tower
13 × stone lantern               12 × rock         11 × bench       7 × post lantern
2 × shrine hall / boathouse / net rack / beach hut / komainu / well
1 each: lighthouse, keeper's house, bathhouse, teahouse, temizuya, breakwater,
        notice board, summit marker
```

Roadside lanterns are **not** in that list: 67 of them are placed by arc length along the
four paths at build time, because spacing them by hand would go stale the moment a road is
re-routed. The coast road gets stone tōrō (a matched run is the real-world convention) and
the three inland lanes get timber post lanterns.

### There are no trees

This pass of the world puts its effort into terrain and architecture and plants nothing.
That is a real constraint on the art direction rather than an omission: with no canopy to
hide behind, the hillsides have to be read by their *contours* and their colour banding,
which is why the terrain colourer patches two greens at a scale the eye reads as brushwork
and why the massif has spurs rather than being a smooth cone. Vegetation slots back into
`world/scatter.ts` without touching anything else when it is wanted.

What is scattered: boulders on the steep ground and along the shore, grass tufts on the
gentle ground, driftwood at the tide line — 18 500 instances across 4 draw calls, placed by
rejection sampling against the terrain field so the rules read as rules ("boulders live on
ground steeper than 15°, keeping 3 m clear of any path") rather than as coordinates.

### Waterfront props have their own placement rule

Piers, boats, breakwaters and the two sea torii are placed at `y = 0`, not at terrain
height. They are authored with their piles and hulls running well below their origin so they
reach the seabed at whatever depth the bathymetry happens to be. Dropping a pier at terrain
height would bury it. `island.ts` owns the placement side of that contract; `structures.ts`
owns the geometry side, and both say so.

---

## 5. Arrival

Six spawn points on the south harbour quay, all facing the mountain. You arrive by water,
and the walk up to the plaza is the island introducing itself. They are spread along the
quay so a crowd arriving together does not stack into one body.

---

## 6. Tools

| Command | What it does |
|---|---|
| `node scripts/world-map.mjs out.png --size 1400` | Shaded relief map with paths, terraces, zone anchors and every unwalkable pixel flagged in red |
| `npm run test:world` | Asserts the invariants: finite heights, pads at their authored level, every path walkable, every landmark kind buildable, scatter determinism |
| `node tools/shot.mjs` | Renders twelve viewpoints to PNG through the real pipeline in headless Chromium |

The map is the one to reach for first when something looks wrong. The failure modes of a
procedural world are spatial, and reading numbers does not catch them: a terrace that has
drifted onto a cliff, a lane that dives into the sea, a bay that closed up when the coast
noise was retuned — all of it is obvious in one glance at a map and invisible in a test log.
