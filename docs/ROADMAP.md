# Scope and roadmap

---

## 1. What is built

Everything below is implemented; the last list says what the automated
tests cover.

### World
- One Japanese island about 250 m across, generated entirely from code: six places on a
  hexagon around a central mountain, sea on every side.
- Ten zones — South Harbour, Main Plaza, Notice Board, Old Street, North Harbour,
  Lighthouse Cape, Shrine, Summit, Sunset Beach, and the Ring Road that catches everything
  else — each named in English, Japanese and Chinese, with a caption in all three.
- Five surveyed routes, every metre walkable at a legal grade: the 493 m ring road, the
  summit road, the shrine path, the harbour lane and the lighthouse path.
- 134 hand-placed landmarks from a procedural prop library — piers, boats, warehouses,
  torii, machiya, minka, a teahouse, shrine halls, a lighthouse, stages, bell towers, a notice
  board — plus the games' own furniture: eight stamp stands, the omikuji box and a rod rack.
- Roadside lanterns dealt out along the routes by rule, with vetoes recorded from inside the
  world; instanced boulders, grass tufts and driftwood placed by rejection sampling.
- Custom sea shader with baked bathymetry driving depth colour and shoreline foam.
- Sky dome and a three-light rig on a 90-minute day/night cycle, synchronised to server
  time so everyone shares the same dusk — and the same programme.
- Synthesised per-zone ambience, six families, crossfaded on zone change.
- The island is a swappable map pack; a second one (`lantern-atoll`) ships.

### Multiplayer
- Server-authoritative rooms with 10 Hz snapshot/delta synchronisation, each delta encoded
  once and sent compressed.
- Packed integer transforms: measured, a visitor in a full shard of 108 receives ~8.6 KB/s
  on the wire (~29 KB/s decoded) — everything the server sends, not the transforms alone.
- Client-predicted movement with server speed/walkability validation and hard corrections.
- Remote-player interpolation at a 200 ms delay, with animation recovered from observed
  motion so legs never skate.
- Presence, emotes, name tags, per-zone occupancy, a minimap.
- Reconnection with signed resume tokens and a 45-second grace window; disconnected
  players fade rather than vanish. After a longer outage or a restart, you come back to the
  same island and where you were standing.
- Public shards with population-biased matchmaking.
- **Private islands**: five-letter invite codes, `?island=` links, a keeper who is admin
  there and only there, a persisted registry so links outlive everyone leaving and a
  restart, and rooms that sleep when empty and wake on their code.
- **Visitor profiles** keyed by a hashed browser key: stamp card, fish book, badges, the
  badge you wear.

### Talking
- A chat log with speech bubbles over the speaker; arrivals and departures as quiet lines.
- Whispers (`/w`, reply with `/r`) delivered to both ends only.
- Player cards: follow someone, challenge them to janken, whisper, add them as a friend,
  block them on your own screen; admins also mute, kick and make hosts.
- Friends: asked for on the player card and accepted while the ask stands; the people
  panel shows whether each friend is on and which island they are on — a private one
  included — and takes you there.
- A notice board that can be signed: a line of up to 80 characters, kept across restarts.

### Activities and the island's day
- Nine templates across six venues, each with a title and blurb in three languages.
- A daily programme per room — the treasure hunt in the small hours, derby at dawn, morning
  assembly, two quizzes, the market, the lamp lighting, the lantern walk, the concert,
  fireworks — kept on every room's board
  by the scheduler, without duplicates across restarts.
- A lifecycle that runs itself: doors open five minutes early, things start on time unless a
  present host is holding them (for at most three minutes), anything that could not happen
  is cancelled, and finished things are cleared off.
- Features that do something while live: the quiz, the derby, the fireworks show, the
  concert, lanterns carried on the lantern walk, the lighthouse lamp, the treasure hunt.
- Participant and audience modes, capacity enforcement, ring-based crowd placement.
- Check-in with arrival ordinals, visible to everyone as `checkedIn`.
- Announcements scoped to an activity, a zone or the island, gated by role, and toasted only
  to the people they are addressed to.
