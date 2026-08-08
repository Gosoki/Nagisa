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

### Voice — decided in principle, not scheduled

Discussed 2026-08-08. Recorded now because the reasoning is worth more than the conclusion,
and re-deriving it in two months would cost a day.

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

**A cheaper first step worth taking seriously.** Opus over the existing WebSocket: no
WebRTC, no NAT, no TURN, no signalling, no second auth path — it reuses the connection that
already has resume tokens and reconnection. The cost is TCP head-of-line blocking: stutter
under packet loss, and 100–300 ms more latency than WebRTC.

For a competitive game that is disqualifying. For a quiet island where people stand around
talking, it may well not be — 250 ms is close to unnoticeable in conversation. It is days of
work against weeks for an SFU, and **the spatialisation half (PannerNode driven by the
existing transform stream) is identical either way**, so nothing is wasted by proving the
feel first and migrating the transport later.

**Things that will bite, noted while they are fresh:**
- **WebTransport** (unreliable datagrams without WebRTC) is where this is heading, but
  Safari support has trailed. Not a primary path while this is a mobile-capable web world.
- **Mobile battery.** Continuous upstream plus eight decoders is expensive. `ClientHello`
  already carries `caps: { mobile, lowMemory }`; the subscription cap belongs there.
- **Moderation is not optional** in a public world: self-mute, block-a-player, and an
  admin mute. It hangs off the existing `Role` and `permissions.ts` — do not grow a second
  authority for it.
- **Zone ambience must duck** when someone nearby speaks, or the two layers smear.

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
