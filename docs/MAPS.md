# Maps

Nagisa's island is data. Everything that makes it *this* island lives in a **map pack**, and
the engine that turns a pack into ground you can stand on knows nothing about its contents.
Two packs ship: `nagisa-island` and `lantern-atoll`.

```
packages/shared/src/
  map/
    types.ts        what a map is — MapPack, MapTerrain, MapWorld, and the shapes inside them
    registry.ts     register / activate / subscribe. ~100 lines, no logic
  maps/
    index.ts        registers the built-ins, picks the default, resolves requested ids
    nagisa-island.ts    渚島 — the shipped world. Pure data
    lantern-atoll.ts    灯籠環礁 — a second world, and the proof the split is real
  terrain.ts      the engine: heightAt, path surveying, walkability
  world.ts        the engine: zones, spawns, crowd placement
```

## Switching

Both hosts pick a map the same way, and they must agree.

```bash
# server
NAGISA_MAP=lantern-atoll npm run dev -w @nagisa/server

# client
http://localhost:5173/?map=lantern-atoll

# tools
NAGISA_MAP=lantern-atoll npm run test:world
NAGISA_MAP=lantern-atoll node scripts/world-map.mjs atoll.png
node tools/shot.mjs --map lantern-atoll --views island
```

An unknown id throws, listing what is registered. It never falls back to the default: the
server tells the client which map it chose in the welcome message, and a client that loaded a
different one would be validating every step against ground that is somewhere else. That
failure presents as constant unexplained teleporting, with nothing in either log pointing at
its cause, so both sides fail loudly at the handshake instead.

Maps are chosen at boot and not switchable under a populated room. `setActiveMap()` is
synchronous and immediate — the moment it returns, `heightAt` is answering about somewhere
else, and every player's coordinates describe a world that is no longer loaded.

## What is a map, and what is the engine

**In a pack:** the coastline (capes, bays), the landform (shelves, the massif, the relief
scale), the terraces, the routes, the named places, the buildings, the interactables, the
activity templates, the spawn points.

**In the engine:** how a terrace is applied, how a route's grade is surveyed, what counts as
walkable, how a building is modelled, how many players a room holds. A pack that needs a new
*rule* is asking for an engine change, not a map.

The line is not always obvious, and the second map is how it gets found. Three things were
sitting on the engine side that turned out to be Nagisa Island's data:

- `naturalHeight` hard-coded three circles around the island's own harbours and beach to
  suppress sea cliffs there. Now `MapTerrain.shelters`.
- Rolling-ground, cliff and detail amplitudes were literals in metres, tuned for a 52 m
  summit. Loaded through a 3.5 m atoll they produced 23 m hills. Now `MapTerrain.relief`.
- `ZoneId` was a closed union of the island's own place names, so no other pack could name
  its own places. Now open, with the shipped ids kept for autocomplete.

None of those were visible with one map in the tree.

## Live bindings

`terrain.ts` and `world.ts` republish the active pack's data as module bindings — `PADS`,
`PATHS`, `ZONES`, `LANDMARKS`, `SUMMIT`, `ISLAND_EXTENT` and the rest — declared `let` and
reassigned by a subscriber at the bottom of each file. ES module bindings are *live*, so the
thirteen modules that already imported these needed no changes at all.

The rule that comes with it:

> **Do not snapshot them at module scope.**
> `const EXTENT = ISLAND_EXTENT` in another file freezes whichever map was active when that
> file was first imported — which is always the default, since imports are evaluated before
> any code gets to choose. Read them where you use them, or subscribe with `onMapChange`.

Three places were doing exactly that and were fixed: `ocean.ts`'s bathymetry extent,
`room.ts`'s zone id list, and `scripts/world-map.mjs`'s destructuring.

Subscribers are the **last statement** in `terrain.ts` and `world.ts`. `onMapChange` invokes
its listener immediately when a map is already active, so everything it assigns must already
be initialised; registering it earlier reaches those declarations in the temporal dead zone
and fails at import time.

## The contract a pack must satisfy

`scripts/world-smoke.ts` runs 34 checks against *whichever pack is active*, with no map's
numbers written into it. Both shipped maps pass all 34.

- Every terrace's centre reaches its stated height.
- Every route is walkable end to end, at a legal grade.
- Every grounded landmark stands on ground level to within 0.45 m.
- Every spawn point is walkable, they all land in the same zone, and they are spread rather
  than stacked.
- The summit is the highest ground; the seabed does not run away downward.
- Every zone anchor resolves to its own zone and is walkable.

Assertions in that file must be written against `activeMap()`, never against a literal. The
one that said `max > 30` was fine until the island's relief was halved, and the one that said
spawns land in `'south-harbor'` was fine until a map without a south harbour was loaded.

## Writing a pack

Write a `MapPack` anywhere, register it, and pass its id:

```ts
import { registerMap, setActiveMap, type MapPack } from '@nagisa/shared';

const MY_MAP: MapPack = { id: 'my-map', name: '…', nameJa: '…', summary: '…',
                          terrain: { … }, world: { … } };
registerMap(MY_MAP);
setActiveMap('my-map');
```

`maps/index.ts` is the *shipped* set, not the allowed set — nothing there needs editing.

Two things catch first-time authors, both now documented on the fields themselves:

- **A loop is declared by repeating the first waypoint at the end.** Landing *near* the start
  is not enough; the survey clamps an open route at its ends and wraps a closed one, so a ring
  that does not repeat comes out as a lane with a gap in it.
- **Relief is absolute metres, not a ratio.** A pack whose summit is a tenth the height wants
  roughly a tenth of the island's `relief` values, or its noise will dwarf its landform.

Then check it: `NAGISA_MAP=my-map npm run test:world`, and look at it with
`NAGISA_MAP=my-map node scripts/world-map.mjs my-map.png`.
