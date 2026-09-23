# The island — world model v3

Nagisa is one small Japanese island, about 250 m across, surrounded by open water on every
side. Six places sit on a hexagon 74 m to a side, with a single mountain at its centre.

That scale is the whole design. A neighbour is about nine seconds away at a walk and half
that at a run; the entire ring road takes under a minute at a walk. When something starts at
the plaza, the answer is "I'm nearly there" rather than "I'll set off".

> Two earlier islands are kept for reference, each with a table of what changed and why:
> [`archive/world-v1/`](../archive/world-v1/README.md) and
> [`archive/world-v2/`](../archive/world-v2/README.md). v3 is a *scale* change from v2, not
> a redesign — almost every mechanism below is v2's.

---

## 1. Geography

```
                          北港 North Harbour        2.4 m
                                (0, −74)
                              ╱          ╲
        灯台岬 Lighthouse                    町並み Old Street  ┐
           (−64, −37)  13 m                    (64, −37)  9 m  │ one shelf,
               │           ▲ 山頂 Summit            │           │ and the road
               │             (0, 0)  26 m           │           │ up the mountain
        神社 Shrine                           広場 Main Plaza   ┘
           (−64, 37)  11 m                     (64, 37)   8 m
                              ╲          ╱
                          南港 South Harbour       2.4 m
                                (0, 74)
```

The heights say what each place is:

- **Two harbours**, north and south, at sea level in their own bays.
- **Two high places** — the shrine on its headland, the lighthouse on its cape — raised
  above the ring so they read as somewhere you go *up* to.
- **Two that adjoin**: the plaza and the old street share one continuous eastern shelf with
  no dip between them, and the road up the mountain leaves from where they meet.
- **The summit**, highest, in the middle, visible from everywhere.

`−z` is north and `+x` is east — the three.js convention, used consistently everywhere in
this codebase including in every coordinate in this document.

### Zones

| Zone | 日本語 | Kind | Venue | Anchor | Ground | What it is |
|---|---|---|---|---|---|---|
| South Harbour | 南港 | venue | ✓ | (0, 74) | 2.4 m | The arrival port. Ferry pier, breakwater, warehouses, market stalls, a torii in the bay. Everyone spawns here. |
| Sunset Beach | 浜 | venue | ✓ | (46, 92) | 1.6 m | Sand east of the quay. Huts, a boat, a low stage. |
| Main Plaza | 広場 | venue | ✓ | (64, 37) | 8 m | The civic centre. Roofed stage, gates, well, and the teahouse on its quiet side. |
| Notice Board | 掲示板 | notice | | (48, 22) | 8.4 m | A shallow step up from the plaza floor. Announcements are read here. |
| Old Street | 町並み | transit | | (64, −37) | 9 m | Six machiya facing each other across a street, a bathhouse, a kura. |
| North Harbour | 北港 | venue | ✓ | (0, −74) | 2.4 m | The working fishery. Funaya boat houses, net racks, an Ebisu torii offshore. |
| Lighthouse Cape | 灯台岬 | venue | ✓ | (−64, −37) | 13 m | Exposed clifftop. The lamp turns day and night. |
| Shrine | 神社 | venue | ✓ | (−64, 37) | 11 m | The western headland. Three torii along the approach, komainu, temizuya, the hall. |
| Summit | 山頂 | scenic | | (0, 0) | 26 m | The inner shrine and a railing. The camera widens automatically. |
| Ring Road | 渚道 | transit | | fallback | — | Catches anyone not inside a named place. |

Zone membership resolves as **smallest containing zone wins**, so the notice board (r=11)
inside the plaza (r=32) inside the ring fallback (r=9999) yields the most specific place
without any priority field to maintain.

