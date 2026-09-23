/**
 * Server configuration.
 * =====================
 *
 * Every tunable the process needs is read from `process.env` exactly once, at import
 * time, validated, and frozen into {@link CONFIG}. Nothing downstream reads
 * `process.env` directly — that would let configuration drift between modules and
 * makes testing (which wants to inject its own config) painful. If you need a new
 * knob, add it here, document its default, and thread it through explicitly.
 *
 * All values are safe to run with zero environment variables set: a bare
 * `node dist/index.js` boots a single-room, single-shard island on localhost:8787.
 */

import { randomBytes } from 'node:crypto';
import { DEFAULT_MAP_ID, resolveMapId, PROTOCOL } from '@nagisa/shared';

/** Parse an integer env var, falling back to `def` when unset or unparsable. */
function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer for env var ${name}: ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Parse a string env var, falling back to `def` when unset. Empty string is preserved. */
function envStr(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined ? def : raw;
}

/** Parse an optional string env var. Returns `undefined` when unset or blank. */
function envOptStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw;
}

const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof VALID_LOG_LEVELS)[number];

function envLogLevel(name: string, def: LogLevel): LogLevel {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  if ((VALID_LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  throw new Error(`Invalid ${name}: ${JSON.stringify(raw)}. Expected one of ${VALID_LOG_LEVELS.join(', ')}`);
}

/**
 * The fully-resolved, validated server configuration. Read once at boot; treat as
 * immutable for the lifetime of the process (it is frozen, so mutation throws in
 * strict mode and silently no-ops otherwise — either way, don't).
 */
export interface Config {
  /** TCP port the HTTP+WS server listens on. Default 8787. */
  readonly PORT: number;
  /** Interface to bind. Default '0.0.0.0' so containers/proxies can reach it. */
  readonly HOST: string;
  /** Maximum players per room shard before matchmaking opens a new one. Default 120. */
  readonly ROOM_CAPACITY: number;
  /** Maximum players on one private island. Default 40 — a gathering of friends, not a festival. */
  readonly PRIVATE_ROOM_CAPACITY: number;
  /** Open WebSocket connections the process accepts in total. Default 2000. */
  readonly MAX_CONNECTIONS: number;
  /**
   * Open connections accepted from one client address. Default 0 = no per-address limit,
   * because behind a reverse proxy every visitor shares the proxy's address unless
   * `TRUST_PROXY` is set — a default limit would lock out everyone at once.
   */
  readonly MAX_CONNECTIONS_PER_IP: number;
  /** Read the client address from `X-Forwarded-For` (set this behind nginx/Caddy). Default off. */
  readonly TRUST_PROXY: boolean;
  /** Number of room shards to pre-create at boot. Default 1. More are opened on demand. */
  readonly ROOM_COUNT: number;
  /** Simulation/broadcast tick rate, Hz. Sourced from the protocol, not independently configurable. */
  readonly TICK_HZ: number;
  /** Minimum severity that reaches stdout. Default 'info'. */
  readonly LOG_LEVEL: LogLevel;
  /**
   * Which map pack to simulate. Default `nagisa-island`; `lantern-atoll` also ships.
   *
   * Applied once at boot, before any room is created. Switching maps under a populated
   * room would leave every player standing on coordinates that no longer describe ground,
   * so this is deliberately not runtime-reconfigurable: restart the process.
   *
   * Clients must load the same map — they pass `?map=` — and the server tells them which
   * one it chose in the welcome message so a mismatch fails loudly at the handshake.
   */
  readonly MAP_ID: string;
  /**
   * Bearer token that grants {@link import('@nagisa/shared').Role.Admin} when supplied as
   * `?admin=<token>` on the WebSocket upgrade URL. Unset (the default) disables admin
   * grant-by-query entirely — production deployments should set this to a long random
   * value out-of-band and treat it like a password.
   */
  readonly ADMIN_TOKEN: string | undefined;
  /**
   * Filesystem path to a built client bundle (index.html + assets). When set, `http.ts`
   * serves it as static files with a SPA fallback. When unset, the HTTP server only
   * answers the API/health endpoints — useful when the client is deployed separately
   * (e.g. a CDN) and this process only needs to speak WebSocket.
   */
  readonly STATIC_DIR: string | undefined;
  /**
   * Filesystem path for the JSON persistence file (activities, announcements, check-ins,
   * audit log). When unset, the server falls back to an in-memory store: it still runs
   * correctly, but a restart loses the day's schedule. Set this in any deployment where
   * that matters.
   */
  readonly PERSIST_PATH: string | undefined;
  /**
   * Value for the `Access-Control-Allow-Origin` header on HTTP API responses. Default
   * '*' (open) — the API surface is read-only JSON with no cookies/credentials, so a
   * permissive CORS policy carries no meaningful risk. Tighten in deployments that want
   * to keep the room listing private to one origin.
   */
  readonly CORS_ORIGIN: string;
  /**
   * Secret used to HMAC-sign resume tokens. See resume.ts. Read from `SESSION_SECRET` (the
   * name the README, Dockerfile and compose file use) or `RESUME_SECRET`; generated if
   * neither is set, in which case tokens do not survive a restart.
   */
  readonly RESUME_SECRET: string;
  /**
   * Filesystem path for developer placement notes (see notes.ts). When unset — which is
   * every deployment — the `/dev/notes` endpoints do not exist at all. `scripts/dev.mjs`
   * sets it, so it is on for local development and absent everywhere else.
   */
  readonly DEV_NOTES_PATH: string | undefined;
}

function buildConfig(): Config {
  const PORT = envInt('PORT', 8787);
  const HOST = envStr('HOST', '0.0.0.0');
  const ROOM_CAPACITY = envInt('ROOM_CAPACITY', 120);
  const PRIVATE_ROOM_CAPACITY = envInt('PRIVATE_ROOM_CAPACITY', 40);
  const MAX_CONNECTIONS = envInt('MAX_CONNECTIONS', 2000);
  const MAX_CONNECTIONS_PER_IP = envInt('MAX_CONNECTIONS_PER_IP', 0);
  const TRUST_PROXY = ['1', 'true', 'yes'].includes(envStr('TRUST_PROXY', '').trim().toLowerCase());
  const ROOM_COUNT = envInt('ROOM_COUNT', 1);
  const LOG_LEVEL = envLogLevel('LOG_LEVEL', 'info');
  const MAP_ID = envStr('NAGISA_MAP', DEFAULT_MAP_ID);
  const ADMIN_TOKEN = envOptStr('ADMIN_TOKEN');
  const STATIC_DIR = envOptStr('STATIC_DIR');
  const PERSIST_PATH = envOptStr('PERSIST_PATH');
  const DEV_NOTES_PATH = envOptStr('DEV_NOTES_PATH');
  const CORS_ORIGIN = envStr('CORS_ORIGIN', '*');
  // A resume secret is required for HMAC signing. If the operator did not supply one,
  // generate a random per-process secret: resume tokens simply won't survive a restart,
  // which is a safe (if slightly less convenient) default rather than a fixed, guessable key.
  // The documented name is SESSION_SECRET; RESUME_SECRET was the only one ever read, so every
  // deployment that followed the README silently ran with a per-process secret. Both work now.
  const RESUME_SECRET =
    envOptStr('SESSION_SECRET') ??
    envOptStr('RESUME_SECRET') ??
    `ephemeral-${randomBytes(24).toString('hex')}`;

  if (PORT < 1 || PORT > 65535) throw new Error(`PORT out of range: ${PORT}`);
  if (ROOM_CAPACITY < 1) throw new Error(`ROOM_CAPACITY must be >= 1, got ${ROOM_CAPACITY}`);
  if (PRIVATE_ROOM_CAPACITY < 1) throw new Error(`PRIVATE_ROOM_CAPACITY must be >= 1, got ${PRIVATE_ROOM_CAPACITY}`);
  if (MAX_CONNECTIONS < 1) throw new Error(`MAX_CONNECTIONS must be >= 1, got ${MAX_CONNECTIONS}`);
  if (MAX_CONNECTIONS_PER_IP < 0) throw new Error(`MAX_CONNECTIONS_PER_IP must be >= 0, got ${MAX_CONNECTIONS_PER_IP}`);
  if (ROOM_COUNT < 1) throw new Error(`ROOM_COUNT must be >= 1, got ${ROOM_COUNT}`);
  // Fail at boot, not at the first player's first step. resolveMapId throws with the list of
  // registered ids, which is the only thing an operator who mistyped one actually wants.
  resolveMapId(MAP_ID);

  return Object.freeze({
    PORT,
    HOST,
    ROOM_CAPACITY,
    PRIVATE_ROOM_CAPACITY,
    MAX_CONNECTIONS,
    MAX_CONNECTIONS_PER_IP,
    TRUST_PROXY,
    ROOM_COUNT,
    TICK_HZ: PROTOCOL.TICK_HZ,
    LOG_LEVEL,
    MAP_ID,
    ADMIN_TOKEN,
    STATIC_DIR,
    PERSIST_PATH,
    DEV_NOTES_PATH,
    CORS_ORIGIN,
    RESUME_SECRET,
  });
}

/** The process-wide configuration singleton. See {@link Config} for field docs. */
export const CONFIG: Config = buildConfig();
