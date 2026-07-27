# The island

Nagisa is one small Japanese island, roughly 340 m east–west and 300 m north–south,
surrounded by open water. You can walk from the harbour to the lighthouse in about ninety
seconds. That is deliberate: the island has to be small enough to hold in your head after
one visit, and large enough that arriving somewhere feels like arriving.

---

## 1. Geography

```
                              N
                    ╔═══════════════════╗
              cliffs║   ▲ mountain      ║  ← Lighthouse Cape (112, −78)
                    ║  ╱ ╲   ▄ Lookout  ║     white tower, keeper's house,
         NW headland║ ╱   ╲  (−14,−84)  ║     the lamp turns day and night
                    ║⛩ Shrine Path      ║
                    ║  (−58, −62)       ║
      W             ║                   ║             E
   Sunset Beach ────╫──  ⬛ Main Plaza  ─╫──── Old Street ── Teahouse
     (−122, 22)     ║      (0, 0)       ║     (46, 10)      (78, 44)
                    ║   📋 Notice Board  ║
                    ║      (6, −34)     ║
                    ║                   ║
             Harbour║⛩                  ║
            (−96,104)╚═══════════════════╝
                              S
```

Heights run from the harbour quay at 2.2 m to the mountain spine at ~58 m. The north and
north-east coasts are cliffs; the west is a shallow beach; the south-west is a harbour
basin cut into the shore.

### Zones

| Zone | 日本語 | Kind | Venue | What it is |
|---|---|---|---|---|
| Harbour | 港 | venue | ✓ | Where everyone arrives. Two piers, moored boats, warehouses, a torii standing in the water. |
| Main Plaza | 広場 | venue | ✓ | The centre. A roofed stage, paved ground, gates on two sides. Highest capacity on the island. |
| Notice Board | 掲示板 | notice | | A terrace one step up from the plaza. Announcements are readable here. |
| Old Street | 町並み | transit | | Machiya townhouses and minka farmhouses between the plaza and the teahouse. |
| Teahouse | 茶屋 | rest | ✓ | Somewhere to sit. Small, quiet, seated activities only. |
| Shrine Path | 神社 | venue | ✓ | A run of torii up the hill to the shrine hall. Processions start here. |
| Lookout | 見晴台 | scenic | | Clifftop terrace at 44 m. The camera widens automatically. |
| Lighthouse Cape | 灯台岬 | venue | ✓ | Exposed clifftop, 26 m. Wind ambience, nothing between you and the sea. |
| Sunset Beach | 浜 | venue | ✓ | Flat sand and shallow water on the west coast. Seated concerts. |
| Seaside Path | 渚道 | transit | | An 802 m promenade looping the entire coast, lit by stone lanterns every 28 m. |

Zone membership resolves as **smallest containing zone wins**. Overlaps are intentional
and nested — the notice board (r=16) sits inside the plaza (r=50), which sits inside the
promenade fallback (r=999) — so ranking by radius yields the most specific place without
any priority field to maintain.

---

## 2. The terrain field

The island's surface is **an analytic function**, not a mesh:

```ts
heightAt(x: number, z: number): number   // metres; y = 0 is mean sea level
```

There is no heightmap texture and no exported geometry. `heightAt` *is* the terrain.

### Why

- **Client and server agree by construction.** The server validates player positions
  against exactly the ground the client meshed. A baked mesh would require shipping
  collision data to the server and keeping two artefacts in sync forever.
- **The island costs zero bytes.** The whole landmass is a few hundred lines of maths;
  the client meshes it in a worker at load time.
- **It is editable by anyone.** Moving the shrine 20 m east is a number change, not a
  Blender round-trip.

### How it is composed

1. **Island mask** — an ellipse pulled out of round by angular fbm noise, with two capes
   added (north-east for the lighthouse, north-west for the cliff walk) and two bites
   taken out (the harbour basin, a small east cove).
2. **Natural height** — a shore-to-inland ramp, rolling fbm, a ridged-noise mountain
   spine across the north, a cliff term that rises with "northness", and fine detail.
3. **Promenade carve** — within ~10 m of the path polyline, the surface blends toward a
   locally smoothed grade so the path stays walkable across slopes.
4. **Gathering pads** — nine flat terraces (`PADS`), blended last so a flat plaza always
   wins over a path that crosses it. Everything people gather on gets one: an event plaza
   on a natural slope is unusable, and characters sliding down a shrine courtyard would
   break the calm instantly.

### Determinism

Every function uses integer hashing (`Math.imul`, bit operations). No `Math.random`, no
`Date`, no engine-dependent transcendental identities. Given the same `(x, z)`, every
machine returns the same height, bit for bit. This is a **hard requirement**, not a
preference: vegetation scatter is generated independently on every client and never
networked, so non-determinism would silently give each player a different island.

### Derived queries

