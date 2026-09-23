/**
 * The guestbook — signatures on the notice board.
 * ================================================
 *
 * The cheapest possible "somebody was here": a line of up to 80 characters, written standing
 * at a notice board, kept across restarts. The board holds the newest {@link GUESTBOOK_LIMIT}
 * per island; older lines fall off the bottom (and clients are told, so their copy does not
 * drift from the server's).
 *
 * A line can be taken down by whoever wrote it — the same player in this session, or the same
 * visitor key after a restart — or by an admin. Muted players cannot sign.
 */

import { randomUUID } from 'node:crypto';
import {
  PROTOCOL,
  Role,
  interactablesWith,
  withinReach,
  type GuestbookEntry,
  type PlayerId,
} from '@nagisa/shared';
import type { Player } from '../player.js';
import type { PersistedGuestbookEntry } from '../persistence.js';
import type { GameRoom } from './context.js';

export const GUESTBOOK_LIMIT = 60;
/** One line per player this often. */
export const GUESTBOOK_COOLDOWN_MS = 30_000;
/** How far past a board's own range a signer may stand (network jitter). */
const REACH_SLOP_M = 1.5;

interface Line extends GuestbookEntry {
  authorHash: string | null;
}

export class Guestbook {
  private lines: Line[] = [];
  private readonly lastWrite = new Map<PlayerId, number>();
  /** Changes since the last delta. */
  private added: GuestbookEntry[] = [];
  private removed: string[] = [];

  constructor(private readonly room: GameRoom) {}

  /** Restore from persistence. Author player ids do not survive a restart; hashes do. */
  restore(entries: readonly PersistedGuestbookEntry[]): void {
    this.lines = entries
      .filter((e) => typeof e?.id === 'string' && typeof e.text === 'string')
      .slice(-GUESTBOOK_LIMIT)
      .map((e) => ({ id: e.id, name: String(e.name ?? ''), text: e.text, at: Number(e.at) || 0, authorId: null, authorHash: e.authorHash ?? null }));
  }

  export(): PersistedGuestbookEntry[] {
    return this.lines.map(({ id, name, text, at, authorHash }) => ({ id, name, text, at, authorHash }));
  }

  /** Every line, oldest first, as the wire shows it. */
  view(): GuestbookEntry[] {
    return this.lines.map(({ id, name, text, at, authorId }) => ({ id, name, text, at, authorId }));
  }

  write(player: Player, raw: unknown, now: number): void {
    if (player.muted) {
      this.room.refuse(player.id, 'muted');
      return;
    }
    const atBoard = interactablesWith('read_announcements').some((b) => withinReach(b, player.pos[0], player.pos[2], REACH_SLOP_M));
    if (!atBoard) {
      this.room.refuse(player.id, 'not_here');
      return;
    }
    const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (!text) {
      this.room.refuse(player.id, 'empty');
      return;
    }
    if ([...text].length > PROTOCOL.MAX_GUESTBOOK_LENGTH) {
      this.room.refuse(player.id, 'too_long', { max: PROTOCOL.MAX_GUESTBOOK_LENGTH });
      return;
    }
    const last = this.lastWrite.get(player.id) ?? -Infinity;
    if (now - last < GUESTBOOK_COOLDOWN_MS) {
      this.room.refuse(player.id, 'cooldown', { seconds: Math.ceil((GUESTBOOK_COOLDOWN_MS - (now - last)) / 1000) });
      return;
    }
    this.lastWrite.set(player.id, now);
    const line: Line = { id: randomUUID(), name: player.name, text, at: now, authorId: player.id, authorHash: player.visitorHash };
    this.lines.push(line);
    this.added.push({ id: line.id, name: line.name, text: line.text, at: line.at, authorId: line.authorId });
    while (this.lines.length > GUESTBOOK_LIMIT) {
      const gone = this.lines.shift()!;
      this.removed.push(gone.id);
    }
    this.room.persist();
  }

  remove(player: Player, id: unknown): void {
    const index = typeof id === 'string' ? this.lines.findIndex((l) => l.id === id) : -1;
    if (index < 0) {
      this.room.refuse(player.id, 'not_found');
      return;
    }
    const line = this.lines[index];
    const mine = line.authorId === player.id || (line.authorHash !== null && line.authorHash === player.visitorHash);
    if (!mine && player.role < Role.Admin) {
      this.room.refuse(player.id, 'forbidden');
      return;
    }
    this.lines.splice(index, 1);
    this.removed.push(line.id);
    this.room.persist();
  }

  onLeave(id: PlayerId): void {
    this.lastWrite.delete(id);
  }

  /** What changed since the last call, for the delta. */
  drain(): { added: GuestbookEntry[]; removed: string[] } {
    // A line added and pushed off in the same tick never needs to reach anybody.
    const removed = new Set(this.removed);
    const added = this.added.filter((a) => !removed.has(a.id));
    const out = { added, removed: this.removed.filter((r) => !this.added.some((a) => a.id === r)) };
    this.added = [];
    this.removed = [];
    return out;
  }
}
