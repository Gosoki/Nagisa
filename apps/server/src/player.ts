/**
 * Player — the server-side record of one participant in a room.
 * ================================================================
 *
 * A `Player` outlives any single `Session`: during the reconnect grace window
 * ({@link PROTOCOL.SESSION_GRACE_MS}) a player has no live socket at all, yet still
 * occupies their spot in the room, their activity roster slot, and the world. This file
 * intentionally has zero knowledge of WebSockets — see `session.ts` for that half.
 */

import {
  AnimState,
  MAX_SERVER_SPEED,
  MAX_SERVER_VERTICAL_SPEED,
  isWalkable,
  heightAt,
  nearestWalkable,
  zoneAt,
  Role,
  type Appearance,
  type ActivityId,
  type AttendanceMode,
  type PlayerId,
  type PlayerView,
  type ServerCorrection,
  type Vec3,
  type ZoneId,
} from '@nagisa/shared';

/**
 * Horizontal and vertical speed budgets, metres/second.
 *
 * Imported from the shared movement contract, never authored here. The client clamps its
 * own speed to `MAX_CLIENT_SPEED` and the server's budget is that number plus headroom, so
 * making the character faster cannot, by construction, make the character get corrected.
 * See `@nagisa/shared/movement` for the three ways that went wrong when the two sides held
 * their own copies.
 */
const MAX_HORIZONTAL_SPEED = MAX_SERVER_SPEED;

const MAX_VERTICAL_SPEED = MAX_SERVER_VERTICAL_SPEED;

/**
 * Slack added to every speed budget, metres, to absorb network arrival jitter.
 *
 * The budget is computed from the gap between *arrival* times, but the distance being
 * judged was covered over the gap between *send* times. On a jittery mobile connection
 * those differ substantially: two reports sent 100 ms apart can arrive 20 ms apart after
 * a radio stall clears and the queue drains. The elapsed time then under-measures the
 * real interval by 5×, and a legitimately running player is corrected — producing exactly
 * the rubber-banding this design goes to some length to avoid.
 *
 * A fixed 1.5 m absorbs that: it is more than a running character covers in one report
 * (6.2 m/s ÷ 10 Hz ≈ 0.62 m) but negligible against a real teleport, which is tens of
 * metres. A cheat could exploit it to gain at most 1.5 m per report — and there is
 * nothing on this island to win by doing so.
 */
const JITTER_SLACK_M = 1.5;

/**
 * How far above `heightAt(x, z)` a player may report standing, metres. Covers jump
 * apexes and small terrain-quantisation mismatches between what the client's mesh
 * shows and what the analytic field says at the exact same float coordinates.
 */
const JUMP_TOLERANCE_M = 6;

/** How far *below* `heightAt` we tolerate before treating a report as falling through the world. */
const SINK_TOLERANCE_M = 1.5;

/**
 * A minimum elapsed-time floor used when computing the speed budget for a move report.
 * Without this, two reports arriving in the same millisecond (e.g. a coalesced resend)
 * would divide by a near-zero delta and produce an enormous, meaningless "allowed"
 * distance that defeats the speed cap entirely.
 */
const MIN_DT_S = 1 / 60;

/** A maximum elapsed-time ceiling, so a player who was away for minutes doesn't get a free teleport budget. */
const MAX_DT_S = 2;

/**
 * The server-side record of one participant. Fields mirror {@link PlayerView} (the
 * wire representation) plus bookkeeping the client never sees: mute state, the last
 * validated transform/tick, and identity used to authorize resume.
 */
export class Player {
  readonly id: PlayerId;
  name: string;
  appearance: Appearance;
  role: Role;

  pos: Vec3;
  yaw: number;
  anim: AnimState = AnimState.Idle;
  zone: ZoneId | null;

  activity: ActivityId | null = null;
  mode: AttendanceMode | null = null;

  /**
   * The activity this player holds {@link Role.Host} for, if any. Distinct from
   * `activity`/`mode` (attendance) — a host is not necessarily attending in the
   * participant/audience sense, and an attendee is not necessarily the host. Granted
   * and revoked exclusively by `admin_action` (see permissions.ts); a player holds at
   * most one hosted activity at a time.
   */
  hostOf: ActivityId | null = null;

  /** True while muted by a host/admin: chat and emotes are silently dropped. */
  muted = false;

  /** True while the session is disconnected but still inside its grace window. */
  away = false;

  /** Monotonic per-connection sequence number of the last accepted `move`, for out-of-order rejection. */
  lastMoveSeq = -1;

  /** Wall-clock ms of the last accepted move report, used to compute the speed budget's elapsed time. */
  lastMoveAt: number;

  /** Set true whenever pos/yaw/anim changes since the last tick's packed-transform gather. */
  dirty = true;

  constructor(id: PlayerId, name: string, appearance: Appearance, role: Role, spawn: { pos: Vec3; yaw: number }) {
    this.id = id;
    this.name = name;
    this.appearance = appearance;
    this.role = role;
    this.pos = spawn.pos;
    this.yaw = spawn.yaw;
    this.zone = zoneAt(spawn.pos[0], spawn.pos[2]);
    this.lastMoveAt = Date.now();
  }