Every zone carries its words in three languages. `name` is the English shown as you
arrive and `nameJa` the Japanese beneath it; `nameZh` is the Chinese interface's name and
falls back to `nameJa`, which shares its script. `caption` is the one observational sentence
shown on first entry, with `captionZh` and `captionJa` beside it, each falling back to the
English. The client picks the field (`apps/client/src/i18n/index.ts`); nothing is
duplicated in the interface's dictionaries.

---

## 2. The terrain field

The island's surface is **an analytic function**, not a mesh. `heightAt(x, z)` in
[`packages/shared/src/terrain.ts`](../packages/shared/src/terrain.ts) *is* the terrain. The
client meshes it in a worker at load time; the server calls the same function to validate
every position a player reports.

- **Client and server agree by construction.** No collision data to ship.
- **The landmass costs zero bytes.** A few hundred lines of maths.
- **It is editable by anyone.** Moving the shrine 20 m is a number change.

### Composition, in evaluation order

```
islandMask(x, z)          circle, angular wobble, four capes, two harbour bays
   ↓
naturalHeight(x, z)       seabed offshore; onshore: rolling ground + named shelves
                          + sea cliffs + the massif
   ↓
paddedHeight(x, z)        ten gathering terraces blended in
   ↓
heightAt(x, z)            routes cut to their surveyed grade
```

**Pads before paths.** A lane crossing a terrace is graded against the flat plaza rather
than the hillside underneath it. Cutting paths first (as v1 did) meant a terrace's own blend
ring added its 30-odd degrees on top of the lane's gradient, and the last ten metres of
every ascent were steeper than the mountain the lane existed to make climbable.

### Shelves

A *shelf* is landform where a terrace is a platform: a broad, gentle rise that the
surrounding terrain still shows through. Three of them — one carrying both the plaza and
the old street, and one under each western headland. The eastern shelf is what makes those
two zones read as one continuous piece of high ground with the mountain road leaving from
between them, rather than as two platforms with a dip in the middle.

### Terraces

Ten flat pads. Everything people gather on gets one, and so does the saddle between the
plaza and the old street.

Their **inner radii are sized by what stands on them**, not by eye — a building is placed at
a single height sample, so its whole footprint has to be inside the flat part. The ceiling
on how wide they can get is the gap to the next terrace: two pads need
`heightDifference / walkableGradient` of clear ground between their flat parts, and the
hexagon gives 74 m to spend. The tightest pair is the north harbour and the lighthouse cape,
10.6 m apart in height.

Harbour pads are kept deliberately tight. A pad's blend raises the ground all the way out to
`outer`, and at a harbour the ground it raises is *seabed* — an over-generous quay does not
make a bigger harbour, it fills the bay in and leaves the piers standing on a beach.

---

## 3. Routes

| Route | Length | At a walk | Surface | Where it goes |
|---|---|---|---|---|
| Ring Road | 493 m | 55 s | stone | A closed loop through all six zones |
| Summit Road | 85 m | 9 s | stone | Leaves the ring at its eastern point (82, 0), between plaza and old street, and climbs west to the summit |
| Shrine Path | 74 m | 8 s | gravel | Shrine → up the west flank → summit |
| Harbour Lane | 112 m | 12 s | gravel | South harbour → the notice board terrace → the ring at (82, 0), where the summit road leaves it |
| Lighthouse Path | 35 m | 4 s | gravel | From the ring on the cape terrace out along the headland to the lighthouse |

Lengths are surveyed arc lengths (`pathLength`); times are at the 9 m/s walk, on the flat.
Every metre of all five is walkable; `world-smoke` checks it.

### Surveyed grades

Flattening the ground *across* a route is not enough — a lane that is level side to side but
follows every gully along its length still throws 70° pitches at you. So each route is
surveyed like a real road: its height is sampled every 4 m along its arc length, smoothed,
then **grade-limited** by a relaxation pass that clamps the rise between neighbours until no
step exceeds 30%.

Three kinds of fixed point constrain that relaxation, and each exists because leaving it out
produced a specific, visible failure:

