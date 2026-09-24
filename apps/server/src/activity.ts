/**
 * Activities — scheduled things happening somewhere on the island, and the people
 * attending them.
 * =====================================================================================
 *
 * `Activity` is one instance (a specific Lantern Walk at 18:00); `ActivityManager` owns
 * every activity in a room plus the scheduler that advances them through time without
 * anyone having to click a button. This file has no knowledge of WebSockets or rooms —
 * it emits plain Node events, and `room.ts` is the only place that turns those into
 * wire deltas. That separation is what makes `activity.test.ts` able to test lifecycle
 * rules without spinning up a socket.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  canTransition,
  getTemplate,
  ActivityState,
  type ActivityFeature,
  type ActivityId,
  type ActivityTemplate,
  type ActivityView,
  type AttendanceMode,
  type PlayerId,
  type ZoneId,
} from '@nagisa/shared';

/** How long before `startsAt` the doors open for join/audience. Product-chosen, not protocol. */
export const OPEN_BEFORE_START_MS = 5 * 60 * 1000;

/**
 * How long a present host has to press start before the island starts it anyway. A host
 * waiting for a few more people is a human decision worth honouring; a host who wandered off
 * to fish is not a reason for sixty people to stand in the plaza indefinitely.
 */
export const HOST_START_GRACE_MS = 3 * 60 * 1000;

/** How long an ended or cancelled activity stays on the board before it is cleared off. */
export const CLEAR_AFTER_MS = 15 * 60 * 1000;

/** One recorded check-in: who, in what order, and when. */
export interface CheckinRecord {
  readonly playerId: PlayerId;
  /** 1-based position in check-in arrival order. Stable once assigned — never renumbered. */
  readonly ordinal: number;
  readonly at: number;
  /**
   * The name they checked in under: the register outlives the people on it, who leave and
   * take their player (and its name) with them. Absent in files from before it was kept.
   */
  readonly name?: string;
  /**
   * The visitor-key hash they checked in with, if they had a key: one person is one line on
   * the register, however many tabs they have or player ids they come back as.
   */
  readonly visitor?: string;
}

/** Outcome of a join attempt. */
export type JoinResult = { ok: true } | { ok: false; reason: 'full' | 'not_open' };

/** Outcome of a check-in attempt. */
export type CheckinResult = { ok: true; ordinal: number } | { ok: false; reason: 'not_live' | 'already' | 'not_attending' };

/**
 * One scheduled activity and its live roster.
 *
 * State is intentionally mutable and owned by the containing `ActivityManager` — this
 * class has no persistence or broadcast concerns of its own, it just enforces the rules
 * of what an activity is allowed to do.
 */
export class Activity {
  readonly id: ActivityId;
  readonly templateId: string;
  title: string;
  blurb: string;
  zone: ZoneId;
  state: ActivityState = ActivityState.Scheduled;
  startsAt: number;
  endsAt: number | null;
  hostId: PlayerId | null = null;
  hostName: string | null = null;
  /** 0 = uncapped. Enforced against total attendance (participants + audience) on join. */
  capacity: number;
  checkinEnabled: boolean;
  /** What the island does while it runs (the quiz, the derby, fireworks…). From the template. */
  readonly feature: ActivityFeature | null;
  /** The programme slot it was made for, or an `adhoc:` id. See `schedule.ts`. */
  slot: string | null;
  /** When it ended or was called off; drives clearing it off the board. */
  closedAt: number | null = null;
  /** The activity's small leaderboard, if it keeps score. */
  board: Array<{ id: PlayerId; name: string; score: number }> | null = null;
  /** A treasure hunt's count of things still buried; null for anything else. */
  left: number | null = null;

  readonly participants = new Set<PlayerId>();
  readonly audience = new Set<PlayerId>();
  private readonly checkins = new Map<PlayerId, CheckinRecord>();
  private nextOrdinal = 1;

