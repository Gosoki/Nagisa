/**
 * Profiles — what a visitor has done on the island.
 * ==================================================
 *
 * A profile is the stamp card, the fish book, the badges and the day's omikuji. It is keyed
 * by a hash of the visitor key a browser presents in `hello` (see `ClientHello.visitor`);
 * the key itself is never stored. A visitor with no usable key still gets a profile — kept on
 * their `Player` for the session and forgotten with it — so every game works for everyone and
 * only the *keeping* depends on the key.
 *
 * Two tabs with the same key share one record object, so they cannot disagree about what is
 * on the card.
 *
 * The store is bounded: past {@link PROFILE_LIMIT} records, the least recently seen are
 * dropped at save time. A profile is a few hundred bytes; the cap keeps the persistence file
 * from growing for as long as the island exists.
 */

import { createHash } from 'node:crypto';
import {
  ANGLER_CATCHES,
  COLLECTIBLE_FISH,
  JANKEN_MASTER_WINS,
  STAMP_ZONES,
  VISITOR_KEY_PATTERN,
  type BadgeId,
  type ProfileView,
} from '@nagisa/shared';
import type { ProfileRecord } from '../persistence.js';
import { dailyView } from './daily.js';

/** How many profiles are kept across restarts. */
export const PROFILE_LIMIT = 20_000;

/** A fresh, empty record. */
export function newProfile(now = Date.now()): ProfileRecord {
  return {
    stamps: [],
    fish: {},
    catches: 0,
    badges: [],
    title: null,
    omikuji: null,
    jankenWins: 0,
    quizWins: 0,
    treasures: 0,
    daily: null,
    dailyStreak: 0,
    dailyLast: null,
    dailyDays: 0,
    friends: [],
    lastSeen: now,
  };
}

/**
 * Hash a visitor key, or return null when it is absent or malformed. A malformed key is
 * treated exactly like no key: the visitor plays without a past, and nothing is stored.
 */
export function hashVisitorKey(raw: unknown): string | null {
  if (typeof raw !== 'string' || !VISITOR_KEY_PATTERN.test(raw)) return null;
  return createHash('sha256').update(`nagisa-visitor:${raw}`).digest('hex');
}

/**
 * Normalise a record read from disk: fill anything a version of the file did not have, and
 * drop anything of the wrong type, so a hand-edited or older file cannot crash a handler.
 */
function sanitise(raw: Partial<ProfileRecord> | null | undefined): ProfileRecord {
  const base = newProfile(0);
  if (!raw || typeof raw !== 'object') return base;
  return {
    stamps: Array.isArray(raw.stamps) ? raw.stamps.filter((s): s is string => typeof s === 'string') : [],
    fish: raw.fish && typeof raw.fish === 'object' ? raw.fish : {},
    catches: Number.isFinite(raw.catches) ? Number(raw.catches) : 0,
    badges: Array.isArray(raw.badges) ? (raw.badges.filter((b) => typeof b === 'string') as BadgeId[]) : [],
    title: typeof raw.title === 'string' ? raw.title : null,
    omikuji: raw.omikuji && typeof raw.omikuji === 'object' ? raw.omikuji : null,
    jankenWins: Number.isFinite(raw.jankenWins) ? Number(raw.jankenWins) : 0,
    quizWins: Number.isFinite(raw.quizWins) ? Number(raw.quizWins) : 0,
    treasures: Number.isFinite(raw.treasures) ? Number(raw.treasures) : 0,
    daily:
      raw.daily && typeof raw.daily.day === 'string' && Array.isArray(raw.daily.progress)
        ? {
            day: raw.daily.day,
            progress: raw.daily.progress.map((n) => (Number.isFinite(n) ? Number(n) : 0)),
            zones: Array.isArray(raw.daily.zones) ? raw.daily.zones.filter((z) => typeof z === 'string') : [],
            done: raw.daily.done === true,
          }
        : null,
    dailyStreak: Number.isFinite(raw.dailyStreak) ? Number(raw.dailyStreak) : 0,
    dailyLast: typeof raw.dailyLast === 'string' ? raw.dailyLast : null,
    dailyDays: Number.isFinite(raw.dailyDays) ? Number(raw.dailyDays) : 0,
    friends: Array.isArray(raw.friends)
      ? raw.friends
          .filter((f) => f && typeof f.hash === 'string' && typeof f.name === 'string')
          .map((f) => ({ hash: f.hash, name: f.name, since: Number.isFinite(f.since) ? Number(f.since) : 0 }))
      : [],
    lastSeen: Number.isFinite(raw.lastSeen) ? Number(raw.lastSeen) : 0,
  };
}

