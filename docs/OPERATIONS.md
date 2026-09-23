# Operations

Deploying, running and debugging Nagisa.

---

## 1. Deploy

### Docker (recommended)

```bash
export NAGISA_ADMIN_TOKEN=$(openssl rand -hex 24)
export NAGISA_SESSION_SECRET=$(openssl rand -hex 32)
docker compose up --build -d
```

One container serves the WebSocket, the small REST surface and the built client from the
same origin. That is deliberate: splitting the client onto a CDN means cross-origin
WebSocket configuration, a second certificate and a CORS policy to maintain, in exchange
for offloading static serving from a process that is otherwise idle between ticks. Put a
CDN in front of it when traffic justifies it — nothing here prevents that.

The compose file runs two public shards (`ROOM_COUNT: '2'`), caps private islands at 40,
and puts `PERSIST_PATH` on a named volume. The image runs as the `node` user and needs
nothing but its port and `/data`.

### Bare Node

```bash
npm ci
npm run build
STATIC_DIR=apps/client/dist \
PERSIST_PATH=/var/lib/nagisa/state.json \
SESSION_SECRET=... ADMIN_TOKEN=... \
node apps/server/dist/index.js
```

### Behind a reverse proxy

WebSockets need the upgrade headers forwarded and a read timeout longer than the
heartbeat interval.

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    # The real client address, and only that. With TRUST_PROXY=1 the server reads the
    # *first* X-Forwarded-For hop, so appending ($proxy_add_x_forwarded_for) would let a
    # client put any address it likes in front and slip the per-address limit.
    proxy_set_header X-Forwarded-For $remote_addr;

    # Must exceed PING_INTERVAL_MS (5 s) with a wide margin, or the proxy will cut
    # idle-but-healthy connections. 75 s is a safe default.
    proxy_read_timeout 75s;
}
```

Behind a proxy the server sees every visitor as the proxy's own address. Set
`TRUST_PROXY=1` so it reads the client address from `X-Forwarded-For` instead — and only
behind a proxy that sets that header itself, as above; exposed directly, a client could
claim any address. Only then is `MAX_CONNECTIONS_PER_IP` meaningful.

The admin token travels as `?admin=` on the WebSocket upgrade URL. If your proxy logs
query strings, it will log the token; strip it from access logs or treat those logs as
secret.

Serve over HTTPS in production. The client selects `wss:` automatically from
`location.protocol`; a page served over HTTPS cannot open a `ws:` socket, and the failure
is silent enough to waste an afternoon.

---

## 2. Configuration

See the table in the [README](../README.md#runtime-configuration). The entries that need
thought:

**`PERSIST_PATH`** — set it in any real deployment. It is not only the schedule: it holds
the **private-island registry**, and without it a restart forgets every island, so every
invite link anybody has sent stops working. It also holds every visitor's stamps, fish book
and badges, each island's guestbook, and the audit log.

**`SESSION_SECRET`** (also read as `RESUME_SECRET`) — HMAC key for resume tokens. If unset,
a random one is generated at boot, which means every restart invalidates every session.
Set it in production. Rotating it deliberately is the intended way to force a global
reconnect. Earlier builds read only `RESUME_SECRET`, so a deployment that set
`SESSION_SECRET` as documented was silently running with a per-process secret; both names
work now.

**`ADMIN_TOKEN`** — presented as `?admin=<token>` to receive `Role.Admin` on every island.
If unset, token admin is disabled entirely rather than defaulting to something guessable.
Anyone holding it can announce island-wide, kick and mute on any island, including a private
one; treat it as a credential. The server compares it in constant time (both sides hashed,
then `timingSafeEqual`), so response timing does not leak it. A private island's keeper is
admin on their own island whether or not this is set.

**`MAX_CONNECTIONS`** (default 2000) and **`MAX_CONNECTIONS_PER_IP`** (default 0 = off) —
checked when a socket opens, before any per-connection state exists; a refused socket is
closed with code 1013 (`server_busy`) and counted as `nagisa_errors_total{kind="connection_refused"}`.
The per-address limit is off by default because behind a reverse proxy every visitor shares
the proxy's address unless `TRUST_PROXY` is set, and a default limit would lock everyone out
at once. When you do set it, leave room for an office or a school behind one NAT address —
a team's morning check-in is exactly that.

**`TRUST_PROXY`** — `1`, `true` or `yes` makes the server take the client address from the
last `X-Forwarded-For` hop — the one the proxy itself appended; earlier hops are whatever the
client sent. Set it only behind a proxy that writes that header itself.

**`ROOM_COUNT`** — the public shards created at boot, which **never sleep**. More open on
demand when every shard is within 10% of `ROOM_CAPACITY`, and those sleep when empty.

**`PRIVATE_ROOM_CAPACITY`** — players per private island (default 40). Independent of the
cap on how many private islands may be awake at once, which is fixed at 200 in code
(`MAX_LIVE_ISLANDS` in `rooms.ts`).

**`NAGISA_MAP`** — which map pack the server simulates. Clients must load the same one
(`?map=`); the welcome carries the server's map id and a client on a different map refuses
to enter rather than standing everyone in mid-air.

---

## 3. Health and monitoring

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness: `200 ok` while every awake room's tick loop is running; `503 tick stalled` once any room has gone more than 5 s without a tick. The Docker `HEALTHCHECK` uses it, so a wedged island gets its container restarted. |
| `GET /readyz` | Readiness: `200` once listening, `503` from the first moment of a graceful shutdown. Use this as the load-balancer gate. |
| `GET /metrics` | Prometheus text. |
| `GET /api/rooms` | The public shards with their populations. Private islands are never listed. |

Every response from the API, the health endpoints, `/metrics` and the static client carries
`X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. The second matters
here: the address bar holds `?island=CODE`, and it must not travel to another site in a
`Referer`.