  constructor(opts: {
    id?: ActivityId;
    templateId: string;
    title: string;
    blurb: string;
    zone: ZoneId;
    startsAt: number;
    endsAt: number | null;
    capacity: number;
    checkinEnabled: boolean;
    slot?: string | null;
  }) {
    this.id = opts.id ?? randomUUID();
    this.feature = getTemplate(opts.templateId)?.feature ?? null;
    this.slot = opts.slot ?? null;
    this.templateId = opts.templateId;
    this.title = opts.title;
    this.blurb = opts.blurb;
    this.zone = opts.zone;
    this.startsAt = opts.startsAt;
    this.endsAt = opts.endsAt;
    this.capacity = opts.capacity;
    this.checkinEnabled = opts.checkinEnabled;
  }

  /** Build one from a world.ts template, with a concrete schedule. */
  static fromTemplate(template: ActivityTemplate, startsAt: number, slot: string | null = null): Activity {
    const endsAt = startsAt + template.durationMin * 60 * 1000;
    return new Activity({
      templateId: template.id,
      title: template.title,
      blurb: template.blurb,
      zone: template.zone,
      startsAt,
      endsAt,
      capacity: template.capacity,
      checkinEnabled: template.checkinEnabled,
      slot,
    });
  }

  /** Current total attendance, both roles. */
  get attendanceCount(): number {
    return this.participants.size + this.audience.size;
  }

  /** Whether attaching one more attendee (of either mode) would exceed capacity. */
  private hasRoom(): boolean {
    return this.capacity === 0 || this.attendanceCount < this.capacity;
  }

  /**
   * Attempt a server-validated lifecycle transition. Rejections are intentional and
   * common (a double-tapped "start" button, a stale client racing another host) — see
   * {@link canTransition} for the legal graph. Returns whether the transition happened.
   */
  transitionTo(next: ActivityState, nowMs = Date.now()): boolean {
    if (!canTransition(this.state, next)) return false;
    this.state = next;
    if (next === ActivityState.Ended || next === ActivityState.Cancelled) this.closedAt = nowMs;
    return true;
  }

  /** Whether it is over, one way or the other. */
  get closed(): boolean {
    return this.state === ActivityState.Ended || this.state === ActivityState.Cancelled;
  }

  /**
   * Attach a player as participant or audience. Legal only while the activity is
   * `open` or `live` (you may slip into an audience after it has started; you may not
   * join something `scheduled`, `ended` or `cancelled`), and only while there is room.
   */
  join(playerId: PlayerId, mode: AttendanceMode): JoinResult {
    if (this.state !== ActivityState.Open && this.state !== ActivityState.Live) {
      return { ok: false, reason: 'not_open' };
    }
    // Idempotent: re-joining in the same mode you're already in is a no-op success.
    if (mode === 'participant' && this.participants.has(playerId)) return { ok: true };
    if (mode === 'audience' && this.audience.has(playerId)) return { ok: true };

    // Changing from watching to taking part (or back) does not add anybody.
    if (!this.isAttending(playerId) && !this.hasRoom()) return { ok: false, reason: 'full' };

    // A player can hold only one mode at a time; switching modes releases the old slot.
    this.participants.delete(playerId);
    this.audience.delete(playerId);
    (mode === 'participant' ? this.participants : this.audience).add(playerId);
    return { ok: true };
  }

  /** Detach a player from either roster. A no-op if they were not attending. */
  leave(playerId: PlayerId): void {
    this.participants.delete(playerId);
    this.audience.delete(playerId);
  }

  /** Whether `playerId` currently holds either attendance role. */
  isAttending(playerId: PlayerId): boolean {
    return this.participants.has(playerId) || this.audience.has(playerId);
  }

  /**
   * Record a check-in. Only accepted while `Live`, only once per player, and only for
   * someone currently attending. Ordinals are assigned strictly in arrival order and
   * never reused or renumbered, even if an earlier check-in were somehow retracted —
   * they are a historical record ("you were the 12th person here"), not a live seat
   * count.
   */
  checkin(playerId: PlayerId, nowMs: number, name?: string, visitor?: string): CheckinResult {
    if (this.state !== ActivityState.Live) return { ok: false, reason: 'not_live' };
    if (!this.checkinEnabled) return { ok: false, reason: 'not_live' };
    if (!this.isAttending(playerId)) return { ok: false, reason: 'not_attending' };
    const existing = this.checkins.get(playerId) ?? (visitor ? [...this.checkins.values()].find((r) => r.visitor === visitor) : undefined);
    if (existing) return { ok: false, reason: 'already' };
    const record: CheckinRecord = { playerId, ordinal: this.nextOrdinal++, at: nowMs, ...(name ? { name } : {}), ...(visitor ? { visitor } : {}) };
    this.checkins.set(playerId, record);
    return { ok: true, ordinal: record.ordinal };
  }