- Roles computed per room, a pure-function permission layer, an append-only audit log, and
  admin scheduling of any template from the host panel.
- Seats that hold one person.

### Games
- The ○× quiz, answered by where you stand, judged by the server; a 90-statement bank in
  three languages.
- Fishing at five spots, 19 catches with rarity and size, night-only species, today's
  records, and the dawn derby with a live leaderboard.
- The shrine's omikuji, one slip a day by Japan's calendar.
- A stamp rally across eight places.
- Janken between neighbours, with hidden hands, tie replays and a forfeit clock.
- Fireworks from two shores, and a show after dark.
- Four bells that everyone in earshot hears, spatialised; two viewpoints the camera turns to
  take in.
- Weather off the island clock — fair, grey, rain — with umbrellas in the rain, mist round
  the mountain's shoulders when it clouds over, and fireflies at the shrine on nights without
  rain.
- A treasure hunt in the small hours: three things buried at random, hot-or-cold digging
  that everyone nearby can read, and a board of finds.
- Today's tasks: three a day, the same for everyone, with a streak and a badge at seven days.
- Dice, nine badges, and titles worn under your name.

### Interface
- Simplified Chinese, Japanese and English throughout, following the browser, switchable.
- Game cards (quiz, fishing line, treasure hunt, omikuji slip, janken, player card) and
  panels (notice board, collection, island) that stay small and fold away.
- A photo button that saves the frame without the interface or the name plates, with a small
  paper label in the corner: the place, the date, the weather.

### Client engineering
- Three quality tiers plus a settling adaptive-resolution controller.
- Fixed-step simulation at 60 Hz, decoupled from render rate.
- Worker-based terrain meshing with a main-thread fallback.
- Zone-bucket distance culling; ranked character LOD.
- An effects layer (`fx/`) that draws the games through the ink pipeline without
  disturbing its outlines, with every sound synthesised.
- Keyboard, mouse, touch (floating virtual stick) and gamepad input.
- No art assets of any kind.

### Server engineering
- Zero runtime dependencies beyond `ws`.
- Structured JSON logging, Prometheus metrics, health and readiness endpoints.
- Per-connection token buckets with bursts, per-game cooldowns, a 16 KiB inbound frame cap,
  and classified backpressure.
- Pluggable persistence (`Store` interface, JSON-file and in-memory implementations),
  partitioned by room, with caps on every collection, atomic serialised writes, and a
  corrupt file set aside rather than overwritten.
- Graceful shutdown; static client serving from the same origin.

### Verification
- Server unit tests (`node:test`): lifecycle, permissions, rooms, reconnection, the
  movement validator, and every game through a room with a pinned random source.
- Headless world-generation checks: terrain finiteness and determinism, zone/pad/spawn
  correctness, every route walkable, every building level, every landmark kind built, the
  walkability contract between client and server.
- Two interface suites in jsdom: the whole overlay through every phase and panel, and each
  game card and panel through every state the server can put it in, in all three languages.
- End-to-end checks against a real server over real WebSockets — handshake, movement,
  corrections, the activity lifecycle, permissions, reconnect and resync, private islands,
  whispers, and every game.
- Browser tests of the whole stack: two players meeting, a private island reached by its
  invite link, a long walk with no corrections, and coming back after the server dies.

---

## 2. Deliberately not built

Each of these was considered and left out on purpose. They are listed so nobody has to
guess whether they were forgotten.

The first version of this list said Nagisa was not a chat application and not a game:
nothing to win, and no text beyond a one-line bubble. v2 moved that line, deliberately. The
product was broadened from a quiet place you pass through into a **lively hangout** — somewhere
a group of friends, a remote team or a club comes *together*, and a group needs things to do
and things to say to each other. What did not move is the register: the games are small,
ambient and done with your feet; nothing is lost, bought or ranked across the island; the
interface still folds away; and calm is still the art direction. The rows below record where
the line is now.

