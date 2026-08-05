# Performance

The target is 60 fps on a desktop and a steady 30 fps on a 2019 mid-range Android, with a
crowd of dozens visible, over cellular data. Everything below exists to hit that.

---

## 1. Budget

| | `low` | `medium` | `high` |
|---|---|---|---|
| Max pixel ratio | 1.0 | 1.5 | 2.0 |
| Min pixel ratio | 0.6 | 0.75 | 0.9 |
| Shadows | off | 1024² | 2048² |
| Terrain grid | 160² (~26 k verts) | 240² (~58 k) | 400² (~160 k) |
| Scatter instances | ~3 200 | ~9 000 | ~18 500 |
| Draw distance | 240 m | 400 m | 700 m |
| Animated water | no | yes | yes |
| Detailed characters | 12 | 28 | 60 |
| Contour pass | on (thicker line) | on | on |
| Paper grain | reduced | full | full |

Tier is chosen at boot from device memory, core count and pointer coarseness. It sets
scene **content**, which cannot be changed cheaply mid-session; adaptive resolution then
absorbs everything else.

---

## 2. Adaptive resolution

Resolution is the only knob that can be turned every frame for free, so it carries all the
runtime variance.

```
measure frame time (EMA, α = 0.06)
  ├─ avg > target × 1.35  →  drop DPR by 0.15
  ├─ avg < target × 0.80  →  raise DPR by 0.10
  └─ stable for 180 frames →  settle, stop adjusting
```

Three details that matter more than the loop itself:

- **Asymmetric thresholds.** We drop readily (a stuttering world is unpleasant
  immediately) and raise reluctantly (a resolution that climbs then falls back is worse
  than one that stayed put).
- **It settles.** After about three seconds of stability the controller stops for the rest
  of the session. A resolution that keeps breathing is more distracting than one that is
  slightly too low.
- **Oscillation detection.** A device sitting exactly on the boundary between two ratios
  would flip forever; after three direction changes the controller drops to the lower
  ratio and settles there.

A 45-frame warm-up is skipped entirely, because the first frames are dominated by shader
compilation and first-use uploads and would push every device to its floor. Frames longer
than 500 ms are ignored as stalls rather than treated as slow rendering.

---

## 3. Draw calls

The whole island is a few hundred draw calls. The techniques, in order of how much they
buy:

| Technique | Where | Effect |
|---|---|---|
| **Instancing** | `scatter.ts` | 18 500 boulders, tufts and driftwood → 4 `InstancedMesh` calls. |
| **Geometry merging** | `scatter.ts`, `props/geometry.ts` | Each prototype's meshes are flattened and merged per material before instancing; each building collapses to one mesh per material. |
| **Shared materials** | `materials.ts` | Cached by key. Material *identity* is what makes merging possible at all. |
| **Bucket culling** | `island.ts` | Landmarks grouped by zone with one bounding sphere each. One distance test hides the whole harbour from the lighthouse. |
| **Single terrain mesh** | `island.ts` | One vertex-coloured mesh, one material, no textures. |

`frustumCulled = false` is set deliberately on the terrain, the ocean and the scatter
meshes: each spans the whole island, so their bounding spheres cover the camera and the
cull test can only ever produce a wrong answer while still costing time.

---

## 4. Characters

Two mechanisms keep a crowd affordable:

**Ranked LOD.** The nearest *N* characters animate; the rest hold a pose. Cost is capped
by *N*, not by population — an eighty-person plaza costs the same as a twenty-person one.
This is what makes "the world should feel populated" affordable at all.

**Distance detail.** Past 55 m, faces and accessories are hidden and the animation update
is skipped entirely. Past 320 m, characters are not drawn. Interpolation still runs for
everyone, or distant players would teleport on re-entering detail range.

Procedural rigs help twice over: no skinning cost per instance, and no download.

---

## 5. Network