  /** All check-in records, in arrival order. Used for persistence and the post-event summary. */
  checkinRecords(): CheckinRecord[] {
    return [...this.checkins.values()].sort((a, b) => a.ordinal - b.ordinal);
  }

  /** Restore check-in records from persisted state (server restart). Does not re-validate attendance. */
  restoreCheckins(records: readonly CheckinRecord[]): void {
    for (const r of records) {
      if (!r || typeof r.playerId !== 'string' || !Number.isFinite(r.ordinal) || !Number.isFinite(r.at)) continue;
      this.checkins.set(r.playerId, {
        playerId: r.playerId,
        ordinal: r.ordinal,
        at: r.at,
        ...(typeof r.name === 'string' ? { name: r.name } : {}),
        ...(typeof r.visitor === 'string' ? { visitor: r.visitor } : {}),
      });
      this.nextOrdinal = Math.max(this.nextOrdinal, r.ordinal + 1);
    }
  }

  /** Assign (or clear, with `null`) the host. Does not itself check permissions — see permissions.ts. */
  setHost(playerId: PlayerId | null, name: string | null): void {
    this.hostId = playerId;
    this.hostName = playerId ? name : null;
  }

  /** Project to the wire shape. */
  toView(): ActivityView {
    return {
      id: this.id,
      title: this.title,
      blurb: this.blurb,
      zone: this.zone,
      state: this.state,
      startsAt: this.startsAt,
      endsAt: this.endsAt,
      hostId: this.hostId,
      hostName: this.hostName,
      participantCount: this.participants.size,
      audienceCount: this.audience.size,
      capacity: this.capacity,
      checkinEnabled: this.checkinEnabled,
      checkinCount: this.checkins.size,
      templateId: this.templateId,
      feature: this.feature,
      board: this.board ? this.board.map((b) => ({ ...b })) : undefined,
      left: this.left ?? undefined,
    };
  }
}

/** Events emitted by `ActivityManager`, consumed by `room.ts` to build wire deltas. */
export interface ActivityManagerEvents {
  /** An activity was created or one of its fields changed (including lifecycle state). */
  changed: [activity: Activity];
  /**
   * An activity moved between lifecycle states — by the scheduler, a host, or a game ending
   * it. Emitted before `changed`. The room starts and stops the activity's feature here.
   */
  transition: [activity: Activity, from: ActivityState, to: ActivityState];
  /** An activity was cleared off the board entirely. */
  removed: [id: ActivityId];
}

/**
 * Owns every activity in a room and the rules that move them through time.
 *
 * The scheduler is deliberately dumb: a periodic sweep rather than per-activity timers. A
 * sweep is trivially resilient to the process having been asleep (suspended in a container
 * pause, a laptop lid): it compares against wall-clock "now" rather than trusting that a
 * timer fired on schedule.
 */
export class ActivityManager extends EventEmitter {
  private readonly activities = new Map<ActivityId, Activity>();

  /** Create and register an activity from a world.ts template. Emits `changed`. */
  createFromTemplate(templateId: string, startsAt: number, slot: string | null = null): Activity {
    const template = getTemplate(templateId);
    if (!template) throw new Error(`Unknown activity template: ${templateId}`);
    const activity = Activity.fromTemplate(template, startsAt, slot);
    this.activities.set(activity.id, activity);
    this.emit('changed', activity);
    return activity;
  }

  /** Register a fully-formed activity (used when restoring from persistence). */
  add(activity: Activity): void {
    this.activities.set(activity.id, activity);
  }

  get(id: ActivityId): Activity | undefined {
    return this.activities.get(id);
  }

  list(): Activity[] {
    return [...this.activities.values()];
  }

  /** Whether some activity already occupies this programme slot. */
  hasSlot(slot: string): boolean {
    for (const a of this.activities.values()) if (a.slot === slot) return true;
    return false;
  }