| Not built | Why |
|---|---|
| **Voice** | Would dominate the atmosphere and require a media server, TURN infrastructure and a much larger moderation commitment. Designed in advance and deferred — see §4. |
| **Accounts** | A random visitor key in the browser carries your profile and your private islands between visits, and the server keeps only its hash. Accounts would add a password reset flow, a privacy policy and a data-deletion obligation for what is, still, a place you visit. The cost is in §3. |
| **Heavy progression** | Progression exists in a light form — a stamp card, a fish book, a streak of days done, nine badges, one worn as a title. There is no inventory, no currency, no levels, and no leaderboard beyond the ones on a live derby or treasure hunt. A collection gives people something to point at; a scoreboard would change the register completely. |
| **Chat history and a moderation queue** | Text chat exists now (a log, bubbles, whispers), because a group that has come together has to be able to talk. But the log is the client's own since you arrived; the server keeps no history, and whispers never enter one. Moderation is mute, kick and a personal block, from inside the world. |
| **An admin dashboard** | Explicitly out of scope. Hosts run events from inside the world; admins schedule from a one-row control in the same host panel. |
| **Fast travel** | The island is small enough to cross in well under a minute, and the crossing is the product. |
| **User-generated building** | A large feature that needs its own permission model, moderation story and persistence layer. |
| **Cross-process room sharding** | Not needed below several hundred concurrent players. The path is documented in [`OPERATIONS.md`](OPERATIONS.md) § Scaling. |

---

## 3. Known limitations

Honest list of what is imperfect today.

1. **Announcement delivery is unfiltered server-side.** Scope governs who may *create* an
   announcement and — now — whom the client interrupts with a toast, but every session in
   the room still receives every announcement. Harmless at current scale; it should become a
   real filter before island-wide traffic grows.
2. **Voice is still deferred.** See §4.
3. **A profile lives in one browser.** It is keyed by a random key in `localStorage`.
   Clearing site data, a private window or another device is a new visitor: the stamp card,
   the fish book, the badges — and the keepership of any private island made from that
   browser — are unreachable from there, and the server, holding only hashes, cannot help.
4. **Private island codes are unlisted, not secret.** Five characters from a 31-letter
   alphabet is about 28.6 million codes, drawn from the system CSPRNG, and unknown codes open
   nothing — but anyone who has the link can walk in. A kick keeps a keyed visitor off for
   half an hour, not for good, and a visitor without a key not at all. There is no lock, no
   guest list and no way to change an island's code.
5. **One process.** Every room lives in one Node process and one event loop; the registry,
   the profiles and every room's state live in one JSON file, rewritten whole on each save.
   Fine at the current caps; the first thing to change before scaling out (see
   [`OPERATIONS.md`](OPERATIONS.md) § Scaling).
6. **Template `formation` is not implemented.** `seated` and `procession` are declared and
   ignored; every crowd is placed in rings. The lantern walk reads as a procession because of
   its lanterns, not because anyone follows the host.
7. **One quiz arena per map**, so one quiz at a time per room.
8. **Quality tier changes take effect on next load.** Tier controls scene content, which
    cannot be rebuilt in place without a visible hitch. The interface says so rather than
    pretending otherwise.
9. **No visual regression testing.** The world generation is verified numerically
    (finiteness, determinism, budgets), but nothing checks that the island *looks* right.
    A screenshot-diff harness would need a GPU-capable CI runner.
10. **Character animation is coarse.** Procedural cycles cannot express subtle motion. This
    is the accepted cost of shipping no rigged assets.

---

## 4. Roadmap

### Done since the last roadmap

The previous version of this section held three environment interactions, blocked on the
modelling pass, and a near-term list. All of the following are now built and are in §1:

- **The bells ring.** A world event, a synthesised bronze note placed by distance and
  bearing for everyone within earshot, and ink rings spreading from the tower. It was the strongest of the three for the reason given at the
  time: it is a channel on which one player's action is perceived by another — the world
  answering rather than text about it.
