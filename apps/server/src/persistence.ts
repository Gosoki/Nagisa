/**
 * Persistence — surviving a restart without losing the day's schedule.
 * ======================================================================
 *
 * The realtime state that matters to persist is small and low-churn: activities
 * (including their rosters and check-in records) and announcements. Player positions,
 * emotes and chat are deliberately *not* persisted — they are ephemeral by nature, and
 * persisting them would only give a restarted server stale, misleading data to resume
 * players into.
 *
 * ## Swapping in Redis/Postgres
 *
 * Everything downstream of this file talks to the {@link Store} interface, not to JSON
 * files. To move to Redis: implement `load`/`save`/`flush` against a single key (e.g.
 * `SET nagisa:state <json>` / `GET`), keeping the same debounce discipline so you are
 * not hammering Redis on every activity mutation. To move to Postgres: normalise
 * `PersistedState` into `activities`, `checkins`, `announcements` tables inside `save`,
 * and reconstruct it with a handful of `SELECT`s in `load`. Either way:
 *
 * 1. Implement the three methods of {@link Store}.
 * 2. Construct your implementation in `index.ts` in place of `JsonFileStore`, gated on
 *    whatever env var makes sense for the new backend (e.g. `REDIS_URL`).
 * 3. Nothing else changes — `ActivityManager`, `Room` and `audit.ts` only ever see the
 *    `Store` interface.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ActivityId, ActivityState, AnnouncementView, AttendanceMode, PlayerId, ZoneId } from '@nagisa/shared';
import type { Logger } from './logger.js';

/** One persisted activity, including its roster and check-in history. */
export interface PersistedActivity {
  id: ActivityId;
  templateId: string;
  title: string;
  blurb: string;
  zone: ZoneId;
  state: ActivityState;
  startsAt: number;
  endsAt: number | null;
  hostId: PlayerId | null;
  hostName: string | null;
  capacity: number;
  checkinEnabled: boolean;
  participants: PlayerId[];
  audience: PlayerId[];
  checkins: Array<{ playerId: PlayerId; ordinal: number; at: number }>;
  /** For future use if attendance mode needs disambiguating beyond the two set memberships. */
  attendanceMode?: Record<PlayerId, AttendanceMode>;
}

/** One append-only audit entry. See audit.ts. */
export interface AuditEntry {
  at: number;
  actorId: PlayerId;
  actorName: string;
  action: string;
  targetId: PlayerId | null;
  reason: string | null;
}

/** Everything the store round-trips across a restart. */
export interface PersistedState {
  /** Epoch ms the very first boot happened. Used to decide whether to seed a demo schedule. */
  firstBootAt: number;
  activities: PersistedActivity[];
  announcements: AnnouncementView[];
  audit: AuditEntry[];
}

function emptyState(): PersistedState {
  return { firstBootAt: Date.now(), activities: [], announcements: [], audit: [] };
}

/**
 * Storage backend for persisted world state. Implementations decide *how* state is
 * kept durable; callers only ever `load` once at boot and `save` whenever something
 * changes. `flush` guarantees any pending, debounced write actually lands — call it
 * during graceful shutdown so the last few seconds of activity are never lost.
 */
export interface Store {
  /** Load the last-persisted state, or a fresh empty state if none exists yet. */
  load(): Promise<PersistedState>;
  /**
   * Persist `state`. Implementations may debounce/coalesce rapid successive calls —
   * callers must not assume `save` has hit durable storage by the time it resolves;
   * use `flush` when that guarantee is required.
   */
  save(state: PersistedState): Promise<void>;
  /** Force any pending write to complete immediately. Always safe to call redundantly. */
  flush(): Promise<void>;
}

/**
 * Pure in-memory store. The default when {@link import('./config.js').CONFIG.PERSIST_PATH}
 * is unset — the server runs correctly, but a restart starts the schedule over. Useful
 * for tests and for deployments that intentionally treat each process lifetime as a
 * fresh island.
 */
export class MemoryStore implements Store {
  private state: PersistedState = emptyState();

  async load(): Promise<PersistedState> {
    return this.state;
  }
  async save(state: PersistedState): Promise<void> {
    this.state = state;
  }
  async flush(): Promise<void> {
    // Nothing buffered — save() is synchronous-equivalent.
  }
}

/**
 * JSON-file-backed store.
 *
 * Writes are atomic (write to a sibling temp file, then `rename` over the target) so a
 * process killed mid-write never leaves a truncated, unparsable file behind — `rename`
 * within the same directory is atomic on POSIX filesystems. Writes are also debounced:
 * activity/announcement mutations can happen many times a second during a busy check-in
 * rush, and this is a JSON file, not a database — coalescing bursts into one write a
 * short interval later keeps disk I/O off the hot path.
 */
export class JsonFileStore implements Store {
  private pending: PersistedState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writing = false;
  /** Resolved after the currently in-flight (or next scheduled) write completes. */
  private drainPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly log: Logger,
    private readonly debounceMs = 500,
  ) {}

  async load(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        firstBootAt: parsed.firstBootAt ?? Date.now(),
        activities: parsed.activities ?? [],
        announcements: parsed.announcements ?? [],
        audit: parsed.audit ?? [],
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.log.info('persist_no_existing_file', { path: this.path });
        return emptyState();
      }
      this.log.error('persist_load_failed', { path: this.path, err });
      return emptyState();
    }
  }

  async save(state: PersistedState): Promise<void> {
    this.pending = state;
    if (this.timer) return;
    this.drainPromise = new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushNow().finally(resolve);
      }, this.debounceMs);
      // Don't hold the process open just for a pending debounced write.
      this.timer.unref?.();
    });
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.flushNow();
    }
    await this.drainPromise;
  }

  private async flushNow(): Promise<void> {
    if (this.writing) {
      // A write is already in flight; the pending state it's about to (or already did)
      // capture will be picked up — reschedule a short debounce to be safe.
      await this.save(this.pending ?? (await this.load()));
      return;
    }
    const state = this.pending;
    if (!state) return;
    this.pending = null;
    this.writing = true;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmpPath = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmpPath, this.path);
    } catch (err) {
      this.log.error('persist_save_failed', { path: this.path, err });
    } finally {
      this.writing = false;
    }
  }
}
