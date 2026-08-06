# Nagisa 渚

**It's a small island, but everyone has to be somewhere.**

A real-time multiplayer 3D world in the browser. You arrive at the harbour of a small
Japanese island, walk up to the plaza, and find other people already there — at a lantern
walk on the shrine path, a concert on the sand, or just sitting outside the teahouse
watching the light change.

Nagisa is built as a *place*, not an application. There is no lobby, no menu tree and no
dashboard. You load the page, choose a name, and you are ashore.

---

## Table of contents

- [What it is](#what-it-is)
- [Technology stack](#technology-stack)
- [Quick start](#quick-start)
- [Directory structure](#directory-structure)
- [Runtime configuration](#runtime-configuration)
- [Documentation](#documentation)
- [Design principles](#design-principles)

---

## What it is

| | |
|---|---|
| **The world** | One hand-designed Japanese island, sea on every side. Six places on a hexagon 74 m to a side — two harbours, a main plaza, an old street, a shrine headland, a lighthouse cape — with a mountain at the centre and a ring road under 500 m. A neighbour is eight seconds away at a run. 107 buildings and structures, all generated from code — the island ships as maths, not as a downloaded mesh. |
| **The look** | Drawn, not lit. A screen-space contour pass puts a pen line on every silhouette, crease and material boundary; surfaces are flat fills with a hand-authored shadow tone, pen hatching in the shade, and paper grain over the whole frame. See [docs/RENDERING.md](docs/RENDERING.md). |
| **Multiplayer** | Server-authoritative rooms with real-time position and animation sync, presence, emotes, and shared time of day. Reconnection restores your identity, your role and your place in whatever you had joined. |
| **Activities** | Several things run concurrently in different zones — each with a lifecycle, a host, a participant roster, an audience, and optional check-in. Switching between them is walking somewhere. |
| **Announcements** | Hosts announce to their activity or its zone; admins announce island-wide. Announcements arrive as a quiet toast and stay readable on the notice board. |
| **Interface** | Deliberately small. At rest it covers under a tenth of the screen: a zone name, a headcount, three icon buttons, and whatever is on next. |

---

## Technology stack

**Client**

- **Three.js** (r170) — WebGL2 renderer, a custom multiple-render-target contour pipeline,
  and hand-written shaders for every surface, the sea and the sky.
- **Svelte 5** — the interface overlay, mounted over the canvas. Runes in components,
  plain stores as the engine↔UI boundary.
- **Vite 6** — dev server and bundler, with `three` split into its own long-lived chunk.
- **TypeScript**, strict throughout.
- **Web Workers** for terrain meshing, so the island builds without dropping frames.
- **Web Audio** for ambience, synthesised at runtime rather than streamed.

**Server**

- **Node 20+**, TypeScript, ESM.
- **`ws`** for WebSockets, over a plain `node:http` server. No framework.
- Zero other runtime dependencies.

**Shared**

- **`@nagisa/shared`** — the wire protocol, the terrain field, the world layout and the
  design tokens. Pure TypeScript with no platform dependencies, so the identical code
  runs in the browser, in Node and in a worker. This is what lets the server validate
  your position against exactly the ground you are standing on.

---

## Quick start

Requires Node 20 or newer.

```bash
npm install          # installs all three workspaces
npm run dev          # shared (watch) + server :8787 + client :5173
```

Open <http://localhost:5173>. Open it a second time in another window to meet yourself.

To grant yourself host/admin controls in development, append the admin token:

```
http://localhost:5173/?admin=dev-token
```

…with `ADMIN_TOKEN=dev-token` set in the server's environment (see below).

### Production build

```bash
npm run build        # shared → server → client, in that order
npm start            # serves the API, the WebSocket and the built client on :8787
```

### Docker

```bash
export NAGISA_ADMIN_TOKEN=$(openssl rand -hex 24)
export NAGISA_SESSION_SECRET=$(openssl rand -hex 32)
docker compose up --build
```

### Other commands

```bash
npm run typecheck    # all three workspaces, including Svelte components

npm test             # server unit tests + world generation + interface (116 checks)
npm run test:e2e     # two real clients against a real server over a real socket
npm run test:app     # the whole stack in a browser: two players, entry → world
npm run test:all     # all of the above

npm run shots        # render twelve viewpoints to PNG (headless, real pipeline)
npm run map          # render the island to a shaded relief map
```

`test`, `test:e2e` and `test:app` check three different things and none of them subsumes
another. The first two exercise a layer against a stub of its neighbour; `test:app` is the
only one that fails when the pieces are individually correct and jointly wrong — a store
default naming a zone that no longer exists, a proxy path that changed, an entry screen
whose button stopped calling `enterWorld`.

`shots` is how the art direction is reviewed. The failure modes of a stylised renderer are
pictures, and no type checker or unit test can see them; see
[docs/RENDERING.md](docs/RENDERING.md) §9.

---

## Directory structure

```
nagisa/
├── packages/shared/          # The contract. Imported by both sides.
│   └── src/
│       ├── protocol.ts       # Every WebSocket message + hot-path packing
│       ├── terrain.ts        # The island's surface, as a pure function of (x, z)
│       ├── world.ts          # Zones, venues, spawns, landmarks, activity templates
│       └── tokens.ts         # Palette, type scale, motion curves — UI *and* scene
│
├── apps/server/src/
│   ├── index.ts              # Bootstrap, demo schedule seeding, graceful shutdown
│   ├── http.ts               # health / readiness / metrics / static client
│   ├── session.ts            # One socket: rate limits, backpressure, heartbeat
│   ├── player.ts             # Player record + movement validation
│   ├── room.ts               # Tick loop, snapshots, deltas, delta history
│   ├── rooms.ts              # Shard management and matchmaking
│   ├── activity.ts           # Lifecycle, rosters, check-in, scheduling
│   ├── permissions.ts        # Who may do what
│   ├── handlers.ts           # One validated handler per client message
│   ├── resume.ts             # Signed session resume tokens
│   ├── persistence.ts        # Store interface + JSON file / memory implementations
│   ├── audit.ts              # Append-only admin action log
│   ├── logger.ts             # Dependency-free structured JSON logging
│   └── metrics.ts            # Counters, gauges, histograms → Prometheus text
│
├── apps/client/src/
│   ├── main.ts               # Entry: mount overlay, boot app, context-loss handling
│   ├── app.ts                # Composition root — the only file that knows everything
│   ├── engine/
│   │   ├── renderer.ts       # GL context, ink pass, fixed-step frame loop
│   │   ├── camera-rig.ts     # Third-person follow camera and framing
│   │   ├── quality.ts        # Device tiers + adaptive resolution controller
│   │   └── ink/              # The drawn look: MRT material, contour pass, shared GLSL
│   ├── world/
│   │   ├── island.ts         # Scene assembly, prop bucketing, distance culling
│   │   ├── terrain.worker.ts # Meshes the height field off the main thread
│   │   ├── ocean.ts          # Sea shader + baked bathymetry for shoreline foam
│   │   ├── sky.ts            # Sky dome, light rig, server-synced day cycle
│   │   ├── scatter.ts        # Deterministic instanced ground detail
│   │   ├── materials.ts      # The shared, cached material library
│   │   └── props/            # geometry → kit → buildings / structures / furniture
│   ├── character/
│   │   ├── character.ts      # Procedural rig + procedural animation
│   │   ├── local-player.ts   # Client-predicted movement against the height field
│   │   ├── remote-players.ts # Interpolation, ranked LOD
│   │   └── name-tags.ts      # Sprite labels for nearby players
│   ├── net/
│   │   ├── connection.ts     # Socket lifecycle, heartbeat, backoff, clock sync
│   │   └── world-sync.ts     # Snapshot/delta application, outbound throttling
│   ├── input/input.ts        # Keyboard, mouse, touch stick, gamepad → one intent
│   ├── audio/ambience.ts     # Synthesised per-zone ambience
│   ├── state/stores.ts       # The engine ↔ interface boundary
│   ├── probe/probe.ts        # Render probe — the real world, no UI, for screenshots
│   └── ui/                   # Svelte overlay
│
├── docs/                     # See below
├── archive/world-v1/         # The previous world model, kept for reference
├── scripts/
│   ├── dev.mjs               # Runs all three workspaces with prefixed output
│   ├── dev-server.mjs        # Compiles + restarts the realtime server on change
│   ├── world-map.mjs         # Renders the island to a PNG relief map
│   ├── find-spot.mjs         # Every legal position for a landmark
│   └── notes.mjs             # Prints placement notes written from inside the world
├── tools/
│   ├── shot.mjs              # Twelve viewpoints → PNG, through the real pipeline
│   ├── plan-diagram.mjs      # One plan drawing per place: roads, footprints, doors
│   ├── app-smoke.mjs         # Whole stack, two players, end to end
│   └── pixel-probe.mjs       # Live material uniforms from a running page
├── Dockerfile
└── docker-compose.yml
```

---

## Runtime configuration

All server configuration is environment variables. Defaults are chosen so that
`npm start` with no environment at all produces a working island.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP + WebSocket port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `ROOM_CAPACITY` | `120` | Players per room shard. |
| `ROOM_COUNT` | `1` | Shards created at boot. |
| `STATIC_DIR` | *(unset)* | Path to the built client. Unset means API/WebSocket only. |
| `PERSIST_PATH` | *(unset)* | JSON file for activities, announcements and check-ins. Unset means in-memory only. |
| `ADMIN_TOKEN` | *(unset)* | Presented as `?admin=…` to receive `Role.Admin`. Unset disables admin entirely. |
| `SESSION_SECRET` | *(random)* | HMAC key for resume tokens. Random at boot means restarts invalidate sessions — set it in production. |
| `CORS_ORIGIN` | `*` | Allowed origin for the small REST surface. |

The client needs no configuration: it always talks to `/ws` on its own origin, proxied to
the server in development and served by it in production.

---

## Documentation

| Document | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the whole thing fits together, and why each major decision was made. |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | The wire protocol: connection, heartbeat, snapshots, deltas, reconnection, every message. |
| [`docs/WORLD.md`](docs/WORLD.md) | The island: geography, zones, the terrain field, the path survey, how to add a place or a building. |
| [`docs/RENDERING.md`](docs/RENDERING.md) | The ink pipeline: the contour pass, the material model, the four precision traps it invites, and how to review it. |
| [`archive/world-v1/`](archive/world-v1/README.md) | The previous world model, kept with a table of what changed and why. |
| [`docs/ACTIVITIES.md`](docs/ACTIVITIES.md) | The multi-activity system, rooms, roles and permissions. |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | Quality tiers, adaptive resolution, culling, batching, and the mobile budget. |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Deployment, monitoring, scaling, incident playbooks. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | MVP scope, what was deliberately left out, and what comes next. |

---

## Design principles

These are the rules the codebase is written against. They are here because they explain
most of the decisions you will find odd otherwise.

1. **The world is the product; the interface is furniture.** Any change that makes the UI
   more prominent needs a very good reason. At rest the overlay covers under 10% of the
   screen.

2. **Nothing loads twice.** You arrive once. There is no second loading screen for
   entering an activity, changing zone, or joining a crowd — because the island is one
   scene and activities are places within it, not levels.

3. **Generate, don't download.** The terrain, the buildings, the vegetation, the
   characters and the ambience are all produced from code. This is not asceticism: it is
   what keeps the whole experience inside a budget a phone on cellular data will
   tolerate, and it means the island is editable by anyone who can edit a number.

4. **The server owns shared truth; the client owns your own body.** Activity state,
   rosters, check-ins and permissions are decided server-side. Your movement is predicted
   locally and validated, not round-tripped — 150 ms of input lag would be far more
   damaging here than the cheating it would prevent.

5. **Latency is admitted, not hidden.** Remote players are rendered 200 ms in the past so
   their motion is smooth *and* true. Extrapolation would look better for 100 ms and then
   snap, and a visible snap costs more than an invisible delay.

6. **Populated beats empty.** Matchmaking fills rooms rather than spreading players
   evenly, crowds are arranged in rings that hide gaps, and distant characters keep their
   silhouettes long after they stop animating.

7. **Calm is a performance requirement.** Anything that flashes, pulses, or demands
   attention is a bug. Motion uses one slow easing curve; the camera never overshoots;
   announcements fade rather than arrive.
