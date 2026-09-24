# Architecture

How Nagisa is put together, and why.

---

## 1. The shape of the system

```
                    ┌──────────────────────────────────────────┐
   Browser          │              @nagisa/client              │
                    │                                          │
                    │  ui/ (Svelte)          i18n/ zh · ja · en│
                    │      ▲ reads stores · calls commands     │
                    │      │                                   │
                    │  state/stores.ts   ← the only boundary   │
                    │      ▲                                   │
                    │      │                                   │
                    │  app.ts (composition root)               │
                    │   ├── engine/   renderer, camera, quality│
                    │   ├── world/    island, sea, sky, props  │
                    │   ├── character/ local, remote, tags,    │
                    │   │              bubbles                 │
                    │   ├── fx/       the games in the world   │
                    │   ├── input/    kb · mouse · touch · pad │
                    │   ├── audio/    synthesised ambience     │
                    │   └── net/      connection, world-sync,  │
                    │                 visitor key, last pose   │
                    └───────────────────┬──────────────────────┘
                                        │  one WebSocket
                                        │  JSON frames, packed movement,
                                        │  permessage-deflate
                    ┌───────────────────┴──────────────────────┐
   Node             │              @nagisa/server              │
                    │                                          │
                    │  http.ts  ── health · metrics · static   │
                    │  session.ts ── rate limits · backpressure│
                    │  handlers.ts ── validate every message   │
                    │  rooms.ts ── public shards · private     │
                    │              islands · sleep · registry  │
                    │    └→ room.ts (tick loop)                │
                    │         ├── players   transforms, seats  │
                    │         ├── activities + schedule.ts     │
                    │         ├── games/    behind GameRoom    │
                    │         └── announcements, guestbook     │
                    │  permissions.ts · resume.ts · audit.ts   │
                    │  games/profiles.ts ── visitor profiles   │
                    │  persistence.ts ── Store interface       │
                    └──────────────────────────────────────────┘
                                        ▲
                    ┌───────────────────┴──────────────────────┐
                    │              @nagisa/shared              │
                    │  protocol · terrain · movement · world   │
                    │  map packs · games (tables, island clock)│
                    │  tokens                                  │
                    │  (pure TS — browser, Node and worker)    │
                    └──────────────────────────────────────────┘
```

The load-bearing idea is the bottom box. `@nagisa/shared` is not a utility grab-bag; it
is the **contract**, and it is deliberately platform-free so that both sides can execute
the *same* code rather than two implementations that agree by convention.

Four things follow from that, and each removes a whole category of bug:

- The server validates your position against `heightAt(x, z)` — literally the function
  whose output the client meshed into the ground you are standing on. There is no
  collision mesh to export, no server-side navmesh to keep in sync, and no possibility of
  the two drifting apart.
- Zones, venues, interactables, activity templates and the programme have exactly one
  definition, in the map pack. Adding a place or a game spot to the island is data in
  `maps/nagisa-island.ts`, and the scene, the server's reach checks and the permission
  system learn about it at once.
- The games' tables — fish, fortunes, badges, the quiz bank — and the island clock are
  shared. The server rolls a catch from the table the client draws the fish book from, and
  the scheduler puts the lamp lighting at the dusk the sky shows, because both read the same
  `islandTimeOfDay`.
- The palette is shared between the DOM overlay and the 3D scene, so the interface is
  tinted by the same values that light the island.

---

## 2. Client

### 2.1 Frame loop

`engine/renderer.ts` owns the loop and everything else subscribes to it. Two clocks:

- **Fixed step, 60 Hz** (`fixedUpdate`) — character physics and anything else that must
  behave identically on a 30 fps phone and a 144 Hz monitor. Without this, movement speed
  becomes a function of frame rate, which is the oldest bug in browser games.
- **Per frame** (`update`) — camera, interpolation, animation blending, effects, shader
  time.

An accumulator carries the remainder between frames, capped at five steps so that a
stall (alt-tab, a garbage collection pause) does not cause the simulation to try to
catch up three seconds of movement in one frame.

### 2.2 Quality and adaptive resolution

A browser has no hardware survey, so:

1. A **static tier** (`low` / `medium` / `high`) is guessed at boot from device memory,
   core count and pointer coarseness. It sets scene *content* — terrain mesh density,
   scatter density, shadows, draw distance, roadside lantern spacing — because content
   cannot be changed mid-run without a visible rebuild.
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

1. **Terrain** — meshed from `heightAt` in a Web Worker. Vertex colours encode the
   material logic, layered in the order a landscape actually forms: altitude bands give
   sand → grass → upland, slope overrides them with rock because a steep face is bare rock
   whatever its height, paved terraces override that, and the roads override everything.
2. **Landmarks** — the 134 hand-placed buildings, structures and furniture of the map pack,
   each dropped onto the terrain by a single height lookup and grouped into **zone
   buckets**. Waterfront kinds (piers, boats, breakwaters, sea torii) are placed at sea
   level instead; see `docs/WORLD.md` §4.
3. **Roadside props** — lanterns placed by arc length along the routes (every 21 m, or 34 m
   on the low tier), so they stay evenly spaced however a road is re-routed.
4. **Scatter** — instanced boulders, grass tufts and driftwood, one draw call per species,
   placed by rejection sampling against the terrain field.

Culling is **bucket-level**: one distance test hides the entire south harbour when you are
at the lighthouse, instead of Three.js frustum-testing forty objects every frame. Three's
own culling still runs on what remains.

The renderer itself is documented separately in [RENDERING.md](RENDERING.md) — the contour
pass, the material model and the precision traps it invites are enough material to need
their own page.

### 2.4 Characters

Characters are built from primitives and animated procedurally — no rigged GLB, no
`AnimationMixer`. A skinned character with baked clips would cost 1–3 MB and a skinning
pass per instance; procedural articulation costs zero bytes and blends between states by
interpolating six numbers. The trade is that subtle motion is impossible, which suits an
art direction that is readable at fifty metres and simple up close. A character can hold
a prop in its hand — a rod, a paper lantern, an umbrella in the rain — which is how the
games put things on people.

Level of detail is applied **by rank, not by distance**: the nearest *N* characters
animate and the rest hold a pose. That keeps the cost of a crowd flat — an eighty-person
plaza costs the same as a twenty-person one — which is what makes "the world should feel
populated" affordable on a phone.

Speech bubbles (`character/speech.ts`) are the chat log's other half. The log is the
record; the bubble is the attribution — it puts the words on the body, so a plaza with six
people talking reads as six conversations. Bubbles are drawn by the name-tag layer, which
already pools sprites and ranks them by distance.

### 2.5 The effects layer

`fx/` is everything the games put *in the world* rather than on the interface: a bell's
note carrying across the water and ink rings spreading from its tower, fireworks over the bay, a float off the
pier and a fish leaping out of the splash, the ○× circles painted on the plaza, lanterns
carried up the shrine path, the concert on the beach, the lighthouse beam, emote glyphs.

