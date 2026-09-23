/**
 * Persistence — surviving a restart without losing the island.
 * =============================================================
 *
 * What is worth keeping is small and low-churn, and it is kept **per room**: each island's
 * schedule (activities with their rosters and check-ins), its announcements and its
 * guestbook. Beside the rooms: the registry of private islands (code → keeper), visitor
 * profiles (stamps, the fish book, badges), and the admin audit log.
 *
 * Player positions, emotes, chat, whispers, fishing lines, duels and quizzes in progress are
 * deliberately *not* persisted — they are ephemeral by nature, and restoring them would only
 * give a restarted server stale, misleading things to resume players into.
 *
 * ## Swapping in Redis/Postgres
 *
 * Everything downstream talks to the {@link Store} interface, not to JSON files. To move to
 * Redis: implement `load`/`save`/`flush` against a key per section, keeping the same debounce
 * discipline. To move to Postgres: normalise {@link PersistedState} into tables inside `save`
 * and reconstruct it in `load`. `index.ts` is the only place that constructs a store.
 *
 * ## Versions
 *
 * v1 files held one flat list of activities and announcements (every room's, consolidated).
 * {@link migrate} moves that into the first public shard, which is exactly where v1 put it
 * back on restart, so upgrading loses nothing.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ActivityId,
  ActivityState,
  AnnouncementView,
  AttendanceMode,
  BadgeId,
  PlayerId,
  RoomId,
  ZoneId,
} from '@nagisa/shared';
import type { Logger } from './logger.js';

/** The file format this build writes. */
export const PERSIST_VERSION = 2;

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
  /**
   * Which programme slot this activity was materialised for (`template@startsAt`), or an
   * `adhoc:` id for one an admin put on. Persisted so a restart does not schedule the same
   * slot twice. Absent in v1 files.
   */
  slot?: string | null;
  /** When it ended or was called off, epoch ms — drives when it is cleared off the board. */
  closedAt?: number | null;
  /** For future use if attendance mode needs disambiguating beyond the two set memberships. */
  attendanceMode?: Record<PlayerId, AttendanceMode>;
}

/** One guestbook line as stored — with who wrote it, which the wire never shows. */
export interface PersistedGuestbookEntry {
  id: string;
  name: string;
  text: string;
  at: number;
  /** Hash of the author's visitor key, so they can take it down after a restart. */
  authorHash: string | null;
}

/** Everything one room keeps. */
export interface PersistedRoom {
  activities: PersistedActivity[];
  announcements: AnnouncementView[];
  guestbook: PersistedGuestbookEntry[];
  /** Epoch ms of the last save — the eviction key for islands nobody visits any more. */
  savedAt: number;
}

/** A private island in the registry. */
export interface PersistedIsland {
  code: string;
  /** Hash of the keeper's visitor key. Null when they had none; then nobody keeps it after they leave. */
  ownerHash: string | null;
  ownerName: string | null;
  createdAt: number;
  lastActiveAt: number;
}

/** A visitor's progress. See `games/profiles.ts`. */
export interface ProfileRecord {
  stamps: ZoneId[];
  fish: Record<string, { count: number; best: number }>;
  catches: number;
  badges: BadgeId[];
  title: BadgeId | null;
  omikuji: { day: string; fortune: number; item: number; direction: number } | null;
  jankenWins: number;
  quizWins: number;
  /** Treasures dug up, over every hunt. */
  treasures: number;
  lastSeen: number;
}

/** One append-only audit entry. See audit.ts. */
export interface AuditEntry {
  at: number;
  actorId: PlayerId;
  actorName: string;
  action: string;
  targetId: PlayerId | null;
  reason: string | null;
  /** Which room it happened in. Absent in v1 entries. */
  room?: RoomId;
}

/** Everything the store round-trips across a restart. */
export interface PersistedState {
  version: typeof PERSIST_VERSION;
  /** Epoch ms of the very first boot. */
  firstBootAt: number;
  rooms: Record<RoomId, PersistedRoom>;
  islands: PersistedIsland[];
  profiles: Record<string, ProfileRecord>;
  audit: AuditEntry[];
}

export function emptyState(): PersistedState {
  return { version: PERSIST_VERSION, firstBootAt: Date.now(), rooms: {}, islands: [], profiles: {}, audit: [] };
}

/** The public shard a v1 file's consolidated schedule belongs to. */
const V1_HOME_ROOM = 'shore-1';

