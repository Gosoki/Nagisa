# Games, private islands and the v2 protocol

What there is to *do* on Nagisa, how each thing works end to end, and the rules both
sides hold to. Read with [PROTOCOL.md](PROTOCOL.md) (the transport) and
[ACTIVITIES.md](ACTIVITIES.md) (the lifecycle every scheduled thing shares).

---

## 1. What changed in v2, in one table

| | What it is | Who decides |
|---|---|---|
| **Private islands** | Make your own shard, get a five-letter code, send the link (`?island=CODE`). Whoever made it keeps it — as its admin — whenever they come back. | Server |
| **Visitor key** | A random key the browser keeps so stamps, the fish book and badges survive between visits. No account; the server stores a hash. | Client mints, server hashes |
| **The island's day** | Every room runs the same programme on the island clock (a day is 90 real minutes): the fishing derby at dawn, quizzes mid-morning and afternoon, the market at noon, the lamp at dusk, lanterns, the concert, fireworks after dark. | Server scheduler |
| **○× quiz** | True/false statements; contestants *run* to the ○ or × circle on the plaza; wrong ones are out; last standing wins. | Server reads positions |
| **Fishing** | Cast at a pier end or the beach, strike when the float goes under, land something from a table of 19 species. A derby scores the biggest fish during the dawn activity. | Server rolls every catch |
| **Omikuji** | One fortune a day (JST) at the shrine; drawing again returns the same slip. | Server |
| **Stamp rally** | A stamp stand in each of the eight places. Collect them all for the *Island Walker* badge. | Server checks you are at the stand |
| **Janken** | Challenge someone standing near you; both throw; ties replay. | Server |
| **Fireworks** | Anyone on a firework shore can send one up; the fireworks show sends up its own. | Server picks the site |
| **Bells** | The four bells ring, and everybody within earshot hears them. | Server (cooldown) |
| **Guestbook** | Sign the notice board; it survives restarts. | Server |
| **Whispers, dice** | `/w name …` reaches one person only; `/roll` rolls for everyone to see. | Server |
| **Badges** | Seven, earned by doing the above; wear one under your name. | Server |
| **Languages** | The interface speaks 中文, 日本語 and English. | Client |

The protocol version is **2**. A v1 client is refused at the handshake with
`version_mismatch`; there is no compatibility shim, because v1 clients cannot render any of
this and would silently miss half the island.

---

## 2. Rooms: public shards and private islands

`RoomView.kind` is `public` or `private`. Matchmaking only ever fills public shards; a private
island is reached by its code and is never listed to strangers (the room list a client
receives is the public shards plus the room it is in).

- **Create**: `room_create`. The server mints a code from `ROOM_CODE_ALPHABET` (no 0/O, 1/I/L),
  creates the room, moves you there (`room_changed`, carrying your new role and a fresh resume
  token) and records you — by visitor-key hash — as its keeper. Keepers are `Role.Admin`
  *in their own island only*.
- **Join**: `hello.room` or `room_switch.room` may be a room id *or* a code. A registered code
  the server is not currently holding **re-opens** the island, with its keeper: an invite link
  keeps working after everyone has left and — with `PERSIST_PATH` set — after a restart. A code
  nobody registered opens nothing (`room_not_found`; a `hello` is matchmade instead), so a
  script trying random codes cannot fill the server with empty islands. Codes come from the
  system CSPRNG.
- **Limits**: switching islands is rate-limited (a burst of 3, then one per 5 s), making one
  to one per 30 s per connection; at most 200 private islands are awake at once (`busy`
  beyond that — sleeping ones wake as others fall asleep).
- **Idle rooms** stop ticking and are dropped from memory after ten empty minutes — private
  islands and any public shard beyond the first `ROOM_COUNT`. Their registry entry (code,
  keeper, name) and their persisted state (schedule, announcements, guestbook) stay.
- **Room switch** detaches you from any activity, reels in any line, cancels any duel and
  re-spawns you at the new island's harbour. Your role is recomputed for the new room.

The client keeps the address bar on the island you are on (`?island=CODE`, or nothing on a
public shard), so a reload returns you there and a copied URL is an invitation. `?admin=` is
taken out of the address bar as soon as it is read and kept in `sessionStorage` for the tab.

---

## 3. The visitor key and your profile

`hello.visitor` is 16–64 characters of `[A-Za-z0-9_-]`, minted by the client
(`net/visitor.ts`). Anything else is ignored as if absent. The server keys a **profile** by
`sha256(key)` and never stores the key:

```ts
ProfileView = {
  stamps: ZoneId[]; stampTotal: number;
  fish: Record<fishId, { count, best }>; catches: number;
  badges: BadgeId[]; title: BadgeId | null;
  omikuji: { day, fortune, item, direction } | null;   // today's, JST
  jankenWins: number; quizWins: number;
  persistent: boolean;   // false = no usable key: works, but forgotten with the session
}
```

It arrives in `welcome.profile` and again as `{ t: 'profile' }` whenever it changes. Profiles
are capped (least recently seen evicted first) so the store cannot grow without bound.

**Badges** (`games/badges.ts`): *walker* (every stamp), *angler* (10 catches),
*master-angler* (every species but the boot), *quiz-champ* (win a quiz), *derby-champ* (win
the derby), *lucky* (draw 大吉), *janken* (10 wins). Earning one broadcasts a `badge` event.
`set_title` wears one you have (or `null`); it appears as `PlayerView.title`.

---

## 4. World events

One-shot things everyone nearby should see or hear ride in the tick's delta as
`delta.events: WorldEvent[]` — ordered with everything else in that tick, replayed with it on
resync, never kept in a snapshot.

| `k` | fields | client |
|---|---|---|
| `bell` | `id` (interactable), `by` | bell sound, spatialised; ripple at the tower |
| `firework` | `x, z, h, hue, pattern, at, by` | rocket, burst, boom delayed by distance/343 m·s⁻¹ |
| `catch` | `by, fish, size, record` | splash and a leaping fish; a chat line if near, or if `record` |
| `omikuji` | `by, fortune` | the fortune over their head; a line if near |
| `stamp` | `by, zone, complete` | a line when someone completes the card |
| `dice` | `by, value, sides` | a line and a bubble |
| `janken` | `a, b, ha, hb, winner` | both hands as bubbles; a line |
| `badge` | `by, badge` | a line |

---

## 5. Each game, end to end

### ○× quiz (`feature: 'quiz'`, template `island-quiz`, venue: plaza)

The arena is two circles on the plaza (`MapWorld.quizArena`, r = 4.5 m). When the activity goes
live the server runs a `QuizRunner`:

1. **lobby** (20 s) — `QuizView.phase = 'lobby'`. Everyone who is in the plaza zone or attached
   to the activity when the lobby closes is a contestant.
2. **question** (15 s) — a statement from the bank (`games/quiz-bank.ts`, 90 statements in
   three languages; never the same one twice in a quiz). `endsAt` is server time.
3. At `endsAt` the server reads each contestant's **last validated position**: inside ○, inside
   ×, or neither. Neither counts as wrong.
4. **reveal** (6 s) — `answer`, and `fell` (who went out). If *everyone* was wrong, nobody goes
   out: the round is replayed with a new statement rather than ending the quiz with no winner.
5. Repeat until one contestant is left, nobody is left to ask, or 8 rounds have been asked.
   **finished** (8 s) names `winners` (all survivors), who get *quiz-champ*; then the view
   is cleared and the activity ends.

A contestant who leaves the room is out. Joining after the lobby closes makes you a spectator.
The badge needs a field of at least two — a quiz won alone still counts toward `quizWins`, but
is not a championship. There is one arena, so one quiz at a time: an admin asking for another
while one runs is refused (`busy`), and a scheduled quiz that goes live during an ad-hoc one is
ended at once rather than shown as live with nothing happening.

### Fishing (`effect: 'fish'` interactables; derby: `feature: 'derby'`)

```
client                         server
fish{cast, spot}  ───────────► in reach of spot? not already fishing?
                  ◄─────────── fish{waiting, spot}          (bite scheduled 2.5–9 s)
                  ◄─────────── fish{bite, window: 1200}     (at the scheduled moment)
fish{hook}        ───────────► hooked within window (+300 ms slack)?
                  ◄─────────── fish{caught, fish, size, newSpecies, record, personalBest}
                               + event catch → everyone
```

- `hook` before the bite → `escaped/early`; after the window → `escaped/late`; the line stays
  in the water at most 30 s without a bite before the server reels it in.
- Moving more than `range + 1.5 m` from the spot, leaving the room or disconnecting reels in
  (`escaped/moved` or silently).
- The catch is rolled from `fishFor(habitat, night)` weighted by rarity; size skews small.
  `record` = biggest of that species landed in this room today (island day).