### Metrics

| Metric | Type | Labels | What it is |
|---|---|---|---|
| `nagisa_connections_total` | counter | | WebSocket connections accepted. |
| `nagisa_connections_current` | gauge | | Open WebSocket connections. |
| `nagisa_messages_in_total` | counter | `type` | Inbound client messages. Only known message types become labels; unparsable frames and unknown types are all counted as `type="invalid"`. |
| `nagisa_messages_out_total` | counter | `type` | Outbound server messages. |
| `nagisa_messages_dropped_total` | counter | `type` | Outbound frames dropped under backpressure (only movement-only deltas are ever dropped). |
| `nagisa_rate_limited_total` | counter | `type` | Inbound messages refused by the token buckets. |
| `nagisa_errors_total` | counter | `kind` | `hello`, `handler` or `room_tick` — faults caught and survived — and `connection_refused` (over `MAX_CONNECTIONS` or `MAX_CONNECTIONS_PER_IP`). |
| `nagisa_tick_duration_ms` | summary | | p50 / p95 / p99 of the last 1000 room ticks, all rooms together. |
| `nagisa_room_population` | gauge | `room` | Players in each **public shard** by its id, including those in their grace window; every private island summed under `room="private"`. A private island's id contains its invite code and `/metrics` is readable by anyone who can reach the port, so islands are never labelled individually. A shard's series is removed when it falls asleep. |
| `nagisa_rooms_current` | gauge | | Awake rooms, public and private. |
| `nagisa_activities_current` | gauge | `state` | Activities on every awake room's board, by lifecycle state. Counted at scrape time. |

v2 added no metric names. Label values are escaped per the exposition format, and no label
value is ever taken from what a client sent. The games' own refusals (a cooldown, a stamp
already taken) are ordinary replies and are not counted anywhere.

`/metrics` is not authenticated. Keep the port off the public internet, or let only your
Prometheus reach that path.

### What to alert on

| Signal | Threshold | Why |
|---|---|---|
| Tick duration p99 | > 60 ms (of a 100 ms budget) | The process is running out of headroom. Every room ticks in one event loop, so this is the whole server, not one room. |
| `nagisa_rooms_current` | approaching `ROOM_COUNT` + 200 | Private islands are near the awake cap; people will start to see `busy`. |
| Rooms at capacity | any public shard, sustained | Players are being crowded into one shard. |
| Reconnect rate | sharp rise | Network trouble, a proxy timeout that is too short, or a crash loop. |
| `nagisa_errors_total` | any rise in `handler` or `room_tick` | A genuine server-side fault; the logs carry the stack. |
| `nagisa_messages_dropped_total` | sustained rise | Clients are falling behind — slow networks, or deltas getting larger than they should. |
| `nagisa_rate_limited_total` | sudden rise on one type | A script, or a client bug sending in a loop. |
| `nagisa_messages_in_total{type="invalid"}` | sustained | Something is sending garbage; each such connection is closed after 20 invalid frames. |
| `nagisa_errors_total{kind="connection_refused"}` | any, sustained | At `MAX_CONNECTIONS`, or one address at its limit — a crowd behind one NAT, or a flood. |
| Process restarts | > 0 unexplained | Check the memory limit, and the logs for `/healthz` having reported a stalled tick. |