- **Terraces are pinned.** They are the island's fixed levels — the quay is at 2.4 m because
  boats tie up to it. Pinning them also fixes junctions for free, since routes that meet on a
  terrace are pinned to the same height there.
- **Open routes' ends are pinned.** A road has to meet what it stops at. Without this the
  limiter, whose job is to make the profile gentle rather than to keep it on the ground,
  satisfies itself by lifting the free end into the air — the summit road floated thirteen
  metres above the shelf it starts from, with an 80° wall of terrain where the carve met the
  hillside.
- **A branch pins to the route it joins**, not to the bare ground. The ring road has already
  been cut to its own profile where the summit road leaves it; pinning to the untouched
  ground underneath reproduces the same cliff nine metres lower down.

### Switchbacks

Where a route doubles back, two samples eighty metres apart *along the road* are fifteen
metres apart *on the ground*. Their carve influences overlap, `nearestPath` flips between
them from one pixel to the next, and whatever height difference they hold becomes a vertical
step. A hairpin with a four-metre drop across it does not read as a hairpin; it reads as the
road being broken.

Real switchbacks answer this by making the turn itself level, and so does the survey: any two
samples far apart in arc length but close in space are pulled toward their mean, in
proportion to how much their influence regions overlap. Straight road is untouched, because
no two distant samples on it are ever close together.

---

## 4. What is built on it

134 hand-placed landmarks in the map pack's `LANDMARKS`, built by the prop library in
[`apps/client/src/world/props/`](../apps/client/src/world/props/).

```
26 × stone lantern   10 × bench     9 × rock       8 × stamp stand    7 × machiya
6 × torii            5 × boat / warehouse
4 × pier / stage / bell tower / post lantern / banner / gate
3 × market stall / notice board
2 each: sea wall, beach hut, minka, well, boathouse, net rack, rail, komainu, temizuya,
        shrine hall
1 each: breakwater, teahouse, bathhouse, lighthouse, keeper's house, summit marker,
        omikuji stand, rod rack
```

The last three kinds in that list — `stamp-stand`, `omikuji-stand`, `rod-rack` — are the
games' furniture (`props/games.ts`); §7 says how they are used.

Roadside lanterns are **not** in that list: they are placed by arc length along the five
routes at build time, every 21 m (34 m on the low tier), because spacing them by hand goes
stale the moment a road is re-routed. After the map's vetoes that is fifteen lamps (thirteen
on the low tier).

### Buildings stand on level ground

A prop is a rigid body placed at **one** height sample, so any variation across its footprint
puts one corner in the air and buries the opposite one. Two things keep that from happening:

1. **The layout puts buildings on the flat part of a terrace.** `node tools/flatness.mjs`
   measures the ground variation under every footprint and `world-smoke` fails the build if
   any exceeds 45 cm.
2. **The scene assembly fits a foundation** as a backstop: a prop is placed at its *highest*
   corner, so nothing is ever swallowed, and a block sized to the footprint fills what that
   leaves underneath.

The second is a backstop, not a licence for the first. A foundation deep enough to hide a
real slope is a retaining wall, and a village of buildings on retaining walls looks like a
village that was placed by a script.

### There are no trees

This pass of the world puts its effort into terrain and architecture and plants nothing.
That is a constraint on the art direction rather than an omission: with no canopy to hide
behind, the hillsides are read by their contours and colour banding, which is why the terrain
colourer patches two greens at a brushwork scale and why the massif has spurs. Vegetation
slots back into `world/scatter.ts` without touching anything else.

What is scattered: boulders on steep ground and along the shore, grass tufts on gentle
ground, driftwood at the tide line — about 18 000 instances across 4 draw calls, placed by
rejection sampling against the terrain field.

---

## 5. Movement, and the walkability contract

The client predicts your movement and the server validates it. Both sides enforce the same
rule, from [`packages/shared/src/movement.ts`](../packages/shared/src/movement.ts):