/**
 * Bring a parsed file of any known version up to the current shape. Unknown or malformed
 * sections are dropped rather than trusted — a corrupt section should cost that section, not
 * the whole island.
 */
export function migrate(raw: unknown): PersistedState {
  const out = emptyState();
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.firstBootAt === 'number') out.firstBootAt = r.firstBootAt;
  if (Array.isArray(r.audit)) out.audit = r.audit as AuditEntry[];

  if (r.version === PERSIST_VERSION) {
    if (typeof r.rooms === 'object' && r.rooms !== null) {
      for (const [id, room] of Object.entries(r.rooms as Record<string, unknown>)) {
        const pr = room as Partial<PersistedRoom> | null;
        if (!pr || typeof pr !== 'object') continue;
        out.rooms[id] = {
          activities: Array.isArray(pr.activities) ? pr.activities : [],
          announcements: Array.isArray(pr.announcements) ? pr.announcements : [],
          guestbook: Array.isArray(pr.guestbook) ? pr.guestbook : [],
          savedAt: typeof pr.savedAt === 'number' ? pr.savedAt : Date.now(),
        };
      }
    }
    if (Array.isArray(r.islands)) out.islands = r.islands as PersistedIsland[];
    if (typeof r.profiles === 'object' && r.profiles !== null) out.profiles = r.profiles as Record<string, ProfileRecord>;
    return out;
  }

  // v1: one consolidated schedule, which v1 itself restored onto the first shard.
  const activities = Array.isArray(r.activities) ? (r.activities as PersistedActivity[]) : [];
  const announcements = Array.isArray(r.announcements) ? (r.announcements as AnnouncementView[]) : [];
  if (activities.length || announcements.length) {
    out.rooms[V1_HOME_ROOM] = { activities, announcements, guestbook: [], savedAt: Date.now() };
  }
  return out;
}

/**
 * Storage backend for persisted world state. Callers `load` once at boot and `save` whenever
 * something changes. `flush` guarantees any pending, debounced write actually lands — call it
 * during graceful shutdown so the last few seconds are never lost.
 */
export interface Store {
  /** Load the last-persisted state, or a fresh empty state if none exists yet. */
  load(): Promise<PersistedState>;
  /**
   * Persist `state`. Implementations may debounce/coalesce rapid successive calls — callers
   * must not assume it has hit durable storage when this resolves; use `flush` for that.
   */
  save(state: PersistedState): Promise<void>;
  /** Force any pending write to complete. Always safe to call redundantly. */
  flush(): Promise<void>;
}

/**
 * Pure in-memory store. The default when `PERSIST_PATH` is unset — the server runs
 * correctly, but a restart starts everything over. Useful for tests and for deployments that
 * intentionally treat each process lifetime as a fresh island.
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
    // Nothing buffered.
  }
}

/**
 * JSON-file-backed store.
 *
 * Writes are atomic (write a sibling temp file, then `rename` over the target), so a process
 * killed mid-write never leaves a truncated file. They are debounced — mutations can come many
 * times a second during a busy quiz — and **serialised**: every write is chained after the
 * previous one and always writes the newest state it has, so two writes can never interleave
 * and an older state can never land after a newer one.
 */
export class JsonFileStore implements Store {
  private pending: PersistedState | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The tail of the write chain. Every write waits for the one before it. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly log: Logger,
    private readonly debounceMs = 800,
  ) {}

  async load(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return migrate(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.log.info('persist_no_existing_file', { path: this.path });
        return emptyState();
      }
      // A file we cannot parse is not a file we should overwrite with an empty island on the
      // next save: keep it aside for a human, and start fresh.
      this.log.error('persist_load_failed', { path: this.path, err });
      try {
        await rename(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {
        /* Nothing more we can do; the fresh state will overwrite it. */
      }
      return emptyState();
    }
  }

  async save(state: PersistedState): Promise<void> {
    this.pending = state;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueWrite();
    }, this.debounceMs);
    // Don't hold the process open just for a pending debounced write.
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.enqueueWrite();
  }

  private enqueueWrite(): Promise<void> {
    this.chain = this.chain.then(() => this.writePending());
    return this.chain;
  }

  private async writePending(): Promise<void> {
    const state = this.pending;
    if (!state) return;
    this.pending = null;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmpPath = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmpPath, JSON.stringify(state), 'utf8');
      await rename(tmpPath, this.path);
    } catch (err) {
      this.log.error('persist_save_failed', { path: this.path, err });
    }
  }
}