### Logs

One JSON object per line, ready for any aggregator. Errors go to stderr, everything else to
stdout.

```json
{"ts":"2026-07-26T21:14:02.881Z","level":"info","event":"player_joined","component":"rooms","room":"shore-1","playerId":"p_7f3","name":"Sawada"}
```

Useful events: `boot_complete`, `rooms_ready` (with how many rooms, sleeping rooms, islands
and profiles came back), `player_joined`, `player_disconnected` (with `graceMs`),
`player_resumed`, `player_removed` (with `reason`), `island_created`, `island_opened`,
`room_awake` (with `restored`), `room_asleep`, `audit_action`, `persist_load_failed`,
`persist_save_failed`, `handler_error`, `room_tick_error`, `shutdown_start`.

There are no `debug`-level events at present, so `LOG_LEVEL=debug` logs the same as `info`.

---

## 4. Persistence

`PERSIST_PATH` points at one JSON file (`PersistedState`, format version 2):

| Section | Holds | Cap |
|---|---|---|
| `rooms` | Per room: activities with their check-in records and programme slot keys, announcements still within their TTL, the guestbook. Awake rooms are saved fresh; sleeping rooms as they were when they fell asleep. | Guestbook: 60 lines per room. Sleeping rooms: the 500 most recently saved. Awake rooms: always kept. |
| `islands` | The private-island registry: code, the keeper's visitor-key hash and name, created and last-active times. | 2 000, most recently active first. |
| `profiles` | Visitor progress, keyed by the SHA-256 of the visitor key: stamps, fish book, catches, badges, the badge worn, today's omikuji, janken and quiz wins, last seen. | 20 000, least recently seen evicted first. |
| `audit` | The admin action log. | The newest 2 000. |

Caps are applied when the state is saved. An island that falls out of the registry is gone:
its code opens nothing any more. A room that falls out of the dormant set comes back empty
if its island is ever woken.

What is **not** persisted: positions, emotes, chat, whispers, fishing lines, duels, quizzes
in progress, and activity rosters and hosts — the players those name belonged to a process
that no longer exists.

### Writes

Games ask for a save after every catch, stamp and signature, so saves are gathered: calls
within one second become one build of the state, the store debounces the write by another
800 ms, and a 30 s heartbeat catches changes the scheduler makes on its own. Each write goes
to a temporary sibling file and is renamed over the target, so a crash mid-write cannot
leave a truncated file, and writes are chained so an older state can never land after a
newer one. Graceful shutdown flushes.

The whole file is rewritten on every save. Full to the caps above it is several megabytes —
fine for one process, and the first thing to change if the caps are raised.

### A file that cannot be read

If the file exists but cannot be read or parsed, the server logs `persist_load_failed`,
renames it aside to `<PERSIST_PATH>.corrupt-<epoch ms>` and starts empty — rather than
overwriting it with an empty island on the next save. The corrupt copy is for a human:
repair it and put it back while the server is stopped. A section of the right file with the
wrong shape costs that section only.

A v1 file (one consolidated list of activities and announcements) is migrated on load onto
`shore-1`, which is where v1 itself put it back on restart.

### Sleep

Every minute the server puts to sleep each room that has been empty for ten minutes:
its tick stops and its state moves into the dormant set, which is saved with everything
else. The first `ROOM_COUNT` public shards are never put to sleep. A private island wakes
the next time its code is used — from `hello`, from `room_switch`, or from an invite link —
with its schedule brought up to date before the first snapshot. While asleep a room runs
nothing, so it wakes to the programme from now on, not to the events it slept through.

### Swapping the store