| | |
|---|---|
| Walk | 9.0 m/s |
| Run | 18.0 m/s |
| Wade | 2.0 m/s, to 0.9 m of water |
| Max slope | 0.86 rad ≈ 49° |
| Server budget | 20.5 m/s horizontal — the client's ceiling plus 2.5 m/s of headroom — and 16 m/s vertical |

That file is not a preferences list. Any divergence between the two sides is not a subtle
physics discrepancy: it is **the player being teleported at random while running**, because
every frame the client spends outside the server's rule earns a correction. Three versions of
that bug shipped simultaneously, all from the two sides holding their own copies of these
numbers — the client waded deeper than the server allowed, let a player stand on ground the
server rejected, and applied its slide impulse after its speed clamp so sliding could exceed
the server's budget.

`world-smoke` now simulates the client's integrator against the server's validator, walking
long lines out from every zone in every direction, and asserts that every position the client
would commit to is one the server accepts. Against the old client rule it finds about 4 800
violations in 110 000 steps.

---

## 6. Tools

| Command | What it does |
|---|---|
| `npm run map` | Shaded relief map with routes, terraces and every unwalkable pixel in red |
| `npm run plans` | One plan drawing per place: terrain, carriageway, every built footprint, and an arrow out of each door |
| `node tools/flatness.mjs` | Ground variation under every building's footprint |
| `npm run audit:terrain` | Walkability: pinholes, stranded pockets, snags on the lanes and terraces, reachability |
| `npm run audit:placement` | Layout: symmetry, orientation, overlaps, buildings in the carriageway, doors turned away from the road, walls holding nothing back |
| `npm run test:world` | The invariants: finite heights, pads at their authored level, every route walkable, every building level, the walkability contract |
| `npm run shots` | Thirteen viewpoints rendered to PNG through the real pipeline |
| `node tools/shot.mjs plans` | The same places again, but from directly overhead, through the real renderer |
| `node scripts/layout-solve.mjs --intent f.json` | Turns *station along a lane, offset, facing* into `x`, `z` and a yaw |
| `SPOT='{"id":"…","near":[x,z]}' node scripts/find-spot.mjs` | Every position a landmark could stand that satisfies all four audits at once |
| `npm run notes` | Placement notes written from inside the world — see below |

The map is the one to reach for first when something looks wrong. The failure modes of a
procedural world are spatial, and reading numbers does not catch them.

### Terrace edges

A terrace is a flat disc pressed into a hillside, so how deep it cuts is a function of
*direction*: the south harbour sits at 2.4 m on ground that is at sea level to seaward and
thirteen metres up the mountain twenty-eight metres inland. The authored `outer` is one ring
width for all of it, and it was sized for the gentle side — which put a sixty-seven degree
bank around the whole inland arc, twenty-seven per cent of it unwalkable.

That bank is what you meet as an invisible wall. `isWalkable` refuses ground steeper than
`MAX_WALKABLE_SLOPE` and a jump does not help, because the test is horizontal — so a cut face
reads as a plane of air on ground that looks like a hillside.

So `outer` is now a *minimum*: the ring grows, per direction, to whatever width the drop on
that side needs at a walkable grade, capped at three times the authored one. The growth is
asymmetric by construction, so a harbour's seaward side keeps its authored ring and only the
uphill approach becomes a ramp.

Two things this deliberately does **not** do:

- **It does not excavate.** Modelling what a builder would actually do — dig the pad, run a
  cut face out from its rim at the steepest angle that holds — is correct and eats the
  mountain, because the harbour's flat is ten metres below the hillside at its own rim and a
  face climbing out of that does not catch a slope already rising at thirty-five degrees until
  it is fifty metres inland. The blend cuts less and leaves a steeper join.
- **It does not make cliffs jumpable.** Relaxing the contract to "steep ground may be passed
  over while your feet are clear of it" was tried and cannot be validated: the server sees
  positions, not velocities, so it cannot tell a jump arc from a client reporting itself half
  a metre above a cliff face and walking up it. Steep ground a player wants to jump *up* is a
  terrain defect, and is fixed as one.

