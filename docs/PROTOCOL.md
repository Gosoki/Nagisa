# Wire protocol

Everything real-time travels over one WebSocket at `/ws`. There is no second channel and
no REST call in the hot path.

Authoritative definitions live in
[`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts) — this document
explains the *flows*; the source is the spec. What each game *means* — the quiz's phases,
when a fish bites, what a badge takes — is in [GAMES.md](GAMES.md); this page covers only
how those things travel.

---

## 1. Constants

| Constant | Value | Notes |
|---|---|---|
| `VERSION` | `2` | Sent in `hello`, echoed in `welcome`. Bumped on any breaking change. |
| `TICK_HZ` | `10` | Server broadcast rate. |
| `MOVE_SEND_HZ` | `10` | Client transform report rate. |
| `PING_INTERVAL_MS` | `5 000` | Client heartbeat. |
| `IDLE_TIMEOUT_MS` | `20 000` | Server closes a silent connection. |
| `SESSION_GRACE_MS` | `45 000` | How long a disconnected player stays in the room. |
| `DELTA_HISTORY_TICKS` | `120` | Deltas retained per room for replay. |
| `INTERPOLATION_DELAY_MS` | `200` | How far in the past remote players are rendered. |
| `POS_SCALE` / `YAW_SCALE` | `100` / `1024` | Quantisation: 1 cm, ~0.35°. |
| `MAX_NAME_LENGTH` | `20` | Code points, after cleaning (§11, *Text*). |
| `MAX_CHAT_LENGTH` | `140` | Island chat and whispers alike. |
| `MAX_ANNOUNCEMENT_LENGTH` | `240` | |
| `MAX_GUESTBOOK_LENGTH` | `80` | A signature, not a letter. |
| `VISITOR_KEY_MIN` / `_MAX` | `16` / `64` | `VISITOR_KEY_PATTERN` is `[A-Za-z0-9_-]{16,64}`. |
| `RATE_LIMIT` | per type, below | A token bucket per message type per connection. |

`ROOM_CODE_ALPHABET` is `23456789ABCDEFGHJKMNPQRSTUVWXYZ` — no 0/O, no 1/I/L, so a code
survives being read aloud or copied off a phone — and a code is `ROOM_CODE_LENGTH = 5` of
them. `normaliseRoomCode()` accepts what people actually type (`"ab c2d"`, `ab-c2d`).

### Transport limits

- **Inbound frames are capped at 16 KiB** (`maxPayload` on the `ws` server). The largest
  thing a client legitimately sends is a line of text; without a cap, `ws` accepts frames
  up to 100 MiB, and one of those parsed as JSON is enough to take the process down.
- **`permessage-deflate` is on** (zlib level 3, frames under 512 bytes are not compressed).
  The packed transform stream is integers and compresses several-fold; pings and single
  moves are not worth the CPU.
- **Connections are capped** at `MAX_CONNECTIONS` in total and, when configured,
  `MAX_CONNECTIONS_PER_IP` per client address. A socket over either cap is closed at once
  with code **1013** (`server_busy`) — before `hello`, with no error frame.
- **`hello` within 10 s**, or the socket is closed with code **4001** (`no_hello`).
- **Invalid frames** — unparsable JSON, or a `t` that is not a client message type — are
  answered with `bad_message` for the first three, then ignored, and after twenty the socket
  is closed with code **1008** (`invalid_frames`). The type is checked against the real
  message list before it is used for anything else. Only a frame the server understood
  resets the idle timer.
- **Idle for 20 s** (`IDLE_TIMEOUT_MS`: no frame the server understood), and the socket is
  closed with code **4000** (`idle_timeout`); the player enters the grace window like any
  other disconnect.
- **Taken over by another socket** — a resume token naming a player who is still connected
  (§9) — and the old socket is closed with code **4002** (`replaced`). The client does not
  reconnect after 4002.
- **A fault while handling `hello`** closes the socket with code **1011**
  (`internal_error`), after a fatal `internal` error frame (§11).

---

## 2. Connection

```
client                                server
  │                                     │
  ├─ WebSocket open (/ws[?admin=…]) ──▶│
  │                                     │
  ├─ hello {protocol, name, appearance, │
  │         resumeToken?, at?, room?,   │
  │         visitor?, caps?}           ▶│  validate version
  │                                     │  resume, or create a player
  │                                     │  pick a room (id, invite code, or matchmaker)
  │◀────── welcome {self, resumeToken,  │
  │                 resumed, room,      │
  │                 serverTime, tickHz, │
  │                 mapId, rooms,       │
  │                 profile}            │
  │◀────── snapshot {…}                 │
  │                                     │
  ├─ ping {t0} ───────────────────────▶│  every 5 s
  │◀────── pong {t0, serverTime}        │
  │                                     │
  ├─ move {pos, yaw, anim, seq} ──────▶│  10 Hz, dead-banded
  │◀────── delta {tick, moves, …}       │  10 Hz
```

`welcome` is **always** followed immediately by a `snapshot`. A client that has a welcome
but no snapshot is in an undefined state and should wait, not render.

### What `hello` carries

| Field | Meaning |
|---|---|
| `protocol` | Must equal the server's `VERSION`. |
| `name`, `appearance` | Cleaned server-side (`apps/server/src/text.ts`): control characters, bidirectional overrides and isolates, zero-width characters (joiners included), LRM/RLM, the BOM and line separators removed, whitespace collapsed, cut to 20 code points; empty becomes `Visitor`. Appearance indices clamped. |
| `resumeToken` | Resume a player the server is still holding — in its grace window, or still connected, in which case the old socket is closed with 4002 and this one takes over (§9). Invalid or expired tokens are ignored, not rejected. |
| `at` | Where the client last stood. Used for a *new* player's spawn when it survives the walkability contract: finite, inside the map, and within 6 m of walkable ground after snapping. Otherwise the player lands at a harbour. See §9. |
| `room` | A room id **or a private island's invite code**. A registered code the server is not currently holding re-opens that island. An unknown code, a full island or too many awake islands means the player is matchmade onto a public shard instead and then told why (`error` with `key` `room_not_found`, `full` or `islands_busy`). |
| `visitor` | This browser's visitor key. The server hashes it (SHA-256) and keys a profile by the hash; the key itself is never stored. Absent or malformed means a profile that lasts only for this session. |
| `caps` | `{ mobile, lowMemory }`. Advisory. |

**Admin is not in `hello`.** It is granted from the upgrade URL — `/ws?admin=<ADMIN_TOKEN>`
— and never from a message, so it is decided once per connection, by a constant-time
comparison. The client takes the token out of the address bar when it reads it and keeps it
in `sessionStorage` for the tab.

### What `welcome` carries

`self`, a fresh `resumeToken`, `resumed`, the `room` you are in (`RoomView`), `serverTime`,
`tickHz`, `mapId` (the client refuses to enter a world it did not load itself — see
`ServerWelcome.mapId`), `rooms` (every public shard, plus your own room if it is private —
somebody else's island is never listed), and `profile` (`ProfileView`: your stamps, fish
book, badges, the badge you wear, today's omikuji, treasures found, and today's tasks with
the streak; `persistent: false` when there was no usable visitor key).

### Version mismatch

If `hello.protocol` is not the server's version, it replies with
`error { code: version_mismatch, fatal: true }` and closes. The client does **not**
reconnect — retrying against a wall achieves nothing — and asks the player to reload. The
server speaks exactly one version: v1 clients are refused, because they cannot render any of
v2 and would silently miss half the island.

---

## 3. Heartbeat and the clock

`ping` carries the client's local `t0`; `pong` echoes it with the server's time.

Round-trip time is `now - t0`. The clock offset is estimated NTP-style —
`serverTime + rtt/2 - now` — but **only from the lowest-RTT sample seen so far**, because
a congested sample would drag the estimate around by tens of milliseconds.

The offset matters: the day/night cycle, the island's programme, every activity countdown,
the quiz's `endsAt` and a firework's `at` all run on server time, so a visitor with a
badly-set system clock still sees the same dusk, and the same countdown, as everyone else.

A connection with no inbound frame the server understood for `IDLE_TIMEOUT_MS` is closed. The
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
  "zonePopulation": { "plaza": 14, "south-harbor": 3 },
  "guestbook": [ /* GuestbookEntry, oldest first */ ],
  "quiz": null,                                 // or the QuizView in progress
  "daruma": null                                // or the DarumaView in progress
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
  "players": [ { "id": "p_4", "zone": "shrine", "activity": "a_7", "mode": "audience", "checkedIn": false } ],
  "activities": [ /* full ActivityView objects — small and rare */ ],
  "activitiesRemoved": [ "a_3" ],
  "announcements": [ /* AnnouncementView */ ],
  "emotes": [ { "id": "p_2", "emote": "wave" } ],
  "chats":  [ { "id": "p_5", "text": "over here" } ],
  "zonePopulation": { "plaza": 15 },
  "events": [ { "k": "bell", "id": "shrine-bell", "by": "p_5" } ],
  "guestbook": [ /* new GuestbookEntry */ ],
  "guestbookRemoved": [ "g_12" ],
  "quiz": { /* QuizView */ },                   // null = over; absent = unchanged
  "daruma": { /* DarumaView */ }                // likewise
}
```

Activities are sent whole rather than as patches: they are small, they change rarely, and
a whole object cannot be applied in the wrong order. `quiz` and `daruma` are three-valued on
purpose: absent means nothing changed, `null` means the game is over and its card should go.

The server encodes each tick's delta **once** and hands the same string to every session in
the room; at 10 Hz, stringifying the same object a hundred times was most of the tick.

### What rides in `players`

Non-transform changes to a `PlayerView`: `zone`, `activity`, `mode`, `role`, `away`,
`checkedIn` (checked in to the activity they attend — cleared whenever that attachment
changes) and `title` (the badge they wear, or `null`).

### Packed transforms

Six integers per moving player:

```
[ idIndex, x·100, y·100, z·100, yaw·1024, anim ]
```

`idIndex` refers to `moves.ids`, which is **re-sent only when room membership changes**.
Quiet ticks therefore carry integers and nothing else, and `permessage-deflate` compresses
runs of similar integers extremely well.

`anim` is an `AnimState`: `Idle 0`, `Walk 1`, `Run 2`, `Jump 3`, `Fall 4`, `Sit 5`, `Clap 6`,
`Wave 7`, `Bow 8`, `Fish 9` (holding a rod over the water, so everyone sees the rod),
`Cheer 10` and `Dance 11` (bon-odori at the concert: the arms move on a beat read off the server clock, so everyone dancing is in step and nothing but the state is sent).

At 120 players this is ~720 integers per tick; the equivalent JSON objects would be ~60 KB/s
per client before compression. Measured (`npm run test:load`, OPERATIONS.md §6), a visitor
in a full shard of 108 receives **~29 KB/s decoded, ~8.6 KB/s on the wire** after
`permessage-deflate` — and that is everything the server sends them, not the transforms
alone.

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
snapshot requests would make a congested connection worse. The server answers with the
missing deltas from its history when it still has them, and a snapshot otherwise.

### Backpressure

When a socket's buffer passes 256 KiB, the server drops deltas that carry **nothing but
movement** — the next one repairs them. Anything else in a delta (a join, an event, a quiz
phase, a guestbook line) is a one-shot fact with no repairing successor, so such deltas are
never dropped. Neither is anything sent directly to one player.

---

## 5. Movement and correction

The client reports its own transform at 10 Hz, with a dead-band: no send unless it has
moved more than 2 cm or turned more than 0.01 rad, plus a keep-alive every 2 s so a client
joining after you stopped still learns where you are.

On a plaza where two thirds of the crowd is watching rather than walking, the dead-band
removes roughly two thirds of upstream traffic for free.

The server validates each report (`Player.applyMove`):

- drops reports whose `seq` is not newer than the last accepted one;
- rejects `NaN` / `Infinity`;
- clamps horizontal distance against `MAX_SERVER_SPEED` (the client's run speed plus
  2.5 m/s of headroom) times the elapsed time, and vertical distance against 16 m/s, each
  with slack for arrival jitter — two and a half reports' worth of running (4.5 m), so a
  burst of reports held back by a radio stall is not snapped back;
- rejects a step that `canEnterFrom` refuses — steep ground may be entered from above, never
  climbed onto (`packages/shared/src/movement.ts`, `terrain.ts`);
- allows a band from 1.5 m below to 6 m above `heightAt`, so jumping is not treated as
  flight.

A failed report produces:

```jsonc
{ "t": "correction", "pos": [x, y, z], "yaw": 1.2, "reason": "speed" | "bounds" }
```

With `reason: "teleport"` it is the island moving the player by its own decision — a race of
だるまさんがころんだ putting its racers on the start line, or sending back one it saw moving.
The client treats that as a move, not a disagreement: a walk under way, a follow and a seat all
end, and it faces the `yaw` it was given. Until a report arrives from within a metre of the spot,
the server answers every report with the same correction rather than believing it — the ones
already in flight describe where the player was — so a move can never be undone by the
client's own lag (`Player.relocate`). `stage` is also in the type; the server does not send it.

The client **hard-snaps**. Blending would fight the server and produce a rubber-band.
Corrections are not surfaced to the player: they are almost always a terrain edge case,
not cheating, and a warning would make an invisible problem visible.

---

## 6. Rooms

A room is either a **public shard** (`RoomView.kind: 'public'`, id `shore-N`) — what
matchmaking fills — or a **private island** (`kind: 'private'`, id `isle-CODE`, carrying
`code` and `ownerName`), reached only by its code. Same geography, same programme,
different people. See [GAMES.md §2](GAMES.md#2-rooms-public-shards-and-private-islands).

```
client                                      server
  ├─ room_switch { room: "shore-2" | "K7QPM" } ─▶│  resolve id or code, capacity check
  │◀────── room_changed { room, role, rooms,    │
  │                       resumeToken }         │
  │◀────── snapshot { … }                        │

  ├─ room_create {} ────────────────────────────▶│  mint a code, register you as keeper
  │◀────── room_changed { room: {kind: "private", code, …}, role: 3, … }
  │◀────── snapshot { … }
```

`room_changed` carries your **role in the new room** (a keeper is `Admin` on their own
island and nowhere else), the room list from the new room's point of view, and a **fresh
resume token** bound to the new room — the old one names a room you are no longer in.

A switch lets go of everything that belonged to the old room — the activity and its
check-in, hosting, your seat, your fishing line, any duel — and puts you at the new
island's harbour.

On `room_changed` the client clears its remote-player set and resets its tick baseline
**before** the new snapshot arrives, so there is never a frame showing the previous room's
crowd in the new room's geometry. It also rewrites the address bar to `?island=CODE` (or
removes it on a public shard), so a reload returns you there and a copied URL is an
invitation.

Refusals are `error` frames with a `key`: `room_not_found` (no island has that code),
`full`, `islands_busy` (too many private islands awake to wake another), and for `room_create`
`cooldown {seconds}` (one island per connection per 30 s).

A keeper — or an admin — can name the private island they are on with
`room_title { title }` (cleaned like a player name, at most 24 characters; empty takes the
name away). Everyone on it is sent `room_info { room }` with `RoomView.title` set, friends'
lists show it in place of the code, and it is kept in the island registry across sleep and
restarts. Anyone else, or anywhere public, gets `error { key: "forbidden" }`.

Matchmaking (`rooms.ts`) deliberately **fills the fullest public shard that still has
comfortable headroom** rather than balancing evenly, and never places anyone on a private
island. Two half-empty islands feel worse than one busy one; this is a product requirement
expressed as a scheduling policy.

---

## 7. Activities

```
client                                     server
  ├─ activity_join { activity, mode } ────▶│  capacity, state checks
  │◀────── delta { players: [{id, activity, mode, checkedIn}], activities: [updated counts] }
  │
  ├─ checkin { activity } ────────────────▶│  only while state === "live"
  │◀────── checkin_ack { ok, ordinal }     │
  │◀────── delta { players: [{id, checkedIn: true}] }
  │
  ├─ activity_leave { activity } ─────────▶│
  │◀────── delta { players: [{id, activity: null}] }
```

`ActivityView` carries, beyond its schedule and counts, `templateId` (the client's key for
the localised title and the venue's effects), `feature` (`quiz`, `derby`, `fireworks`,
`concert`, `lanterns`, `lamp`, `treasure`, `daruma`, or `null`), an optional `board` — the top
few `{ id, name, score }` for an activity that keeps score (the derby's biggest fish, in cm; a
hunt's finds; a race's places, in seconds taken) —
and, for a treasure hunt, an optional `left`: how many things are still buried.

Lifecycle, with transitions validated server-side by `canTransition`:

```
scheduled ──▶ open ──▶ live ──▶ ended
     │          │
     └──────────┴──▶ cancelled
```

A host drives it with `host_activity_state { activity, state }`; an illegal request returns
`error { code: invalid_transition, key: "invalid" }` and changes nothing. An admin puts a
template on the programme with `host_schedule { template, inMin }` (0–120 minutes from now).
The island also moves every activity along by itself; the rules are in
[ACTIVITIES.md](ACTIVITIES.md) §3–4.

Check-in is accepted **only** while `live`, only for someone attending, **once** per player,
and returns a 1-based `ordinal` in arrival order. `checkin_ack.reason` on failure is
`not_found`, `not_live`, `already` or `not_attending`.

The register itself — who checked in, in what order, when — is asked for with
`checkin_list { activity }` and answered with `checkin_list { activity, list: [{ ordinal,
name, at }] }`. Only the activity's host or an admin may ask (anyone else gets
`error { key: "forbidden" }`); the name is the one the player had when they checked in, so
the register still reads right after they leave or rename. Records saved before names were
kept show `…`.

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

