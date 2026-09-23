# Nagisa 渚

**It's a small island, but everyone has to be somewhere.**

A real-time multiplayer 3D world in the browser. You arrive at the harbour of a small
Japanese island, walk up to the plaza, and find other people already there — fishing off the
end of a pier, running for the ○ circle in a quiz, drawing a fortune at the shrine, or just
sitting outside the teahouse watching the light change. After dark somebody sends a firework
up over the bay.

Nagisa is built as a *place*, not an application. There is no lobby, no menu tree and no
dashboard. You load the page, choose a name, and you are ashore. If you want to be ashore
with particular people, you make an island of your own and send them the link.

> 中文说明：[README.zh.md](README.zh.md)

---

## Table of contents

- [What it is](#what-it-is)
- [What it is for](#what-it-is-for)
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
| **The world** | One hand-designed Japanese island, sea on every side. Six places on a hexagon 74 m to a side — two harbours, a main plaza, an old street, a shrine headland, a lighthouse cape — with a mountain at the centre and a ring road under 500 m. A neighbour is a few seconds away at a run. 134 hand-placed landmarks, all generated from code — the island ships as maths, not as a downloaded mesh. |
| **The look** | Drawn, not lit. A screen-space contour pass puts a pen line on every silhouette, crease and material boundary; surfaces are flat fills with a hand-authored shadow tone, pen hatching in the shade, and paper grain over the whole frame. See [docs/RENDERING.md](docs/RENDERING.md). |
| **Things to do** | A ○× quiz you answer with your feet, by standing in a circle on the plaza. Fishing from the pier ends and the beach, nineteen things to catch, and a derby at dawn. The shrine's omikuji, one slip a day. A stamp stand in each of eight places. Janken with whoever is standing near you, dice, fireworks from the shore, four bells that everyone in earshot hears. A treasure hunt in the small hours: dig anywhere and the sand says hot or cold — and everyone sees what yours said. Three small tasks a day, the same three for everyone. The server decides every outcome. A stamp card, a fish book, a streak of days and nine badges are kept between visits — see [docs/GAMES.md](docs/GAMES.md). |
| **The island's day** | Day and night turn every 90 real minutes, on one clock for everyone; the weather comes off the same clock in quarter-hour spells — fair, grey, now and then rain (the fish bite sooner in it). Every room runs the same programme on it: a treasure hunt in the small hours, the fishing derby at first light, a morning gathering, two quizzes, the harbour market at noon, the lamp lighting at dusk, the lantern walk, a concert on the sand, fireworks after dark. Things open and start by themselves; an admin can put one on at any time. |
| **Private islands** | Make your own island and get a five-letter code; the link is `?island=CODE`. Whoever made it is its keeper — admin there, and only there — each time they come back from the same browser — and can give it a name ("Design team's break room") that friends see in place of the code. An invite link keeps working after everyone has left, and after a restart when `PERSIST_PATH` is set. |
| **Talking** | A chat log in the corner, a speech bubble over the speaker's head, whispers (`/w name …`) that reach one person only, and a notice board you can sign. |
| **Friends** | Ask someone from their card; once they accept, each of you sees whether the other is on, which island they are on, and a button that takes you there — private islands included. A line and a soft two-note chime tell you when a friend arrives (and when someone whispers to you); on the minimap, friends are the blue dots. |
| **Multiplayer** | Server-authoritative rooms with real-time position and animation sync, presence, emotes, and shared time of day. Reconnection restores your identity, your role and your place in whatever you had joined; after a longer outage you come back where you were standing. |
| **Activities** | Several things run concurrently in different zones — each with a lifecycle, an optional host, a participant roster, an audience, and optional check-in. Switching between them is walking somewhere. |
| **Announcements** | Hosts announce to their activity or its zone; admins announce island-wide. An announcement interrupts only the people it is addressed to, as a quiet toast, and stays readable on the notice board. |
| **Languages** | 中文, 日本語 and English. The interface follows the browser and can be switched on the entry screen or in settings. |
| **Interface** | Deliberately small. At rest it is a small map with the place name under it, a headcount, a few icon buttons, and whatever is on next. |

---

## What it is for

| | |
|---|---|
| **Friends hanging out** | Make a private island from the Island panel, copy the invite link into the group chat, and everyone lands on the same island. Walk round together, fish, play the quiz, and end up on the beach for the fireworks. |
| **A remote team's break room or morning check-in** | The programme runs itself, including a morning gathering on the plaza that takes check-ins. A standing link to the team's own island is somewhere to drop into between meetings; its keeper can put a quiz on in five minutes from the host panel. |
| **Club and community events** | An admin makes someone host of an activity. The host opens and starts it from the host panel, announces to the people attending, and watches the check-ins come in — then saves the register as a CSV for the attendance sheet; the quiz hosts itself and judges itself. |
| **On your own** | Sit on the teahouse mats and watch the day go round, look out from the lighthouse door, fill the stamp card and the fish book. |

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
- **Web Audio** for ambience and every game sound — bells, fireworks, the concert's
  strings — synthesised at runtime rather than streamed.
- No i18n library: three flat dictionaries and a store (`i18n/`).

**Server**

- **Node 20+**, TypeScript, ESM.
- **`ws`** for WebSockets, over a plain `node:http` server. No framework.
- Zero other runtime dependencies.

**Shared**

- **`@nagisa/shared`** — the wire protocol, the terrain field, the map packs, the game
  tables (fish, fortunes, badges, the quiz bank, the island clock) and the design tokens.
  Pure TypeScript with no platform dependencies, so the identical code runs in the browser,
  in Node and in a worker. This is what lets the server validate your position against
  exactly the ground you are standing on, and judge a quiz answer by where you stand.

---

## Quick start

Requires Node 20 or newer.

```bash
npm install          # installs all three workspaces
npm run dev          # shared (watch) + server :8787 + client :5173
```

Open <http://localhost:5173>. Open it a second time in another window to meet yourself.

To grant yourself admin controls in development, append the admin token:

```
http://localhost:5173/?admin=dev-token
```

…with `ADMIN_TOKEN=dev-token` set in the server's environment (see below). The client takes
the token out of the address bar as soon as it has read it and keeps it for the tab only, so
it does not end up in a screenshot or an invite link.

### Production build

```bash
npm run build        # shared → server → client, in that order
STATIC_DIR="$PWD/apps/client/dist" npm start   # the API, the WebSocket and the built client on :8787
```

`npm start` serves the built client only when `STATIC_DIR` points at it; without it the
process answers the API and the WebSocket and nothing else. It runs inside `apps/server`, so
give the path absolute.

### Docker

```bash
export NAGISA_ADMIN_TOKEN=$(openssl rand -hex 24)
export NAGISA_SESSION_SECRET=$(openssl rand -hex 32)
docker compose up --build
```

The compose file sets `PERSIST_PATH` on a volume. Keep it that way: without it, a restart
forgets every private island, so every invite link stops working.

### Other commands

```bash
npm run typecheck    # all three workspaces, including Svelte components

npm test             # server unit tests + world generation + interface mount checks
npm run test:e2e     # real clients against a real server over real sockets, every game included
npm run test:app     # the whole stack in a browser: two players, entry → world
npm run test:island  # in a browser: make a private island, follow the invite, whisper
npm run test:load    # 150 scripted visitors walking, chatting and waving; tick time and bandwidth
npm run test:all     # test + test:e2e + test:app + test:island + test:roam

npm run shots        # render the review viewpoints to PNG (headless, real pipeline)
npm run map          # render the island to a shaded relief map
```

`npm test` runs `test:world` and `test:ui` after the server's unit tests, and `test:ui` is
itself two scripts: `ui-smoke.mjs` mounts the whole overlay through every app phase and
panel, and `ui-games-smoke.mjs` mounts each game card and panel on its own, drives it through
every state the server can put it in, and checks that the three languages hold the same keys
and placeholders in both dictionaries, `core.ts` and `games.ts`.
`test:e2e` runs against the built output, so `npm run build` first.

`test`, `test:e2e` and the browser tests check different things and none of them subsumes
another. The first two exercise a layer against a stub of its neighbour; `test:app` and
`test:island` are the only ones that fail when the pieces are individually correct and
jointly wrong — a store default naming a zone that no longer exists, a proxy path that
changed, an invite link the entry screen does not honour.

`shots` is how the art direction is reviewed. The failure modes of a stylised renderer are
pictures, and no type checker or unit test can see them; see
[docs/RENDERING.md](docs/RENDERING.md) §9.

---

## Directory structure

```
nagisa/
├── packages/shared/src/      # The contract. Imported by both sides.
│   ├── protocol.ts           # Every WebSocket message + hot-path packing
│   ├── terrain.ts            # The island's surface, as a pure function of (x, z)
│   ├── movement.ts           # Speeds and the speed budget both sides enforce
│   ├── world.ts              # Zones, landmarks, interactables, templates — of the active map
│   ├── map/                  # What a map pack is (types) and the registry
│   ├── maps/                 # The packs: nagisa-island (default), lantern-atoll
│   ├── games/                # Fish, fortunes, badges, the quiz bank, the island clock,
│   │                         # weather, treasure spots, today's tasks
│   └── tokens.ts             # Palette, type scale, motion curves — UI *and* scene
│
├── apps/server/src/
│   ├── index.ts              # Bootstrap, persistence wiring, idle sweep, graceful shutdown
│   ├── config.ts             # Every environment variable, validated once
│   ├── http.ts               # health / readiness / metrics / room list / static client
│   ├── session.ts            # One socket: rate limits, backpressure, heartbeat
│   ├── player.ts             # Player record + movement validation
│   ├── room.ts               # Tick loop, snapshots, deltas, seats, the games' host
│   ├── rooms.ts              # Public shards, private islands, matchmaking, sleep
│   ├── activity.ts           # Lifecycle, rosters, check-in, the lifecycle sweep
│   ├── schedule.ts           # Keeps the island's daily programme on every room's board
│   ├── games/                # Quiz, fishing + derby, janken, fireworks, treasure hunt,
│   │                         # bells/omikuji/stamps/dice, guestbook, profiles, today's
│   │                         # tasks (daily) — behind `GameRoom`
│   ├── friends.ts            # Friend lists, requests and presence across islands
│   ├── text.ts               # Cleaning what players type (controls, bidi, invisibles)
│   ├── permissions.ts        # Who may do what
│   ├── handlers.ts           # One validated handler per client message
│   ├── resume.ts             # Signed session resume tokens
│   ├── persistence.ts        # Store interface + JSON file / memory implementations
│   ├── audit.ts              # Append-only admin action log
│   ├── notes.ts              # Developer placement notes (dev only)
│   ├── logger.ts             # Dependency-free structured JSON logging
│   └── metrics.ts            # Counters, gauges, summaries → Prometheus text
│
├── apps/client/src/
│   ├── main.ts               # Entry: mount overlay, boot app, context-loss handling
│   ├── app.ts                # Composition root — the only file that knows everything
│   ├── engine/               # Renderer, ink pass, camera rig, quality tiers
│   ├── world/                # Island assembly, terrain worker, sea, sky, scatter, props/
│   ├── character/            # Procedural rig, local + remote players, name tags, bubbles
│   ├── fx/                   # The games in the world: bells, fireworks, fishing, the quiz
│   │                         # arena, lanterns, the lighthouse beam, the concert, emotes,
│   │                         # rain, fireflies, treasure digs
│   ├── net/
│   │   ├── connection.ts     # Socket lifecycle, heartbeat, backoff, clock sync
│   │   ├── world-sync.ts     # Snapshot/delta application, events, outbound throttling
│   │   ├── visitor.ts        # Visitor key, invite codes in the URL, the admin token
│   │   └── last-pose.ts      # Where you stood, so a long outage returns you there
│   ├── i18n/                 # zh / ja / en dictionaries (core.ts, games.ts) and helpers
│   ├── input/input.ts        # Keyboard, mouse, touch stick, gamepad → one intent
│   ├── audio/ambience.ts     # Synthesised per-zone ambience
│   ├── state/                # stores.ts (the engine ↔ interface boundary), settings.ts
│   ├── probe/probe.ts        # Render probe — the real world, no UI, for screenshots
│   └── ui/                   # Svelte overlay:
│                             #   Overlay, Hud, Minimap, NextUp, ZoneCard, Announcements,
│                             #   Chat, EmoteWheel, Joystick, Entry, Loader, Panels;
│                             #   panels: People, Activities, Settings, Host, Board,
│                             #   Collection, Island, Notes (dev);
│                             #   game cards: QuizHud, FishingHud, TreasureHud,
│                             #   OmikujiCard, JankenCard, PlayerCard;
│                             #   WelcomeCard (said once, to a first arrival)
│
├── docs/                     # See below
├── archive/                  # world-v1/ and world-v2/: earlier world models, for reference
├── scripts/
│   ├── dev.mjs               # Runs all three workspaces with prefixed output
│   ├── dev-server.mjs        # Compiles + restarts the realtime server on change
│   ├── e2e.mjs               # Real server, real sockets, every flow
│   ├── world-smoke.mjs       # World generation and the walkability contract
│   ├── ui-smoke.mjs          # The overlay, mounted in jsdom
│   ├── ui-games-smoke.mjs    # Each game card and panel, every state, three languages
│   ├── placement-audit.mjs   # Layout rules, including prompts that reach nothing
│   ├── terrain-audit.mjs     # Walkability: pinholes, snags, reachability
│   ├── world-map.mjs         # Renders the island to a PNG relief map
│   ├── find-spot.mjs         # Legal positions for a landmark, nearest first
│   └── notes.mjs             # Prints placement notes written from inside the world
├── tools/
│   ├── shot.mjs              # Viewpoints → PNG, through the real pipeline
│   ├── plan-diagram.mjs      # One plan drawing per place: roads, footprints, doors
│   ├── app-smoke.mjs         # Whole stack, two players, end to end
│   ├── island-smoke.mjs      # Private island → invite link → friend arrives → whisper
│   ├── roam-smoke.mjs        # A long walk that must never earn a correction
│   ├── reconnect-smoke.mjs   # Server dies under you; do you come back where you stood?
│   ├── load-smoke.mjs        # A crowd of scripted visitors; tick time and bandwidth
│   └── pixel-probe.mjs       # Live material uniforms from a running page
├── Dockerfile
└── docker-compose.yml
```

---

## Runtime configuration

All server configuration is environment variables, read once in `apps/server/src/config.ts`.
Defaults are chosen so that `npm start` with nothing but `STATIC_DIR` set produces a working
island; with no environment at all it serves the API and the WebSocket without the client.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP + WebSocket port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `ROOM_CAPACITY` | `120` | Players per public shard. |
| `ROOM_COUNT` | `1` | Public shards created at boot. These never sleep, so there is always somewhere to arrive; more open on demand and sleep when they have been empty for ten minutes. |
| `PRIVATE_ROOM_CAPACITY` | `40` | Players per private island. |
| `MAX_CONNECTIONS` | `2000` | Open WebSocket connections the process accepts in total; past it, new sockets are closed with 1013. |
| `MAX_CONNECTIONS_PER_IP` | `0` | Open connections from one client address; `0` is no limit. Behind a reverse proxy set it only together with `TRUST_PROXY`, or every visitor shares the proxy's address. |
| `TRUST_PROXY` | *(off)* | `1` / `true` / `yes`: take the client address from the last `X-Forwarded-For` hop (the one your proxy appended). Set it behind nginx or Caddy, and only there. |
| `NAGISA_MAP` | `nagisa-island` | Map pack to simulate (`lantern-atoll` also ships). Clients must load the same one with `?map=`; a mismatch is refused at the handshake. |
| `STATIC_DIR` | *(unset)* | Path to the built client. Unset means API/WebSocket only. |
| `PERSIST_PATH` | *(unset)* | JSON file holding each room's schedule, announcements and guestbook, the private-island registry, visitor profiles (stamps, fish book, badges) and the admin audit log. Unset means in-memory only — and invite links die with the process. |
| `ADMIN_TOKEN` | *(unset)* | Presented as `?admin=…` to receive `Role.Admin` on every island. Unset disables token admin entirely (a private island's keeper is still admin there). |
| `SESSION_SECRET` | *(random)* | HMAC key for resume tokens; also accepted as `RESUME_SECRET`. Random at boot means restarts invalidate sessions — set it in production. |
| `CORS_ORIGIN` | `*` | Allowed origin for the small REST surface. |
| `DEV_NOTES_PATH` | *(unset)* | File for developer placement notes; set only in development, by `scripts/dev.mjs`. Unset means the `/dev/notes` endpoints do not exist. |

The client needs no configuration: it always talks to `/ws` on its own origin, proxied to
the server in development and served by it in production.

---

## Documentation

| Document | What it covers |
|---|---|
| [`README.zh.md`](README.zh.md) | This page in Chinese, written for someone deciding whether to use it. |
| [`docs/GAMES.md`](docs/GAMES.md) | Everything there is to do: private islands, visitor profiles, world events, and each game end to end. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the whole thing fits together, and why each major decision was made. |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | The wire protocol: connection, heartbeat, snapshots, deltas, reconnection, every message. |
| [`docs/ACTIVITIES.md`](docs/ACTIVITIES.md) | Activities, the island's daily programme, rooms, roles and permissions. |
| [`docs/WORLD.md`](docs/WORLD.md) | The island: geography, zones, the terrain field, the routes, how to add a place, a building or a game spot. |
| [`docs/MAPS.md`](docs/MAPS.md) | Map packs: what a map is, and how a second one is swapped in. |
| [`docs/RENDERING.md`](docs/RENDERING.md) | The ink pipeline: the contour pass, the material model, the precision traps it invites, and how to review it. |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | Quality tiers, adaptive resolution, culling, batching, and the mobile budget. |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Deployment, persistence, monitoring, scaling, incident playbooks. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What is built, what was deliberately left out, what is imperfect, and what comes next. |
| [`archive/`](archive/world-v1/README.md) | Earlier world models, kept with a table of what changed and why. |

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