| Function | Use |
|---|---|
| `normalAt(x, z)` | Character alignment, scatter slope rules, terrain mesh normals. |
| `slopeAt(x, z)` | Walkability, rock colouring on steep faces. |
| `isWalkable(x, z)` | Server-side position validation. |
| `nearestWalkable(x, z)` | Building corrections that do not teleport players somewhere absurd. |
| `promenadeDistance(x, z)` | Paving, carving, keeping vegetation off the path. |
| `promenadeAt(s)` | Placing lanterns evenly by arc length. |

---

## 3. Asset strategy

**Nagisa downloads no art.** Not a mesh, not a texture, not an audio file, not a font.

| Asset class | How it is produced |
|---|---|
| Terrain | Meshed from `heightAt` in a Web Worker. Vertex colours, no textures. |
| Buildings & structures | Procedural builders in `world/props/`, built from primitives and hand-written `BufferGeometry` roofs. ~45 hand-placed landmarks. |
| Vegetation & rocks | Six seeded species × 4–6 variants each, placed by rejection sampling and packed into `InstancedMesh`. ~6 000 instances at the `high` tier. |
| Characters | Procedural rigs from primitives, animated by hand-written cycles. No skinning, no `AnimationMixer`. |
| Sea | Custom shader + a 256² bathymetry texture baked on the CPU from `heightAt`. |
| Sky | Gradient-dome shader driven by a stop table. |
| Ambience | Synthesised at runtime with Web Audio: filtered pink noise beds, slow swells, sparse one-shots. |
| Typography | A system font stack. |

### Why go this far

The reference product this is modelled on ships 5.7 MB on first load and 17.5 MB total —
an excellent result achieved with Houdini, Blender, Substance, Draco and KTX2. Matching
that pipeline would mean an art team and a build chain.

Generating instead gets a comparable amount of *world* for a fraction of the payload, and
it buys three things a downloaded island cannot:

- **Editability.** Everything is a number in a file under version control.
- **Consistency.** One material library means the island cannot drift out of style.
- **No asset pipeline.** No LOD baking, no texture compression matrix, no CDN.

The honest cost: less fidelity per object, no hand-sculpted hero assets, and a load-time
CPU cost (~200–700 ms of meshing) in place of a network cost. For a world that wants to
be entered immediately on a phone, that is the right side of the trade.

There is nothing preventing GLB assets later — `createLandmark` is a single dispatch
point, and swapping a procedural builder for a loaded model is a local change.

---

## 4. Materials and the look

Everything goes through `world/materials.ts`. Two reasons:

- **One look.** Coherence comes from a single lighting model applied everywhere: a
  three-band toon ramp, a warm key light, a cool sky fill, and a bounce from the sea.
  Materials created ad hoc in prop files always drift.
- **Batching.** Props are built as hundreds of small meshes. Shared material *identity*
  is what lets the scatter pass merge geometry and what keeps the scene in the low
  hundreds of draw calls instead of ~900.

Materials are **immutable once handed out**. Ask for a variant by key (`wood('dark')`);
never mutate what you were given, because you would be mutating every other prop on the
island.

The palette is defined once in `@nagisa/shared/tokens.ts` and used by both the scene and
the interface.

---

## 5. Day cycle

Time of day is derived from **server time**, so everyone standing on the plaza sees the
same light at the same moment. Shared weather is a surprisingly large part of a world
feeling inhabited rather than instanced — if your dusk is my noon, we are not in the same
place.

One cycle is 90 minutes. Deliberately long: a sunset every four minutes is a novelty; a
sunset you happen to be present for is an event.

As the cycle passes dusk, `setNightFactor` raises the emissive on paper screens and
lanterns, the sea takes a cool tint, and bloom strength rises so the lighthouse lamp and
the promenade lanterns read properly.

---

## 6. How to change the island

### Move or add a place

Edit `ZONES` in `packages/shared/src/world.ts`, and add a matching flattening pad to
`PADS` in `terrain.ts` if people will gather there. Both the scene and the server pick it
up — the zone label, the ambience, the occupancy count and the venue validation are all
driven from that one entry.

### Add a building

1. Write a builder in `world/props/buildings.ts` (or `structures.ts`), returning a
   `THREE.Group` whose **origin is at its base centre** so it can be dropped on the
   terrain with one height lookup.
2. Add its name to the `Landmark['kind']` union in `world.ts`.
3. Add a `case` to `createLandmark`.
4. Add one or more entries to `LANDMARKS`.

Budget: under ~600 triangles per building, merged per material.

### Add a species of plant

Add a builder taking a `seed: number` to `world/props/nature.ts`, then an entry to
`SPECIES` in `world/scatter.ts` describing where it may grow — altitude band, maximum
slope, clearance from the path and from gathering pads, scale range, and whether it casts
shadows. Placement rules are declarative; you are describing an ecology, not a layout.

### Re-route the promenade

Edit the `PROMENADE` waypoint array in `terrain.ts`. The path carve, the paving colour,
the lantern spacing and the vegetation clearance all follow automatically.

### Change the whole island's vegetation

Change `SCATTER_SEED` in `scatter.ts`. Every tree, shrub, rock and grass tuft re-rolls,
identically for every player.
