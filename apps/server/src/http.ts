/**
 * HTTP surface: health checks, metrics, the room listing API, optional static client
 * hosting, and the WebSocket upgrade point. Built on `node:http` directly — no Express.
 * ====================================================================================
 *
 * Routes:
 * - `GET /healthz` — liveness. 200 once the process is up, regardless of readiness.
 *   An orchestrator uses this to decide "should I restart this container," not "should
 *   I route traffic here" — those are different questions, hence two endpoints.
 * - `GET /readyz`   — readiness. 200 once rooms are constructed and ticking; used to
 *   gate load-balancer traffic during boot/shutdown.
 * - `GET /metrics`  — Prometheus text exposition (see `metrics.ts`).
 * - `GET /api/rooms` — JSON room listing, for a room picker UI.
 * - Everything else, if `CONFIG.STATIC_DIR` is set: static files from the built client,
 *   with a SPA fallback to `index.html` for any path that isn't a real file — a client
 *   router needs `/some/deep/route` to still resolve to the app shell.
 *
 * The WebSocket upgrade itself is *not* handled here — `index.ts` owns the
 * `WebSocketServer` and all connection/message logic, since that is where session and
 * protocol state live. This module only wires the raw `upgrade` event to the
 * `WebSocketServer` passed in, restricted to `WS_PATH`, so the two concerns (transport
 * plumbing vs. protocol logic) stay in separate files.
 */

import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { WebSocketServer } from 'ws';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { metrics } from './metrics.js';
import type { RoomManager } from './rooms.js';

/** Path on which WebSocket upgrades are accepted. Anything else 404s at the HTTP layer. */
export const WS_PATH = '/ws';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function json(res: ServerResponse, status: number, body: unknown, corsOrigin: string): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'access-control-allow-origin': corsOrigin,
  });
  res.end(buf);
}

function text(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length });
  res.end(buf);
}

/**
 * Serve one static file, resolved and containment-checked against `staticDir` so a
 * crafted request path (`/../../etc/passwd`) can never escape the client bundle
 * directory. Returns true if a response was sent (success or a definitive 404/403),
 * false if the caller should fall through to the SPA fallback.
 */
async function tryServeStatic(staticDir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const relative = normalize(decoded).replace(/^([.]{2}[/\\])+/, '');
  const abs = resolve(join(staticDir, relative));
  const staticRoot = resolve(staticDir);
  if (abs !== staticRoot && !abs.startsWith(staticRoot + sep)) {
    text(res, 403, 'forbidden');
    return true;
  }

  let stats: Stats;
  try {
    stats = await stat(abs);
  } catch {
    return false; // Not a real file — let the caller decide (SPA fallback or 404).
  }
  if (stats.isDirectory()) return false; // Directory requests fall through to index.html.

  res.writeHead(200, { 'content-type': mimeFor(abs), 'content-length': stats.size });
  createReadStream(abs).pipe(res);
  return true;
}

/**
 * Build the HTTP server. `isReady` is a callback rather than a boolean because
 * readiness can change after boot (e.g. during graceful shutdown, `/readyz` should
 * start failing before the process actually exits, so a load balancer stops sending
 * new traffic while in-flight connections drain).
 */
export function createServer(deps: {
  config: Config;
  log: Logger;
  rooms: RoomManager;
  wss: WebSocketServer;
  isReady: () => boolean;
}): Server {
  const { config, log, rooms, wss, isReady } = deps;

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err) => {
      log.error('http_request_failed', { url: req.url, err });
      if (!res.headersSent) text(res, 500, 'internal error');
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      text(res, 200, 'ok');
      return;
    }
    if (req.method === 'GET' && pathname === '/readyz') {
      text(res, isReady() ? 200 : 503, isReady() ? 'ready' : 'not ready');
      return;
    }
    if (req.method === 'GET' && pathname === '/metrics') {
      text(res, 200, metrics.renderPrometheus(), 'text/plain; version=0.0.4; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && pathname === '/api/rooms') {
      json(res, 200, { rooms: rooms.listViews() }, config.CORS_ORIGIN);
      return;
    }
    if (pathname === WS_PATH) {
      // Real WebSocket upgrades never reach here (the 'upgrade' event fires instead of
      // 'request' for those) — a plain GET to the ws path is a client mistake.
      text(res, 400, 'this endpoint speaks WebSocket only');
      return;
    }

    if (config.STATIC_DIR && req.method === 'GET') {
      if (await tryServeStatic(config.STATIC_DIR, pathname, res)) return;
      // SPA fallback: any unrecognised GET path resolves to the app shell so a client
      // router (e.g. `/island/plaza`) works on a hard refresh, not just on client-side
      // navigation.
      if (await tryServeStatic(config.STATIC_DIR, '/index.html', res)) return;
    }

    text(res, 404, 'not found');
  }

  // Route WebSocket upgrade requests to `wss`, restricted to WS_PATH. Anything else
  // (an upgrade attempt on a random path) is rejected at the TCP level rather than
  // silently accepted, which is both correct and cheap — `destroy()` on a socket that
  // was never fully handed to `ws` costs nothing.
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname;
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  return server;
}
