/**
 * Session — the server-side wrapper around one WebSocket connection.
 * ====================================================================
 *
 * `Session` owns everything that is about the *connection*, as opposed to the *player*
 * (see `player.ts`): framing outbound messages, backpressure policy, per-message-type
 * rate limiting, and idle/heartbeat tracking. Splitting connection concerns from player
 * concerns is what makes {@link import('./resume.js')} possible — a player can outlive
 * the session that briefly represented it (grace-window reconnects) without the two
 * classes tangling their lifecycles together.
 */

import type { WebSocket } from 'ws';
import { encode, PROTOCOL, type PlayerId, type ServerMessage, type ClientMessageType } from '@nagisa/shared';
import type { Logger } from './logger.js';
import { metrics } from './metrics.js';

/**
 * Above this many buffered bytes on the underlying socket, we consider the client
 * "backed up" (a slow mobile radio, a tab in the background throttled by the browser,
 * etc.) and start shedding droppable traffic rather than letting the buffer grow
 * without bound. 256 KiB is generous relative to our per-tick payload (a few KB even
 * for a full room) — it absorbs a couple of seconds of transient stall before we shed
 * anything.
 */
const BACKPRESSURE_HIGH_WATERMARK = 256 * 1024;

/**
 * Token bucket for one message type. Refilled continuously (not in discrete ticks) so
 * the limiter is independent of when it happens to be checked. Capacity equals the
 * configured per-second rate, which permits a one-second burst and then settles to the
 * steady-state rate — appropriate for bursty-but-bounded traffic like `move`.
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly ratePerSecond: number) {
    this.tokens = ratePerSecond;
    this.lastRefillMs = Date.now();
  }

  /** Attempt to consume one token. Returns false (and consumes nothing) if empty. */
  tryTake(nowMs: number): boolean {
    const elapsedSec = Math.max(0, nowMs - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.ratePerSecond, this.tokens + elapsedSec * this.ratePerSecond);
    this.lastRefillMs = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Message types whose frames are safe to drop under backpressure without desyncing the client. */
const DROPPABLE_TYPES: ReadonlySet<ServerMessage['t']> = new Set(['delta']);

export interface SendOptions {
  /**
   * Marks this specific call as droppable even though its message type could in
   * principle be sent critically. Used by `room.ts` to mark a `delta` frame as
   * droppable only when it carries *nothing but* movement — a delta that also carries
   * a join/leave/activity/announcement is never dropped, because those are one-shot
   * events with no future frame to repair them (a missed movement tick is repaired by
   * the next one; a missed "activity went live" is not).
   */
  droppable?: boolean;
}

/**
 * Wraps one live WebSocket connection. A `Session` is created on `hello` and destroyed
 * on close/teardown; the `Player` it represents may persist beyond it (see
 * `resume.ts`).
 */
export class Session {
  /** Set by the hello handler once the player id is known. Undefined only pre-handshake. */
  playerId: PlayerId | undefined;

  /** Wall-clock ms of the last inbound frame of any kind. Drives idle-timeout closure. */
  private lastInboundAt = Date.now();

  /** Per-message-type token buckets, created lazily on first use of that type. */
  private readonly buckets = new Map<ClientMessageType, TokenBucket>();

  /** True once `close()` has run, guarding against double-teardown. */
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly connId: string,
    private readonly log: Logger,
  ) {}

  /** Record that a frame was received, for idle-timeout purposes. Call on every inbound message. */
  touch(): void {
    this.lastInboundAt = Date.now();
  }

  /** Milliseconds since the last inbound frame. */
  idleForMs(nowMs = Date.now()): number {
    return nowMs - this.lastInboundAt;
  }

  /** Whether this connection has been silent long enough to be considered dead. */
  isIdle(nowMs = Date.now()): boolean {
    return this.idleForMs(nowMs) > PROTOCOL.IDLE_TIMEOUT_MS;
  }

  /**
   * Consume one rate-limit token for `type`. Returns false if the caller should be
   * rejected with `ErrorCode.RateLimited`. Each message type gets its own bucket sized
   * from {@link PROTOCOL.RATE_LIMIT}, falling back to `.default` for any type not
   * explicitly listed there (currently everything except move/emote/chat).
   */
  allow(type: ClientMessageType): boolean {
    let bucket = this.buckets.get(type);
    if (!bucket) {
      const rate =
        (PROTOCOL.RATE_LIMIT as Record<string, number>)[type] ?? PROTOCOL.RATE_LIMIT.default;
      bucket = new TokenBucket(rate);
      this.buckets.set(type, bucket);
    }
    const ok = bucket.tryTake(Date.now());
    if (!ok) metrics.rateLimited.inc({ type });
    return ok;
  }

  /**
   * Send one message to the client.
   *
   * Backpressure policy: once `ws.bufferedAmount` crosses
   * {@link BACKPRESSURE_HIGH_WATERMARK}, we start dropping frames that are marked (or
   * inferred) droppable rather than letting the OS/browser buffer grow unbounded, which
   * would otherwise turn a slow client into an ever-growing memory liability and, worse,
   * an ever-growing *latency* liability — a movement update queued behind two seconds of
   * backlog is not worth delivering, the next tick's update will supersede it in a
   * fraction of a second anyway. Non-droppable frames (snapshots, joins/leaves, activity
   * and announcement changes, corrections, errors) are always sent: they are one-shot
   * facts with no future frame that would repair a silent drop.
   *
   * Returns true if the frame was sent (handed to the socket), false if it was dropped.
   */
  send(msg: ServerMessage, opts: SendOptions = {}): boolean {
    if (this.closed) return false;
    if (this.ws.readyState !== this.ws.OPEN) return false;

    // Only ever drop frames the caller explicitly marks droppable — being conservative
    // here means a bug that forgets to mark something never causes a silent,
    // un-repairable state loss. `DROPPABLE_TYPES` further restricts this to message
    // types that are structurally safe to lose (currently just `delta`), so a caller
    // cannot accidentally mark e.g. an `error` as droppable and have it honoured.
    const isDroppable = opts.droppable === true && DROPPABLE_TYPES.has(msg.t);

    if (isDroppable && this.ws.bufferedAmount > BACKPRESSURE_HIGH_WATERMARK) {
      metrics.messagesDropped.inc({ type: msg.t });
      return false;
    }

    try {
      this.ws.send(encode(msg));
      metrics.messagesOut.inc({ type: msg.t });
      return true;
    } catch (err) {
      this.log.warn('session_send_failed', { connId: this.connId, err });
      return false;
    }
  }

  /** Current backpressure snapshot, exposed for diagnostics/tests. */
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /** Idempotent teardown: closes the socket and releases references. Safe to call twice. */
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
        this.ws.close(code, reason);
      }
    } catch (err) {
      this.log.warn('session_close_failed', { connId: this.connId, err });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
