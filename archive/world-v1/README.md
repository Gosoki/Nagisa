# World model v1 — archived

This directory holds the **first** version of Nagisa's world: its terrain field, its layout
data, its prop library, its materials and its character rig, exactly as they were before
the v2 rebuild. Nothing here is compiled, imported or shipped. It is kept for one reason —
so the decisions v2 made *against* something can still be read against the thing they were
made against.

## What v1 was

An east–west ellipse with a mountain ridge pushed up against its northern edge, one harbour
in the south-west, and the main plaza sitting on the origin. Buildings were assembled from
boxes and wedges; roofs were two flat quads; the renderer was `MeshToonMaterial` with a
three-step gradient ramp, ACES tone mapping and a restrained bloom.

It was coherent and it ran well. It read as *a coastline with some hills behind it*, and its
buildings read as models rather than as architecture.

## Why it was replaced

Point by point, and each of these is a design decision v2 makes differently:

| v1 | v2 | why |
|----|----|-----|
| Ellipse against the edge of the meshed area | Compact disc, sea visible from every shore | "Sea on four sides" is a shape decision, not a camera decision — an ellipse in a square leaves two horizons that are land |
| Mountain ridge in the north | One massif at the centre, with radial spurs | The high ground is what you orient by; against an edge it can only be seen from one half of the island |
| One harbour | North and south harbours, each in its own bay | Two harbours give the coast road two destinations and the island two characters — arrival port and working fishery |
| Everything on one shore | Six inhabited places spread round the ring | A world you walk *through* rather than *along* |
| Paths followed the terrain | Paths carry a surveyed, grade-limited profile | A 96 m mountain is not climbable without one; see `terrain.ts`'s profile section |
| Toon ramp + bloom | Screen-space contour pass, flat fills, paper grain | The reference product's look comes from *drawn line work*, which a lighting ramp cannot produce |
| Two-quad roofs | Stepped tile courses, ridge caps, barge boards | The roof is the dominant mass of every building here, and its banding is what reads at fifty metres |
| One-joint limbs | Two-joint limbs, three garment tones | One joint scissors; two walks |

## Reading it

The layout is the same as the live tree:

```
shared/terrain.ts   shared/world.ts        the analytic field and the layout data
client/world/       island, ocean, sky, scatter, materials, props
client/character/   the character rig
```

`archive/world-v1/shared/terrain.ts` in particular is worth keeping: its coastline is built
from an ellipse plus bites and capes, which is a technique v2 still uses, and its `PADS` and
`PROMENADE` show the shape the path system had before it grew profiles and a spatial index.
