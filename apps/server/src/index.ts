/**
 * Bootstrap — wires every module together and owns the process lifecycle.
 * ==========================================================================
 *
 * Boot order matters:
 * 1. Config + logger (everything else logs, and config has no dependencies).
 * 2. The persistence store, loaded *before* rooms exist, so room construction can seed
 *    from whatever survived the last restart.
 * 3. Rooms (which start ticking immediately — an island with nobody in it still keeps
 *    its activity schedule moving).
 * 4. HTTP + WebSocket transport, last, so nothing can connect before the world it would
 *    connect to actually exists.
 *
 * Shutdown is the mirror image: stop accepting new connections, tell everyone still
 * connected why, stop the simulation, flush the store, then close sockets and exit.
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  decode,
  ErrorCode,
  type ClientHello,
  type ClientMessage,
  type ClientMessageType,
} from '@nagisa/shared';
import { CONFIG } from './config.js';
import { createLogger } from './logger.js';
import { metrics } from './metrics.js';
import { RoomManager } from './rooms.js';
import { Session } from './session.js';
import { AuditLog } from './audit.js';
import { JsonFileStore, MemoryStore, PERSIST_VERSION, type PersistedState, type Store } from './persistence.js';
import { ConnState, HANDLERS, handleHello, type HandlerDeps } from './handlers.js';
import { PermissionError } from './permissions.js';
import { createServer, WS_PATH } from './http.js';
import { ProfileStore } from './games/profiles.js';

/** Largest frame a client may send, bytes. See the WebSocketServer options below. */
const MAX_CLIENT_FRAME_BYTES = 16 * 1024;

/** How often empty rooms are checked for putting to sleep. */
const IDLE_SWEEP_MS = 60_000;

/** Saves are gathered for this long before the state is built and handed to the store. */
const PERSIST_COALESCE_MS = 1000;