/** Every visitor's record, by key hash. */
export class ProfileStore {
  private readonly records = new Map<string, ProfileRecord>();

  constructor(persisted: Record<string, ProfileRecord> = {}) {
    for (const [hash, rec] of Object.entries(persisted)) this.records.set(hash, sanitise(rec));
  }

  /** The record for a visitor hash, created on first sight. Marks it seen. */
  forVisitor(hash: string, now = Date.now()): ProfileRecord {
    let rec = this.records.get(hash);
    if (!rec) {
      rec = newProfile(now);
      this.records.set(hash, rec);
    }
    rec.lastSeen = now;
    return rec;
  }

  /**
   * A record is in use: mark it seen, and put it back if the store had evicted it while its
   * player was still here — otherwise everything they did from then on would be kept in an
   * object nothing saves.
   */
  touch(hash: string, rec: ProfileRecord, now = Date.now()): void {
    rec.lastSeen = now;
    if (this.records.get(hash) !== rec) this.records.set(hash, rec);
  }

  /** The record for a visitor hash if there is one. Unlike `forVisitor`, neither creates nor marks it. */
  peek(hash: string): ProfileRecord | undefined {
    return this.records.get(hash);
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * The records to persist: the most recently seen {@link PROFILE_LIMIT}. Evicted ones are
   * also dropped from memory, so the in-memory store is bounded by the same number.
   */
  export(limit = PROFILE_LIMIT): Record<string, ProfileRecord> {
    if (this.records.size > limit) {
      const byAge = [...this.records.entries()].sort((a, b) => b[1].lastSeen - a[1].lastSeen);
      for (const [hash] of byAge.slice(limit)) this.records.delete(hash);
    }
    return Object.fromEntries(this.records);
  }
}

/** Project a record to the wire. */
export function profileView(rec: ProfileRecord, persistent: boolean): ProfileView {
  return {
    stamps: [...rec.stamps],
    stampTotal: STAMP_ZONES.length,
    fish: { ...rec.fish },
    catches: rec.catches,
    badges: [...rec.badges],
    title: rec.title,
    omikuji: rec.omikuji ? { ...rec.omikuji } : null,
    jankenWins: rec.jankenWins,
    quizWins: rec.quizWins,
    treasures: rec.treasures,
    ...dailyView(rec),
    persistent,
  };
}

/**
 * Give a badge if it is not already held. Returns whether it was new. The first badge anyone
 * earns is also put on — a badge nobody sees is not much of one, and taking it off is one
 * tap in the collection book.
 */
export function awardBadge(rec: ProfileRecord, badge: BadgeId): boolean {
  if (rec.badges.includes(badge)) return false;
  rec.badges.push(badge);
  if (rec.title === null) rec.title = badge;
  return true;
}

/** Whether the stamp card is full on the current map. */
export function stampCardComplete(rec: ProfileRecord): boolean {
  return STAMP_ZONES.length > 0 && STAMP_ZONES.every((z) => rec.stamps.includes(z));
}

/**
 * The fishing badges a record has now earned and not yet been given. Checked after every
 * catch; returns the ones newly awarded.
 */
export function awardFishingBadges(rec: ProfileRecord): BadgeId[] {
  const earned: BadgeId[] = [];
  if (rec.catches >= ANGLER_CATCHES && awardBadge(rec, 'angler')) earned.push('angler');
  if (COLLECTIBLE_FISH.every((f) => (rec.fish[f.id]?.count ?? 0) > 0) && awardBadge(rec, 'master-angler')) {
    earned.push('master-angler');
  }
  return earned;
}

/** The janken badge, if a win just earned it. */
export function awardJankenBadge(rec: ProfileRecord): BadgeId[] {
  return rec.jankenWins >= JANKEN_MASTER_WINS && awardBadge(rec, 'janken') ? ['janken'] : [];
}
