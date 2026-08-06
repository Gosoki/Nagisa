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
import {
  activeMapId,
  AnimState,
  PROTOCOL,
  Role,
  packTransform,
  unpackTransforms,
  type ActivityId,
  type AnnouncementView,
  type ClientMessage,
  type Emote,
  type PlayerId,
  type ServerDelta,
  type ServerMessage,
  type ServerSnapshot,
  type Vec3,
} from '@nagisa/shared';
import type { RemotePlayers } from '../character/remote-players.js';
import type { LocalPlayer } from '../character/local-player.js';
import type { Connection } from './connection.js';
import {
  activities,
  announcements,
  currentToast,
  followTarget,
  latency,
  notify,
  players,
  pushChat,
  pushSystemChat,
  room,
  rooms,
  self,
  zonePopulation,
} from '../state/stores.js';
import type { Speech } from '../character/speech.js';

/** Minimum movement before a transform is worth sending, metres. */
const POSITION_DEADBAND = 0.02;

/** Minimum yaw change before it is worth sending, radians (~0.6°). */
const YAW_DEADBAND = 0.01;

/**
 * Even a perfectly still player reports occasionally, so a client that joined after
 * they stopped moving still learns where they are without waiting for a snapshot.
 */
const KEEPALIVE_INTERVAL_MS = 2000;

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

  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly connection: Connection,
    private readonly remote: RemotePlayers,
    private readonly local: LocalPlayer,
    private readonly bubbles: Speech,
  ) {
    this.unsubscribers.push(connection.on('message', this.onMessage));
    this.unsubscribers.push(connection.on('latency', (rtt) => latency.set(rtt)));
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
          notify(`This room is on "${msg.mapId}" — reload with ?map=${msg.mapId}`, 'warn', 60_000);
          console.error(`[nagisa] map mismatch: client "${activeMapId()}", server "${msg.mapId}"`);
        }
        self.update((s) => ({ ...s, id: msg.self }));
        room.set(msg.room);
        rooms.set(msg.rooms);
        // A resumed session means we were already here; a fresh one means we just
        // arrived. Only the first deserves a greeting.
        if (msg.resumed) notify('Welcome back', 'good');
        break;

      case 'snapshot':
        this.applySnapshot(msg);
        break;

      case 'delta':
        this.applyDelta(msg);
        break;

      case 'correction':
        // The server disagreed about where we are. Snap, and say nothing — corrections
        // are almost always a terrain edge case, not cheating, and a warning would only
        // make an invisible problem visible.
        this.local.applyCorrection(msg.pos[0], msg.pos[1], msg.pos[2]);
        break;

      case 'checkin_ack':
        if (msg.ok) {
          self.update((s) => ({ ...s, checkedIn: true }));
          notify(msg.ordinal ? `Checked in — #${msg.ordinal}` : 'Checked in', 'good');
        } else {
          notify(msg.reason ?? 'Could not check in', 'warn');
        }
        break;

      case 'role_changed':
        self.update((s) => ({ ...s, role: msg.role }));
        if (msg.role >= Role.Host) notify('You are hosting', 'good');
        break;

      case 'room_changed':
        room.set(msg.room);
        // The snapshot for the new room follows; clear the old one so there is never a
        // frame showing the previous room's crowd in the new room's geometry.
        this.remote.clear();
        this.roster = [];
        this.lastTick = -1;
        // A new shard spawns us afresh, so the next snapshot's position is authoritative.
        this.adoptedSpawn = false;
        break;

      case 'error':
        this.onServerError(msg.code, msg.message, msg.fatal === true);
        break;

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
    const others = snap.players.filter((p) => p.id !== selfId);
    this.remote.reset(others);
    players.set(others);

    activities.set(snap.activities);
    announcements.set([...snap.announcements].sort((a, b) => b.at - a.at));
    zonePopulation.set(snap.zonePopulation);

    // Adopt our own server-side attachment state, which matters after a resume: you
    // rejoin already attached to the activity you were in.
    const me = snap.players.find((p) => p.id === selfId);
    if (me) {
      self.update((s) => ({ ...s, role: me.role, activity: me.activity, mode: me.mode }));
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
        pushSystemChat(`${view.name} arrived`);
        this.remote.add(view);
      }
      players.set(this.remote.views());
    }

    if (delta.leave?.length) {
      for (const id of delta.leave) {
        // Read the name before the removal, not after.
        const name = this.remote.views().find((p) => p.id === id)?.name;
        if (name) pushSystemChat(`${name} left`);
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
            // Detaching from an activity clears the check-in.
            checkedIn: patch.activity === null ? false : s.checkedIn,
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
      announcements.update((list) => [...delta.announcements!, ...list].slice(0, 40));
      // Present the highest-priority new announcement; a burst should not queue six
      // toasts one after another.
      const top = [...delta.announcements].sort((a, b) =>
        a.priority === b.priority ? b.at - a.at : a.priority === 'high' ? -1 : 1,
      )[0];
      this.showToast(top);
    }

    if (delta.emotes?.length) {
      for (const e of delta.emotes) {
        if (e.id === selfId) continue;
        const anim = EMOTE_ANIMATIONS[e.emote] ?? AnimState.Wave;
        this.remote.playEmote(e.id, anim);
      }
    }

    if (delta.chats?.length) {
      for (const c of delta.chats) {
        // The server echoes our own line back. It is already in the log — appended
        // optimistically the moment it was typed, so the composer feels instant — but the
        // *bubble* is raised here, from the echo, so it appears exactly when everyone
        // else's does rather than a round trip early.
        const mine = c.id === selfId;
        const name = mine ? this.selfName() : (this.remote.views().find((p) => p.id === c.id)?.name ?? 'Someone');
        if (!mine) pushChat({ playerId: c.id, name, text: c.text, self: false });
        this.bubbles.say(c.id, c.text);
      }
    }

    if (delta.zonePopulation) zonePopulation.set(delta.zonePopulation);
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

  private onServerError(code: string, message: string, fatal: boolean): void {
    // Rate limiting is our own fault and not worth telling the player about.
    if (code === 'rate_limited') return;
    notify(message, fatal ? 'warn' : 'neutral');
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

    const moved =
      !Number.isFinite(this.lastSentYaw) ||
      pos.distanceToSquared(this.lastSentPos) > POSITION_DEADBAND * POSITION_DEADBAND ||
      Math.abs(yaw - this.lastSentYaw) > YAW_DEADBAND;

    if (!moved && now - this.lastSentAt < KEEPALIVE_INTERVAL_MS) return;

    this.lastSentPos.copy(pos);
    this.lastSentYaw = yaw;
    this.lastSentAt = now;

    this.connection.send({
      t: 'move',
      pos: [pos.x, pos.y, pos.z] as Vec3,
      yaw,
      anim: this.local.character.animState,
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
    this.connection.send({ t: 'chat', text: trimmed });
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
  }
}
