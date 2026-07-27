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
| **The world** | One hand-designed Japanese island: harbour, lighthouse cape, shrine path, main plaza, old street, teahouse, sunset beach, clifftop lookout, and a seaside promenade that loops the whole coast. Generated entirely from code — the island ships as roughly 40 KB of maths, not as a downloaded mesh. |
| **Multiplayer** | Server-authoritative rooms with real-time position and animation sync, presence, emotes, and shared time of day. Reconnection restores your identity, your role and your place in whatever you had joined. |
| **Activities** | Several things run concurrently in different zones — each with a lifecycle, a host, a participant roster, an audience, and optional check-in. Switching between them is walking somewhere. |
| **Announcements** | Hosts announce to their activity or its zone; admins announce island-wide. Announcements arrive as a quiet toast and stay readable on the notice board. |
| **Interface** | Deliberately small. At rest it covers under a tenth of the screen: a zone name, a headcount, three icon buttons, and whatever is on next. |

---

## Technology stack

**Client**

- **Three.js** (r170) — WebGL renderer, toon/cel materials, custom sea and sky shaders.
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
npm test             # protocol + server unit tests (node:test)
npm run typecheck    # all three workspaces
```

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
│   │   ├── renderer.ts       # GL context, post chain, fixed-step frame loop
│   │   ├── camera-rig.ts     # Third-person follow camera and framing
│   │   └── quality.ts        # Device tiers + adaptive resolution controller
│   ├── world/
│   │   ├── island.ts         # Scene assembly, prop bucketing, distance culling
│   │   ├── terrain.worker.ts # Meshes the height field off the main thread
│   │   ├── ocean.ts          # Sea shader + baked bathymetry for shoreline foam
│   │   ├── sky.ts            # Sky dome, light rig, server-synced day cycle
│   │   ├── scatter.ts        # Deterministic instanced vegetation
│   │   ├── materials.ts      # The shared, cached material library
│   │   └── props/            # Procedural buildings, structures and nature
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
│   └── ui/                   # Svelte overlay
│
├── docs/                     # See below
├── scripts/dev.mjs           # Runs all three workspaces with prefixed output
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
| [`docs/WORLD.md`](docs/WORLD.md) | The island: geography, zones, the terrain field, the asset strategy, how to add a place or a building. |
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
