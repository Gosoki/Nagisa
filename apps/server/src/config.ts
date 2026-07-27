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

import { PROTOCOL } from '@nagisa/shared';

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
  /** Number of room shards to pre-create at boot. Default 1. More are opened on demand. */
  readonly ROOM_COUNT: number;
  /** Simulation/broadcast tick rate, Hz. Sourced from the protocol, not independently configurable. */
  readonly TICK_HZ: number;
  /** Minimum severity that reaches stdout. Default 'info'. */
  readonly LOG_LEVEL: LogLevel;
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
  /** Secret used to HMAC-sign resume tokens. See resume.ts. Generated if not supplied. */
  readonly RESUME_SECRET: string;
}

function buildConfig(): Config {
  const PORT = envInt('PORT', 8787);
  const HOST = envStr('HOST', '0.0.0.0');
  const ROOM_CAPACITY = envInt('ROOM_CAPACITY', 120);
  const ROOM_COUNT = envInt('ROOM_COUNT', 1);
  const LOG_LEVEL = envLogLevel('LOG_LEVEL', 'info');
  const ADMIN_TOKEN = envOptStr('ADMIN_TOKEN');
  const STATIC_DIR = envOptStr('STATIC_DIR');
  const PERSIST_PATH = envOptStr('PERSIST_PATH');
  const CORS_ORIGIN = envStr('CORS_ORIGIN', '*');
  // A resume secret is required for HMAC signing. If the operator did not supply one,
  // generate a random per-process secret: resume tokens simply won't survive a restart,
  // which is a safe (if slightly less convenient) default rather than a fixed, guessable key.
  const RESUME_SECRET =
    envOptStr('RESUME_SECRET') ?? `ephemeral-${Math.random().toString(36).slice(2)}${Date.now()}`;

  if (PORT < 1 || PORT > 65535) throw new Error(`PORT out of range: ${PORT}`);
  if (ROOM_CAPACITY < 1) throw new Error(`ROOM_CAPACITY must be >= 1, got ${ROOM_CAPACITY}`);
  if (ROOM_COUNT < 1) throw new Error(`ROOM_COUNT must be >= 1, got ${ROOM_COUNT}`);

  return Object.freeze({
    PORT,
    HOST,
    ROOM_CAPACITY,
    ROOM_COUNT,
    TICK_HZ: PROTOCOL.TICK_HZ,
    LOG_LEVEL,
    ADMIN_TOKEN,
    STATIC_DIR,
    PERSIST_PATH,
    CORS_ORIGIN,
    RESUME_SECRET,
  });
}

/** The process-wide configuration singleton. See {@link Config} for field docs. */
export const CONFIG: Config = buildConfig();