| Measure | Effect |
|---|---|
| Packed transforms | 120 players: ~3 KB/s per client, against ~60 KB/s as JSON objects. |
| Stable roster | `ids` re-sent only on membership change; quiet ticks carry integers only. |
| Movement dead-band | No send below 2 cm / 0.6°. On a plaza where most people are watching, this removes ~⅔ of upstream traffic. |
| Keep-alive | Every 2 s regardless, so late joiners learn about stationary players. |
| `permessage-deflate` | Compresses runs of similar integers very well. |
| Backpressure policy | Movement deltas dropped when a socket backs up; activity, announcement and roster frames never. |

Interpolation delay is 200 ms — two ticks of slack, so there are always two real samples
to interpolate between. We never extrapolate: it looks better for 100 ms and then snaps,
and in a calm world a visible snap costs more than an invisible delay.

---

## 6. Load time

| Phase | `high` tier |
|---|---|
| Terrain meshing (worker) | ~400–700 ms |
| Landmarks (126 props) | ~300 ms, yielding every 8 props |
| Roadside lanterns (67) | ~70 ms |
| Scatter placement + merge | ~350 ms |

Two things keep this from feeling like a freeze:

- **Terrain meshes in a Web Worker.** ~160 000 `heightAt` evaluations at the `high` tier
  is comfortably enough to drop frames, and it happens exactly when the player is staring
  at a loading screen forming an opinion about whether this world is worth their time.
- **Everything else yields.** Landmarks build in batches of eight with a frame between
  them, so the loader keeps animating instead of freezing at 60%.

Network payload is the JS bundle only — `three` in its own long-lived chunk, plus the app.
There is no art to download.

---

## 7. Mobile specifics

- **Touch input** is split by screen half: a floating virtual stick wherever your left
  thumb lands, camera orbit on the right. No on-screen furniture until you touch.
- **FOV widens on tall viewports** (50° → 62°), or portrait would crop the world badly.
- **`ResizeObserver`, not `window.onresize`**, because the iOS URL bar collapsing does not
  reliably fire `resize`.
- **Hidden tabs skip the whole frame.** A backgrounded tab's rAF is throttled to ~1 Hz;
  rendering that frame is pointless and the huge `dt` would launch the character into
  orbit.
- **Antialiasing is off.** The drawn look tolerates the softness adaptive DPR introduces far
  better than it tolerates a halved frame rate.
- **Memory.** No textures beyond a 256² bathymetry bake and the two half-float
  render targets the contour pass needs (16 bytes per pixel in total), plus small
  per-name label canvases. The scene's GPU footprint is geometry and nothing else.

---

## 8. Measuring

The debug readout (toggled in settings) reports FPS, draw calls, triangles, the current
adaptive pixel ratio and the scatter instance count. Boot logs a one-line build summary:

```
[nagisa] island built — terrain 152ms, 126 landmarks, 18447 scattered instances
```

Server-side, `GET /metrics` exposes Prometheus text: connections, messages in/out by type,
tick duration percentiles, room populations and error counts. Tick duration is the number
to watch — if p99 approaches the 100 ms tick interval, the room is overloaded and the
answer is more shards, not a longer tick.

---

## 9. If you need more headroom

In rough order of return on effort:

1. **Raise `INTERPOLATION_DELAY_MS`** before anything else if remote motion looks rough on
   bad connections. It costs nothing and fixes most of it.
2. **Lower `maxDetailedCharacters`.** Crowd animation is the largest per-frame CPU cost at
   high population.
3. **Reduce `terrainResolution`.** Quadratic, and the flat shading hides a surprising
   amount of tessellation loss.
4. **Drop `scatterDensity`.** Cheap and visually costly — do this after the terrain.
5. **Turn off shadows.** The single most expensive feature, but the island loses a lot of
   its form without them; prefer a smaller shadow map first.
6. **Add room shards.** Anything above ~150 players per room is better solved by sharding
   than by optimising.
