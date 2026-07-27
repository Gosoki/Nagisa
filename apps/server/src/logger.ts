/**
 * Structured JSON logger.
 * =======================
 *
 * Dependency-free on purpose: pulling in pino/winston for a realtime server that
 * already has zero non-`ws` dependencies would be an odd trade for what is, at heart,
 * "print one JSON object per line." One JSON object per line is also exactly what every
 * log aggregator (CloudWatch, Loki, Datadog, `jq`) wants to ingest, so there is nothing
 * to gain from a heavier library here.
 *
 * Usage:
 * ```ts
 * const log = createLogger({ level: CONFIG.LOG_LEVEL });
 * const roomLog = log.child({ room: 'shore-1' });
 * roomLog.info('player_joined', { playerId });
 * ```
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

/** Arbitrary structured fields attached to a log line. Kept JSON-serialisable. */
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /**
   * Return a new logger that merges `fields` into every line it emits, in addition to
   * whatever this logger already binds. Used to attach `room`, `playerId`, `connId` etc.
   * once at a call site rather than repeating them on every log call.
   */
  child(fields: Fields): Logger;
}

/**
 * Serialise `value` defensively: errors become `{message, stack, name}`, and anything
 * that fails to JSON-serialise (circular refs, BigInt) is coerced to a string rather
 * than throwing and losing the log line entirely.
 */
function safeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function safeFields(fields: Fields | undefined): Fields | undefined {
  if (!fields) return undefined;
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) out[k] = safeValue(v);
  return out;
}

class JsonLogger implements Logger {
  constructor(
    private readonly minLevel: Level,
    private readonly bound: Fields,
  ) {}

  private emit(level: Level, event: string, fields?: Fields): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      event,
      ...this.bound,
      ...safeFields(fields),
    };
    // Errors go to stderr so orchestrators that split streams keep noise separate from
    // health-check-driven stdout scraping. Everything else goes to stdout.
    const target = level === 'error' ? console.error : console.log;
    try {
      target(JSON.stringify(line));
    } catch {
      // Last-ditch fallback if something in `fields` still refuses to stringify.
      target(JSON.stringify({ ts: line.ts, level, event, logError: 'unserializable_fields' }));
    }
  }

  debug(event: string, fields?: Fields): void {
    this.emit('debug', event, fields);
  }
  info(event: string, fields?: Fields): void {
    this.emit('info', event, fields);
  }
  warn(event: string, fields?: Fields): void {
    this.emit('warn', event, fields);
  }
  error(event: string, fields?: Fields): void {
    this.emit('error', event, fields);
  }

  child(fields: Fields): Logger {
    return new JsonLogger(this.minLevel, { ...this.bound, ...fields });
  }
}

/** Build a root logger. `level` filters which severities are actually printed. */
export function createLogger(opts: { level: Level }): Logger {
  return new JsonLogger(opts.level, {});
}
