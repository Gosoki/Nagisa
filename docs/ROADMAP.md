# MVP scope and roadmap

---

## 1. What is built

Everything below is implemented, typechecked and covered by an automated test.

### World
- One Japanese island, ~340 × 300 m, generated entirely from code.
- Ten zones: harbour, main plaza, notice board, old street, teahouse, shrine path,
  summit, lighthouse cape, sunset beach, north and south harbours, and a 1 289 m coast
  road looping the island with three graded lanes climbing to the summit.
- 40 hand-placed landmarks (6 336 triangles total) — piers, boats, warehouses, torii,
  machiya, minka, a teahouse, a shrine hall, a lighthouse, stages, gates, rails, a notice
  board — from a procedural prop library covering all 16 landmark kinds.
- 18 567 instanced scattered props across 4 draw calls: boulders, grass tufts, driftwood,
  grass and rocks, placed by rejection sampling against the terrain.
- Custom sea shader with baked bathymetry driving depth colour and shoreline foam.
- Sky dome and a three-light rig on a 90-minute day/night cycle, synchronised to server
  time so everyone shares the same dusk.
- Synthesised per-zone ambience, six families, crossfaded on zone change.

### Multiplayer
- Server-authoritative rooms with 10 Hz snapshot/delta synchronisation.
- Packed integer transforms: ~3 KB/s per client at 120 players.
- Client-predicted movement with server speed/bounds validation and hard corrections.
- Remote-player interpolation at a 200 ms delay, with animation recovered from observed
  motion so legs never skate.
- Presence, emotes, name tags, per-zone occupancy.
- Reconnection with signed resume tokens and a 45-second grace window; disconnected
  players fade rather than vanish.
- Room shards with population-biased matchmaking.

### Activities
- Six activity templates across five venues.
- Full lifecycle (`scheduled → open → live → ended` / `cancelled`) with server-validated
  transitions and automatic scheduling.
- Participant and audience modes, capacity enforcement, ring-based crowd placement.
- Check-in with arrival ordinals, accepted only while live and only once.
- Announcements scoped to an activity, a zone or the island, gated by role.
- Four ordered roles with a pure-function permission layer and an append-only audit log.

### Client engineering
- Three quality tiers plus a settling adaptive-resolution controller.
- Fixed-step simulation at 60 Hz, decoupled from render rate.
- Worker-based terrain meshing with a main-thread fallback.
- Zone-bucket distance culling; ranked character LOD.
- Keyboard, mouse, touch (floating virtual stick) and gamepad input.
- Total payload: **~188 KB gzipped**, with no art assets of any kind.

### Server engineering
- Zero runtime dependencies beyond `ws`.
- Structured JSON logging, Prometheus metrics, health and readiness endpoints.
- Per-connection token-bucket rate limits and classified backpressure.
- Pluggable persistence (`Store` interface, JSON-file and in-memory implementations).
- Graceful shutdown; static client serving from the same origin.

### Verification
- 28 server unit tests (`node:test`).
- 26 headless world-generation checks — terrain finiteness and determinism, zone/pad/spawn
  correctness, mesh integrity, all landmarks, scatter determinism, every character variant.
- 41 end-to-end checks against a real server over real WebSockets — handshake, movement
  sync, correction, jitter tolerance, the full activity lifecycle, permissions, admin
  announcements, emotes, reconnect-and-resume, resync, version rejection.

---

## 2. Deliberately not built

Each of these was considered and left out on purpose. They are listed so nobody has to
guess whether they were forgotten.

| Not built | Why |
|---|---|
| **Text chat** | Nagisa is not a chat application. A one-line speech bubble exists in the protocol and is rate-limited to 1/s; a chat log, history and moderation queue would change what the product is. |
| **Voice** | Would dominate the atmosphere and require a media server, TURN infrastructure and a much larger moderation commitment. |
| **Accounts and persistence of identity** | You are whoever you say you are, for as long as your session lasts. Adding accounts adds a password reset flow, a privacy policy and a data-deletion obligation — for a world you visit for twenty minutes. |
| **An admin dashboard** | Explicitly out of scope. Hosts run events from inside the world, standing on the stage. |
| **Fast travel** | The island is small enough to cross in ninety seconds, and the crossing is the product. |
| **Inventory, currency, progression** | There is nothing to win here, and adding a scoreboard would change the register completely. |
| **User-generated building** | A large feature that needs its own permission model, moderation story and persistence layer. |
| **Cross-process room sharding** | Not needed below several hundred concurrent players. The path is documented in [`OPERATIONS.md`](OPERATIONS.md) § Scaling. |

---