`ttlMs` is clamped to 5 s – 10 min (default 60 s). The island itself announces too, as
`渚 Nagisa` — the derby's podium, a quiz's winners, a race's places.

**Delivery is not filtered by scope.** Every session in the room receives every
announcement. The client decides who is interrupted: it shows a toast only for
announcements addressed to you (island-wide, your zone, or the activity you attend), and
only the highest-priority one in a tick, so a burst does not queue six toasts. All of them
remain readable on the notice board until their TTL expires.

---

## 9. Reconnection and resume

```
  ├─ (socket closes) ─────────────────────│  player marked away: true,
  │                                        │  broadcast to the room, grace timer starts;
  │                                        │  line reeled in, duel called off, seat freed
  │   backoff: 600 ms → 15 s, full jitter  │
  │   immediate retry on `online` event    │
  │   or when the tab is foregrounded      │
  │                                        │
  ├─ hello { resumeToken, at, room, … } ─▶│  verify HMAC, check the player is still held
  │◀────── welcome { resumed: true }       │  identity, role and activity restored
  │◀────── snapshot { … }                  │
```

Resume tokens are opaque, bound to a player id and a room, and HMAC-signed with
`SESSION_SECRET`. A token older than 24 hours is refused outright. The client keeps its
token **per tab**, in `sessionStorage`: it survives a reload and a dropped socket and is not
shared with a tab opened fresh. A *duplicated* tab, though, copies `sessionStorage`, and
comes up presenting the original's token. The server resumes a player named by a valid token
even while that player is still connected — the old socket may be a half-open one the server
has not yet noticed dying — so the newer socket takes the player over and the old one is
closed with **4002** (`replaced`). The tab that was replaced does not reconnect, since coming
straight back would take the player back again and the two tabs would push each other off
for ever; it says the island was opened in another tab and offers **Continue here**, which
takes the player back on the person's say-so. An invalid or expired
token is **ignored rather than rejected** — the client silently becomes a new visitor,
which is a far better outcome than an error screen.

