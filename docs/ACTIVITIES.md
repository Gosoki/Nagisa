# Activities, the island's day, rooms and permissions

The multi-activity system is what makes Nagisa a venue rather than a scene. Several
things run at once, in different places on the same island, and moving between them is
walking. Since v2 they also run *by themselves*: every room keeps the island's daily
programme on its board, so a room with nobody in charge still has a morning, a market and
fireworks.

---

## 1. What an activity is

An activity is **a scheduled thing, happening in a place, that people attend**.

```ts
interface ActivityView {
  id: ActivityId;
  title: string;            // "Lantern Walk" — English; the client localises by templateId
  blurb: string;            // one line of context, not a description essay
  zone: ZoneId;             // where it happens: the template's venue
  state: ActivityState;
  startsAt: number;         // epoch ms — drives the "Next Up" strip
  endsAt: number | null;
  hostId: PlayerId | null;
  hostName: string | null;
  participantCount: number; // maintained server-side; clients never tally rosters
  audienceCount: number;
  capacity: number;         // 0 = uncapped
  checkinEnabled: boolean;
  checkinCount: number;
  templateId: string;       // which template it was made from
  feature: ActivityFeature | null;  // what the island does while it runs (§5)
  board?: Array<{ id: PlayerId; name: string; score: number }>;  // top few, if it keeps score
  left?: number;            // treasure hunt: how many things are still buried
}
```

Activities are **places, not levels**. Joining one does not load anything, does not change
scene, and does not take control away from you. You walk over, and you are in it.

---

## 2. Templates

Hosts do not fill in a form. Every activity comes from a template, and the template knows
the venue, the length, the shape and what the island does while it runs. This is the
difference between a calm product and an events dashboard.

The shipped island's nine (`ACTIVITY_TEMPLATES` in
[`maps/nagisa-island.ts`](../packages/shared/src/maps/nagisa-island.ts)):

| Template | id | Venue | Duration | Capacity | Check-in | Feature |
|---|---|---|---|---|---|---|
| Fishing Derby | `morning-catch` | North Harbour | 15 min | 40 | ✓ | `derby` |
| Morning Assembly | `morning-assembly` | Main Plaza | 8 min | ∞ | ✓ | — |
| ○× Quiz | `island-quiz` | Main Plaza | 10 min | ∞ | — | `quiz` |
| Harbour Market | `harbor-market` | South Harbour | 25 min | ∞ | — | — |
| Lamp Lighting | `lamp-lighting` | Lighthouse Cape | 8 min | 50 | ✓ | `lamp` |
| Lantern Walk | `lantern-walk` | Shrine | 12 min | 60 | ✓ | `lanterns` |
| Beach Concert | `beach-concert` | Sunset Beach | 9 min | 70 | ✓ | `concert` |
| Fireworks | `fireworks` | Sunset Beach | 8 min | ∞ | — | `fireworks` |
| Treasure Hunt | `treasure-hunt` | Main Plaza (the field is the whole island) | 10 min | ∞ | — | `treasure` |

Each template carries its title and blurb in English, Chinese and Japanese (`titleZh`,
`titleJa`, `blurbZh`, `blurbJa`); the wire carries the English and the `templateId`, and
the client picks the words.

Templates also declare a `formation` — `gather`, `seated` or `procession` — meant to tell
the client how a crowd arranges itself. **Nothing reads it yet.** Every activity's crowd is
placed by the same rings (§6); the lantern walk's procession is the lanterns, not the
placement.

---

## 3. The island's day

The island keeps one clock for everybody: a full day and night every **90 real minutes**
(`ISLAND_DAY_MS`), derived from server epoch time and nothing else
([`games/island-time.ts`](../packages/shared/src/games/island-time.ts)). One real minute is
sixteen island minutes; island midnight falls on every multiple of 90 minutes since the
epoch. The client's sky and the server's scheduler read the same function, so the lamp is
lit when the sky says dusk.

