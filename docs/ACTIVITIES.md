# Activities, rooms and permissions

The multi-activity system is what makes Nagisa a venue rather than a scene. Several
things run at once, in different places on the same island, and moving between them is
walking.

---

## 1. What an activity is

An activity is **a scheduled thing, happening in a place, that people attend**.

```ts
interface ActivityView {
  id: ActivityId;
  title: string;            // "Evening Lantern Walk"
  blurb: string;            // one line of context, not a description essay
  zone: ZoneId;             // must be a venue zone
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
}
```

Activities are **places, not levels**. Joining one does not load anything, does not change
scene, and does not take control away from you. You walk over, and you are in it.

---

## 2. Templates

Hosts do not fill in a form. They pick a template, and the server knows the venue, the
shape and the defaults. This is the difference between a calm product and an events
dashboard.

| Template | Venue | Duration | Capacity | Check-in | Formation |
|---|---|---|---|---|---|
| Morning Assembly | Main Plaza | 15 min | ∞ | ✓ | gather |
| Lantern Walk | Shrine Path | 20 min | 60 | ✓ | procession |
| Harbour Market | Harbour | 45 min | ∞ | — | gather |
| Beach Concert | Sunset Beach | 30 min | 70 | ✓ | seated |
| Lamp Lighting | Lighthouse Cape | 10 min | 50 | ✓ | gather |
| Tea Sitting | Teahouse | 60 min | 24 | — | seated |

`formation` tells the client how a crowd should arrange itself: `gather` mills about,
`seated` sits, `procession` follows the host.

A fresh island seeds a demo schedule from these templates on first boot, staggered across
the next couple of hours, so an empty island is never a blank one.

---

## 3. Lifecycle

```
scheduled ──▶ open ──▶ live ──▶ ended
     │          │
     └──────────┴──▶ cancelled
```

| State | Meaning |
|---|---|
| `scheduled` | Announced and visible on the island. Not yet accepting the crowd. |
| `open` | Doors open. Players may attach as participant or audience. |
| `live` | Running. **Check-in is accepted only in this state.** |
| `ended` | Finished. The roster is frozen and retained for the post-event summary. |
| `cancelled` | Called off. Distinguished from `ended` so the interface can say so honestly. |

Transitions are validated server-side by `canTransition`. `open → scheduled` is allowed
(a host can close the doors again); everything else is one-way, and `ended` / `cancelled`
are terminal. An illegal request returns `error { code: invalid_transition }` and changes
nothing — which is what stops a host's double-tap from producing an impossible activity.

The scheduler advances activities automatically: `scheduled → open` five minutes before
`startsAt`, and `live → ended` at `endsAt`. A host can always drive it manually.

---

## 4. Attendance

Two modes, and the difference is social rather than mechanical:

| Mode | Meaning |
|---|---|
| `participant` | You are *in* it. Counted, placed in the crowd formation, may check in. |
| `audience` | You are watching. Counted separately, placed further back, not checked in. |

Both are attachments to the *same place*, so switching is instant and costs nothing.

Joining is a **request**: the client sends `activity_join`, the server checks capacity,
state and permission, and broadcasts the resulting attachment. Meanwhile the client
starts walking you toward a crowd slot — it does not wait for the round trip, because the
walk is not the server's business.

### Crowd placement

`crowdSlot(zone, index)` places the *n*th attendee in expanding rings around the venue's
stage anchor: ring 0 holds 8, each further ring holds 6 more and sits 4 m further out,
spread over a 200° arc in front of the stage.

Rings rather than a grid, for two reasons: crowds around a performer are round, and a
round crowd hides population gaps — which is what keeps a half-full plaza from feeling
empty.

---

## 5. Check-in

Attendance recording, for activities that want it.

- Accepted **only** while the activity is `live`.
- **Once** per player. A second attempt is rejected, not silently ignored.
- Returns a 1-based `ordinal` in arrival order, so "you were the fourteenth person here"
  is available to the interface.
- Records are persisted through the `Store`, so a restart does not lose them.

There are two ways to check in: the action on the activity strip, and physically walking
to the `plaza-post` interactable and using it. The second exists because doing a thing by
going somewhere is more in keeping with the world than pressing a button.

---

## 6. Rooms

Rooms are **shards of the same island** — identical geography, different people.

```
ROOM_CAPACITY = 120     # players per shard
ROOM_COUNT    = 1       # shards created at boot
```

### Matchmaking

`pickRoom()` deliberately **fills the fullest room that still has comfortable headroom**,
rather than balancing load evenly.

This is a product requirement expressed as a scheduling policy. Two half-empty islands
feel worse than one busy island, and "the environment should feel populated rather than
empty" is not something you can fix later with art.

### Switching

A player may switch rooms explicitly from the settings panel, which lists each room's
population. On switch the client clears its remote-player set and resets its tick baseline
before the new snapshot arrives, so there is never a frame showing the previous room's
crowd in the new room's geometry.

### Why 120

Above roughly 150 players the per-tick delta starts to dominate bandwidth on mobile
connections, and the crowd stops being legible anyway. Add rooms rather than raising the
cap.

---

## 7. Roles and permissions

Roles are **ordered**: a higher role subsumes every capability below it. Always compare
with `roleAtLeast`, never with `===`.

| Role | Value | Can |
|---|---|---|
| `Guest` | 0 | Move, emote, watch, join activities, use interactables. |
| `Participant` | 1 | Everything above, plus check in and be counted. |
| `Host` | 2 | Everything above, for **one specific activity**: drive its lifecycle, announce to it or its zone, mute within it. |
| `Admin` | 3 | Everything, island-wide: any activity, island-wide announcements, kick, mute, grant/revoke host. |

### Announcement scope, by role

| Role | May announce to |
|---|---|
| Guest / Participant | nothing |
| Host | their own activity, or that activity's zone |
| Admin | anything, including island-wide |

Every rule is a pure function in `permissions.ts`, so it is testable without a socket and
impossible to bypass by taking a different code path.

### Becoming an admin

Connect with `?admin=<ADMIN_TOKEN>`. The token is an environment variable; if it is unset,
admin is disabled entirely rather than defaulting to something guessable.

### Audit

Every admin action — kick, mute, grant host, revoke host — is written to an append-only
audit log through the `Store`, with who, what, whom, when and the stated reason.

---

## 8. Announcements

Three scopes, matching the three sizes of thing worth saying:

| Scope | Reaches | Typical use |
|---|---|---|
| `activity` | Everyone attached to that activity | "We're starting at the first torii." |
| `zone` | Everyone standing in that zone | "The market is packing up." |
| `island` | Everyone in the room | "Lamp lighting at the cape in ten minutes." |

An announcement arrives as a quiet toast, fading in over ~400 ms, and remains readable on
the notice board until its TTL expires. `priority: 'high'` gets a slower, more deliberate
presentation — it does not flash, get larger, or make a sound.

Clients present the highest-priority *new* announcement per tick; a burst does not queue
six toasts in sequence.

---

## 9. The host console

Hosting must not feel like operating software. The host controls are a small paper slip:
the activity's title, three lifecycle buttons (Open / Start / End), and a one-line
announcement composer with a scope selector limited to what the role actually permits.

There is no admin dashboard, no analytics view, and no separate operator interface. A host
runs an event from inside the world, standing on the stage, which is both more pleasant
and considerably harder to get wrong.