Past the grace window, or across a server restart, there is nobody left to resume. Two
things still bring you back to where you were:

- **`hello.room`** — the client sends the invite code of the private island it was on, so
  you land on the same island (re-opened if it had gone to sleep);
- **`hello.at`** — the client remembers its pose (`net/last-pose.ts`, kept for six hours in
  `localStorage`) and offers it; the server re-derives it through the walkability contract
  before using it as your spawn, so a claim can never put a player inside a hill, out at
  sea or hovering.

Rotating `SESSION_SECRET` invalidates every outstanding session. That is the intended
mechanism for forcing a global reconnect.

**Full jitter on the backoff is not optional.** Without it, a server restart brings every
client back simultaneously and knocks it over again.

---

## 10. Games and world events

Semantics are in [GAMES.md](GAMES.md); these are the messages.

**Client → server**

| Message | Purpose |
|---|---|
| `interact { target, kind: "use" \| "sit" \| "stand" }` | Use an interactable within reach. What `use` does depends on its `effect`: ring a bell, draw the omikuji, take a stamp, start fishing, check in. `sit` reserves the seat (`seat_taken` if someone present holds it). |
| `fish { action: "cast", spot }` / `{ action: "hook" }` / `{ action: "stop" }` | Cast at a fishing spot, strike, reel in. |
| `janken { action: "challenge", target }` / `{ action: "respond", duel, accept }` / `{ action: "throw", duel, hand }` | Rock, paper, scissors with someone near you. |
| `roll { sides? }` | A die with 2–1000 sides, default 100. |
| `firework { hue?, pattern? }` | Send one up from a firework shore. `hue` 0–1, `pattern` 0–3; omitted means the server picks. |
| `guestbook_write { text }` | Sign the notice board, standing at it. |
| `guestbook_remove { id }` | Take a line down: your own, or any if admin. |
| `set_title { badge \| null }` | Wear a badge you hold under your name, or none. |
| `dig` | Dig where you stand, while a treasure hunt is live. One per 1.5 s per visitor key, and none in the first 5 s after arriving. |
| `friend { action, target }` | `request` a player here (`target`: their id) to be friends; `accept` / `decline` an ask or `remove` a friend by its opaque id. Both sides need a visitor key. |
| `chat { text, to? }` | With `to`, a whisper: delivered to both ends only, never in a delta, never bubbled. |

