/**
 * World synchronisation.
 * ======================
 *
 * The bridge between the wire and everything the player can see. It owns two jobs:
 *
 * **Inbound** — apply `snapshot` and `delta` frames to the remote-player set and to the
 * UI stores. Snapshots replace state wholesale; deltas patch it. Nothing else in the
 * client parses a server message.
 *
 * **Outbound** — report the local transform at a fixed rate, with a dead-band so a
 * player standing still sends nothing at all. On a plaza where two thirds of the crowd
 * is watching rather than walking, that dead-band removes roughly two thirds of the
 * upstream traffic for free.
 *
 * ### Delta gaps
 * Deltas carry a monotonic `tick`. If a tick arrives that is not the successor of the
 * last one applied, we have missed a frame — usually because the socket was briefly
 * backed up. Rather than applying a patch to state we no longer trust, we ask for a
 * fresh snapshot with `resync`. Requests are debounced, because one lost frame usually
 * means several.
 */

import * as THREE from 'three';
import { get } from 'svelte/store';
import {
  activeMapId,
  AnimState,
  PROTOCOL,
  Role,
  getBadge,
  packTransform,
  unpackTransforms,
  type ActivityId,
  type AnnouncementView,
  type ClientMessage,
  type DarumaView,
  type Emote,
  type Hand,
  type PlayerId,
  type QuizView,
  type ServerDelta,
  type ServerFriends,
  type ServerError,
  type ServerJanken,
  type ServerMessage,
  type ServerSnapshot,
  type Vec3,
  type WorldEvent,
} from '@nagisa/shared';
import type { RemotePlayers } from '../character/remote-players.js';
import type { LocalPlayer } from '../character/local-player.js';
import type { Connection } from './connection.js';
import { rememberPose } from './last-pose.js';
import {
  activities,
  announcements,
  checkinList,
  currentToast,
  daruma,
  fishing,
  followTarget,
  guestbook,
  isMuted,
  friends,
  janken,
  lastDig,
  vista,
  latency,
  notify,
  omikujiSlip,
  players,
  profile,
  pushChat,
  pushSystemChat,
  quiz,
  room,
  rooms,
  self,
  serverNow,
  zonePopulation,
} from '../state/stores.js';
import type { Speech } from '../character/speech.js';
import { badgeName, fishName, fortuneText, islandName, tr, zoneName } from '../i18n/index.js';

/** Minimum movement before a transform is worth sending, metres. */
const POSITION_DEADBAND = 0.02;

/** Minimum yaw change before it is worth sending, radians (~0.6°). */
const YAW_DEADBAND = 0.01;

/**
 * Even a perfectly still player reports occasionally, so a client that joined after
 * they stopped moving still learns where they are without waiting for a snapshot.
 */
const KEEPALIVE_INTERVAL_MS = 2000;

/** How often expired announcements are cleared off the local board. */
const ANNOUNCEMENT_PRUNE_MS = 5000;

/** How long a toast stays up if the announcement did not specify. */
const DEFAULT_TOAST_MS = 6000;

/** Map an emote name onto the animation that expresses it. */
const EMOTE_ANIMATIONS: Record<string, AnimState> = {
  wave: AnimState.Wave,
  clap: AnimState.Clap,
  bow: AnimState.Bow,
  heart: AnimState.Wave,
  laugh: AnimState.Clap,
  question: AnimState.Idle,
  music: AnimState.Clap,
  sparkle: AnimState.Wave,
};

export class WorldSync {
  /** Roster the packed transform indices refer to. Rebuilt only when the server says so. */
  private roster: PlayerId[] = [];

  /** Last delta tick successfully applied. */
  private lastTick = -1;

  /** Sequence number for outbound moves. */
  private seq = 0;

  private lastSentPos = new THREE.Vector3(NaN, NaN, NaN);
  private lastSentYaw = NaN;
  private lastSentAnim: AnimState | null = null;
  private lastSentAt = 0;
  private moveAccumulator = 0;

  /** Debounce for resync requests. */
  private resyncPending = false;

  /**
   * Whether we have adopted the server's authoritative spawn position yet.
   *
   * Reset on room change, because a new room means a new spawn.
   */
  private adoptedSpawn = false;

  /** Toast dismissal timer. */
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** Clears the fishing result card after it has been read. */
  private fishingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Clears a finished janken from the screen. */
  private jankenTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Chat lines waiting to go out. The server allows a burst of four and then one a second;
   * pacing here means a quick second line is delayed by a moment rather than refused while
   * already showing in your own log as said.
   */
  private chatQueue: ClientMessage[] = [];
  private chatTimer: ReturnType<typeof setTimeout> | null = null;
  private chatTokens = 4;
  /** Whether this connection has had its first friends list (see `onFriends`). */
  private friendsSeen = false;
  private chatRefilledAt = performance.now();

  /**
   * Called for every world event, after the interface has had its say. The app points this
   * at the effects layer (bells, fireworks, splashes).
   */
  onWorldEvent: ((event: WorldEvent) => void) | null = null;

  /** Something arrived that is for you alone — a whisper, a friend coming on. The app chimes. */
  onForYou: (() => void) | null = null;

  /** The island put us somewhere, facing `yaw`. The app turns the camera to look that way too. */
  onPlaced: ((yaw: number) => void) | null = null;