- **The viewpoints have something to look at.** The lighthouse door and the summit rail turn
  the camera out to sea and over the shrine.
- **The notice board can be signed** — the cheapest possible "somebody was here", surviving
  a restart.
- **Speech bubbles**, from the chat the protocol always carried.
- **Seat occupancy**, reserved server-side.
- **Announcement toasts filtered by scope** on the client (delivery is still unfiltered —
  limitation 1).
- **A health check that means it.** `/healthz` answers 503 when an awake room's tick loop
  has stalled, so an orchestrator restarts a frozen island; `nagisa_activities_current` is
  counted on each scrape.
- **Sleeping overflow shards come back.** A new public shard takes the lowest free number,
  so a shard that slept wakes with its own guestbook and board.
- **Room-partitioned persistence**, which retired the old limitation that every shard's
  schedule consolidated onto the first room after a restart.
- **Lanterns on the lantern walk.** The procession *reads* now; the formation itself does
  not exist yet (limitation 6).

### Voice — deferred on purpose, designed in advance

**Decided 2026-08-08: not now.** Voice waits until the rest of the world is where the author
wants it, and then goes in as one piece rather than being grown alongside everything else.

Recorded in full anyway, because the reasoning is worth more than the conclusion and
re-deriving it in two months would cost a day. Read the "which route" section below before
acting on anything here — the deferral changes the answer, and the earlier advice was written
under a premise that no longer holds.

**P2P is out, and not for the reason it looks like.** The obvious worry is NAT traversal —
raw WebRTC with STUN alone fails on roughly 15–20% of connections (symmetric NAT, corporate
firewalls, some mobile carriers), and that *is* real. But it is a solved problem: a TURN
relay takes success past 99%, at the price of paying for relayed bytes.

What actually kills P2P here is bandwidth. A mesh has every client sending N−1 streams and
receiving N−1. At 32 kbps Opus, twenty people in earshot is **~600 kbps of upstream per
client** — beyond most home connections and hopeless on mobile. Mesh tops out around 4–6
participants. `ROOM_CAPACITY` is 120 and the entire premise of the island is that people
gather, so the topology contradicts the product. Hybrid P2P (electing relay peers) is worse:
it makes the weakest uplink in the room everybody's bottleneck, and drops the room when that
person leaves.

**The shape that fits: SFU + distance-based subscription + client-side spatialisation.**

1. An **SFU** forwards rather than mixes. An MCU (server-side mixing) would halve client
   bandwidth and destroy positional audio in the same move — you cannot place a stream that
   has already been mixed. Discrete streams per speaker is the requirement.
2. **Subscribe only to the nearest 8–12 speakers**, updated as people move. This is the
   whole scalability trick: upstream is a constant 1 track, downstream is capped regardless
   of whether the room holds 12 people or 120.
3. **Position never travels on the voice channel.** The packed-transform stream already
   carries every player's position at 10 Hz to 1 cm. The client feeds that straight into a
   WebAudio `PannerNode` (HRTF). The voice transport moves audio; the game protocol answers
   "who is where" — which it already does, for free.

The server is also already holding everything the subscription decision needs: room shards,
zone membership, and every transform. "Who should hear whom" is better computed there than
guessed at on the client.

**Licensing, since it decides the build-vs-buy question:**

| | licence | free to self-host? |
|---|---|---|
| **LiveKit server** | Apache 2.0 | Yes — no seat limits, no open-core catch on the SFU |
| **mediasoup** | ISC | Yes. A Node library, so it stays in one language with this server |
| **Jitsi Videobridge** | Apache 2.0 | Yes |
| **Janus** | **GPLv3** | Yes, but the copyleft is worth a lawyer's minute if this is ever commercial |
| LiveKit Cloud / Agora / Daily / 100ms | commercial SaaS | Free tiers, then usage-based |

**LiveKit is the pick.** Apache 2.0, self-hostable at no licence cost, `setSubscribed` per
publication is exactly the distance-subscription primitive, and it ships TURN over TLS on
443 — which is what gets through the networks that block UDP outright. Its multi-node
coordination is Redis-backed, the same shape as the cross-process sharding already on this
roadmap, so the two can converge rather than fight.