  /** Emit `changed` for an activity after an external mutation (join/leave/checkin/host). */
  notifyChanged(activity: Activity): void {
    this.emit('changed', activity);
  }

  /**
   * Move an activity to `next` if the lifecycle allows it, announcing the transition.
   * Every state change — scheduler, host, game — goes through here, so the room never
   * misses one.
   */
  transition(activity: Activity, next: ActivityState, nowMs = Date.now()): boolean {
    const from = activity.state;
    if (!activity.transitionTo(next, nowMs)) return false;
    this.emit('transition', activity, from, next);
    this.emit('changed', activity);
    return true;
  }

  /**
   * Advance every activity whose scheduled transition is due, and clear off the ones that
   * finished a while ago. Called by the room's tick; a handful of comparisons per activity.
   *
   * The rules, all product-chosen:
   * - `scheduled → open` at `startsAt - OPEN_BEFORE_START_MS`, so a crowd can form.
   * - `open → live` at `startsAt` when nobody is hosting it, or when its host is not here;
   *   a present host gets {@link HOST_START_GRACE_MS} to start it themselves. The island runs
   *   its own day — an activity nobody is hosting is not an activity that never starts.
   * - `live → ended` at `endsAt`, so nothing runs forever.
   * - Anything still `scheduled` or `open` when its end time has passed is `cancelled`: it
   *   was never going to happen (the server was down through it, or its host held it and
   *   never let it go), and saying so is better than leaving it on the board.
   * - Ended and cancelled activities are removed {@link CLEAR_AFTER_MS} after they closed
   *   (and not before their scheduled end).
   *
   * `hostPresent` answers whether a player id is in the room and connected.
   */
  sweep(nowMs: number, hostPresent: (id: PlayerId) => boolean = () => false): void {
    for (const activity of [...this.activities.values()]) {
      // Apply every transition that is due, not just the first: an activity restored after
      // a long sleep may be owed `scheduled → open → live` at once, and taking one step per
      // tick would show a live event as "open" for a frame for no reason.
      for (let step = 0; step < 4; step++) {
        const before = activity.state;
        this.step(activity, nowMs, hostPresent);
        if (activity.state === before || !this.activities.has(activity.id)) break;
      }
    }
  }

  /** One lifecycle step for one activity, if one is due. See {@link sweep}. */
  private step(activity: Activity, nowMs: number, hostPresent: (id: PlayerId) => boolean): void {
    const end = activity.endsAt ?? Infinity;
    switch (activity.state) {
      case ActivityState.Scheduled:
        if (nowMs >= end) this.transition(activity, ActivityState.Cancelled, nowMs);
        else if (nowMs >= activity.startsAt - OPEN_BEFORE_START_MS) this.transition(activity, ActivityState.Open, nowMs);
        return;
      case ActivityState.Open: {
        if (nowMs >= end) {
          this.transition(activity, ActivityState.Cancelled, nowMs);
          return;
        }
        if (nowMs < activity.startsAt) return;
        const hosted = activity.hostId !== null && hostPresent(activity.hostId);
        if (!hosted || nowMs >= activity.startsAt + HOST_START_GRACE_MS) {
          this.transition(activity, ActivityState.Live, nowMs);
        }
        return;
      }
      case ActivityState.Live:
        if (nowMs >= end) this.transition(activity, ActivityState.Ended, nowMs);
        return;
      default:
        if (activity.closedAt === null) activity.closedAt = nowMs; // restored from an old file
        // Kept at least until its scheduled end as well: the programme recognises a slot by
        // the activity sitting in it, and would otherwise re-create one that was called off
        // early (see `schedule.ts`).
        if (nowMs - activity.closedAt >= CLEAR_AFTER_MS && nowMs >= end) {
          this.activities.delete(activity.id);
          this.emit('removed', activity.id);
        }
    }
  }
}

export interface ActivityManager {
  on<K extends keyof ActivityManagerEvents>(event: K, listener: (...args: ActivityManagerEvents[K]) => void): this;
  emit<K extends keyof ActivityManagerEvents>(event: K, ...args: ActivityManagerEvents[K]): boolean;
}