  /** Project this record into the wire shape broadcast to other players. */
  toView(): PlayerView {
    return {
      id: this.id,
      name: this.name,
      appearance: this.appearance,
      role: this.role,
      pos: this.pos,
      yaw: this.yaw,
      anim: this.anim,
      zone: this.zone,
      activity: this.activity,
      mode: this.mode,
      away: this.away || undefined,
    };
  }

  /**
   * Validate and, if legal, apply a client-reported transform.
   *
   * The server is authoritative: a client predicts its own movement locally for
   * responsiveness, but every report is re-checked here against a speed budget and the
   * island's walkable terrain before it is trusted. Failure produces a
   * {@link ServerCorrection} that snaps the client back onto legal ground rather than
   * silently ignoring the report (silently ignoring would leave the client's local
   * prediction diverging from the server's truth with no signal to reconcile).
   *
   * Returns `null` on success (the player record has been updated) or a
   * `ServerCorrection` describing where the client must snap to.
   */
  applyMove(report: { pos: Vec3; yaw: number; anim: AnimState; seq: number }, nowMs = Date.now()): ServerCorrection | null {
    const { pos, yaw, anim, seq } = report;

    // Out-of-order or replayed reports are dropped without penalty: the client's own
    // sequence numbers make this cheap to detect, and it is a normal consequence of
    // network reordering rather than misbehaviour.
    if (seq <= this.lastMoveSeq) return null;

    // Reject non-finite input outright. `Number.isFinite` also catches NaN. This must be
    // checked before any arithmetic on the values, since NaN propagates silently through
    // every subsequent comparison as `false` and would otherwise slip past the speed
    // check (any comparison against NaN is false, including the ones meant to reject it).
    if (!isFiniteVec3(pos) || !Number.isFinite(yaw)) {
      return this.correctionTo(nowMs, 'bounds');
    }

    const dtS = clamp((nowMs - this.lastMoveAt) / 1000, MIN_DT_S, MAX_DT_S);
    const dx = pos[0] - this.pos[0];
    const dz = pos[2] - this.pos[2];
    const dy = pos[1] - this.pos[1];
    const horizontalDist = Math.hypot(dx, dz);
    const verticalDist = Math.abs(dy);

    const horizontalBudget = MAX_HORIZONTAL_SPEED * dtS + JITTER_SLACK_M;
    const verticalBudget = MAX_VERTICAL_SPEED * dtS + JITTER_SLACK_M;

    if (horizontalDist > horizontalBudget || verticalDist > verticalBudget) {
      return this.correctionTo(nowMs, 'speed');
    }

    // Walkability is checked in the horizontal plane only — `isWalkable` cares about
    // place (on land, not too steep), not the reported altitude, which the client owns
    // for the duration of a jump arc.
    //
    // Relaxing it to "steep ground may be passed over while your feet are clear of it" was
    // tried, to make a jump worth pressing at a bank. It cannot be validated: the server
    // sees positions, not velocities, so it cannot tell a jump arc from a client that
    // simply reports itself half a metre above a cliff face and walks up it. Steep ground
    // that a player wants to jump is a terrain defect, and is fixed as one.
    if (!isWalkable(pos[0], pos[2])) {
      return this.correctionTo(nowMs, 'bounds');
    }

    // Height sanity: forgiving upward (jumping) tolerance, tighter downward (sinking
    // through the world / clipping into a slope) tolerance.
    const ground = heightAt(pos[0], pos[2]);
    if (pos[1] > ground + JUMP_TOLERANCE_M || pos[1] < ground - SINK_TOLERANCE_M) {
      return this.correctionTo(nowMs, 'bounds');
    }

    // Accepted: commit the new state.
    this.pos = pos;
    this.yaw = yaw;
    this.anim = anim;
    this.lastMoveSeq = seq;
    this.lastMoveAt = nowMs;
    this.dirty = true;
    const newZone = zoneAt(pos[0], pos[2]);
    if (newZone !== this.zone) this.zone = newZone;
    return null;
  }

  /**
   * Build a correction targeting the nearest walkable ground to the player's *last
   * known-good* position. Correcting relative to last-good (rather than the rejected
   * report) guarantees the target is always legal, since last-good was itself validated
   * when it was accepted.
   */
  private correctionTo(nowMs: number, reason: ServerCorrection['reason']): ServerCorrection {
    const [nx, nz] = nearestWalkable(this.pos[0], this.pos[2]);
    const ny = heightAt(nx, nz);
    // Do not advance lastMoveAt/lastMoveSeq on rejection — the client will retry, and we
    // want the next accepted report's dt computed from the last *accepted* time, not
    // from a rejected attempt, so a burst of rejected reports cannot inflate the budget.
    void nowMs;
    return { t: 'correction', pos: [nx, ny, nz], yaw: this.yaw, reason };
  }

  /** Force this player to a specific transform (teleport, stage placement, spawn). Bypasses validation. */
  teleport(pos: Vec3, yaw: number): void {
    this.pos = pos;
    this.yaw = yaw;
    this.zone = zoneAt(pos[0], pos[2]);
    this.dirty = true;
  }
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
