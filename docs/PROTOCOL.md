# Wire protocol

Everything real-time travels over one WebSocket at `/ws`. There is no second channel and
no REST call in the hot path.

Authoritative definitions live in
[`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts) — this document
explains the *flows*; the source is the spec.

---

## 1. Constants

| Constant | Value | Notes |
|---|---|---|
| `VERSION` | `1` | Sent in `hello`, echoed in `welcome`. Bumped on any breaking change. |
| `TICK_HZ` | `10` | Server broadcast rate. |
| `MOVE_SEND_HZ` | `10` | Client transform report rate. |
| `PING_INTERVAL_MS` | `5 000` | Client heartbeat. |
| `IDLE_TIMEOUT_MS` | `20 000` | Server closes a silent connection. |
| `SESSION_GRACE_MS` | `45 000` | How long a disconnected player stays in the room. |
| `DELTA_HISTORY_TICKS` | `120` | Deltas retained per room for replay. |
| `INTERPOLATION_DELAY_MS` | `200` | How far in the past remote players are rendered. |
| `POS_SCALE` / `YAW_SCALE` | `100` / `1024` | Quantisation: 1 cm, ~0.35°. |

---

## 2. Connection

```
client                                server
  │                                     │
  ├─ WebSocket open ───────────────────▶│
  │                                     │
  ├─ hello {protocol, name,             │
  │         appearance, resumeToken?}  ▶│  validate version
  │                                     │  resolve or create session
  │                                     │  choose room (matchmaker)
  │◀────── welcome {self, resumeToken,  │
  │                 resumed, room,      │
  │                 serverTime, rooms}  │
  │◀────── snapshot {players,           │
  │                  activities,        │
  │                  announcements,     │
  │                  zonePopulation}    │
  │                                     │
  ├─ ping {t0} ───────────────────────▶│  every 5 s
  │◀────── pong {t0, serverTime}        │
  │                                     │
  ├─ move {pos, yaw, anim, seq} ──────▶│  10 Hz, dead-banded
  │◀────── delta {tick, moves, …}       │  10 Hz
```

`welcome` is **always** followed immediately by a `snapshot`. A client that has a welcome
but no snapshot is in an undefined state and should wait, not render.

### Version mismatch

If `hello.protocol` is not a version the server serves, it replies with
`error { code: version_mismatch, fatal: true }` and closes. The client does **not**
reconnect — retrying against a wall achieves nothing. During a rolling deploy the server
may accept two adjacent versions.

---

## 3. Heartbeat and the clock

`ping` carries the client's local `t0`; `pong` echoes it with the server's time.

Round-trip time is `now - t0`. The clock offset is estimated NTP-style —
`serverTime + rtt/2 - now` — but **only from the lowest-RTT sample seen so far**, because
a congested sample would drag the estimate around by tens of milliseconds.

The offset matters: the day/night cycle and every activity countdown run on server time,
so a visitor with a badly-set system clock still sees the same dusk as everyone else.

A connection with no inbound frame for `IDLE_TIMEOUT_MS` is closed by the server. The
5 s heartbeat against a 20 s timeout gives three missed beats of slack, which is enough
to survive a mobile radio stall without being enough to leave ghosts around.

---

## 4. Snapshots and deltas

### Snapshot

Complete observable state of a room. **Idempotent** — applying it twice is safe. Sent on
join, on room switch, and in response to `resync`.

```jsonc
{
  "t": "snapshot",
  "room": "shore-1",
  "tick": 84213,
  "serverTime": 1769472000000,
  "players": [ /* PlayerView */ ],
  "activities": [ /* ActivityView */ ],
  "announcements": [ /* still within TTL, oldest first */ ],
  "zonePopulation": { "plaza": 14, "harbor": 3 }
}
```

The snapshot's player order **defines the initial packed-transform roster**.

### Delta

One per tick. Every field is optional; a quiet tick carries `tick` plus the packed
transforms of whoever moved.

```jsonc
{
  "t": "delta",
  "tick": 84214,
  "join":  [ /* PlayerView */ ],
  "leave": [ "p_9f2" ],
  "moves": { "ids": ["p_1","p_2"], "data": [0, 1204, 812, -3390, 2412, 1, …] },
  "players": [ { "id": "p_4", "zone": "shrine", "activity": "a_7", "mode": "audience" } ],
  "activities": [ /* full ActivityView objects — small and rare */ ],
  "activitiesRemoved": [ "a_3" ],
  "announcements": [ /* AnnouncementView */ ],
  "emotes": [ { "id": "p_2", "emote": "wave" } ],
  "chats":  [ { "id": "p_5", "text": "over here" } ],
  "zonePopulation": { "plaza": 15 }
}
```

Activities are sent whole rather than as patches: they are small, they change rarely, and
a whole object cannot be applied in the wrong order.

### Packed transforms

Six integers per moving player:

```
[ idIndex, x·100, y·100, z·100, yaw·1024, anim ]
```

`idIndex` refers to `moves.ids`, which is **re-sent only when room membership changes**.
Quiet ticks therefore carry integers and nothing else, and `permessage-deflate` compresses
runs of similar integers extremely well.

At 120 players this is ~720 integers per tick ≈ **3 KB/s** per client, against ~60 KB/s
for the equivalent JSON objects.

> **Roster stability is a correctness requirement.** If an index shifts under a client
> mid-flight, one player's movement is attributed to another. The server keeps indices
> stable across joins and leaves and re-sends `ids` on any change; this is covered by
> tests.

### Gap detection

Deltas carry a monotonic `tick`. If the arriving tick is not `lastTick + 1`:

- **greater** → a frame was missed. Send `resync { haveTick }` and wait for a fresh
  snapshot. Do **not** apply the delta: patching state you no longer trust is how a
  desync becomes permanent.
- **less than or equal** → stale or duplicated. Drop it.

`resync` is debounced (3 s), because one lost frame usually means several and five
snapshot requests would make a congested connection worse.

---

## 5. Movement and correction

The client reports its own transform at 10 Hz, with a dead-band: no send unless it has
moved more than 2 cm or turned more than ~0.6°, plus a keep-alive every 2 s so a client
joining after you stopped still learns where you are.

On a plaza where two thirds of the crowd is watching rather than walking, the dead-band
removes roughly two thirds of upstream traffic for free.

The server validates each report:

- rejects `NaN` / `Infinity`;
- clamps horizontal speed against a budget computed from elapsed time (~7 m/s, with
  generous vertical allowance for jump arcs);
- rejects positions failing `isWalkable(x, z)` from the shared terrain field;
- allows a tolerance band above `heightAt` so jumping is not treated as flight.

A failed report produces:

```jsonc
{ "t": "correction", "pos": [x, y, z], "yaw": 1.2, "reason": "speed" | "bounds" | "teleport" | "stage" }
```

The client **hard-snaps**. Blending would fight the server and produce a rubber-band.
Corrections are not surfaced to the player: they are almost always a terrain edge case,
not cheating, and a warning would make an invisible problem visible.

---

## 6. Rooms

Rooms are shards of the same island — same geography, different people.

```
client                                server
  ├─ room_switch { room: "shore-2" } ─▶│  capacity check
  │◀────── room_changed { room }        │
  │◀────── snapshot { … }               │
```

On `room_changed` the client clears its remote-player set and resets its tick baseline
**before** the new snapshot arrives, so there is never a frame showing the previous room's
crowd in the new room's geometry.

Matchmaking (`rooms.ts`) deliberately **fills the fullest room that still has comfortable
headroom** rather than balancing evenly. Two half-empty islands feel worse than one busy
one; this is a product requirement expressed as a scheduling policy.

---

## 7. Activities

```
client                                     server
  ├─ activity_join { activity, mode } ────▶│  capacity, state, permission checks
  │◀────── delta { players: [{id, activity, mode}], activities: [updated counts] }
  │
  ├─ checkin { activity } ────────────────▶│  only while state === "live"
  │◀────── checkin_ack { ok, ordinal }     │
  │
  ├─ activity_leave { activity } ─────────▶│
  │◀────── delta { players: [{id, activity: null}] }
```

Lifecycle, with transitions validated server-side by `canTransition`:

```
scheduled ──▶ open ──▶ live ──▶ ended
     │          │
     └──────────┴──▶ cancelled
```

`open → scheduled` is permitted (a host can close the doors again); everything else is
one-way. `ended` and `cancelled` are terminal. An illegal request returns
`error { code: invalid_transition }` and changes nothing — this is what stops a host's
double-tap from producing an impossible activity.

Check-in is accepted **only** while `live`, **once** per player, and returns a 1-based
`ordinal` in arrival order.

---

## 8. Announcements

```jsonc
{
  "t": "delta",
  "announcements": [{
    "id": "an_44",
    "text": "The lantern walk starts at the first torii.",
    "fromName": "Keeper",
    "scope": { "kind": "activity", "activity": "a_7" },
    "at": 1769472000000,
    "ttlMs": 8000,
    "priority": "normal"
  }]
}
```

Scope is validated against the sender's role:

| Role | May announce to |
|---|---|
| `Guest` | nothing |
| `Participant` | nothing |
| `Host` | their own activity, or that activity's zone |
| `Admin` | anything, including island-wide |

Clients show the highest-priority new announcement as a toast; a burst does not queue six
toasts in sequence. All of them remain readable on the notice board until their TTL
expires.

---

## 9. Reconnection and resume

```
  ├─ (socket closes) ─────────────────────│  player marked away: true,
  │                                        │  broadcast to the room, grace timer starts
  │   backoff: 600 ms → 15 s, full jitter  │
  │   immediate retry on `online` event    │
  │   or when the tab is foregrounded      │
  │                                        │
  ├─ hello { resumeToken } ──────────────▶│  verify HMAC, check grace window
  │◀────── welcome { resumed: true }       │  identity, role and activity restored
  │◀────── snapshot { … }                  │
```

Resume tokens are opaque and HMAC-signed with `SESSION_SECRET`. An invalid or expired
token is **ignored rather than rejected** — the client silently becomes a new visitor,
which is a far better outcome than an error screen.

Rotating `SESSION_SECRET` invalidates every outstanding session. That is the intended
mechanism for forcing a global reconnect.

**Full jitter on the backoff is not optional.** Without it, a server restart brings every
client back simultaneously and knocks it over again.

---

## 10. Errors and rate limits

```jsonc
{ "t": "error", "code": "activity_full", "message": "That one is full", "fatal": false }
```

Non-fatal errors describe a problem with the **last request**, not the connection; the
socket stays open. A rejected activity join must never cost you the world.

| Code | Fatal | Meaning |
|---|---|---|
| `version_mismatch` | yes | Client protocol version unsupported. Do not reconnect. |
| `bad_message` | no | Malformed or failed validation. |
| `rate_limited` | no | Token bucket exhausted. Not surfaced to the player. |
| `forbidden` | no | Role insufficient. |
| `not_found` | no | Unknown activity, room or interactable. |
| `room_full` / `activity_full` | no | At capacity. |
| `invalid_transition` | no | Illegal activity lifecycle change. |
| `kicked` | yes | Removed by an admin. Resume token cleared. |
| `server_shutdown` | yes | Graceful shutdown. Client *does* reconnect (with backoff). |
| `internal` | no | Server-side fault; logged with a correlation id. |

Rate limits are per-connection token buckets: `move` 15/s, `emote` 2/s, `chat` 1/s,
everything else 10/s.

---

## 11. Changing the protocol

**Backwards compatible** (no version bump): adding an optional field; adding a new
message type that old clients can ignore; adding an enum member that old clients treat as
unknown.

**Breaking** (bump `PROTOCOL.VERSION`): changing the meaning, type or units of an existing
field; changing the packing layout of `PackedTransforms`; removing a message type; making
an optional field required.

Deploy order for a breaking change: ship a server that accepts both versions → deploy
clients → remove the old version from the server.
