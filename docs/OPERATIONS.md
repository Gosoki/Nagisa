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
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # Must exceed PING_INTERVAL_MS (5 s) with a wide margin, or the proxy will cut
    # idle-but-healthy connections. 75 s is a safe default.
    proxy_read_timeout 75s;
}
```

Serve over HTTPS in production. The client selects `wss:` automatically from
`location.protocol`; a page served over HTTPS cannot open a `ws:` socket, and the failure
is silent enough to waste an afternoon.

---

## 2. Configuration

See the table in the [README](../README.md#runtime-configuration). Two entries deserve
emphasis:

**`SESSION_SECRET`** — HMAC key for resume tokens. If unset, a random one is generated at
boot, which means every restart invalidates every session and every player reconnects as
a new visitor. Set it in production. Rotating it deliberately is the intended way to force
a global reconnect.

**`ADMIN_TOKEN`** — presented as `?admin=<token>` to receive `Role.Admin`. If unset, admin
is disabled entirely rather than defaulting to something guessable. Anyone holding it can
announce island-wide and remove players; treat it as a credential.

---

## 3. Health and monitoring

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness. Reports unhealthy when the tick loop has stalled, not merely when the process is alive — a wedged tick loop with a listening socket is the failure mode that matters. |
| `GET /readyz` | Readiness. Use this as the load-balancer gate. |
| `GET /metrics` | Prometheus text. |
| `GET /api/rooms` | Room list with populations. Useful for a status page. |

### What to alert on

| Signal | Threshold | Why |
|---|---|---|
| Tick duration p99 | > 60 ms (of a 100 ms budget) | The room is running out of headroom. Add shards. |
| Rooms at capacity | any, sustained | Players are being turned away or crowded into one shard. |
| Reconnect rate | sharp rise | Network trouble, a proxy timeout that is too short, or a crash loop. |
| `error` counter by code | rise in `internal` | A genuine server-side fault; correlate by the logged id. |
| Process restarts | > 0 unexplained | Check the healthcheck and the memory limit. |

### Logs

One JSON object per line, ready for any aggregator:

```json
{"ts":"2026-07-26T21:14:02.881Z","level":"info","msg":"player_joined","room":"shore-1","player":"p_7f3","name":"Sawada"}
```

Useful events: `player_joined`, `player_disconnected` (with `graceMs`), `player_removed`
(with `reason`), `activity_state_changed`, `announcement`, `admin_action`,
`schedule_seeded`, `schedule_restored`, `shutdown_start`.

Set `LOG_LEVEL=debug` to include per-message tracing. Do not leave it on: it is one line
per inbound frame, which at 10 Hz × 120 players is 1 200 lines a second.

---

## 4. Persistence

`PERSIST_PATH` points at a JSON file holding activities, announcements and check-in
records. Writes are debounced and atomic (temp file + rename), so a crash mid-write cannot
corrupt it.

On boot the server restores the schedule if the file exists, and seeds a fresh demo
schedule from the activity templates if it does not — so a brand-new island is never
blank.

**Known limitation:** persisted state is not partitioned by room id. On restart, all
shards' schedules consolidate onto the first room. Nothing is lost, but activities are
re-homed. This is an accepted simplification for the default single-shard deployment and
is documented inline in `persistence.ts`.

### Swapping the store

`persistence.ts` defines a `Store` interface with `JsonFileStore` and `MemoryStore`
implementations. Redis or Postgres is a new class implementing the same interface and one
line in `index.ts`. Do this when you move to multiple processes — a JSON file on a local
disk is per-process by definition.

---

## 5. Scaling

Today rooms are shards **within one process**. That takes a single machine a long way: a
room is a few MB of state and a 10 Hz loop, and the practical limit is bandwidth, not CPU.

To shard across processes, three things change:

1. **Sticky routing.** Players in the same room must reach the same process. Route on a
   room id in the connection URL, or use consistent hashing at the load balancer.
2. **A shared store.** Swap `JsonFileStore` for Redis or Postgres so the schedule and
   check-ins are global rather than per-process.
3. **Cross-process announcements.** Island-wide announcements need a pub/sub channel; the
   `Store` interface is the natural place to hang it.

What does **not** need to change: the protocol, the tick loop, the client. Rooms are
already isolated from each other by design, which is what makes this a contained change
rather than a rewrite.

---

## 6. Deploying a protocol change

Additive changes (a new optional field, a new message type old clients ignore) need no
coordination.

For a breaking change — different meaning, type or units for an existing field, a changed
`PackedTransforms` layout, a removed message type:

1. Bump `PROTOCOL.VERSION`.
2. Deploy a server that accepts **both** the old and the new version.
3. Deploy the client.
4. Remove the old version from the server once traffic on it has drained.

Skipping step 2 disconnects every player mid-session with `version_mismatch`.

---

## 7. Graceful shutdown

On `SIGTERM` / `SIGINT` the server stops accepting connections, broadcasts
`error { code: server_shutdown, fatal: true }`, flushes the store, closes sockets and
exits.

Clients treat `server_shutdown` as **reconnectable** — unlike a kick or a version
mismatch — and come back with exponential backoff **and full jitter**. The jitter is not
optional: without it every client returns simultaneously and knocks the new process over
before it has finished starting.

Allow at least 10 seconds of termination grace so the store flush completes.

---

## 8. Playbooks

**"Players say the world froze but the page is responsive."**
The tick loop is alive (the UI still works) but deltas have stopped. Check
`/healthz` — it tests tick freshness. Check tick duration p99. If one room is wedged,
restarting the process is safe: sessions resume within the 45 s grace window.

**"Everyone got disconnected at once."**
Check for a deploy, an OOM kill (`docker inspect`, look for exit code 137), or a proxy
`proxy_read_timeout` shorter than the heartbeat. Clients reconnect automatically; if they
are reconnecting in a tight loop, look for `version_mismatch` in the logs.

**"A player is stuck in the terrain."**
They cannot be: slopes steeper than the walkable limit push characters downhill, deep
water nudges them back toward shore, and there are no invisible walls. If it happens
anyway, it is a `heightAt` discontinuity — reproduce with `nearestWalkable` at their last
logged position and check for a pad or promenade edit that created a cliff.

**"The island looks different for different players."**
Vegetation scatter is generated client-side from a fixed seed and is never networked.
Divergence means non-determinism has crept into `terrain.ts` or `scatter.ts` — almost
always a `Math.random()`, a `Date`, or a floating-point identity that differs across
engines. Every function in those files must be pure and integer-hashed.

**"Someone is misbehaving."**
Connect with the admin token, open the host panel, and kick or mute. The action is written
to the audit log with your stated reason. A kick clears that player's resume token, so
they return as a new visitor rather than resuming.

---

## 9. Backup

The only stateful artefact is `PERSIST_PATH`. It is a small JSON file; copy it. Everything
else — the island, the buildings, the vegetation — is generated from code in version
control and needs no backup at all.