The map lays the day out as a **programme** — which template starts how many real minutes
after island midnight:

| Real min | Island time | Template | Venue |
|---|---|---|---|
| 8 | 02:08 | Treasure Hunt | Main Plaza |
| 22 | 05:52 | Fishing Derby | North Harbour |
| 28 | 07:28 | Morning Assembly | Main Plaza |
| 37 | 09:52 | ○× Quiz | Main Plaza |
| 45 | 12:00 | Harbour Market | South Harbour |
| 56 | 14:56 | ○× Quiz | Main Plaza |
| 65 | 17:20 | Lamp Lighting | Lighthouse Cape |
| 70 | 18:40 | Lantern Walk | Shrine |
| 75 | 20:00 | Beach Concert | Sunset Beach |
| 85 | 22:40 | Fireworks | Sunset Beach |

Laid out so each thing happens at the hour it belongs to — the catch at first light, the
lamp at dusk, fireworks in the dark, the treasure hunt in the small hours when nothing else
is on — and so no two things share a venue at once. A map
with no `programme` gets each of its templates once a day, evenly spaced.

### Per-room scheduling

[`schedule.ts`](../apps/server/src/schedule.ts) keeps every room's board stocked. Once a
second (and once when a room wakes, before its first visitor's snapshot) it walks
yesterday's, today's and tomorrow's programme and creates an activity for every slot that
**starts within the next 55 minutes** (`HORIZON_MS`) and **has not yet ended**.

Each slot is identified as `template@startsAt`. The activity made for it carries that key,
it is persisted, and a slot that already has an activity is never filled again — so the
scheduler can run as often as it likes, across restarts, without duplicating anything. The
horizon is what keeps the board to "the next hour", and what stops a room that was asleep
from waking up to a pile of past events.

The previous design seeded one of each template at first boot and then nothing: two hours
later the board was empty for good, and a second shard never had anything at all.

### Putting something on now

An admin (including a private island's keeper, on their island) sends
`host_schedule { template, inMin }`: that template, starting `inMin` minutes from now,
rounded and clamped to 0–120. Its slot key is `adhoc:<uuid>`, so it never collides with the
programme. The host panel offers it as one row: a template, a delay, a button. Every such
request goes into the audit log as `schedule:<template>`.

There is one quiz arena, so asking for a quiz while one is live is refused with `already_running` (as is a second treasure hunt).

---

## 4. Lifecycle

```
scheduled ──▶ open ──▶ live ──▶ ended
     │          │
     └──────────┴──▶ cancelled
```

| State | Meaning |
|---|---|
| `scheduled` | On the board. Not yet accepting the crowd. |
| `open` | Doors open. Players may attach as participant or audience. |
| `live` | Running. **Check-in is accepted only in this state.** |
| `ended` | Finished. Check-ins are kept for the post-event summary. |
| `cancelled` | Called off. Distinguished from `ended` so the interface can say so honestly. |

Transitions are validated server-side by `canTransition`. Every transition is one-way:
`open` goes only to `live` or `cancelled` — never back to `scheduled`, because the doors
open by the clock five minutes before the start and the next sweep would simply open them
again — and `ended` / `cancelled` are terminal. An illegal request returns
`error { code: invalid_transition }` and changes nothing — which is what stops a host's
double-tap from producing an impossible activity.

### What the island does by itself

`ActivityManager.sweep` runs every tick (`activity.ts`). The rules, all product-chosen:

- **`scheduled → open`** five minutes before `startsAt`, so a crowd can form.
- **`open → live`** at `startsAt` when nobody is hosting it, or its host is not in the room
  and connected. A host who *is* present gets **three minutes** (`HOST_START_GRACE_MS`) to
  start it themselves — waiting for a few more people is a human decision worth honouring;
  a host who wandered off to fish is not a reason for sixty people to stand in the plaza
  indefinitely.
- **`live → ended`** at `endsAt`, so nothing runs forever.
- **Anything still `scheduled` or `open` when its end has passed is `cancelled`.** It was
  never going to happen — the server was down through it, or its host held it and never
  let it go — and saying so is better than leaving it on the board.
- **Ended and cancelled activities are cleared off the board** fifteen minutes after they
  closed, and never before their scheduled end: the programme recognises a slot by the
  activity sitting in it, and would otherwise re-create one that was called off early.
- **Every due step is applied in one sweep.** An activity restored after a long sleep may
  be owed `scheduled → open → live` at once; one step per tick would show a live event as
  "open" for a frame for no reason.

A host can drive it by hand at any time within the graph.

Some features end their activity themselves: a quiz that has run its course ends it
whatever the clock says, and a scheduled quiz that goes live while another quiz is running
is ended at once rather than shown as live with nothing happening.

---

## 5. Features

`feature` is what the island does while an activity is live. Templates without one are
gatherings: a place, a time, a roster and a check-in.

| Feature | Runs on | While live |
|---|---|---|
| `quiz` | server | The ○× quiz runs in the map's `quizArena`: lobby, questions, judging by where people stand. |
| `derby` | server | Every catch by a *participant* scores their biggest single fish; the top five ride on `ActivityView.board`. At the end the winner gets the Derby Champion badge and the island hears the podium. |
| `fireworks` | server | The server sends up its own show every 1.2–3 s; anyone on a firework shore may add to it. |
| `treasure` | server | Three things are buried at random places; anyone may dig, anywhere, and hears how close the nearest is. Finds score on `board`, `left` counts down, and the last find ends it. One hunt at a time. |
| `concert` | client | A musician on the beach stage and generated koto phrases, heard from where you stand; anyone on the beach can join a bon-odori, all dancing on one beat. |
| `lanterns` | client | Everyone attending carries a paper lantern, and after dusk each has a halo. |
| `lamp` | client | The lighthouse beam. |

The server-side features are described end to end in [GAMES.md](GAMES.md) §5; the client
ones are in `apps/client/src/fx/`.

---

## 6. Attendance

Two modes, and the difference is social rather than mechanical:

| Mode | Meaning |
|---|---|
| `participant` | You are *in* it. Counted, placed in the crowd's inner rings, scored in a derby, a contestant in a quiz wherever you stand. |
| `audience` | You are watching. Counted separately, placed further back. |

Both are attachments to the *same place*, so switching is instant and costs nothing. A
player attends at most one activity; joining another releases the first, but only once the
new one has accepted them.

Joining is a **request**: the client sends `activity_join`, the server checks state
(`open` or `live`) and capacity (participants and audience together), and broadcasts the
resulting attachment. Meanwhile the client starts walking you toward a crowd slot — it does
not wait for the round trip, because the walk is not the server's business.

### Crowd placement

`crowdSlot(zone, index)` places the *n*th attendee in expanding rings around the venue's
stage anchor: ring 0 holds 8, each further ring holds 6 more and sits 4 m further out,
spread over a 200° arc in front of the stage. Participants take slots from the front;
audience slots start eight places further out.

Rings rather than a grid, for two reasons: crowds around a performer are round, and a
round crowd hides population gaps — which is what keeps a half-full plaza from feeling
empty.

---

## 7. Check-in

Attendance recording, for activities that want it.

- Accepted **only** while the activity is `live`, only when its template enables it, and
  only for someone attending it — as participant or audience.
- **Once** per player. A second attempt is rejected (`already`), not silently ignored.
- Returns a 1-based `ordinal` in arrival order, so "you were the fourteenth person here"
  is available to the interface.
- **Visible**: `PlayerView.checkedIn` goes true for everyone to see, and is cleared whenever
  that player's attachment changes — joining something else, leaving, the activity being
  cleared off the board, or moving to another island.
- Records are persisted with the activity, so a restart does not lose them. Each keeps the
  name the player checked in under, so the register reads right after they have gone.
- **The register**: the host console lists, for each activity that takes check-ins and that
  this player may read (their own; for an admin, any that has taken check-ins), the count and
  a *View* button. Opened, it shows who checked in, in order, with the time, refetches itself
  once new check-ins stop arriving, and saves as a CSV (UTF-8 with a BOM, formula-like names
  defused) for whoever keeps the attendance sheet — the morning assembly's roll call, a club
  night's sign-in.

There are two ways to check in: the action on the activity strip, and walking to the
`plaza-post` interactable (`effect: 'checkin_nearby'`) and using it, which checks you in to
whatever is live in that zone. The second exists because doing a thing by going somewhere
is more in keeping with the world than pressing a button.

---

## 8. Rooms

Rooms are **copies of the same island** — identical geography, identical programme,
different people. There are two kinds:

- **Public shards** (`shore-1`, `shore-2`, …), which matchmaking fills.
- **Private islands** (`isle-<CODE>`), which someone made and shared by its five-letter
  code. Never listed to strangers, never matchmade into. See [GAMES.md §2](GAMES.md#2-rooms-public-shards-and-private-islands).

```
ROOM_CAPACITY         = 120   # players per public shard
ROOM_COUNT            = 1     # public shards created at boot; these never sleep
PRIVATE_ROOM_CAPACITY = 40    # players per private island
```

Every room runs its own schedule, its own games and its own guestbook, and keeps them in its
own section of the persisted state. A room that has been empty for ten minutes is put to
sleep — it stops ticking and its state is set aside — except the first `ROOM_COUNT` public
shards, so there is always somewhere to arrive. A private island wakes again when its code
is next used.

### Matchmaking

`pickRoom()` deliberately **fills the fullest public shard that still has comfortable
headroom** (within 10% of its capacity is too full), rather than balancing load evenly, and
opens a new shard only when every one is at that ceiling.

This is a product requirement expressed as a scheduling policy. Two half-empty islands
feel worse than one busy island, and "the environment should feel populated rather than
empty" is not something you can fix later with art.

### Switching

The Island panel lists the public shards, the island you are on, and how to make or join a
private one. On switch the server lets go of everything you had in the old room (activity,
check-in, hosting, seat, fishing line, duel), recomputes your role for the new one, and puts
you at its harbour. The client clears its remote-player set and resets its tick baseline
before the new snapshot arrives, so there is never a frame showing the previous room's crowd
in the new room's geometry.

### Why 120

Above roughly 150 players the per-tick delta starts to dominate bandwidth on mobile
connections, and the crowd stops being legible anyway. Add rooms rather than raising the
cap. A private island's 40 is a gathering of friends, not a festival.

---

## 9. Roles and permissions

Roles are **ordered**: a higher role subsumes every capability below it. Always compare
with `roleAtLeast`, never with `===`.

| Role | Value | Can |
|---|---|---|
| `Guest` | 0 | Move, emote, chat, watch, join activities, use interactables, play every game. |
| `Participant` | 1 | In the enum and in the permission checks, but never assigned today: attending is carried by `PlayerView.mode`, and grants nothing a guest lacks. |
| `Host` | 2 | For **one specific activity**: drive its lifecycle, announce to it or its zone. |
| `Admin` | 3 | Everything, in the room where they hold it: any activity, island-wide announcements, `host_schedule`, kick, mute, grant/revoke host, take down any guestbook line. |

### Where a role comes from

A role is **computed per room** from first principles (`Room.roleFor`), and recomputed
whenever any input changes — joining, switching rooms, resuming, being granted or losing a
hosted activity, that activity being cleared off the board. So a role can never leak from
one room into another.

1. The **server's admin token** (`?admin=<ADMIN_TOKEN>` on the socket URL) → `Admin` in
   every room.
2. A private island's **keeper** → `Admin` on that island, and only there.
3. The **host of an activity** in this room → `Host`.
4. Otherwise `Guest`.

A keeper is recognised by the hash of their visitor key, so they are keeper again whenever
they come back from the same browser. A keeper who had no visitor key keeps the island only
for the session that made it.

If `ADMIN_TOKEN` is unset, token admin is disabled entirely rather than defaulting to
something guessable. Keepers are unaffected.

### Admin actions

`admin_action { action, target, activity?, reason? }` with `kick`, `mute`, `unmute`,
`grant_host`, `revoke_host`.

- **Nobody moderates themselves, and admins are not moderated by their peers.** A target who
  is an admin can be acted on only by a token admin, and only when the target is not a token
  admin too. So a keeper cannot touch the server's admins, and a token admin can still act on
  a keeper visiting — or on their own island.
- **Kick** sends a fatal `kicked` error and removes the player. It is not a ban: they can
  come back as a new visitor (the client discards its resume token).
- **Mute** silently drops the player's island chat, emotes and dice, and refuses their
  whispers, fireworks, guestbook lines and friend requests with `muted` — a whisper has no
  optimistic echo, so a silent drop would read as a lost message. Mute lives on the player
  record and ends with their session. A server (token) admin's mute follows the player to
  every island; a keeper's holds on the keeper's island only — lifted when the player walks
  to another, and back in force when they return.
- **Grant host** keeps **one host per activity and one hosted activity per host**: whoever
  held either end before lets go of it, so no activity is left pointing at a host who hosts
  elsewhere. The new host is told with `role_changed` even when their role number did not
  change (an admin made host of something).
- A host who leaves the room stops hosting; the island's own schedule takes over.

Every rule is a pure function in `permissions.ts` or a check at the top of its handler, so
it is testable without a socket and impossible to bypass by taking a different code path.

### Audit

Every admin action — kick, mute, unmute, grant host, revoke host, and `host_schedule` — is
appended to the audit log with who, what, whom, which room, when and the stated reason. It
is written to the structured log at once (`audit_action`) and persisted with the rest of the
state (the most recent 2000 entries).

---

## 10. Announcements

Three scopes, matching the three sizes of thing worth saying:

| Scope | Reaches | Typical use |
|---|---|---|
| `activity` | Everyone attached to that activity | "We're starting at the first torii." |
| `zone` | Everyone standing in that zone | "The market is packing up." |
| `island` | Everyone in the room | "Lamp lighting at the cape in ten minutes." |

| Role | May announce to |
|---|---|
| Guest / Participant | nothing |
| Host | their own activity, or that activity's zone |
| Admin | anything, including island-wide |

An announcement arrives as a quiet toast, fading in over ~400 ms, and remains readable on
the notice board until its TTL expires. `priority: 'high'` gets a slower, more deliberate
presentation — it does not flash, get larger, or make a sound.

Scope decides **who is interrupted, not who may read**. Every session in the room receives
every announcement; the client raises a toast only for the ones addressed to it, and only
the highest-priority new one per tick, so a burst does not queue six toasts in sequence.
Everything lands on the board, so a player who walks into a zone just after an announcement
still finds it there.

The island announces too, under the name 渚 Nagisa: the derby's podium island-wide, a quiz's
winners to the plaza.

---

## 11. Seats

A `sit` interactable holds one person. Sitting where someone present is already sitting is
refused with `seat_taken`; a seat held by someone who has gone is simply taken. A seat is
freed by standing, by moving more than 1.5 m past its reach, by dropping, or by leaving.
Sitting itself needs no message of its own on the wire: the `Sit` pose travels in the packed
transforms like any other.

---

## 12. The host console

Hosting must not feel like operating software. The host controls are a small paper slip
per hosted activity: its title, three lifecycle buttons (Open / Start / End, disabled when
the transition is not legal), and a one-line announcement composer with a scope selector
limited to what the role actually permits. Admins get one more row: put a template on the
programme, in a few fixed minutes' time.

There is no admin dashboard, no analytics view, and no separate operator interface. A host
runs an event from inside the world, standing among the people attending it, which is both
more pleasant and considerably harder to get wrong.