**Server → client, to one player only**

| Message | Purpose |
|---|---|
| `profile { profile }` | Your `ProfileView` changed. |
| `friends { friends, requests, enabled }` | Your friends (`id`, `name`, `online`, and while online `player` and `room`) and the asks waiting for you — sent after the welcome and whenever any of it changes. |
| `fish { phase, … }` | Your line: `waiting`, `bite` (with `window` ms), `caught` (`fish`, `size`, `newSpecies`, `record`, `personalBest`), `escaped` (`reason`: `early`, `late`, `moved`), `idle`. |
| `omikuji { fortune, item, direction, again }` | Your slip; indices into the shared tables. `again` = you had drawn today already. |
| `janken { kind, duel, opponent, opponentName, … }` | Your side of a duel: `invited`, `waiting`, `start`, `result`, `cancelled`. |
| `whisper { from, fromName, to, toName, text, at }` | Sent to both ends. |
| `dig { result, left }` | What your dig turned up: `found`, or the heat of the nearest still buried (`hot` ≤ 8 m, `warm` ≤ 20, `cool` ≤ 40, `cold`). `left` = still buried. |

**World events** — `delta.events`, for everyone in the room. They ride in the tick's delta
so they are ordered with everything else that happened in that tick and replayed with it on
resync; they are never kept in a snapshot, because a bell you did not hear ring is not a
bell that is ringing.