`persistence.ts` defines a `Store` interface (`load` / `save` / `flush`) with
`JsonFileStore` and `MemoryStore` implementations. Redis or Postgres is a new class
implementing the same interface and one line in `index.ts`. Do this when you move to
multiple processes — a JSON file on a local disk is per-process by definition.

---

## 5. Rate limits and connection hygiene

Three layers.

**Per connection, before anything else**:

- Total open connections are capped by `MAX_CONNECTIONS`, and connections per client
  address by `MAX_CONNECTIONS_PER_IP` when it is set (§2). Refused sockets close with 1013.
- A connection must say `hello` within **10 s** or it is closed (code 4001, `no_hello`).
  Every real client says it the moment the socket opens.
- A frame that does not parse, or names a message type that does not exist, is an invalid
  frame. The first three are answered with `bad_message`; the rest are ignored; after
  twenty the connection is closed (1008, `invalid_frames`). The type is checked against the
  real message list before it is used for anything — a metric label, a handler lookup, a
  rate-limit bucket.
- Only frames the server understood count as the connection being alive, so garbage cannot
  hold a socket open past the idle timeout.

**Per message type, per connection** — a token bucket each, refilled at `rate` per second
and holding `burst`. Exceeding one returns `rate_limited`, which the client does not show.

| Type | Rate / s | Burst |
|---|---|---|
| `move` | 15 | 15 |
| `emote` | 2 | 3 |
| `chat` (and whispers) | 1 | 4 |
| `room_switch` | 0.2 | 3 |
| `room_create` | 0.1 | 2 |
| everything else | 10 | 10 |

**Per game** — cooldowns the player is told about (`cooldown {seconds}`): one private island
per connection per 30 s; one firework per player per 6 s and eight per room per 10 s (the
show does not count); one guestbook line per player per 30 s; one die per 2 s; 3 s between
rings of the same bell, whoever rings it.

Inbound frames larger than 16 KiB are refused by the socket layer before they are parsed.

Everything a player types that others will see — names, chat, whispers, announcements,
guestbook lines — is cleaned in `apps/server/src/text.ts` before length is checked: control
characters, bidirectional overrides and isolates, zero-width spaces, LRM/RLM, the BOM and
line separators are removed, and runs of whitespace become one space. The zero-width joiner
and non-joiner are kept in text (emoji and several scripts need them) and removed from
names, which exist to tell people apart. Lengths are counted in code points. None of this is
about markup — the interface never renders player text as HTML — it is about characters that
make one line or name look like another.

---

## 6. Scaling

Today every room — public and private — lives **in one process**. That takes a single
machine a long way: a room is a few MB of state and a 10 Hz loop, a sleeping island is a
little JSON, and the practical limit is bandwidth, not CPU.

To shard across processes, four things change:

1. **Sticky routing.** Players in the same room must reach the same process. Route on the
   room id or invite code, or use consistent hashing at the load balancer.
2. **A shared store.** Swap `JsonFileStore` for Redis or Postgres so schedules, profiles and
   check-ins are global rather than per-process.
3. **A shared island registry.** Minting a code, and deciding which process wakes an
   island, must be coordinated, or two processes can wake the same island.
4. **Cross-process announcements.** Island-wide announcements need a pub/sub channel; the
   `Store` interface is the natural place to hang it.

What does **not** need to change: the protocol, the tick loop, the client. Rooms are
already isolated from each other by design, which is what makes this a contained change
rather than a rewrite.

---

## 7. Deploying a protocol change

Additive changes (a new optional field, a new message type old clients ignore) need no
coordination.

A breaking change — different meaning, type or units for an existing field, a changed
`PackedTransforms` layout, a removed message type — bumps `PROTOCOL.VERSION`. The server
checks for exactly one version, so a deploy disconnects every older client with
`version_mismatch`, and the client asks the player to reload. That is how v2 went out, on
purpose: a v1 client could not have shown any of it.

For a breaking change that must not interrupt anyone, the server would first need to be
taught to accept both versions; then deploy the server, then the client, then remove the
old version once traffic on it has drained. That dual-version path does not exist today.

---

## 8. Graceful shutdown

On `SIGTERM` / `SIGINT` the server marks itself not ready (`/readyz` → 503), stops
accepting connections, broadcasts `error { code: server_shutdown, fatal: true }`, stops
every room, saves and flushes the store, gives the shutdown frame 200 ms to leave, closes
sockets and exits.