Going **down** is a different question, and `canEnterFrom` answers it. `isWalkable` is
symmetric — ground too steep to climb is refused from above as firmly as from below — so a
clifftop used to be a fence: the ground past the edge was unwalkable, the step onto it was
refused, and you could not jump off, fall off, or walk off. Steep ground may now be entered
when it is *below* you. A player can always leave an edge and never climb one, which is
validated from two coordinates, so the server checks it exactly.

What remains is a band of steep ground round the mountain's foot, forty to fifty metres out
from each harbour. That is a mountain, and the roads are how you get past it.

### Saying which building

The slow part of arranging a village is not moving a building; it is *saying which one*. A
note like "this hut is too close to the road" is unusable a day later, because "this" was
something you were looking at and the record kept only the words.

So: run `npm run dev`, open the client with `?dev=1`, and a pin button appears in the top
right. Stand where the problem is, press **Mark here**, pick the landmark from the list of
the eight nearest, write a sentence, save. The note records the position, the heading, the
zone, the landmark's id and the camera, and lands in `dev-notes.jsonl`. `npm run notes`
prints them, each with a `probe.ts`-ready viewpoint for the exact frame it was written from,
so the view can be re-rendered without anybody having to describe it.

The endpoint is *absent* unless `DEV_NOTES_PATH` is set, which only `scripts/dev.mjs` does.
A feature that cannot be reached in a deployment cannot be abused in one, and that is a
better property than a guard, which is a thing to get wrong.

### Placing a building beside a road

Author it in road coordinates and let `scripts/layout-solve.mjs` do the trigonometry. Two
things go wrong every time they are typed by hand:

- **The setback has to clear what the building *occupies*, not what its walls enclose.** Eaves
  overhang by 0.6–1.5 m, a minka's veranda and steps reach 2.4 m past its front wall, a
  funaya's slipway 4.3 m past its. A pass that measured wall lines once left nineteen
  buildings standing in a carriageway while believing none were.
- **A yaw says which way a building is *turned*, not merely how it is squared up.** Every
  builder in `props/buildings.ts` models its entrance on the local −z face, so `rot` and
  `rot + π` are opposite buildings, not the same one. Both rows of the Old Street were
  authored with their backs to it.

The rule, and what `audit:placement` enforces: a frontage may address the road or stand
side-on to it, never turn away. The exemption is a frontage that opens onto water within
46 m — a boat house, a beach hut, a stage playing to a crowd sitting on the sand — which is
measured against the terrain rather than declared per kind, because the same kind is right
both ways round on the same island.

---

## 7. Things to use: interactables and the games' places

Everything a player can walk up to and use is an `Interactable` in the map pack's
`INTERACTABLES` — twenty-six on the shipped island. Each is an offset (`dx`, `dz`) from its
zone's anchor, a `range` within which the prompt appears, a `kind` (`use` or `sit`), an
English `label`, and an `effect` that says what using it does:

| `effect` | On the island | What happens |
|---|---|---|
| `none` | 4 seats (`kind: 'sit'`) | Nothing beyond the pose. The server reserves the seat: one person each. |
| `read_announcements` | the notice board | Opens the board: announcements and the guestbook. Signing requires standing here. |
| `checkin_nearby` | the plaza post | Checks you in to whatever is live in this zone. |
| `ring_bell` | 4 bells | Rings, for everyone within earshot. 3 s rest per bell. |
| `look` | the lighthouse door, the summit rail | The camera turns to take in the view given by `view`. Client only. |
| `stamp` | 8 stamp stands, one per place | Puts this zone's stamp on your card. |
| `omikuji` | the shrine's fortune box | Draws the day's fortune. |
| `fish` | 4 pier ends and 1 beach spot | Casting here starts the fishing game. |

Two optional fields serve particular effects:

- **`view`** — for `look`, where the camera turns: `yaw` in the world's convention (the
  direction `(sin yaw, cos yaw)` in x/z), `pitch` down from level, and an optional framing
  `distance`. For `fish`, `yaw` is the way the line goes out over the water.
- **`habitat`** — for `fish`, `'harbor'` (deep, sheltered) or `'beach'` (surf over sand). It
  decides which species can bite (`packages/shared/src/games/fish.ts`); omitted means
  harbour.

The server checks reach against the same data — the player's last validated position within
`range` plus 1.5 m of slop — so a prompt the client shows is one the server honours. The
prompt's verb is localised by effect (`prompt.<effect>` in `i18n/core.ts`), so `label` is
only the English fallback.

### The games' map data

Three more parts of `MapWorld` exist for the games. A map without them simply does not run
that game.

- **`quizArena`** — `{ zone, o: {x, z, r}, x: {x, z, r} }`: the two circles of the ○× quiz,
  on flat, walkable ground in a venue. The shipped arena is two 4.5 m discs across the middle
  of the plaza, clear of every building and prompt. `zone` is where the quiz gathers its
  field — everyone standing in it when the lobby closes — so it should be the quiz
  template's venue. The circles must not overlap (`quizSide` gives ○ a tie).
- **`fireworks`** — `{ zones, sites }`: the shores a player may launch from (the shipped
  island: the beach and the south harbour), and the launch points out on the water as
  `[x, z]`. The server launches from the site nearest the player, jittered by up to 7 m.
- **`programme`** — the island's day: `{ template, at }`, `at` in real minutes after island
  midnight (a day is ninety). See [ACTIVITIES.md](ACTIVITIES.md) §3. Without one, each
  template runs once a day, evenly spaced.

Activity templates carry their words the way zones do: `title` and `blurb` in English, with
`titleZh`, `titleJa`, `blurbZh` and `blurbJa` beside them, each falling back to the English.
A template's `feature` (`quiz`, `derby`, `fireworks`, `concert`, `lanterns`, `lamp`) says
what the island does while it is live.

### Adding a game spot

A game is something that happens *at a place*, so adding one is the same work as adding a
building, plus a prompt.

1. **Put the furniture down.** A `stamp-stand`, `omikuji-stand` or `rod-rack` landmark in
   `LANDMARKS` — sited like any building, on level ground, clear of the carriageway and of
   every other footprint. `scripts/layout-solve.mjs` and `scripts/find-spot.mjs` do the
   geometry. Fishing needs no furniture, but a spot with a rod rack reads as one.
2. **Add the prompt** in `INTERACTABLES`: offset from the zone's anchor so that it stands in
   front of the thing it names, with the `effect` and, for fishing, `habitat` and `view.yaw`
   pointing over water that is actually deep enough.
3. **Mind the stamp card.** The card is derived: `STAMP_ZONES` is the zone of every `stamp`
   interactable, in map order, and completing it earns *Island Walker*. So a new stand
   lengthens the card for everyone, and **one stand per zone** is a rule — a zone is stamped
   once, so a second stand in the same zone would add a circle nobody can fill.
4. **Run the audits.**
   - `npm run audit:placement` — the layout rules, and *interactables that reach nothing*:
     every prompt must be within its `range` of a landmark's footprint, and on walkable
     ground. This is the check that catches a prompt left behind when its building moved;
     six of the island's first twelve were stranded when it was written.
   - `npm run test:world` — every landmark kind has a builder, every building stands on
     ground level to within 0.45 m, every route and spawn is walkable.

   Neither looks at `quizArena` or the fireworks sites. Check the circles by standing in
   them in the running client (`npm run dev`); the server's `games.test.ts` stands players at
   their centres and would fail on an arena the quiz cannot judge.

The server needs no change for any of this. Handlers dispatch on `effect`, and the games read
the arena, the shores, the fishing spots and the stamp stands from the active map.