| `k` | Fields |
|---|---|
| `bell` | `id` (the interactable), `by` |
| `firework` | `x, z` (launch point), `h` (burst height), `hue`, `pattern`, `at` (server ms), `by` (`null` for the show) |
| `catch` | `by, fish, size, record` |
| `omikuji` | `by, fortune` |
| `stamp` | `by, zone, complete` |
| `dice` | `by, value, sides` |
| `janken` | `a, b, ha, hb, winner` (`null` = a draw) |
| `badge` | `by, badge` |
| `dig` | `by, heat` |
| `treasure` | `by, pos, left` |

The quiz travels as `QuizView` in `snapshot.quiz` and `delta.quiz`, and だるまさんがころんだ as
`DarumaView` in `snapshot.daruma` and `delta.daruma` (a race needs no message of its own:
racers walk, and the server judges where they stand); the guestbook as
`GuestbookEntry` lists in `snapshot.guestbook`, `delta.guestbook` and
`delta.guestbookRemoved`.

---

## 11. Errors and rate limits

```jsonc
{ "t": "error", "code": "forbidden", "message": "cooldown", "key": "cooldown", "params": { "seconds": 4 } }
```

Non-fatal errors describe a problem with the **last request**, not the connection; the
socket stays open. A rejected activity join must never cost you the world.

