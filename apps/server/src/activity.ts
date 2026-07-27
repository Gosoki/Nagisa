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
  type ActivityId,
  type ActivityTemplate,
  type ActivityView,
  type AttendanceMode,
  type PlayerId,
  type ZoneId,
} from '@nagisa/shared';

/** How long before `startsAt` the doors open for join/audience. Product-chosen, not protocol. */
const OPEN_BEFORE_START_MS = 5 * 60 * 1000;

/** One recorded check-in: who, in what order, and when. */
export interface CheckinRecord {
  readonly playerId: PlayerId;
  /** 1-based position in check-in arrival order. Stable once assigned — never renumbered. */
  readonly ordinal: number;
  readonly at: number;
}

/** Outcome of a join attempt. */
export type JoinResult = { ok: true } | { ok: false; reason: 'full' | 'not_open' | 'wrong_zone' };

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
  }) {
    this.id = opts.id ?? randomUUID();
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
  static fromTemplate(template: ActivityTemplate, startsAt: number): Activity {
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
  transitionTo(next: ActivityState): boolean {
    if (!canTransition(this.state, next)) return false;
    this.state = next;
    return true;
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

    if (!this.hasRoom()) return { ok: false, reason: 'full' };

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
  checkin(playerId: PlayerId, nowMs: number): CheckinResult {
    if (this.state !== ActivityState.Live) return { ok: false, reason: 'not_live' };
    if (!this.checkinEnabled) return { ok: false, reason: 'not_live' };
    if (!this.isAttending(playerId)) return { ok: false, reason: 'not_attending' };
    const existing = this.checkins.get(playerId);
    if (existing) return { ok: false, reason: 'already' };
    const record: CheckinRecord = { playerId, ordinal: this.nextOrdinal++, at: nowMs };
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
      this.checkins.set(r.playerId, r);
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
    };
  }
}

/** Events emitted by `ActivityManager`, consumed by `room.ts` to build wire deltas. */
export interface ActivityManagerEvents {
  /** An activity was created or one of its fields changed (including lifecycle state). */
  changed: [activity: Activity];
  /** An activity should be removed from client boards entirely (currently unused by the
   *  scheduler — ended/cancelled activities are kept visible for the post-event summary
   *  — but reserved for a future "clear the board" admin action). */
  removed: [id: ActivityId];
}

/**
 * Owns every activity in a room and the scheduler that advances them through time.
 *
 * The scheduler is deliberately dumb: a periodic sweep (`tick`) rather than per-activity
 * timers. At the scale of one island's schedule (a handful of activities) a `setTimeout`
 * per transition would work too, but a sweep is trivially resilient to the process
 * having been asleep (e.g. suspended in a container pause) — it always compares against
 * wall-clock "now" rather than trusting that a timer fired on schedule.
 */
export class ActivityManager extends EventEmitter {
  private readonly activities = new Map<ActivityId, Activity>();

  /** Create and register an activity from a world.ts template. Emits `changed`. */
  createFromTemplate(templateId: string, startsAt: number): Activity {
    const template = getTemplate(templateId);
    if (!template) throw new Error(`Unknown activity template: ${templateId}`);
    const activity = Activity.fromTemplate(template, startsAt);
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

  /** Emit `changed` for an activity after an external mutation (join/leave/checkin/host). */
  notifyChanged(activity: Activity): void {
    this.emit('changed', activity);
  }

  /**
   * Advance every activity whose scheduled transition is due. Call this periodically
   * (the room's tick loop calls it once a tick; it is cheap — a handful of comparisons
   * per activity).
   *
   * Rules, both product-chosen:
   * - `scheduled → open` fires at `startsAt - OPEN_BEFORE_START_MS`, so a queue can form
   *   before the doors technically open.
   * - `live → ended` fires at `endsAt`, so a forgotten activity doesn't run forever.
   *
   * Note `open → live` is deliberately *not* automatic: a host starts it. Doors opening
   * on time is a scheduling fact; the activity actually beginning is a human decision
   * (the host might be waiting for a few more people, or running a minute late).
   */
  sweep(nowMs: number): void {
    for (const activity of this.activities.values()) {
      if (activity.state === ActivityState.Scheduled && nowMs >= activity.startsAt - OPEN_BEFORE_START_MS) {
        if (activity.transitionTo(ActivityState.Open)) this.emit('changed', activity);
      } else if (activity.state === ActivityState.Live && activity.endsAt !== null && nowMs >= activity.endsAt) {
        if (activity.transitionTo(ActivityState.Ended)) this.emit('changed', activity);
      }
    }
  }
}

export interface ActivityManager {
  on<K extends keyof ActivityManagerEvents>(event: K, listener: (...args: ActivityManagerEvents[K]) => void): this;
  emit<K extends keyof ActivityManagerEvents>(event: K, ...args: ActivityManagerEvents[K]): boolean;
}
