# Architecture

How Nagisa is put together, and why.

---

## 1. The shape of the system

```
                    ┌──────────────────────────────────────────┐
   Browser          │              @nagisa/client              │
                    │                                          │
                    │  ui/ (Svelte)                            │
                    │      ▲ reads stores · calls commands     │
                    │      │                                   │
                    │  state/stores.ts   ← the only boundary   │
                    │      ▲                                   │
                    │      │                                   │
                    │  app.ts (composition root)               │
                    │   ├── engine/   renderer, camera, quality│
                    │   ├── world/    island, sea, sky, props  │
                    │   ├── character/ local, remote, tags     │
                    │   ├── input/    kb · mouse · touch · pad │
                    │   ├── audio/    synthesised ambience     │
                    │   └── net/      connection, world-sync   │
                    └───────────────────┬──────────────────────┘
                                        │  one WebSocket
                                        │  JSON frames, packed movement
                    ┌───────────────────┴──────────────────────┐
   Node             │              @nagisa/server              │
                    │                                          │
                    │  http.ts  ── health · metrics · static    │
                    │  session.ts ── rate limits · backpressure │
                    │  handlers.ts ── validate every message    │
                    │  rooms.ts → room.ts (tick loop)           │
                    │       ├── players     transforms, zones   │
                    │       ├── activities  lifecycle, rosters  │
                    │       └── announcements                   │
                    │  permissions.ts · resume.ts · audit.ts    │
                    │  persistence.ts ── Store interface        │
                    └──────────────────────────────────────────┘
                                        ▲
                    ┌───────────────────┴──────────────────────┐
                    │              @nagisa/shared              │
                    │  protocol · terrain · world · tokens     │
                    │  (pure TS — browser, Node and worker)    │
                    └──────────────────────────────────────────┘
```

The load-bearing idea is the bottom box. `@nagisa/shared` is not a utility grab-bag; it
is the **contract**, and it is deliberately platform-free so that both sides can execute
the *same* code rather than two implementations that agree by convention.

Three things follow from that, and each removes a whole category of bug:

- The server validates your position against `heightAt(x, z)` — literally the function
  whose output the client meshed into the ground you are standing on. There is no
  collision mesh to export, no server-side navmesh to keep in sync, and no possibility of
  the two drifting apart.
- Zones, venues, roles and activity templates have exactly one definition. Adding a place
  to the island is one entry in `world.ts`, and both the scene and the permission system
  learn about it at once.
- The palette is shared between the DOM overlay and the 3D scene, so the interface is
  tinted by the same values that light the island.

---

## 2. Client

### 2.1 Frame loop

`engine/renderer.ts` owns the loop and everything else subscribes to it. Two clocks:

- **Fixed step, 60 Hz** (`fixedUpdate`) — character physics and anything else that must
  behave identically on a 30 fps phone and a 144 Hz monitor. Without this, movement speed
  becomes a function of frame rate, which is the oldest bug in browser games.
- **Per frame** (`update`) — camera, interpolation, animation blending, shader time.

An accumulator carries the remainder between frames, capped at five steps so that a
stall (alt-tab, a garbage collection pause) does not cause the simulation to try to
catch up three seconds of movement in one frame.

### 2.2 Quality and adaptive resolution

A browser has no hardware survey, so:

1. A **static tier** (`low` / `medium` / `high`) is guessed at boot from device memory,
   core count and pointer coarseness. It sets scene *content* — terrain mesh density,
   vegetation counts, shadows, draw distance — because content cannot be changed mid-run
   without a visible rebuild.
2. **Adaptive DPR** then absorbs all remaining variance, because resolution is the one
   knob that can be turned every frame for free.

The adaptive controller deliberately **settles**: once it has held a stable resolution
for about three seconds it stops adjusting for the rest of the session. A resolution that
keeps breathing is more distracting than one that is slightly too low. It also detects
oscillation — a device sitting exactly on the boundary between two ratios — and settles
at the lower one rather than flickering.

### 2.3 The world

`world/island.ts` assembles the scene in a specific order, yielding to the browser
between batches so the loader keeps animating:

1. **Terrain** — meshed from `heightAt` in a Web Worker (~160 000 vertex evaluations at
   the `high` tier). Vertex colours encode the material logic, layered in the order a
   landscape actually forms: altitude bands give sand → grass → upland, slope overrides
   them with rock because a steep face is bare rock whatever its height, paved terraces
   override that, and the roads override everything.
2. **Landmarks** — the 126 hand-placed buildings and structures from `world.ts`, each
   dropped onto the terrain by a single height lookup and grouped into **zone buckets**.
   Waterfront kinds (piers, boats, breakwaters, sea torii) are placed at sea level
   instead; see `docs/WORLD.md` §4.
3. **Roadside props** — 67 lanterns placed by arc length along the four paths, so they
   stay evenly spaced however a road is re-routed.
4. **Scatter** — 18 500 instanced boulders, grass tufts and driftwood in 4 draw calls,
   placed by rejection sampling against the terrain field.

Culling is **bucket-level**: one distance test hides the entire south harbour when you are
at the lighthouse, instead of Three.js frustum-testing forty objects every frame. Three's
own culling still runs on what remains.