| Code | Fatal | Meaning |
|---|---|---|
| `version_mismatch` | yes | Client protocol version unsupported. Do not reconnect. |
| `bad_message` | no | Malformed or failed validation. `fatal` only for a first (known) frame that is not `hello`. Unparsable frames and unknown types get it only three times per connection, and twenty close the socket (§1). |
| `rate_limited` | no | Token bucket exhausted. Not surfaced to the player unless it carries a `key`. |
| `forbidden` | no | Not allowed — and the code most keyed refusals use. |
| `not_found` | no | Unknown activity, room, player, interactable or line. |
| `room_full` / `activity_full` | no | At capacity (also used for a refused room request on `hello`). |
| `invalid_transition` | no | Illegal activity lifecycle change. |
| `kicked` | yes | Removed by an admin. The client discards its resume token. |
| `server_shutdown` | yes | Graceful shutdown. Client *does* reconnect (with backoff). |
| `internal` | usually no | Server-side fault; logged with the connection id. Fatal only when it happens while handling `hello`, and the socket is then closed with 1011. |

### `key` and `params`

A refusal the player should understand carries `key` (and sometimes `params`), which the
client looks up as `error.<key>` in its own language (`apps/client/src/i18n/core.ts`).
`message` stays English and is for logs: the client never shows it, and says something
generic in the player's language for an error without a key. Errors that are not the
player's business — malformed frames, internal faults, role checks a normal interface never
lets you attempt — carry no key.

