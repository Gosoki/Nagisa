/**
 * Today's tasks.
 * ==============
 *
 * Three small things to do on the island today — catch a few fish, ring a bell, say hello —
 * the same three for everyone, drawn from the Japanese calendar day. Being the same is the
 * point: "have you rung a bell yet?" is something to say to a stranger.
 *
 * Doing all three counts the day. Days in a row make a streak; seven days, in a row or not,
 * earn the Regular badge. The server keeps the count (`apps/server/src/games/daily.ts`);
 * this is the list, the goals and the calendar.
 */

import { ACTIVITY_TEMPLATES, FIREWORKS, ZONES, interactablesWith } from '../world.js';

export const DAILY_KINDS = ['fish', 'bell', 'omikuji', 'janken', 'firework', 'checkin', 'chat', 'emote', 'zones'] as const;
export type DailyKind = (typeof DAILY_KINDS)[number];

export interface DailyTask {
  kind: DailyKind;
  /** How many make it done: fish caught, lines said, places walked into. */
  goal: number;
}

/** How many of each make the task. */
const GOALS: Record<DailyKind, number> = {
  fish: 3,
  bell: 1,
  omikuji: 1,
  janken: 1,
  firework: 1,
  checkin: 1,
  chat: 3,
  emote: 3,
  zones: 4,
};

/** Tasks a day. */
export const DAILY_TASK_COUNT = 3;

/** Days of tasks done that make a Regular. Mirrored in `badges.ts`. */
export const REGULAR_DAYS = 7;

/** FNV-1a, then mulberry32: a day's name to a repeatable sequence. */
function sequence(key: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  let t = h;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Whether the island being played has what a task needs: a map without a bell cannot ask for
 * one to be rung. Asked of the active map, which both ends load, so the list still agrees.
 */
function possible(kind: DailyKind): boolean {
  switch (kind) {
    case 'fish':
      return interactablesWith('fish').length > 0;
    case 'bell':
      return interactablesWith('ring_bell').length > 0;
    case 'omikuji':
      return interactablesWith('omikuji').length > 0;
    case 'firework':
      return (FIREWORKS?.zones.length ?? 0) > 0;
    case 'checkin':
      return ACTIVITY_TEMPLATES.some((t) => t.checkinEnabled);
    case 'zones':
      return ZONES.length > GOALS.zones;
    default:
      return true;
  }
}

/** The tasks for a Japanese calendar day (`jstDay`), in the order they are shown. */
export function dailyTasks(day: string): DailyTask[] {
  const random = sequence(`nagisa-daily:${day}`);
  const kinds = DAILY_KINDS.filter(possible);
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  return kinds.slice(0, DAILY_TASK_COUNT).map((kind) => ({ kind, goal: GOALS[kind] }));
}

/** The calendar day before `day` (both `YYYY-MM-DD`). */
export function dayBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const before = new Date(Date.UTC(y, m - 1, d - 1));
  return `${before.getUTCFullYear()}-${String(before.getUTCMonth() + 1).padStart(2, '0')}-${String(before.getUTCDate()).padStart(2, '0')}`;
}