The renderer itself is documented separately in [RENDERING.md](RENDERING.md) — the contour
pass, the material model and the three precision traps it invites are enough material to
need their own page.

### 2.4 Characters

Characters are built from primitives and animated procedurally — no rigged GLB, no
`AnimationMixer`. A skinned character with baked clips would cost 1–3 MB and a skinning
pass per instance; procedural articulation costs zero bytes and blends between states by
interpolating six numbers. The trade is that subtle motion is impossible, which suits an
art direction that is readable at fifty metres and simple up close.

Level of detail is applied **by rank, not by distance**: the nearest *N* characters
animate and the rest hold a pose. That keeps the cost of a crowd flat — an eighty-person
plaza costs the same as a twenty-person one — which is what makes "the world should feel
populated" affordable on a phone.

### 2.5 The engine ↔ interface boundary

`state/stores.ts` is the only thing both halves import. Components never touch a
`THREE.Scene`; engine modules never import a component. The interface acts through a
`WorldCommands` object whose real implementations are registered by `app.ts` at boot.

This costs a little ceremony and buys three things: the interface can be rebuilt or
removed without touching the world, the world runs headless in tests, and every piece of
state the interface *can* show is enumerated in one file — which is the main thing
keeping a "small, restrained" UI from quietly accreting panels.

---

## 3. Server

### 3.1 Room tick

Each `Room` runs a fixed 10 Hz tick:

1. Collect players whose transform changed since the last tick.
2. Pack them into a flat integer array (`PackedTransforms`).
3. Assemble a `ServerDelta` with that array plus any activity, announcement, join/leave
   or emote events from the tick.
4. Broadcast, and push the delta into a ring buffer for replay-on-reconnect.

Everything the room does is **event-sourced into deltas**, which is what makes
reconnection and resync simple: there is exactly one way state reaches a client.

### 3.2 Why transforms are packed

At 120 players, a JSON array of transform objects is ~60 KB/s per client. The same data
as six integers per player — index, x·100, y·100, z·100, yaw·1024, anim — is ~3 KB/s
after `permessage-deflate`, a 20× reduction for about thirty lines of code.

The index refers to a **roster** that is re-sent only when room membership changes, so
quiet ticks carry integers and nothing else. Roster stability is therefore load-bearing
and is covered by tests: an index that shifts under a client mid-flight would attribute
one player's movement to another.

### 3.3 Movement authority

Movement is the deliberate exception to server authority. The client predicts locally and
reports at 10 Hz; the server clamps against a speed budget and the island's walkable
bounds, and issues a hard `correction` when a report fails.

This is the right trade *for this product*. Full server-authoritative movement with
reconciliation would cost 100–200 ms of input lag on a transatlantic connection to defend
against a threat model — speed-hacking in a world with no competition and nothing to win
— that barely exists. What the server does enforce is that everyone is on the island and
moving plausibly, which is all that is needed for the shared space to stay coherent.

### 3.4 Sessions, resume and the grace window

A disconnect does not immediately remove you. Your player stays in the room marked
`away: true` for `SESSION_GRACE_MS` (45 s), fading rather than vanishing for everyone
else, and a reconnect within that window restores your identity, role and activity
attachment via a signed resume token.

This exists because the target device is a phone: screen lock, a tunnel, a network
handover. A world you cannot briefly leave is a world you cannot use on a train.

### 3.5 Backpressure

`session.ts` classifies outbound frames. When a socket's `bufferedAmount` climbs — a slow
connection, a backgrounded tab — movement deltas are **dropped**, because a stale position
has no value, while activity, announcement and roster frames are **never** dropped,
because missing one leaves the client permanently wrong. Without this distinction a slow
client either desyncs silently or forces the server to buffer without bound.

---

## 4. Failure behaviour

| Failure | What happens |
|---|---|
| Client loses network | Backoff reconnect with jitter, forever, plus an immediate retry when `online` fires or the tab is foregrounded. Session resumes if within the grace window. |
| Client misses a delta tick | Gap detected by tick number; client requests `resync` and is re-snapshotted. Debounced, because one gap usually means several. |
| Terrain worker unavailable or fails | Falls back to meshing on the main thread. Slower, still correct. Some embedded WebViews and strict CSP setups block module workers. |
| A prop generator throws | That one landmark is skipped and logged. The island still builds. |
| WebGL context lost | Detected, explained to the player, and the page reloads on restore. |
| Server restarts | Activities, announcements and check-ins reload from the store. Clients reconnect with backoff and jitter, so they do not all return at once. |
| A handler throws | Caught per message. One player's bad input cannot affect the tick loop or another player's connection. |

---

## 5. What is deliberately not here

- **No ECS.** The entity count is in the hundreds and the behaviours are few. An ECS
  would add indirection without buying anything at this scale.
- **No physics engine.** The ground is an analytic function; a ground query is one call.
  Rigid-body physics would be a large dependency for a world in which nothing is thrown.
- **No state-management library.** Svelte stores plus one command object are sufficient,
  and the boundary is small enough to read in one sitting.
- **No REST API in the hot path.** Everything real-time is on the socket. The HTTP surface
  is health, metrics, a room list and static files.
- **No rigged character assets, no textures, no audio files.** See
  [`WORLD.md`](WORLD.md) § Asset strategy.