async function main(): Promise<void> {
  const log = createLogger({ level: CONFIG.LOG_LEVEL });
  log.info('boot_start', {
    port: CONFIG.PORT,
    roomCapacity: CONFIG.ROOM_CAPACITY,
    privateRoomCapacity: CONFIG.PRIVATE_ROOM_CAPACITY,
    roomCount: CONFIG.ROOM_COUNT,
    tickHz: CONFIG.TICK_HZ,
    persist: CONFIG.PERSIST_PATH ?? '(memory only)',
    staticDir: CONFIG.STATIC_DIR ?? '(none)',
  });

  // --- Persistence -------------------------------------------------------------------
  const store: Store = CONFIG.PERSIST_PATH
    ? new JsonFileStore(CONFIG.PERSIST_PATH, log.child({ component: 'store' }))
    : new MemoryStore();
  const persisted: PersistedState = await store.load();

  const auditLog = new AuditLog(log.child({ component: 'audit' }));
  auditLog.restore(persisted.audit);
  const profiles = new ProfileStore(persisted.profiles);

  // `persist()` is called from all over — every check-in, every catch. Building the whole
  // state each time would be wasteful, so calls within a second are gathered into one build,
  // and the store debounces the write on top of that.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = (): void => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void store.save(buildPersistedState());
    }, PERSIST_COALESCE_MS);
    persistTimer.unref?.();
  };

  // --- Rooms ---------------------------------------------------------------------------
  // Each room restores its own schedule, announcements and guestbook as it wakes (see
  // rooms.ts); private islands come back from the registry when their code is next used.
  // Every room keeps the island's daily programme on its own board (schedule.ts), so there
  // is no demo seeding: the day simply runs.
  const rooms = new RoomManager({
    log: log.child({ component: 'rooms' }),
    roomCapacity: CONFIG.ROOM_CAPACITY,
    privateCapacity: CONFIG.PRIVATE_ROOM_CAPACITY,
    initialRoomCount: CONFIG.ROOM_COUNT,
    persist,
    persisted: { rooms: persisted.rooms, islands: persisted.islands },
  });
  log.info('rooms_ready', {
    rooms: rooms.list().length,
    sleeping: Object.keys(persisted.rooms).length,
    islands: persisted.islands.length,
    profiles: profiles.size,
  });

  function buildPersistedState(): PersistedState {
    return {
      version: PERSIST_VERSION,
      firstBootAt: persisted.firstBootAt,
      rooms: rooms.exportRooms(),
      islands: rooms.exportIslands(),
      profiles: profiles.export(),
      audit: auditLog.all().slice(-AUDIT_LIMIT),
    };
  }

  // Belt-and-braces: handlers and games call `persist()` after the mutations they make, but
  // the scheduler changes state on its own timeline inside the tick loop. A slow heartbeat
  // catches those.
  const persistHeartbeat = setInterval(persist, 30_000);
  persistHeartbeat.unref?.();

  const idleSweep = setInterval(() => rooms.sweepIdle(), IDLE_SWEEP_MS);
  idleSweep.unref?.();

  // --- Transport -------------------------------------------------------------------
  const deps: HandlerDeps = { rooms, audit: auditLog, log, config: CONFIG, profiles, persist };
  const wss = new WebSocketServer({
    noServer: true,
    // The largest thing a client legitimately sends is a line of text — a few hundred bytes.
    // Without a cap, `ws` accepts frames up to 100 MiB, and one such frame parsed as JSON is
    // enough to take the process down.
    maxPayload: MAX_CLIENT_FRAME_BYTES,
    // What the architecture relies on for the hot path: packed transforms are integers and
    // compress several-fold. Light settings — this is bandwidth, not archival — and small
    // frames (pings, single moves) are not worth compressing at all.
    perMessageDeflate: {
      zlibDeflateOptions: { level: 3 },
      threshold: 512,
      concurrencyLimit: 8,
    },
  });
  let ready = false;

  const httpServer = createServer({ config: CONFIG, log, rooms, wss, isReady: () => ready });

  /** Every session currently attached to a connection, live across all rooms — used for idle sweep and shutdown broadcast. */
  const activeSessions = new Set<Session>();

  wss.on('connection', (ws, req) => {
    const connId = randomUUID();
    const connLog = log.child({ connId });
    metrics.connectionsTotal.inc();
    metrics.connectionsCurrent.inc();

    const session = new Session(ws, connId, connLog);
    activeSessions.add(session);

    const url = new URL(req.url ?? '/', 'http://internal');
    const adminGranted = Boolean(CONFIG.ADMIN_TOKEN) && url.searchParams.get('admin') === CONFIG.ADMIN_TOKEN;

    /** Set once `hello` succeeds. Every later message on this socket dispatches through it. */
    let state: ConnState | null = null;

    ws.on('message', (raw) => {
      session.touch();
      const msg = decode<ClientMessage>(raw as Buffer);
      if (!msg) {
        session.send({ t: 'error', code: ErrorCode.BadMessage, message: 'unparsable frame' });
        return;
      }
      metrics.messagesIn.inc({ type: msg.t });

      if (!state) {
        if (msg.t !== 'hello') {
          session.send({ t: 'error', code: ErrorCode.BadMessage, message: 'expected hello first', fatal: true });
          session.close(1002, 'expected_hello');
          return;
        }
        if (!session.allow('hello')) {
          session.send({ t: 'error', code: ErrorCode.RateLimited, message: 'slow down' });
          return;
        }
        try {
          state = handleHello(session, msg as ClientHello, { adminGranted }, deps);
        } catch (err) {
          connLog.error('hello_failed', { err });
          metrics.errorsTotal.inc({ kind: 'hello' });
          session.send({ t: 'error', code: ErrorCode.Internal, message: 'internal error', fatal: true });
          session.close(1011, 'internal_error');
          return;
        }
        if (!state) session.close(1002, 'version_mismatch'); // handleHello already sent the error frame.
        return;
      }

      if (msg.t === 'hello') return; // Already established; a duplicate hello is a harmless no-op.

      const type = msg.t as Exclude<ClientMessageType, 'hello'>;
      const handler = HANDLERS[type];
      if (!handler) {
        session.send({ t: 'error', code: ErrorCode.BadMessage, message: `unknown message type ${msg.t}` });
        return;
      }
      if (!session.allow(type)) {
        session.send({ t: 'error', code: ErrorCode.RateLimited, message: `rate limited: ${type}` });
        return;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dispatch map is exhaustively typed per-key; the union collapses here.
        (handler as any)(state, msg, deps);
      } catch (err) {
        if (err instanceof PermissionError) {
          session.send({ t: 'error', code: err.code, message: err.message });
        } else {
          // A bug in one handler must never take down this connection (let alone
          // another player's) — log it, tell the client something went wrong, move on.
          connLog.error('handler_error', { type: msg.t, err });
          metrics.errorsTotal.inc({ kind: 'handler' });
          session.send({ t: 'error', code: ErrorCode.Internal, message: 'internal error' });
        }
      }
    });

    ws.on('close', () => {
      metrics.connectionsCurrent.dec();
      activeSessions.delete(session);
      if (state) state.room.disconnect(state.player.id);
    });

    ws.on('error', (err) => {
      connLog.warn('ws_error', { err });
    });
  });

  // Idle-connection sweep: a socket with no inbound frame for IDLE_TIMEOUT_MS is
  // considered dead (browser tab frozen, radio silently dropped) and closed — its
  // player then enters the same grace-window path as any other disconnect.
  const connectionSweep = setInterval(() => {
    const now = Date.now();
    for (const session of activeSessions) {
      if (session.isIdle(now)) session.close(4000, 'idle_timeout');
    }
  }, 5_000);
  connectionSweep.unref?.();

  await new Promise<void>((resolve) => httpServer.listen(CONFIG.PORT, CONFIG.HOST, resolve));
  ready = true;
  log.info('boot_complete', { host: CONFIG.HOST, port: CONFIG.PORT, wsPath: WS_PATH, map: CONFIG.MAP_ID });

  // --- Graceful shutdown -------------------------------------------------------------
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown_start', { signal });
    ready = false; // /readyz starts failing immediately so a load balancer stops routing here.
    clearInterval(idleSweep);
    clearInterval(connectionSweep);
    clearInterval(persistHeartbeat);
    if (persistTimer) clearTimeout(persistTimer);

    httpServer.close(); // Stop accepting new connections/upgrades.

    for (const session of activeSessions) {
      session.send({ t: 'error', code: ErrorCode.ServerShutdown, message: 'Server is restarting', fatal: true });
    }

    rooms.stopAll();

    try {
      await store.save(buildPersistedState());
      await store.flush();
    } catch (err) {
      log.error('shutdown_flush_failed', { err });
    }

    // Give the shutdown frame a brief moment to actually leave the socket buffers
    // before we sever the connections outright.
    await new Promise((r) => setTimeout(r, 200));
    for (const session of activeSessions) session.close(1001, 'server_shutdown');

    log.info('shutdown_complete', {});
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/** How many audit entries are kept across restarts. */
const AUDIT_LIMIT = 2000;

main().catch((err) => {
  // eslint-disable-next-line no-console -- logger may not exist yet if boot failed before createLogger.
  console.error(JSON.stringify({ level: 'error', event: 'boot_failed', err: String(err), stack: (err as Error)?.stack }));
  process.exit(1);
});
