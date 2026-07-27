/**
 * Audit log — an append-only record of admin actions.
 * =====================================================
 *
 * "Who did what to whom, when, and why" for every privileged action (kick, mute,
 * grant/revoke host). This is the record you reach for after the fact when someone
 * asks "why was I kicked" — it must never be edited or reordered after the fact, only
 * appended to.
 *
 * This class owns the in-memory log and the human-readable log line; it does *not* own
 * the file/DB write itself. Durability is a `Store` concern (see `persistence.ts`), and
 * `PersistedState.audit` is one field alongside activities and announcements — the
 * *caller* (`room.ts`/`index.ts`) is responsible for including `AuditLog.all()` in
 * whatever it hands to `Store.save()`. Keeping the log itself storage-agnostic means it
 * has the same test-without-I/O property as `activity.ts` and `permissions.ts`.
 */

import type { AuditEntry } from './persistence.js';
import type { Logger } from './logger.js';

export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(private readonly log: Logger) {}

  /**
   * Append one entry. Also mirrors it to the structured logger immediately — the audit
   * log is only flushed to durable storage periodically/debounced, but an admin action
   * showing up in the live log stream right away is valuable for on-call debugging.
   */
  record(entry: { actorId: string; actorName: string; action: string; targetId: string | null; reason: string | null }): AuditEntry {
    const full: AuditEntry = { ...entry, at: Date.now() };
    this.entries.push(full);
    this.log.info('audit_action', { ...full });
    return full;
  }

  /** Full history, oldest first. Safe to call often — returns the live backing array by reference for read-only iteration. */
  all(): readonly AuditEntry[] {
    return this.entries;
  }

  /** Replace the in-memory log with persisted entries, e.g. on boot. Does not re-emit log lines. */
  restore(entries: readonly AuditEntry[]): void {
    this.entries = [...entries];
  }
}