Costs are infrastructure only, and modest: 100 concurrent players each subscribing to 8
tracks at 32 kbps is **~26 Mbps of egress**. One ordinary VPS. (Managed SFUs typically bill
per *subscribed* stream-minute, and proximity voice means everyone subscribes to eight of
them — price that carefully before choosing a hosted tier over a box.)

**Constraint added 2026-08-08: no paid services, a VPS is fine.** That removes the hosted
tiers and reorders the rest — with nothing to buy, the scarce resource is the maintainer's
time and the VPS's monthly bandwidth, not money.

Three self-hosted routes, in the order they should be attempted:

1. **Opus over the existing WebSocket.** No WebRTC, no TURN, no second service, no
   certificates beyond the ones already serving the site. The server never decodes anything:
   it forwards opaque Opus frames to whoever is near enough, which is the same fan-out the
   delta broadcaster already performs, with a distance test bolted on. `decode()` already
   takes a `Buffer`, and `ws` reports `isBinary` per message, so binary audio frames and the
   JSON protocol can share one connection cleanly.
2. **mediasoup**, if TCP stutter turns out to matter. ISC, a Node library rather than a
   service, so it runs *inside* this server process and reuses the room membership, the auth
   and the positions that already live there — no parallel notion of who is in what room.
   The cost is writing the signalling (transport setup, ICE exchange, produce/consume), which
   is real but which this codebase already has a typed message channel for.
3. **LiveKit self-hosted**, if the priority is having it working rather than having it
   in-process. One Go binary, TURN included, subscription API included. It brings its own
   Room/Participant concepts to keep in step with ours, which is a known and small tax.

**What self-hosting actually costs, since it is bandwidth and not licences.** Voice is
cheap if three things are true, and expensive if any of them is not:

- **Opus at 16–24 kbps**, not 32. Mono speech is fine there.
- **Proximity subscription**, so a listener averages 4–5 streams rather than the whole room.
- **Voice activity detection**, so silence is not relayed. Without it every player pays for
  everybody else's empty room tone all evening.

With all three: ~100 kbps down per listener, **45 MB per listener-hour**. A hundred people
talking for an hour is ~4.5 GB, so an ordinary 2 TB/month VPS carries roughly 440 hours of
100-concurrent voice. Drop VAD and raise the bitrate and the same box does a quarter of that.
CPU is close to free either way — nothing on the path transcodes, and only an MCU would.

**Which route — and how the deferral changes it.**

The original advice was "start with Opus over the existing WebSocket": no WebRTC, no NAT, no
TURN, no signalling, no second auth path, reusing the connection that already carries resume
tokens and reconnection. Its cost is TCP head-of-line blocking — stutter under packet loss and
100–300 ms more latency than WebRTC, which disqualifies it for a competitive game and probably
does not for a quiet island where people stand around talking.

Every bit of that argument rested on one premise: **that the fastest possible answer to "does
voice make this island better?" was worth more than doing it properly the first time.** Days
of work against weeks, and the spatialisation half is transport-independent, so little is lost
by proving the feel and migrating later.

The decision to defer removes that premise. Building this later, deliberately, in one piece
means there is no proof-of-feel to race toward — and the WebSocket route's throwaway half is
real: the WASM Opus encoder, the framing, the jitter buffer and the server relay all get
deleted on migration. It is also the harder of the two to separate afterwards, because its
relay lives *inside* the game server process, where an SFU is already its own process on a
port.

**So when voice is built, build LiveKit self-hosted directly.** The WebSocket route was the
right first step for a project that wanted to know tonight. It is the wrong first step for one
that has decided to wait.

**It can share the existing VPS, and should to begin with.** The deployment today is nginx
terminating TLS on 443, Docker Compose, Node on 8787. LiveKit fits beside that with three
things to get right:

- **The 443 collision.** nginx holds 443; LiveKit's TURN/TLS wants it too, and wanting it is
  the entire point — TLS on 443 is what survives networks that block UDP outright. Best first:
  SNI routing (HAProxy, or nginx's `stream` module with `ssl_preread`) sending
  `turn.<domain>` to LiveKit and everything else to the existing nginx. Otherwise a second IP,
  which most providers sell for pocket money. Otherwise put TURN on 5349 and accept losing the
  strictest networks — fine to start, easy to revisit.
- **Docker and the UDP range.** LiveKit wants ~10 000 UDP ports for media. Publishing those
  through Docker's userland proxy is a known disaster — slow start, enormous memory. Give that
  container `network_mode: host` and set `use_external_ip: true`.
- **The asymmetry, which is the only real risk.** An SFU forwards without transcoding, so CPU
  is light. But *voice stuttering is annoying and a jittering game tick is fatal* — the 10 Hz
  tick is latency-sensitive in a way voice is not, and if LiveKit saturates the NIC or spikes
  the CPU, movement degrades for everyone including the people with no microphone. Cap the
  container's `cpus` so it cannot starve the game loop, and **add a tick-jitter metric to
  OPERATIONS.md's table** — that number, not a hunch, is what should decide when the two stop
  sharing a box.

Bandwidth shares one monthly cap, and voice will take the larger part of it: game traffic
measures ~8.6 KB/s per visitor on the wire in a full shard (OPERATIONS.md §6), so a hundred
players is ~7 Mbps against voice's ~10 Mbps. Roughly **60% of egress becomes voice** the day
it ships. At this scale 2 vCPU / 4 GB carries nginx, the game server
and the SFU together; the binding constraint is the network, not the compute.

**Things that will bite, noted while they are fresh:**
- **WebTransport** (unreliable datagrams without WebRTC) is where this is heading, but
  Safari support has trailed. Not a primary path while this is a mobile-capable web world.
- **Mobile battery.** Continuous upstream plus eight decoders is expensive. `ClientHello`
  already carries `caps: { mobile, lowMemory }`; the subscription cap belongs there.
- **Moderation is not optional** in a public world: self-mute, block-a-player, and an
  admin mute. It hangs off the existing `Role` and `permissions.ts` — do not grow a second
  authority for it.
- **Zone ambience must duck** when someone nearby speaks, or the two layers smear.

### Next — finish what is started
- **Announcement scope filtering server-side** (limitation 1).
- **A tick-jitter metric**, which the voice plan asks for, beside the tick duration.
- **Procession and seated formations** (limitation 6): followers behind the host up the
  shrine path; the concert's crowd sitting on the sand.
- **Carry a profile to another browser** (limitation 3): a short one-time transfer code
  shown in the collection panel, redeemed in the other browser, re-keying the profile and
  any keeperships. No account, and no new secret to guard.
- **Keeper tools for private islands** (limitation 4): a way to retire a code and issue a
  new one, and a guest list for an island that should not be open to anyone with the link.

### Medium term — deepen the world
- **Interior spaces** — the shrine hall and the teahouse are currently solid. Making two of
  them enterable would add somewhere to be when it rains.
- **A second island in play.** `lantern-atoll` exists as a map pack, but a server runs one
  map; letting a private island choose its map — or reaching another island by the boats
  already moored at the harbour — would be the real test of the room and map abstractions.
- **More for groups to do together**, in the same register: a second quiz arena, team
  quizzes for a team's island, a quiz bank a keeper can extend.
- **Spectator camera for hosts** — a free camera while running an event, without leaving
  the world.
- **Recorded events** — replay a delta stream. The ring buffer and tick numbering already
  make this straightforward.

### Longer term — scale and openness
- **Cross-process sharding** with sticky routing, a shared island registry and a Redis or
  Postgres store (limitation 5).
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

v2 is a test of the rule, not an exception to it. Everything it added is something to do in
the world — a circle to stand in, a pier to fish from, a bell to ring — and each game's
interface is a card that appears while you are playing and goes away when you stop.