The app owns one `GameFx`. It hands it the world events from each delta and calls `update`
once a frame; the effects read everything else — the quiz, the activities, your own line —
straight from the stores, the same way the interface does. What an effect may ask of the
rest of the client is one narrow interface, `FxHost` (the scene, the camera, the quality
tier, where a player is, a player's rig, the server clock, and the sound bus), so no effect
imports the app.

One module per thing the island does — `bells`, `fireworks`, `fishing`, `quiz-arena`,
`emotes`, `lanterns`, `lighthouse`, `music`, `rain`, `fireflies`, `mist`, `digs`, `daruma` — over two shared
ones:

- **`materials`** — how an effect is drawn through the ink pipeline without disturbing it.
  A spark, a beam and a halo are light, not surfaces; they must not be outlined and must
  not disturb the outlines of what is behind them, so they write nothing the contour pass
  reads (see the file's header for the blend factors that make that true).
- **`audio`** — how a sound is placed: a gain for distance, a pan for bearing, a low-pass
  for the air, all synthesised and all through the ambience's master bus, so mute and volume
  apply and no effect ever creates an audio context of its own.

Calm is a budget here as everywhere: pools sized by tier, motion in shaders, no allocation
in the per-frame path, and nothing that flashes.

### 2.6 Language

`i18n/` holds three flat dictionaries — `core.ts` for the interface's furniture, `games.ts`
for everything the games say — and a `t` store of the translate function, so a language
change re-renders everything at once without a reload. A missing key falls back to English,
then to the key itself, so a gap shows up as a readable word rather than a blank;
`ui-games-smoke` fails when the three languages do not hold the same keys and placeholders,
in `core.ts` and `games.ts` alike.

World data is not duplicated there. Zone names and captions, activity titles, fish,
badges, fortunes and quiz statements are authored in the shared package with their
translations beside them, and `i18n/index.ts` only picks the field. Server refusals arrive
as a `key` and `params` (see [PROTOCOL.md](PROTOCOL.md) §11) and are said in the player's
language as `error.<key>`.

### 2.7 The engine ↔ interface boundary

`state/stores.ts` is the only thing both halves import. Components never touch a
`THREE.Scene`; engine modules never import a component. The interface acts through a
`WorldCommands` object whose real implementations are registered by `app.ts` at boot.

This costs a little ceremony and buys three things: the interface can be rebuilt or
removed without touching the world, the world runs headless in tests, and every piece of
state the interface *can* show is enumerated in one file — which is the main thing
keeping a "small, restrained" UI from quietly accreting panels. It is also why every game
card can be mounted and driven through every state in jsdom with no renderer at all.

---

## 3. Server

### 3.1 Room tick

Each awake `Room` runs a fixed 10 Hz tick:

1. **Advance** everything that moves by itself: once a second, put the programme's next
   slots on the board (`schedule.ts`); sweep every activity's lifecycle; tick the games —
   bites, duels, the quiz's and the race's phases, the fireworks show; expire announcements.
2. **Gather** whatever changed into one `ServerDelta`: joins and leaves, player field
   changes, activities, announcements, emotes, chat, world events, guestbook lines, the
   quiz and race views, zone populations, and the packed transforms of whoever moved.
3. **Record** it in a ring buffer for replay-on-reconnect.
4. **Broadcast** it — encoded to JSON **once**, and the same string handed to every
   session. At 10 Hz, stringifying the same object for each of a hundred sessions was most
   of the tick's CPU.

Everything *shared* reaches clients one way — through deltas — which is what makes
reconnection and resync simple. What is private to one player (their fishing line, their
omikuji slip, their side of a duel, a whisper, their profile) is sent to that session
directly and is not replayed.

### 3.2 Why transforms are packed

At 120 players, a JSON array of transform objects would be ~60 KB/s per client before
compression. The same data goes as six integers per player — index, x·100, y·100, z·100,
yaw·1024, anim — for about thirty lines of code, and runs of similar integers are what
`permessage-deflate` compresses best. Measured (`npm run test:load`, OPERATIONS.md §6), a
visitor in a full shard of 108 receives ~29 KB/s decoded and ~8.6 KB/s on the wire — and
that is everything the server sends them, not the transforms alone.

The index refers to a **roster** that is re-sent only when room membership changes, so
quiet ticks carry integers and nothing else. Roster stability is therefore load-bearing
and is covered by tests: an index that shifts under a client mid-flight would attribute
one player's movement to another.

### 3.3 Movement authority

Movement is the deliberate exception to server authority. The client predicts locally and
reports at 10 Hz; the server clamps against a speed budget and the island's walkable
ground, and issues a hard `correction` when a report fails.

This is the right trade *for this product*. Full server-authoritative movement with
reconciliation would cost 100–200 ms of input lag on a transatlantic connection to defend
against a threat model — speed-hacking in a world with nothing to win — that barely
exists. What the server does enforce is that everyone is on the island and moving
plausibly, which is all that is needed for the shared space to stay coherent.

The games lean on this. A quiz answer is read from each contestant's **last validated
position** — so it is exactly as trustworthy as the movement that carried the player there
— and every "are you close enough" check (a fishing spot, a stamp stand, a notice board, a
janken opponent) is measured against that same position.

### 3.4 Sessions, resume and the grace window

A disconnect does not immediately remove you. Your player stays in the room marked
`away: true` for `SESSION_GRACE_MS` (45 s), fading rather than vanishing for everyone
else, and a reconnect within that window restores your identity, role and activity
attachment via a signed resume token. What cannot wait for you does not: your fishing
line is reeled in, a duel is called off, your seat is freed.

Past the window, the client still brings two things back: the island it was on (its
invite code, in `hello.room`) and where it was standing (`hello.at`, re-derived by the
server through the walkability contract).

This exists because the target device is a phone: screen lock, a tunnel, a network
handover. A world you cannot briefly leave is a world you cannot use on a train.

### 3.5 Backpressure

`session.ts` classifies outbound frames. When a socket's `bufferedAmount` climbs past
256 KiB — a slow connection, a backgrounded tab — deltas carrying nothing but movement are
**dropped**, because a stale position has no value, while everything else is **never**
dropped, because missing a join, an event or a quiz phase leaves the client permanently
wrong. Without this distinction a slow client either desyncs silently or forces the server
to buffer without bound.

### 3.6 The games layer

The games live in `apps/server/src/games/` — `quiz.ts`, `daruma.ts` (だるまさんがころんだ),
`fishing.ts` (with the derby), `janken.ts`, `fireworks.ts`, `treasure.ts` (the treasure
hunt), `interactions.ts` (bells, omikuji, stamps, dice), `guestbook.ts`, `profiles.ts` and
`daily.ts` (today's tasks). Each is written against **`GameRoom`** (`games/context.ts`), not
against `Room`: a dozen methods — find a player, send one of them a message, refuse in their
language, emit a world event, patch a player's view, push or celebrate a profile, set the
quiz or race view, move a player by the game's decision (`relocate`), announce as the
island, ask for a save, and an injectable `random()`.

That narrow interface is the point. It keeps each game testable on its own
(`games.test.ts` drives every one through a room with a pinned random source), keeps the
import graph acyclic, and shows on one screen everything a game is able to do to the world.

`Room` implements `GameRoom`, owns one of each game, and tells them the things only it
knows: a player moved, left or dropped; an activity went live or ended. The games have no
timers of their own — a bite, a duel's deadline, a quiz phase are all checked against the
wall clock by the room's tick — so a player leaving costs a map delete, never a cancelled
timer.

The rule the games are written to is **the client asks, the server decides**: when the
fish bites, whether the strike was in time and what was on the line; which circle a
contestant stood in; which slip the shrine gave; both janken hands, held until both are in.

### 3.7 Rooms: public shards, private islands, sleep

`rooms.ts` holds two kinds of room:

- **Public shards** (`shore-N`), created at boot (`ROOM_COUNT`) and on demand when every
  shard is near full. Matchmaking fills them.
- **Private islands** (`isle-<CODE>`), created by `room_create`. The code is five
  characters from the system CSPRNG; the island's keeper is recorded by the hash of their
  visitor key. A **registry** (code → keeper hash, keeper name, island name, kick bans,
  created, last active) is persisted, so a code keeps meaning that island for as long as the
  registry remembers it.

A room nobody has been in for ten minutes is **put to sleep**: its tick stops, its state
(schedule, announcements, guestbook) moves into a dormant set that is persisted with
everything else, and it is dropped from memory. The first `ROOM_COUNT` public shards never
sleep, so there is always somewhere to arrive. A private island wakes when its code is next
used — a registered code the server is not holding simply re-opens the island, restored,
with the programme brought up to date before the first visitor's snapshot.

A code nobody registered opens nothing. Otherwise a script trying random codes would fill
the server with empty islands. For the same reason at most 200 private islands may be awake
at once; past that, a request to wake another is refused as `islands_busy`.

### 3.8 Persistence

What is worth keeping is small and low-churn, and it is kept **per room**:

```
PersistedState
├── rooms      { [roomId]: activities (with check-ins and slot keys),
│                          announcements still in their TTL, guestbook }
├── islands    the private-island registry
├── profiles   { [sha256(visitor key)]: stamps, fish book, badges, … }
└── audit      the admin action log
```

Awake rooms are exported fresh at each save; sleeping ones as they were. Everything
downstream talks to the `Store` interface (`load` / `save` / `flush`); `JsonFileStore`
writes the whole state atomically (temp file and rename), debounced and serialised, and
`MemoryStore` is the default when `PERSIST_PATH` is unset. `index.ts` coalesces the many
`persist()` calls games make — every catch, every stamp — into one build per second, and a
30 s heartbeat catches the scheduler's own changes. A v1 file, which held one consolidated
schedule, migrates onto `shore-1`, which is exactly where v1 put it back on restart.

Positions, emotes, chat, whispers, fishing lines, duels and quizzes in progress are
deliberately not persisted: restoring them would only give a restarted server stale,
misleading things to resume players into. Rosters are not persisted either — see §4.

### 3.9 Profiles and the visitor key

There are no accounts. A browser mints a random **visitor key** (`net/visitor.ts`,
`localStorage`), sends it in `hello`, and the server keys a **profile** by its SHA-256 —
the stamp card, the fish book, catches, badges and the badge being worn, today's omikuji,
janken and quiz wins, treasures dug up, today's tasks with the streak and the days done, and
friends. The key itself is never stored. Two tabs with the same key share one
record object, so they cannot disagree about the card. A visitor without a usable key still
gets a profile for the session; only the keeping depends on the key.

The same hash is what makes the maker of a private island its keeper when they come back,
and what lets someone take their guestbook line down after a restart. It is continuity, not
authentication — there is nothing on the island worth stealing — which is why it can be a
random string in the browser rather than a login.

---

## 4. Failure behaviour

| Failure | What happens |
|---|---|
| Client loses network | Backoff reconnect with jitter, forever — except after a 4002 close (the player was taken over by another tab), when the client stops and offers to continue here — plus an immediate retry when `online` fires or the tab is foregrounded. Session resumes if within the grace window; otherwise the client returns to the same island (`hello.room`) and where it stood (`hello.at`). |
| Client misses a delta tick | Gap detected by tick number; client requests `resync` and is replayed from history or re-snapshotted. Debounced, because one gap usually means several. |
| Client falls behind | Movement-only deltas are dropped past 256 KiB buffered; everything else is kept. |
| Terrain worker unavailable or fails | Falls back to meshing on the main thread. Slower, still correct. Some embedded WebViews and strict CSP setups block module workers. |
| A prop generator throws | That one landmark is skipped and logged. The island still builds. |
| WebGL context lost | Detected, explained to the player, and the page reloads on restore. |
| A handler throws | Caught per message. One player's bad input cannot affect the tick loop or another player's connection. |
| A tick throws | Caught per tick. A game that throws is logged and the tick still goes out with what was gathered (arrivals, departures, chat). If putting the delta together throws, the tick number is spent on an empty delta — the sequence stays whole, so nobody is left discarding every later delta — and everyone is sent a fresh snapshot in place of what was lost. The next tick starts clean either way. |
| Server restarts | Public shards restore their schedule, announcements, guestbook and check-in records at boot; private islands restore theirs when their code is next used; profiles and the registry come back whole. **Rosters and hosts do not**: the players they name belonged to a process that no longer exists, and a roster of ghosts would hold capacity nobody can use. Every client returns as a new player — on the island named in its URL, where it was standing — and the island's own schedule carries on. Clients reconnect with backoff and jitter, so they do not all return at once. |
| The persistence file cannot be parsed | It is renamed aside to `<path>.corrupt-<timestamp>` for a human, and the server starts empty rather than overwriting it on the next save. A malformed *section* costs that section only. |
| Too many private islands awake | Creating or waking one more is refused with `islands_busy`; the player stays where they are, or is matchmade onto a public shard if it was their first frame. Islands fall asleep ten minutes after they empty. |

---

## 5. What is deliberately not here

- **No accounts.** A visitor key in the browser instead, hashed on the server. It carries a
  profile and a private island's keepership between visits; it does not carry them between
  browsers.
- **No ECS.** The entity count is in the hundreds and the behaviours are few. An ECS
  would add indirection without buying anything at this scale.
- **No physics engine.** The ground is an analytic function; a ground query is one call.
  Fireworks and a fishing line are animated, not simulated. Rigid-body physics would be a
  large dependency for a world in which nothing is thrown.
- **No state-management library.** Svelte stores plus one command object are sufficient,
  and the boundary is small enough to read in one sitting.
- **No i18n library.** Three flat dictionaries and a derived store.
- **No REST API in the hot path.** Everything real-time is on the socket. The HTTP surface
  is health, metrics, a public room list and static files.
- **No database.** One JSON file behind a `Store` interface. See
  [OPERATIONS.md](OPERATIONS.md) for when that stops being enough.
- **No rigged character assets, no textures, no audio files.** See the README's design
  principle 3, *Generate, don't download*.