`too_far` · `cooldown {seconds}` · `seat_taken` · `muted` · `not_here` · `full` ·
`not_found` · `forbidden` · `busy` (a janken opponent mid-duel) · `islands_busy` · `schedule_full` · `already_running` · `no_hunt` · `already_stamped` · `not_open` · `room_not_found` ·
`invalid` · `too_long {max}` · `empty` · `too_fast` (a room switch, island or chat line over
its rate limit) · `friend_needs_key` · `friend_unavailable {name}` · `already_friends {name}` ·
`friends_full {max}`

### Rate limits

A token bucket per message type per connection, refilled continuously at `rate` per second
and holding at most `burst`. The burst is what lets someone type two short lines back to
back; the rate is what stops a script.

| Type | Rate / s | Burst |
|---|---|---|
| `move` | 15 | 15 |
| `emote` | 2 | 3 |
| `chat` (whispers included) | 1 | 4 |
| `room_switch` | 0.2 | 3 |
| `room_create` | 0.1 | 2 |
| `room_title` | 0.2 | 3 |
| everything else | 10 | 10 |

Game-level cooldowns sit on top and say so when they refuse (`cooldown {seconds}`): one
private island per connection per 30 s, one firework per player per 6 s and eight per room
per 10 s, one guestbook line per 30 s, one die per 2 s, 3 s between rings of the same bell,
one dig per visitor key per 1.5 s (and none in the first 5 s after arriving), one friend
request per 3 s (and a request turned down is not passed on
again for ten minutes).

### Text

Chat lines, whispers, announcements and guestbook lines are cleaned like names, except that
the zero-width joiner and non-joiner are kept (emoji sequences and several scripts need
them), and lengths — `MAX_CHAT_LENGTH`, `MAX_ANNOUNCEMENT_LENGTH`, `MAX_GUESTBOOK_LENGTH` —
are counted in code points after cleaning, so an emoji is one character, not two. The point
is not markup (the interface never renders player text as HTML) but characters that make one
line or name display as another.

---

## 12. Changing the protocol

**Backwards compatible** (no version bump): adding an optional field; adding a new
message type that old clients can ignore; adding an enum member that old clients treat as
unknown.

**Breaking** (bump `PROTOCOL.VERSION`): changing the meaning, type or units of an existing
field; changing the packing layout of `PackedTransforms`; removing a message type; making
an optional field required.

The server checks for one exact version. v2 was deployed as a hard cut — a v1 client is
refused and asked to reload — because v1 clients could not have shown any of it. For a
breaking change that must not interrupt people, the order is: teach the server to accept
both versions → deploy clients → remove the old version from the server. That dual-version
window does not exist in the code today and would have to be written.
