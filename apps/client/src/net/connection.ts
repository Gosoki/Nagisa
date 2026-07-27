/**
 * The connection.
 * ===============
 *
 * One WebSocket, owned here, plus everything needed to keep it honest: heartbeats,
 * clock offset estimation, exponential-backoff reconnection with session resume, and a
 * typed event surface the rest of the client subscribes to.
 *
 * ### Reconnection is a first-class state, not an error
 * Mobile browsers drop sockets constantly — screen lock, network handover, a tunnel.
 * The product requirement is that none of that costs you your place: you keep your
 * identity, your role and your activity attachment, and the island is still there when
 * you come back. So:
 *
 * - the server issues a **resume token**, which we store and present on the next
 *   `hello`;
 * - reconnection backs off exponentially with jitter, capped, and retries forever while
 *   the tab is open — a world you can walk away from and come back to is the point;
 * - a reconnect attempt is fired **immediately** when the browser reports the network is
 *   back or the tab becomes visible, rather than waiting out the backoff;
 * - the UI is told about every state change, because silently reconnecting behind a
 *   frozen world is worse than saying so quietly.
 *
 * ### Clock
 * Every ping/pong updates an estimate of the offset between our clock and the server's,
 * using the sample with the lowest round-trip time seen recently. Server time is what
 * the day/night cycle and activity countdowns run on, so a client with a badly set
 * system clock still sees the same dusk as everyone else.
 */

import {
  ErrorCode,
  PROTOCOL,
  encode,
  decode,
  type ClientMessage,
  type ServerMessage,
  type ServerWelcome,
} from '@nagisa/shared';

/** Connection lifecycle, as the UI understands it. */
export type ConnectionState =
  /** Never connected yet. */
  | 'idle'
  /** Socket opening, or handshake in flight. */
  | 'connecting'
  /** Live. */
  | 'connected'
  /** Dropped; a retry is scheduled. */
  | 'reconnecting'
  /** Closed and not retrying — the server rejected us, or we called `close()`. */
  | 'closed';

export interface ConnectionEvents {
  state: (state: ConnectionState, detail?: string) => void;
  message: (msg: ServerMessage) => void;
  /** Round-trip time in ms, published on every pong. */
  latency: (rttMs: number) => void;
}

/** Where the resume token lives between sessions. */
const RESUME_KEY = 'nagisa.resume';

/** Backoff bounds for reconnection, ms. */
const BACKOFF_MIN = 600;
const BACKOFF_MAX = 15_000;

export class Connection {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'idle';

  /** Estimated `serverTime - localTime`, ms. */
  private clockOffset = 0;
  /** Lowest RTT seen in the current session; the offset from that sample is the best one. */
  private bestRtt = Infinity;
  private lastRtt = 0;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  /** Set once we have a welcome; used to decide whether a drop is resumable. */
  private welcomed: ServerWelcome | null = null;

  /** Suppresses reconnection after a deliberate close or a fatal server error. */
  private shouldReconnect = true;

  /** Queued outbound frames, flushed on connect. Bounded so a long outage cannot grow it. */
  private outbox: string[] = [];
  private static readonly OUTBOX_LIMIT = 64;

  private listeners: { [K in keyof ConnectionEvents]: Set<ConnectionEvents[K]> } = {
    state: new Set(),
    message: new Set(),
    latency: new Set(),
  };

  /**
   * @param url        WebSocket endpoint. Relative paths are resolved against the page.
   * @param buildHello Produces the handshake. A function, not a value, so the resume
   *                   token and appearance are always current at reconnect time.
   */
  constructor(
    private readonly url: string,
    private readonly buildHello: (resumeToken: string | null) => ClientMessage,
  ) {
    // Reconnect eagerly on the two signals that actually predict success.
    window.addEventListener('online', this.onNetworkHint);
    document.addEventListener('visibilitychange', this.onNetworkHint);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on<K extends keyof ConnectionEvents>(event: K, handler: ConnectionEvents[K]): () => void {
    this.listeners[event].add(handler);
    return () => this.listeners[event].delete(handler);
  }

  private emit<K extends keyof ConnectionEvents>(event: K, ...args: Parameters<ConnectionEvents[K]>): void {
    for (const handler of this.listeners[event]) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (err) {
        // One bad subscriber must never break the socket's read loop.
        console.error('[net] listener threw', err);
      }
    }
  }