## 3. Known limitations

Honest list of what is imperfect today.

1. **Persisted state is not partitioned by room.** On restart, all shards' schedules
   consolidate onto the first room. Nothing is lost; activities are re-homed. Fine for the
   default single-shard deployment, wrong for a large one.
2. **Announcement fan-out is unfiltered.** Scope governs who may *create* an announcement
   and how the client presents it, not server-side delivery filtering. Every session
   receives every announcement's existence. Harmless at current scale; it should become a
   real filter before island-wide traffic grows.
3. **Quality tier changes take effect on next load.** Tier controls scene content, which
   cannot be rebuilt in place without a visible hitch. The interface says so rather than
   pretending otherwise.
4. **No visual regression testing.** The world generation is verified numerically
   (finiteness, determinism, budgets), but nothing checks that the island *looks* right.
   A screenshot-diff harness would need a GPU-capable CI runner.
5. **Character animation is coarse.** Procedural cycles cannot express subtle motion. This
   is the accepted cost of shipping no rigged assets.
6. **`chat` is defined in the protocol but has no interface surface.** The server accepts
   and broadcasts it; no component renders it yet.

---

## 4. Roadmap

### Blocked on modelling — environment interaction

Agreed with the author 2026-08-08: **the models come first.** These three are wanted, and
none of them starts until the prop and building geometry is where the author wants it. Recorded
here so the reasoning is not lost, not as a queue to start on.

The finding that prompted them: of the island's twelve interactables, **six press and
nothing happens** — the four `Ring` bells and the two `Look` viewpoints, all
`effect: 'none'`. (The four `Sit`s do work: `kind: 'sit'` drives the animation through the
packed-transform channel, independently of `effect`. `Check in` and `Read` work too.) The
island is dense and beautiful and, at the moment you touch it, inert. That is what "有点
单调" means here — not a shortage of content.

- **Ring the bell, and have it ring.** The strongest of the three, and the smallest: one new
  effect plus a zone broadcast, a swinging clapper and a sound. Its value is not the sound —
  it is that ringing is the only channel besides chat where *one player's action is
  perceived by another*. Chat is text about the world; a bell is the world answering. Four
  bells already stand in four different places, and their prompts all reach them as of
  `0e88f18`. Expect it to grow its own uses: greeting, gathering, marking dusk.
- **Give the two `Look` viewpoints something to look at.** The lighthouse door and the
  summit rail are the island's two vantage points and both are silent.
- **Let the notice board be written to.** It can be read; it cannot be signed. A short line
  that survives a restart is the cheapest possible "somebody was here", and the persistence
  layer already exists. The world currently resets to nobody-has-ever-been-here.

### Near term — finish what is started
- **Announcement scope filtering** server-side (limitation 2).
- **Room-partitioned persistence** (limitation 1).
- **Speech bubbles** — render the `chat` frames the protocol already carries, as
  short-lived bubbles above characters. Small, and it completes an existing path.
- **Procession formation** — `ACTIVITY_TEMPLATES` declares `formation: 'procession'` for
  the Lantern Walk, and crowd placement currently treats it as `gather`. Implementing
  followers-behind-host would make the shrine walk read properly.
- **Seat occupancy** — sitting is broadcast, but two players can currently sit on the same
  mat. Reserve seats server-side.

### Medium term — deepen the world
- **Weather**, shared like the day cycle: rain on the sea, mist on the mountain. Uses the
  same server-time mechanism, so it costs nothing in protocol terms.
- **Interior spaces** — the shrine hall and the teahouse are currently solid. Making two of
  them enterable would add somewhere to be when it rains.
- **A second island**, reached by the boats already moored at the harbour, as a real test
  of the room/zone abstractions.
- **Spectator camera for hosts** — a free camera while running an event, without leaving
  the world.
- **Recorded events** — replay a delta stream. The ring buffer and tick numbering already
  make this straightforward.

### Longer term — scale and openness
- **Cross-process sharding** with sticky routing and a Redis store.
- **Regional deployments**, with the room list surfacing latency.
- **Optional GLB assets** for hero props, loaded through the existing `createLandmark`
  dispatch — worth doing for a handful of landmarks once there is an artist, without
  abandoning generation for the bulk of the island.
- **An embeddable mode** — the island in an iframe with a reduced interface, for events
  hosted on someone else's page.

---

## 5. Ordering principle

The roadmap is ordered by a single rule: **nothing may make the island noisier**.

Features that add presence, weather, places to be and reasons to stay come before features
that add information, controls and notifications. When a proposed feature would require a
new persistent interface element, that is a strong signal it belongs to a different
product.
