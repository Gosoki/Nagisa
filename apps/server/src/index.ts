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
  ACTIVITY_TEMPLATES,
  decode,
  ErrorCode,
  type ClientHello,
  type ClientMessage,
  type ClientMessageType,
} from '@nagisa/shared';
import { CONFIG } from './config.js';
import { createLogger } from './logger.js';
import { metrics } from './metrics.js';
import { Activity } from './activity.js';
import { RoomManager } from './rooms.js';
import type { Room } from './room.js';
import { Session } from './session.js';
import { AuditLog } from './audit.js';
import { JsonFileStore, MemoryStore, type PersistedActivity, type PersistedState, type Store } from './persistence.js';
import { ConnState, HANDLERS, handleHello, type HandlerDeps } from './handlers.js';
import { PermissionError } from './permissions.js';
import { createServer, WS_PATH } from './http.js';

async function main(): Promise<void> {
  const log = createLogger({ level: CONFIG.LOG_LEVEL });
  log.info('boot_start', {
    port: CONFIG.PORT,
    roomCapacity: CONFIG.ROOM_CAPACITY,
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

  // --- Rooms ---------------------------------------------------------------------------
  const rooms = new RoomManager(log.child({ component: 'rooms' }), CONFIG.ROOM_CAPACITY, CONFIG.ROOM_COUNT);
  const firstRoom: Room = rooms.list()[0];

  // Persisted activity/announcement state is not currently partitioned by room id (see
  // persistence.ts) — on restart everything is consolidated back into the first shard.
  // For the default single-room deployment this is exact; for a multi-shard deployment
  // it means a restart re-homes every shard's schedule onto shard 1, which is a known,
  // acceptable simplification rather than a correctness bug (nothing is lost, activities
  // just aren't preserved on their original shard).
  if (persisted.activities.length > 0) {
    for (const pa of persisted.activities) restoreActivity(firstRoom, pa);
    for (const ann of persisted.announcements) firstRoom.restoreAnnouncement(ann);
    log.info('schedule_restored', { activities: persisted.activities.length, announcements: persisted.announcements.length });
  } else {
    seedDemoSchedule(firstRoom);
    log.info('schedule_seeded', { templates: ACTIVITY_TEMPLATES.length });
  }

  function buildPersistedState(): PersistedState {
    const activities: PersistedActivity[] = [];
    const announcements: PersistedState['announcements'] = [];
    for (const room of rooms.list()) {
      activities.push(...room.exportActivities());
      announcements.push(...room.exportAnnouncements());
    }
    return { firstBootAt: persisted.firstBootAt, activities, announcements, audit: [...auditLog.all()] };
  }

  const persist = (): void => {
    void store.save(buildPersistedState());
  };
  // Belt-and-suspenders: handlers call `persist()` right after the mutations they know
  // about, but the activity scheduler (scheduled→open, live→ended) also changes state
  // on its own timeline inside the tick loop, with no handler in the loop to call
  // `persist()`. A slow heartbeat catches those without persisting on every single tick.
  const persistHeartbeat = setInterval(persist, 30_000);
  persistHeartbeat.unref?.();

  // --- Transport -------------------------------------------------------------------
  const deps: HandlerDeps = { rooms, audit: auditLog, log, config: CONFIG, persist };
  const wss = new WebSocketServer({ noServer: true });
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
  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const session of activeSessions) {
      if (session.isIdle(now)) session.close(4000, 'idle_timeout');
    }
  }, 5_000);
  idleSweep.unref?.();

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
    clearInterval(persistHeartbeat);

    httpServer.close(); // Stop accepting new connections/upgrades.

    for (const session of activeSessions) {
      session.send({ t: 'error', code: ErrorCode.ServerShutdown, message: 'Server is restarting', fatal: true });
    }

    rooms.stopAll();

    try {
      persist();
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

/** Reconstruct an `Activity` from persisted state, bypassing lifecycle transition checks (this is a restore, not a live transition). */
function restoreActivity(room: Room, pa: PersistedActivity): void {
  const activity = new Activity({
    id: pa.id,
    templateId: pa.templateId,
    title: pa.title,
    blurb: pa.blurb,
    zone: pa.zone,
    startsAt: pa.startsAt,
    endsAt: pa.endsAt,
    capacity: pa.capacity,
    checkinEnabled: pa.checkinEnabled,
  });
  activity.state = pa.state;
  activity.hostId = pa.hostId;
  activity.hostName = pa.hostName;
  for (const id of pa.participants) activity.participants.add(id);
  for (const id of pa.audience) activity.audience.add(id);
  activity.restoreCheckins(pa.checkins);
  room.activities.add(activity);
}

/**
 * Seed a fresh island with one instance of every activity template, staggered across
 * the next couple of hours so "Next Up" is never empty and not everything opens at
 * once. Only called on a genuinely first boot (no persisted activities at all) — see
 * the caller in `main()`.
 */
function seedDemoSchedule(room: Room): void {
  const now = Date.now();
  const FIRST_STARTS_IN_MS = 10 * 60_000; // first activity opens for check-in shortly.
  const SPACING_MS = 20 * 60_000; // 20 minutes apart -> 6 templates span 2 hours.
  ACTIVITY_TEMPLATES.forEach((template, i) => {
    room.activities.createFromTemplate(template.id, now + FIRST_STARTS_IN_MS + i * SPACING_MS);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- logger may not exist yet if boot failed before createLogger.
  console.error(JSON.stringify({ level: 'error', event: 'boot_failed', err: String(err), stack: (err as Error)?.stack }));
  process.exit(1);
});
