# World model v2 — archived

The second island: a 480 m disc with a 88 m massif at its centre, six inhabited places
spread around the mountain's foot, north and south harbours, and a 1 289 m coast road with
three graded lanes climbing to the summit. 126 landmarks.

**Nothing here is compiled, imported or shipped.** It is kept because it is the reference
this project's art direction was actually developed against, and because most of what v3
does it inherits directly from here.

## What v2 got right, and v3 keeps

Almost all of it. v3 is a **scale** change, not a redesign:

- The analytic terrain field, and the client/server sharing it by construction.
- The **surveyed path grade** — sampling a route's height along its arc length, smoothing
  it, then relaxing it until no step exceeds a maximum gradient, with terraces pinned as
  fixed control points. This is what makes a mountain climbable without stair geometry, and
  v3 uses it unchanged.
- Terraces (`PADS`) as the thing every gathering place stands on, applied *before* paths so
  a lane crossing a plaza is graded against the flat plaza.
- The spatial index over path segments.
- The whole prop library, the ink render pipeline and the character rig.
- Two harbours, one high shrine, one exposed lighthouse cape, an old street of machiya, a
  teahouse terrace, a beach — the vocabulary of places.

## Why it was replaced

**Distance.** v2 was a world you walked *across*; crossing it took real time. The coast road
is 1 289 m — over two minutes at a run — and the six zones sit 130–180 m apart. That is a
fine shape for a world you explore and the wrong shape for a world you *gather* in, where
the answer to "something is starting at the plaza" has to be "I'm already nearly there".

v3 keeps every element and halves the distances: six zones on a hexagon about 74 m on a
side, the summit at the centre, and a coast road under 450 m. Every neighbour is a few
seconds away.

The secondary reason is legibility. v2's zones were placed by hand around an organic
coastline, which reads beautifully from above and is genuinely hard to hold in your head
from the ground. A hexagon with the mountain in the middle is a shape you learn in one
visit.

## Reading it

```
shared/terrain.ts   shared/world.ts      the analytic field and the layout data
client/world/       island, ocean, sky, scatter, materials, props
client/character/   the character rig
```

`shared/terrain.ts` is the file worth keeping: its path-profile survey, its pad-before-path
ordering and its coastline construction (a disc plus capes and bays) are all carried into
v3, and the comments explaining *why* each is shaped that way were written here.