Clients treat `server_shutdown` as **reconnectable** — unlike a kick or a version
mismatch — and come back with exponential backoff **and full jitter**. The jitter is not
optional: without it every client returns simultaneously and knocks the new process over
before it has finished starting.

Allow at least 10 seconds of termination grace so the store flush completes.

---

## 9. Playbooks

**"Invite links stopped working after a restart."**
Almost always `PERSIST_PATH` is unset — or points somewhere that is not on a volume, so the
file went with the old container. Without the registry, a code opens nothing and the player
is matchmade onto a public shard and told `room_not_found`. Check the `rooms_ready` log line
at boot: `islands: 0` after a restart means the registry did not come back. Set
`PERSIST_PATH` on persistent storage; islands made before that are not recoverable. If the
line shows `persist_load_failed` instead, see §4 — the file was set aside, not lost.

**"People get 'island busy'."**
Two hundred private islands are awake. Check `nagisa_rooms_current`. Islands fall asleep
ten minutes after their last visitor leaves, so this clears by itself unless that many are
genuinely in use at once. If they are, the cap (`MAX_LIVE_ISLANDS` in `rooms.ts`) is a
memory bound, not a principle — raise it, and watch tick p99 as you do, since every awake
island ticks in the same event loop.

**"Players say the world froze but the page is responsive."**
The page is alive but deltas have stopped. If a room's loop has wedged, `/healthz` says
`503 tick stalled` (and Docker will restart the container on its own); otherwise look at
`nagisa_tick_duration_ms` and `room_tick_error` in the logs.
If a room is wedged, restarting the process is safe: players return to the same island and
where they stood, with their collections intact.

**"Nobody from our office can get in" (or only the first few can).**
`MAX_CONNECTIONS_PER_IP` is set, and either `TRUST_PROXY` is not — so every visitor looks
like the proxy — or the limit is too low for a team behind one NAT address. Look for
`nagisa_errors_total{kind="connection_refused"}` rising. Set `TRUST_PROXY=1` behind the
proxy, or raise the limit, or turn it off (`0`) and rely on `MAX_CONNECTIONS`.

**"Everyone got disconnected at once."**
Check for a deploy, an OOM kill (`docker inspect`, look for exit code 137), or a proxy
`proxy_read_timeout` shorter than the heartbeat. Clients reconnect automatically; if they
are reconnecting in a tight loop, look for `version_mismatch` in the logs.

**"Somebody lost their stamps / fish book / badges."**
A profile is keyed by the visitor key in that browser's `localStorage`. A different
browser, a private window, or clearing site data is a different visitor, and the old
profile cannot be reached from the new one. The same goes for being keeper of a private
island. Nothing can be done server-side: the server stores only hashes.

**"A player is stuck in the terrain."**
They cannot be: slopes steeper than the walkable limit push characters downhill, deep
water nudges them back toward shore, and there are no invisible walls. If it happens
anyway, it is a `heightAt` discontinuity — reproduce with `nearestWalkable` at their last
logged position and check for a pad or path edit that created a cliff. `npm run map`
flags every unwalkable pixel in red, which is usually faster than reading the field by hand.

**"The island looks different for different players."**
Vegetation scatter is generated client-side from a fixed seed and is never networked.
Divergence means non-determinism has crept into `terrain.ts` or `scatter.ts` — almost
always a `Math.random()`, a `Date`, or a floating-point identity that differs across
engines. Every function in those files must be pure and integer-hashed.

**"Someone is misbehaving."**
Connect with the admin token (or, on a private island, as its keeper), tap their name,
and kick or mute. The action is written to the audit log with your stated reason. A kick
is not a ban: they can return as a new visitor, and on a private island anyone with the
link can. Mute lasts for the rest of their session.

---

## 10. Backup

The only stateful artefact is `PERSIST_PATH`, plus any `*.corrupt-*` files beside it. Copy
it. It now carries more than a day's schedule: losing it loses every private island's
code, every guestbook and every visitor's collection. It holds display names and guestbook
text as people wrote them, and visitor keys only as hashes.

Everything else — the island, the buildings, the vegetation, the fish and the quiz — is
generated from code in version control and needs no backup at all.