- **Derby**: while a `derby` activity is live, each participant's biggest single fish (cm) is
  their score; `ActivityView.board` carries the top five. At the end the winner gets
  *derby-champ* and an announcement names the top three.

### Omikuji (`effect: 'omikuji'`)

`interact{use}` at the box → `omikuji{fortune, item, direction, again}` to you, `omikuji` event
to everyone. The day is the JST calendar day; without a visitor key it is per session.

### Stamps (`effect: 'stamp'`)

`interact{use}` at a stand → profile updated, `stamp` event (with `complete`), or error
`already_stamped`. The card is `STAMP_ZONES` — every zone with a stamp interactable.

### Janken

`janken{challenge, target}` — target must be in the room, not you, within 12 m, and neither of
you in a duel. The target gets `janken{invited, deadline}` (15 s); the challenger
`janken{waiting}`. `respond{accept:false}` or silence cancels (`declined` / `timeout`). On accept
both get `start{deadline}` (8 s). Each `throw`s; when both have — or at the deadline, where a
missing throw forfeits — the round resolves: both get `result{mine, theirs, winner, final}`
and the room gets a `janken` event. A tie replays (`start` again), up to three times, then ends
drawn. Leaving the room cancels (`left`). The winner's `jankenWins` counts toward the badge.

### Fireworks (`feature: 'fireworks'`)

`firework{hue?, pattern?}` from a zone in `MapWorld.fireworks.zones`, at most one per player
every 6 s and eight per room per 10 s. The launch site is the nearest of `fireworks.sites`,
jittered a few metres; burst height 28–42 m. While the fireworks activity is live the server
sends up its own show every 1.2–3 s.

### Bells (`effect: 'ring_bell'`)

`interact{use}` → `bell` event. Each bell rests 3 s between rings (room-wide); a ring inside
that is refused with `cooldown`.

### Guestbook (notice board)

`guestbook_write{text}` — 1–80 characters, standing within reach of a notice board, one line
per player per 30 s, not while muted. The board keeps the newest 60 per room, persisted.
`guestbook_remove{id}` — your own line (same player id or visitor), or any line if admin.

### Whispers and dice

`chat{text, to}` — delivered as `whisper` to both ends and nobody else; never bubbled, never in
history. Muted players cannot whisper (they are told — a whisper has no optimistic echo, so
silence would read as a lost message), and nobody can whisper to someone in their grace
window. `roll{sides}` — 2–1000, default 100; one per 2 s.

### Seats

A `sit` interactable holds one person. Sitting where someone present is already sitting is
refused (`seat_taken`, and the client stands you back up); a seat is freed by standing, by
moving more than 1.5 m past its reach, by dropping, or by leaving.

---

## 6. Errors the player sees

Refusals carry `ServerError.key` (and `params`) so the client can say them in the player's
language (`i18n/core.ts`, `error.<key>`):

`too_far` · `cooldown {seconds}` · `seat_taken` · `muted` · `not_here` · `full` · `not_found` ·
`forbidden` · `busy` · `already_stamped` · `not_open` · `room_not_found` · `invalid` ·
`too_long {max}` · `empty`

---

## 7. Where the code is

| | Server | Client | Shared |
|---|---|---|---|
| Rooms, private islands | `rooms.ts`, `room.ts` | `ui/IslandPanel.svelte`, `net/visitor.ts` | `protocol.ts` |
| Profiles, badges | `games/profiles.ts` | `ui/CollectionPanel.svelte` | `games/badges.ts` |
| Schedule | `schedule.ts` | `ui/NextUp.svelte`, `ui/ActivitiesPanel.svelte` | `maps/*.ts` (`programme`), `games/island-time.ts` |
| Quiz | `games/quiz.ts` | `ui/QuizHud.svelte`, `fx/` (arena) | `games/quiz-bank.ts` |
| Fishing, derby | `games/fishing.ts` | `ui/FishingHud.svelte`, `fx/` | `games/fish.ts` |
| Omikuji, stamps, bells | `games/interactions.ts` | `ui/OmikujiCard.svelte`, `fx/` | `games/omikuji.ts` |
| Janken | `games/janken.ts` | `ui/JankenCard.svelte` | |
| Fireworks | `games/fireworks.ts` | `fx/` | `maps/*.ts` (`fireworks`) |
| Guestbook | `games/guestbook.ts` | `ui/BoardPanel.svelte` | |
| Languages | — | `i18n/` | names in `maps/*.ts`, `games/*.ts` |