  /** Where the island last put us (x, z), so its repeats — one per report already on its way — are let be. */
  private placedAt: [number, number] | null = null;

  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly connection: Connection,
    private readonly remote: RemotePlayers,
    private readonly local: LocalPlayer,
    private readonly bubbles: Speech,
  ) {
    this.unsubscribers.push(connection.on('message', this.onMessage));
    this.unsubscribers.push(connection.on('latency', (rtt) => latency.set(rtt)));
    // Lines typed while the connection was down wait here rather than in the socket's outbox,
    // which would send them all at once: a new connection's budget is a burst of four, and
    // the fifth line on would be dropped without a word.
    this.unsubscribers.push(
      connection.on('state', (state) => {
        if (state !== 'connected') return;
        this.chatTokens = 4;
        this.chatRefilledAt = performance.now();
        this.drainChat();
      }),
    );
    // The server forgets an announcement when its time is up; the board here should too,
    // rather than keep everything it was ever told until the next snapshot.
    const prune = setInterval(() => {
      const now = serverNow();
      announcements.update((list) => {
        const kept = list.filter((a) => now - a.at < a.ttlMs);
        return kept.length === list.length ? list : kept;
      });
    }, ANNOUNCEMENT_PRUNE_MS);
    this.unsubscribers.push(() => clearInterval(prune));
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private onMessage = (msg: ServerMessage): void => {
    switch (msg.t) {
      case 'welcome':
        // The server names the world it is simulating. Both sides validate movement against
        // `heightAt`, so if we loaded a different pack its ground is somewhere else entirely
        // and every position we send is rejected — which presents as constant teleporting,
        // with nothing in either log to connect it to the cause. Say it plainly instead.
        if (msg.mapId && msg.mapId !== activeMapId()) {
          notify(tr('net.mapMismatch', { map: msg.mapId }), 'warn', 60_000);
          console.error(`[nagisa] map mismatch: client "${activeMapId()}", server "${msg.mapId}"`);
        }
        self.update((s) => ({ ...s, id: msg.self }));
        room.set(msg.room);
        rooms.set(msg.rooms);
        profile.set(msg.profile);
        // Anything that was mid-flight on the old connection is gone with it: the server
        // reels a line in and cancels a duel when the socket drops.
        this.resetGames();
        // A new connection's first friends list is how things stand, not news.
        this.friendsSeen = false;
        // A resumed session means we were already here; a fresh one means we just
        // arrived. Only the first deserves a greeting.
        if (msg.resumed) notify(tr('net.welcomeBack'), 'good');
        break;

      case 'snapshot':
        this.applySnapshot(msg);
        break;

      case 'delta':
        this.applyDelta(msg);
        break;

      case 'correction':
        // The island moved us — a game sent us back to its start. Whatever we were doing where
        // we stood is over: a walk under way, following someone, a seat. We face the way it
        // put us facing.
        if (msg.reason === 'teleport') {
          // The same spot again, answering a report sent before we got there: we are there.
          const [px, , pz] = msg.pos;
          const here = this.local.position;
          if (this.placedAt && this.placedAt[0] === px && this.placedAt[1] === pz && Math.hypot(here.x - px, here.z - pz) < 1) break;
          this.placedAt = [px, pz];
          if (get(self).seated) {
            this.local.setSeated(false);
            self.update((s) => ({ ...s, seated: false }));
          }
          followTarget.set(null);
          this.local.teleport(msg.pos[0], msg.pos[1], msg.pos[2], msg.yaw);
          this.onPlaced?.(msg.yaw);
          break;
        }
        // The server disagreed about where we are. Snap, and say nothing — corrections
        // are almost always a terrain edge case, not cheating, and a warning would only
        // make an invisible problem visible.
        this.local.applyCorrection(msg.pos[0], msg.pos[1], msg.pos[2]);
        break;

      case 'checkin_ack':
        if (msg.ok) {
          self.update((s) => ({ ...s, checkedIn: true }));
          notify(msg.ordinal ? tr('checkin.ok', { n: msg.ordinal }) : tr('checkin.okPlain'), 'good');
        } else {
          notify(msg.reason ? tr(`checkin.reason.${msg.reason}`) : tr('checkin.fail'), 'warn');
        }
        break;

      case 'role_changed':
        self.update((s) => ({ ...s, role: msg.role }));
        // Made host of something: say that, even to an admin, whose role does not change.
        if (msg.role >= Role.Host) notify(tr(msg.activity || msg.role < Role.Admin ? 'role.hosting' : 'role.admin'), 'good');
        break;

      case 'room_info':
        // Named (or unnamed) by its keeper while we are on it.
        room.set(msg.room);
        rooms.update((list) => list.map((r) => (r.id === msg.room.id ? msg.room : r)));
        break;

      case 'room_changed':
        room.set(msg.room);
        rooms.set(msg.rooms);
        self.update((s) => ({ ...s, role: msg.role, activity: null, mode: null, checkedIn: false, seated: false }));
        this.connection.adoptResumeToken(msg.resumeToken);
        // The snapshot for the new room follows; clear the old one so there is never a
        // frame showing the previous room's crowd in the new room's geometry.
        this.remote.clear();
        this.roster = [];
        this.lastTick = -1;
        // The old island's programme too: its ids mean nothing here, and the snapshot brings ours.
        activities.set([]);
        this.resetGames();
        followTarget.set(null);
        // Nothing of the old island follows us: not its toast, not the view from its lookout.
        if (this.toastTimer !== null) clearTimeout(this.toastTimer);
        this.toastTimer = null;
        currentToast.set(null);
        vista.set(null);
        // A new shard spawns us afresh, so the next snapshot's position is authoritative.
        this.adoptedSpawn = false;
        notify(tr('island.moved', { name: islandName(msg.room) }), 'good');
        break;

      case 'error':
        this.onServerError(msg);
        break;

      case 'profile': {
        const before = get(profile);
        profile.set(msg.profile);
        // The day's last task, done just now (not a card that arrived already done).
        const today = msg.profile.daily;
        if (today?.done && before?.daily?.day === today.day && !before.daily.done) {
          notify(tr('daily.done', { n: msg.profile.dailyStreak }), 'good', 6000);
        }
        break;
      }

      case 'fish':
        this.onFish(msg);
        break;

      case 'omikuji':
        omikujiSlip.set({ fortune: msg.fortune, item: msg.item, direction: msg.direction, again: msg.again });
        if (msg.again) notify(tr('omikuji.again'), 'neutral');
        break;

      case 'janken':
        this.onJanken(msg);
        break;

      case 'friends':
        this.onFriends(msg);
        break;

      case 'checkin_list':
        checkinList.set({ activity: msg.activity, list: msg.list });
        break;

      case 'dig':
        lastDig.set({ result: msg.result, at: performance.now() });
        if (msg.result === 'found') {
          notify(tr('treasure.found'), 'good', 3200);
          this.local.character.playEmote(AnimState.Cheer, 1.6);
        }
        break;

      case 'whisper': {
        const mine = msg.from === this.selfId();
        if (!mine && isMuted(msg.from)) break;
        if (!mine) this.onForYou?.();
        pushChat({
          playerId: msg.from,
          name: msg.fromName,
          text: msg.text,
          self: mine,
          whisper: mine
            ? { peerId: msg.to, peerName: msg.toName, outgoing: true }
            : { peerId: msg.from, peerName: msg.fromName, outgoing: false },
        });
        break;
      }

      default:
        break;
    }
  };

  /** Replace all observable state. Idempotent by construction. */
  private applySnapshot(snap: ServerSnapshot): void {
    this.lastTick = snap.tick;
    this.resyncPending = false;

    // The snapshot's player order defines the initial packed-transform roster.
    this.roster = snap.players.map((p) => p.id);

    const selfId = this.selfId();
    // The server leaves `away` and `checkedIn` out when they are false. A snapshot replaces
    // everything, so absent must mean false here — merged as `undefined`, someone who came
    // back while we were away would stay faded for as long as we had missed their return.
    const others = snap.players
      .filter((p) => p.id !== selfId)
      .map((p) => ({ ...p, away: p.away === true, checkedIn: p.checkedIn === true }));
    this.remote.reset(others);
    // Someone we already had keeps their figure, so give it the snapshot's position too:
    // moves are only sent while people move, and one who walked off and stopped while we
    // were away would otherwise stand where we last saw them until they next took a step.
    for (const p of others) this.remote.applyTransform(p.id, p.pos, p.yaw, p.anim);
    players.set(others);

    activities.set(snap.activities);
    announcements.set([...snap.announcements].sort((a, b) => b.at - a.at));
    zonePopulation.set(snap.zonePopulation);
    guestbook.set([...snap.guestbook].sort((a, b) => b.at - a.at));
    quiz.set(snap.quiz);
    daruma.set(snap.daruma ?? null);

    // Adopt our own server-side attachment state, which matters after a resume: you
    // rejoin already attached to the activity you were in, checked in if you had.
    const me = snap.players.find((p) => p.id === selfId);
    if (me) {
      self.update((s) => ({ ...s, role: me.role, activity: me.activity, mode: me.mode, checkedIn: me.checkedIn === true }));
      this.reconcileSelfPosition(me.pos, me.yaw);
    }
  }

  /**
   * Reconcile our own position with the server's.
   *
   * This exists because the client and the server each place a new arrival, and they do
   * so independently: the client parks a character at a harbour spawn point so the entry
   * screen has something to look at, while the server assigns the authoritative spawn
   * when the session is created. Those are two different random draws from the same set
   * of six points, so they almost never agree.
   *
   * Without this, the first movement report of every session looks like a 30 m teleport,
   * fails the server's speed budget, and yanks the player back the moment they take their
   * first step — a bug that would affect literally every player on join.
   *
   * After the initial adoption we only reconcile on a *large* discrepancy. Snapping on
   * every snapshot would fight client prediction and undo legitimate local movement
   * during a routine resync.
   */
  private reconcileSelfPosition(pos: Vec3, yaw: number): void {
    const dx = pos[0] - this.local.position.x;
    const dz = pos[2] - this.local.position.z;
    const drift = Math.hypot(dx, dz);

    if (!this.adoptedSpawn) {
      this.adoptedSpawn = true;
      this.local.teleport(pos[0], pos[1], pos[2], yaw);
      return;
    }

    // 12 m is comfortably beyond any drift client prediction can accumulate in the
    // window between snapshots, so crossing it means we are genuinely out of sync.
    if (drift > 12) this.local.teleport(pos[0], pos[1], pos[2], yaw);
  }

  /** Apply an incremental frame. */
  private applyDelta(delta: ServerDelta): void {
    // Gap detection. `lastTick < 0` means we have no baseline yet and are waiting on a
    // snapshot, so deltas are simply dropped until one arrives.
    if (this.lastTick >= 0 && delta.tick !== this.lastTick + 1) {
      if (delta.tick > this.lastTick) this.requestResync();
      // Out-of-order (tick <= lastTick) frames are stale; dropping them is correct.
      return;
    }
    this.lastTick = delta.tick;

    const selfId = this.selfId();

    // Arrivals and departures are chat lines. In a room whose whole point is that other
    // people are there, "someone came in" is information, and the log is where you look for
    // it. Kept out of the toast queue, which is reserved for things addressed to you.
    if (delta.join?.length) {
      for (const view of delta.join) {
        if (view.id === selfId) continue;
        pushSystemChat(tr('chat.arrived', { name: view.name }));
        this.remote.add(view);
      }
      players.set(this.remote.views());
    }

    if (delta.leave?.length) {
      for (const id of delta.leave) {
        // Read the name before the removal, not after.
        const name = this.remote.views().find((p) => p.id === id)?.name;
        if (name) pushSystemChat(tr('chat.left', { name }));
        // Following someone who has gone would walk you to wherever they last stood and
        // leave you standing there, so drop it here rather than letting it time out.
        followTarget.update((f) => (f?.id === id ? null : f));
        this.bubbles.clear(id);
        this.remote.remove(id);
      }
      players.set(this.remote.views());
    }

    if (delta.moves) {
      // A roster update accompanies any membership change; otherwise reuse the last one.
      if (delta.moves.ids) this.roster = delta.moves.ids;
      for (const t of unpackTransforms(delta.moves, this.roster)) {
        if (t.id === selfId) continue; // Our own transform is authoritative locally.
        this.remote.applyTransform(t.id, t.pos, t.yaw, t.anim);
      }
    }

    if (delta.players?.length) {
      for (const patch of delta.players) {
        if (patch.id === selfId) {
          self.update((s) => ({
            ...s,
            role: patch.role ?? s.role,
            activity: patch.activity !== undefined ? patch.activity : s.activity,
            mode: patch.mode !== undefined ? patch.mode : s.mode,
            // The server owns the check-in; changing activity clears it there too.
            checkedIn: patch.checkedIn !== undefined ? patch.checkedIn : patch.activity !== undefined ? false : s.checkedIn,
          }));
          continue;
        }
        this.remote.updateMeta(patch);
      }
      players.set(this.remote.views());
    }

    if (delta.activities?.length) {
      activities.update((list) => {
        const byId = new Map(list.map((a) => [a.id, a]));
        for (const a of delta.activities!) byId.set(a.id, a);
        return [...byId.values()].sort((a, b) => a.startsAt - b.startsAt);
      });
    }

    if (delta.activitiesRemoved?.length) {
      const removed = new Set(delta.activitiesRemoved);
      activities.update((list) => list.filter((a) => !removed.has(a.id)));
    }

    if (delta.announcements?.length) {
      // An announcement made in the same tick as our snapshot arrives twice — in the snapshot
      // and in this delta. Keep one, and do not toast it again.
      const known = new Set(get(announcements).map((a) => a.id));
      const fresh = delta.announcements.filter((a) => !known.has(a.id));
      announcements.update((list) => [...fresh, ...list].slice(0, 40));
      // Present the highest-priority new announcement *addressed to you*; a burst should
      // not queue six toasts one after another. Everything lands on the notice board
      // regardless — scope decides who is interrupted, not who may read.
      const top = fresh
        .filter((a) => this.addressedToMe(a))
        .sort((a, b) => (a.priority === b.priority ? b.at - a.at : a.priority === 'high' ? -1 : 1))[0];
      if (top) this.showToast(top);
    }

    if (delta.emotes?.length) {
      for (const e of delta.emotes) {
        // Our own emote was played the moment it was chosen; the glyph is raised from the
        // echo so it appears when everyone else's does.
        if (e.id !== selfId) this.remote.playEmote(e.id, EMOTE_ANIMATIONS[e.emote] ?? AnimState.Wave);
        this.onEmote?.(e.id, e.emote);
      }
    }

    if (delta.chats?.length) {
      for (const c of delta.chats) {
        // The server echoes our own line back. It is already in the log — appended
        // optimistically the moment it was typed, so the composer feels instant — but the
        // *bubble* is raised here, from the echo, so it appears exactly when everyone
        // else's does rather than a round trip early.
        const mine = c.id === selfId;
        // A muted person is dropped here, once, rather than filtered in two places later:
        // the line never enters the log and no bubble is raised, so unmuting cannot make an
        // hour of backlog appear. They stay visible on the island — mute is a way to stop
        // reading someone, not a way to lose track of where they are. See `stores.mutedIds`.
        if (!mine && isMuted(c.id)) continue;
        const name = mine ? this.selfName() : (this.remote.views().find((p) => p.id === c.id)?.name ?? '…');
        if (!mine) pushChat({ playerId: c.id, name, text: c.text, self: false });
        this.bubbles.say(c.id, c.text);
      }
    }

    if (delta.zonePopulation) zonePopulation.set(delta.zonePopulation);

    if (delta.guestbook?.length) {
      guestbook.update((list) => {
        const known = new Set(list.map((g) => g.id));
        const fresh = delta.guestbook!.filter((g) => !known.has(g.id));
        return [...fresh, ...list].sort((a, b) => b.at - a.at);
      });
    }
    if (delta.guestbookRemoved?.length) {
      const gone = new Set(delta.guestbookRemoved);
      guestbook.update((list) => list.filter((g) => !gone.has(g.id)));
    }
    if (delta.quiz !== undefined) this.onQuiz(delta.quiz);
    if (delta.daruma !== undefined) this.onDaruma(delta.daruma);

    if (delta.events?.length) {
      for (const event of delta.events) this.onEvent(event);
    }
  }

  /** Called for every emote, own included, so the effects layer can float the glyph. */
  onEmote: ((id: PlayerId, emote: Emote) => void) | null = null;

  /**
   * Whether an announcement is for you: island-wide ones are for everybody; zone ones for
   * whoever is standing there; activity ones for its attendees.
   */
  private addressedToMe(a: AnnouncementView): boolean {
    let me = { zone: '' as string, activity: null as string | null };
    self.subscribe((s) => (me = { zone: s.zone, activity: s.activity }))();
    switch (a.scope.kind) {
      case 'island':
        return true;
      case 'zone':
        return a.scope.zone === me.zone;
      case 'activity':
        return a.scope.activity === me.activity;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Games
  // -------------------------------------------------------------------------

  /** A name for a player id: yours, someone in the room, or a neutral fallback. */
  private nameOf(id: PlayerId | null): string {
    if (!id) return '';
    if (id === this.selfId()) return this.selfName();
    return this.remote.views().find((p) => p.id === id)?.name ?? '…';
  }

  /** Whether a player is close enough to you for their small news to be worth a line. */
  private isNear(id: PlayerId, metres = 40): boolean {
    if (id === this.selfId()) return true;
    const p = this.remote.positionOf(id);
    if (!p) return false;
    return Math.hypot(p.x - this.local.position.x, p.z - this.local.position.z) <= metres;
  }

  private onEvent(event: WorldEvent): void {
    switch (event.k) {
      case 'catch': {
        // A record is news for the whole island; an ordinary catch only for whoever is
        // standing on the same pier.
        if (event.record || this.isNear(event.by, 30)) {
          const params = { name: this.nameOf(event.by), fish: fishName(event.fish), size: event.size };
          pushSystemChat(tr(event.record ? 'event.catchRecord' : 'event.catch', params));
        }
        break;
      }
      case 'omikuji':
        if (this.isNear(event.by, 30)) {
          const slip = fortuneText(event.fortune, 0, 0);
          pushSystemChat(tr('event.omikuji', { name: this.nameOf(event.by), fortune: slip.kanji }));
          this.bubbles.say(event.by, slip.kanji);
        }
        break;
      case 'stamp': {
        if (event.by === this.selfId()) {
          // The profile push that carries the new stamp arrives before this event (it is sent
          // straight away, the event rides the next tick), so the count is already current.
          const card = get(profile);
          notify(tr('stamp.got', { place: zoneName(event.zone), n: card?.stamps.length ?? 1, total: card?.stampTotal ?? 1 }), 'good');
        }
        if (event.complete) pushSystemChat(tr('event.stampComplete', { name: this.nameOf(event.by) }));
        break;
      }
      case 'dice':
        pushSystemChat(tr('event.dice', { name: this.nameOf(event.by), value: event.value, sides: event.sides }));
        this.bubbles.say(event.by, `🎲 ${event.value}`);
        break;
      case 'janken': {
        if (event.winner) {
          const loser = event.winner === event.a ? event.b : event.a;
          pushSystemChat(tr('event.jankenWin', { winner: this.nameOf(event.winner), loser: this.nameOf(loser) }));
        } else {
          pushSystemChat(tr('event.jankenDraw', { a: this.nameOf(event.a), b: this.nameOf(event.b) }));
        }
        this.bubbles.say(event.a, HAND_GLYPH[event.ha]);
        this.bubbles.say(event.b, HAND_GLYPH[event.hb]);
        break;
      }
      case 'treasure':
        pushSystemChat(
          tr(event.left > 0 ? 'event.treasure' : 'event.treasureLast', { name: this.nameOf(event.by), n: event.left }),
        );
        break;
      case 'badge': {
        const badge = getBadge(event.badge);
        if (!badge) break;
        pushSystemChat(tr('event.badge', { icon: badge.icon, name: this.nameOf(event.by), badge: badgeName(event.badge) }));
        if (event.by === this.selfId()) notify(`${badge.icon} ${badgeName(event.badge)}`, 'good', 4000);
        break;
      }
      default:
        break;
    }
    try {
      this.onWorldEvent?.(event);
    } catch (err) {
      console.error('[sync] world event handler threw', err);
    }
  }

  /**
   * A fresh friends list. What changed is worth a word — a new ask, a new friend, a friend
   * who has just come on — but not on the first list of a connection, which is only news
   * of how things stand.
   */
  private onFriends(msg: ServerFriends): void {
    const before = get(friends);
    friends.set({ friends: msg.friends, requests: msg.requests, enabled: msg.enabled });
    if (!this.friendsSeen) {
      this.friendsSeen = true;
      return;
    }
    const knownAsks = new Set(before.requests.map((r) => r.id));
    for (const r of msg.requests) {
      // Someone you have muted still asks — the panel lists it — but does not interrupt you.
      if (knownAsks.has(r.id) || (r.player && isMuted(r.player))) continue;
      notify(tr('friend.asked', { name: r.name }), 'good', 5000);
    }
    const was = new Map(before.friends.map((f) => [f.id, f]));
    for (const f of msg.friends) {
      const old = was.get(f.id);
      if (!old) notify(tr('friend.added', { name: f.name }), 'good', 4000);
      else if (!old.online && f.online && f.room) {
        pushSystemChat(tr('friend.online', { name: f.name, place: this.placeOf(f.room) }));
        this.onForYou?.();
      }
    }
  }

  /** How a friend's island reads in a line. */
  private placeOf(r: NonNullable<ServerFriends['friends'][number]['room']>): string {
    return islandName(r);
  }

  private onFish(msg: Extract<ServerMessage, { t: 'fish' }>): void {
    if (this.fishingTimer !== null) {
      clearTimeout(this.fishingTimer);
      this.fishingTimer = null;
    }
    fishing.set({
      phase: msg.phase,
      spot: msg.phase === 'waiting' || msg.phase === 'bite' ? (msg.spot ?? null) : null,
      biteAt: msg.phase === 'bite' ? performance.now() : 0,
      window: msg.window ?? 0,
      caught:
        msg.phase === 'caught' && msg.fish
          ? {
              fish: msg.fish,
              size: msg.size ?? 0,
              newSpecies: msg.newSpecies === true,
              record: msg.record === true,
              personalBest: msg.personalBest === true,
            }
          : null,
      reason: msg.reason ?? null,
    });
    // The rod goes up while the line is out; it comes down when it is in.
    this.local.setFishing(msg.phase === 'waiting' || msg.phase === 'bite');
    if (msg.phase === 'caught') this.local.character.playEmote(AnimState.Cheer, 1.6);
    if (msg.phase === 'escaped' && msg.reason) notify(tr(`fish.escaped.${msg.reason}`), 'neutral', 2200);
    // A result stays up long enough to read, then the spot is quiet again.
    if (msg.phase === 'caught' || msg.phase === 'escaped') {
      this.fishingTimer = setTimeout(() => {
        this.fishingTimer = null;
        fishing.update((f) => (f.phase === msg.phase ? { ...f, phase: 'idle', caught: null, reason: null } : f));
      }, msg.phase === 'caught' ? 5200 : 1800);
    }
  }

  private onJanken(msg: ServerJanken): void {
    if (this.jankenTimer !== null) {
      clearTimeout(this.jankenTimer);
      this.jankenTimer = null;
    }
    janken.update((cur) => {
      const base = cur && cur.duel === msg.duel ? cur : null;
      const next = {
        duel: msg.duel,
        opponent: msg.opponent,
        opponentName: msg.opponentName,
        deadline: msg.deadline ?? base?.deadline ?? serverNow(),
        round: msg.round ?? base?.round ?? 1,
        mine: base?.mine ?? null,
        theirs: base?.theirs ?? null,
        winner: base?.winner ?? null,
        final: false,
        reason: null as NonNullable<ServerJanken['reason']> | null,
        byMe: false,
      };
      switch (msg.kind) {
        case 'invited':
          return { ...next, phase: 'invited' as const };
        case 'waiting':
          return { ...next, phase: 'waiting' as const };
        case 'start':
          return { ...next, phase: 'choose' as const, mine: null, theirs: null, winner: null };
        case 'result':
          return {
            ...next,
            phase: 'result' as const,
            mine: msg.mine ?? null,
            theirs: msg.theirs ?? null,
            winner: msg.winner ?? null,
            final: msg.final === true,
          };
        case 'cancelled':
          // Only the challenged side can decline, so if we were answering an invitation the
          // one who declined was us — which the card says differently from being declined.
          return { ...next, phase: 'cancelled' as const, reason: msg.reason ?? null, byMe: cur?.duel === msg.duel && cur.phase === 'invited' };
        default:
          return cur;
      }
    });
    // A finished duel lingers long enough to see the hands, then clears. A tie that goes to
    // another round is replaced by the next `start` instead.
    if ((msg.kind === 'result' && msg.final) || msg.kind === 'cancelled') {
      this.jankenTimer = setTimeout(() => {
        this.jankenTimer = null;
        janken.update((cur) => (cur?.duel === msg.duel ? null : cur));
      }, msg.kind === 'result' ? 4000 : 2500);
    }
  }

  private onQuiz(next: QuizView | null): void {
    const before = get(quiz);
    quiz.set(next);
    const me = this.selfId();
    if (!next || !me || next.phase === 'lobby') return;
    // Personal verdicts, said once, when the phase that decides them arrives.
    if (next.phase === 'reveal' && before?.phase !== 'reveal' && next.fell?.includes(me)) notify(tr('quiz.eliminated'), 'neutral');
    else if (next.phase === 'reveal' && before?.phase !== 'reveal' && next.alive.includes(me)) notify(tr('quiz.survived'), 'good');
    if (next.phase === 'finished' && before?.phase !== 'finished' && next.winners?.includes(me)) notify(tr('quiz.won'), 'good', 6000);
  }

  private onDaruma(next: DarumaView | null): void {
    const before = get(daruma);
    daruma.set(next);
    const me = this.selfId();
    if (!next || !me) return;
    const same = before?.activity === next.activity;
    // Said once each: seen moving (the card says it too, but the card may be out of view),
    // and home.
    if (next.caught?.includes(me) && !(same && before?.phase === next.phase && before.caught?.includes(me))) {
      notify(tr('daruma.caughtYou'), 'neutral');
    }
    const place = next.places.findIndex((p) => p.id === me);
    if (place >= 0 && !(same && before?.places.some((p) => p.id === me))) {
      notify(tr('daruma.home', { n: place + 1 }), 'good', 5000);
      this.local.character.playEmote(AnimState.Cheer, 1.6);
    }
  }

  /** Forget in-flight game state: a new connection or a new room starts clean. */
  private resetGames(): void {
    if (this.fishingTimer !== null) clearTimeout(this.fishingTimer);
    if (this.jankenTimer !== null) clearTimeout(this.jankenTimer);
    this.fishingTimer = null;
    this.jankenTimer = null;
    fishing.set({ phase: 'idle', spot: null, biteAt: 0, window: 0, caught: null, reason: null });
    janken.set(null);
    omikujiSlip.set(null);
    lastDig.set(null);
    checkinList.set(null);
    this.placedAt = null;
    this.local.setFishing(false);
    // The seat goes with the connection too (the server frees it on a drop and on a room
    // switch). Left sitting, every movement key would be swallowed at the new harbour.
    this.local.setSeated(false);
    this.local.setDancing(false);
    self.update((s) => (s.seated ? { ...s, seated: false } : s));
  }

  private showToast(announcement: AnnouncementView): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    currentToast.set(announcement);
    this.toastTimer = setTimeout(() => {
      currentToast.set(null);
      this.toastTimer = null;
    }, announcement.ttlMs || DEFAULT_TOAST_MS);
  }

  /**
   * Ask for a fresh snapshot. Debounced: a burst of gaps is one problem, not five, and
   * five snapshot requests would make a congested connection worse.
   */
  private requestResync(): void {
    if (this.resyncPending) return;
    this.resyncPending = true;
    this.connection.send({ t: 'resync', haveTick: this.lastTick });
    // If the resync never lands, allow another attempt rather than wedging forever.
    setTimeout(() => {
      this.resyncPending = false;
    }, 3000);
  }

  private onServerError(msg: ServerError): void {
    // Rate limiting is our own fault and not worth telling the player about.
    if (msg.code === 'rate_limited' && !msg.key) return;
    const fatal = msg.fatal === true;
    // Say it in the player's language when the server said why; otherwise map the code.
    const byCode: Record<string, string> = {
      kicked: 'error.kicked',
      server_shutdown: 'error.shutdown',
      version_mismatch: 'error.version',
      room_full: 'error.full',
      activity_full: 'error.full',
      forbidden: 'error.forbidden',
    };
    // Sitting is optimistic; a seat that turned out to be taken stands us back up.
    if (msg.key === 'seat_taken') {
      this.local.setSeated(false);
      self.update((s) => ({ ...s, seated: false }));
    }
    const key = msg.key ? `error.${msg.key}` : byCode[msg.code];
    // The server's own `message` is English and for logs; never show it to a player.
    const text = key ? tr(key, msg.params) : '';
    notify(!text || text === key ? tr('error.generic') : text, fatal ? 'warn' : 'neutral');
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /**
   * Report our transform if it has changed enough. Called every frame; sends at most
   * `PROTOCOL.MOVE_SEND_HZ` times per second.
   */
  tickOutbound(dt: number): void {
    this.moveAccumulator += dt;
    const interval = 1 / PROTOCOL.MOVE_SEND_HZ;
    if (this.moveAccumulator < interval) return;
    this.moveAccumulator = 0;

    const pos = this.local.position;
    const yaw = this.local.yaw;
    const now = performance.now();

    const anim = this.local.character.animState;
    // A change of pose on the spot — sitting down on the ground, starting to dance — is a
    // change worth sending, though nothing moved.
    const moved =
      !Number.isFinite(this.lastSentYaw) ||
      anim !== this.lastSentAnim ||
      pos.distanceToSquared(this.lastSentPos) > POSITION_DEADBAND * POSITION_DEADBAND ||
      Math.abs(yaw - this.lastSentYaw) > YAW_DEADBAND;

    if (!moved && now - this.lastSentAt < KEEPALIVE_INTERVAL_MS) return;

    this.lastSentPos.copy(pos);
    this.lastSentYaw = yaw;
    this.lastSentAnim = anim;
    this.lastSentAt = now;

    const reported: Vec3 = [pos.x, pos.y, pos.z];
    // Remember it locally too. If the connection dies before the next report — and
    // especially if it stays dead long enough for the server to forget us — this is the
    // only record of where we were, and the thing that gets us back here rather than to
    // the harbour. Throttled inside; safe to call at the move rate.
    rememberPose(reported, yaw, activeMapId() ?? '');

    this.connection.send({
      t: 'move',
      pos: reported,
      yaw,
      anim,
      seq: ++this.seq,
    });
  }

  /** Send an emote and play it locally at once — never wait for the echo. */
  sendEmote(emote: Emote): void {
    this.local.character.playEmote(EMOTE_ANIMATIONS[emote] ?? AnimState.Wave);
    this.connection.send({ t: 'emote', emote });
  }

  joinActivity(activity: ActivityId, mode: 'participant' | 'audience'): void {
    this.connection.send({ t: 'activity_join', activity, mode });
  }

  leaveActivity(activity: ActivityId): void {
    this.connection.send({ t: 'activity_leave', activity });
  }

  checkIn(activity: ActivityId): void {
    this.connection.send({ t: 'checkin', activity });
  }

  interact(target: string, kind: 'use' | 'sit' | 'stand'): void {
    this.connection.send({ t: 'interact', target, kind });
  }

  switchRoom(room: string): void {
    this.connection.send({ t: 'room_switch', room });
  }

  createRoom(): void {
    this.connection.send({ t: 'room_create' });
  }

  fish(action: 'hook' | 'stop'): void;
  fish(action: 'cast', spot: string): void;
  fish(action: 'cast' | 'hook' | 'stop', spot?: string): void {
    if (action === 'cast') this.connection.send({ t: 'fish', action, spot: spot ?? '' });
    else this.connection.send({ t: 'fish', action });
  }

  jankenChallenge(target: PlayerId): void {
    this.connection.send({ t: 'janken', action: 'challenge', target });
  }

  jankenRespond(duel: string, accept: boolean): void {
    this.connection.send({ t: 'janken', action: 'respond', duel, accept });
  }

  jankenThrow(duel: string, hand: Hand): void {
    janken.update((cur) => (cur?.duel === duel && cur.phase === 'choose' ? { ...cur, mine: hand } : cur));
    this.connection.send({ t: 'janken', action: 'throw', duel, hand });
  }

  whisper(to: PlayerId, text: string): void {
    const trimmed = text.trim().slice(0, PROTOCOL.MAX_CHAT_LENGTH);
    if (!trimmed) return;
    // Not echoed optimistically: the server's `whisper` reply is the receipt, and carries
    // the name the other end actually has.
    this.queueChat({ t: 'chat', text: trimmed, to });
  }

  /** Generic passthrough for host and admin messages. */
  send(msg: ClientMessage): void {
    this.connection.send(msg);
  }

  private selfId(): PlayerId | null {
    return this.connection.welcome?.self ?? null;
  }

  /** The local player's server-assigned id, once the handshake has completed. */
  get selfPlayerId(): PlayerId | null {
    return this.selfId();
  }

  /** The local player's chosen name, read from the store at call time. */
  private selfName(): string {
    let name = 'You';
    self.subscribe((s) => (name = s.name || 'You'))();
    return name;
  }

  /**
   * Send a line of chat.
   *
   * Appended to the log optimistically so the composer feels instant, but *not* bubbled —
   * the bubble is raised when the server echoes the line back, so your own words appear
   * over your own head at the same moment everyone else sees them. A bubble that led the
   * room by a round trip would make your character look out of sync with its own voice.
   */
  say(text: string): void {
    const trimmed = text.trim().slice(0, PROTOCOL.MAX_CHAT_LENGTH);
    if (!trimmed) return;
    pushChat({ playerId: this.selfId() ?? '', name: this.selfName(), text: trimmed, self: true });
    this.queueChat({ t: 'chat', text: trimmed });
  }

  /**
   * Send a chat frame within the server's budget (a burst of four, then one a second). The
   * mirror of the server's bucket is approximate — the server's refill clock is its own —
   * so the local one refills slightly slower to stay on the safe side.
   */
  private queueChat(msg: ClientMessage): void {
    this.chatQueue.push(msg);
    if (this.chatQueue.length > 20) this.chatQueue.shift();
    this.drainChat();
  }

  private drainChat(): void {
    if (this.chatTimer !== null || this.connection.currentState !== 'connected') return;
    const now = performance.now();
    this.chatTokens = Math.min(4, this.chatTokens + ((now - this.chatRefilledAt) / 1000) * 0.9);
    this.chatRefilledAt = now;
    while (this.chatQueue.length > 0 && this.chatTokens >= 1) {
      this.chatTokens -= 1;
      this.connection.send(this.chatQueue.shift()!);
    }
    if (this.chatQueue.length > 0) {
      const wait = ((1 - this.chatTokens) / 0.9) * 1000 + 20;
      this.chatTimer = setTimeout(() => {
        this.chatTimer = null;
        this.drainChat();
      }, wait);
    }
  }

  /**
   * Utility used by tests and by the debug console: pack a transform exactly as the
   * server would, so a mismatch in quantisation shows up immediately.
   */
  static packForTest(index: number, pos: Vec3, yaw: number, anim: AnimState): number[] {
    return packTransform(index, pos, yaw, anim);
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    if (this.fishingTimer !== null) clearTimeout(this.fishingTimer);
    if (this.jankenTimer !== null) clearTimeout(this.jankenTimer);
    if (this.chatTimer !== null) clearTimeout(this.chatTimer);
  }
}

/** A hand, as a glyph for the bubble over whoever threw it. */
const HAND_GLYPH: Record<Hand, string> = { rock: '✊', paper: '✋', scissors: '✌️' };