  private setState(next: ConnectionState, detail?: string): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next, detail);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get currentState(): ConnectionState {
    return this.state;
  }

  /** Latest measured round-trip time, ms. */
  get latency(): number {
    return this.lastRtt;
  }

  /** Best estimate of the server's clock right now. */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  /** Open the connection. Safe to call repeatedly. */
  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.shouldReconnect = true;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.resolveUrl());
    } catch (err) {
      // Malformed URL or a blocked mixed-content upgrade: retrying will not fix it, but
      // reporting it will.
      this.setState('closed', String(err));
      return;
    }

    this.socket = socket;
    socket.onopen = this.onOpen;
    socket.onmessage = this.onMessage;
    socket.onclose = this.onClose;
    socket.onerror = () => {
      // `error` carries no useful detail in browsers, and is always followed by `close`.
      // Handling it here would only produce duplicate state transitions.
    };
  }

  /** Send a message, or queue it if the socket is not open. */
  send(msg: ClientMessage): void {
    const frame = encode(msg);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
      return;
    }
    // Movement is worthless by the time a reconnect completes; anything else is worth
    // holding onto so a click during a blip is not simply lost.
    if (msg.t === 'move') return;
    if (this.outbox.length >= Connection.OUTBOX_LIMIT) this.outbox.shift();
    this.outbox.push(frame);
  }

  /** Close deliberately. No reconnection will follow. */
  close(): void {
    this.shouldReconnect = false;
    this.clearTimers();
    this.socket?.close(1000, 'client closed');
    this.socket = null;
    this.setState('closed');
  }

  /** Full teardown, including the window listeners. */
  dispose(): void {
    this.close();
    window.removeEventListener('online', this.onNetworkHint);
    document.removeEventListener('visibilitychange', this.onNetworkHint);
    for (const set of Object.values(this.listeners)) set.clear();
  }

  /** Forget the stored session. Used by "leave the island" and by the name change flow. */
  static clearResumeToken(): void {
    try {
      localStorage.removeItem(RESUME_KEY);
    } catch {
      /* Private browsing: nothing to clear. */
    }
  }

  // -------------------------------------------------------------------------
  // Socket handlers
  // -------------------------------------------------------------------------

  private onOpen = (): void => {
    this.send(this.buildHello(this.readResumeToken()));

    // Flush anything queued during the outage.
    const queued = this.outbox;
    this.outbox = [];
    for (const frame of queued) this.socket?.send(frame);

    this.startHeartbeat();
  };

  private onMessage = (event: MessageEvent): void => {
    const msg = decode<ServerMessage>(event.data as string);
    if (!msg) {
      console.warn('[net] undecodable frame dropped');
      return;
    }

    switch (msg.t) {
      case 'welcome': {
        this.welcomed = msg;
        this.attempt = 0;
        this.bestRtt = Infinity;
        this.writeResumeToken(msg.resumeToken);
        // The welcome carries the server clock; seed the offset before the first pong so
        // the very first frame already has a plausible time of day.
        this.clockOffset = msg.serverTime - Date.now();
        this.setState('connected');
        break;
      }
      case 'pong': {
        const now = Date.now();
        const rtt = now - msg.t0;
        this.lastRtt = rtt;
        // NTP-style: assume the reply took half the round trip, and only trust the
        // sample if it is the least-delayed one we have seen. A congested sample would
        // otherwise drag the estimate around by tens of milliseconds.
        if (rtt <= this.bestRtt) {
          this.bestRtt = rtt;
          this.clockOffset = msg.serverTime + rtt / 2 - now;
        }
        this.emit('latency', rtt);
        return; // Pongs are plumbing; subscribers do not need them.
      }
      case 'error': {
        if (msg.fatal) {
          // The server has told us not to come back — version mismatch, a ban, a
          // shutdown. Retrying would spin against a wall.
          this.shouldReconnect = msg.code === ErrorCode.ServerShutdown;
          if (msg.code === ErrorCode.Kicked) Connection.clearResumeToken();
        }
        break;
      }
      default:
        break;
    }

    this.emit('message', msg);
  };

  private onClose = (event: CloseEvent): void => {
    this.stopHeartbeat();
    this.socket = null;

    if (!this.shouldReconnect) {
      this.setState('closed', event.reason || undefined);
      return;
    }

    this.setState('reconnecting', event.reason || undefined);
    this.scheduleReconnect();
  };

  // -------------------------------------------------------------------------
  // Heartbeat & reconnection
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const beat = (): void => this.send({ t: 'ping', t0: Date.now() });
    beat(); // Measure immediately so the first latency reading is not 5 s late.
    this.pingTimer = setInterval(beat, PROTOCOL.PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.attempt++;

    // Exponential backoff with full jitter. Jitter matters: without it, a server restart
    // brings every client back simultaneously and knocks it over again.
    const ceiling = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** (this.attempt - 1));
    const delay = BACKOFF_MIN + Math.random() * (ceiling - BACKOFF_MIN);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** The network came back, or the tab was foregrounded: try again now. */
  private onNetworkHint = (): void => {
    if (!this.shouldReconnect) return;
    if (this.state !== 'reconnecting') return;
    if (document.hidden) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  };

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Resolve a relative endpoint against the page origin, choosing ws/wss correctly. */
  private resolveUrl(): string {
    if (/^wss?:\/\//.test(this.url)) return this.url;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = this.url.startsWith('/') ? this.url : `/${this.url}`;
    return `${proto}//${location.host}${path}`;
  }

  private readResumeToken(): string | null {
    try {
      return localStorage.getItem(RESUME_KEY);
    } catch {
      // Safari in private mode throws on access. A fresh session is a fine fallback.
      return null;
    }
  }

  private writeResumeToken(token: string): void {
    try {
      localStorage.setItem(RESUME_KEY, token);
    } catch {
      /* Non-fatal: we simply cannot resume after a full reload. */
    }
  }

  /** The most recent welcome, if any. Exposes the room list and our own id. */
  get welcome(): ServerWelcome | null {
    return this.welcomed;
  }
}
