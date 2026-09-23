/**
 * Today's tasks, kept.
 * ====================
 *
 * The list is `dailyTasks(day)` in the shared package — the same three for everyone on a
 * Japanese calendar day. This counts a player's way through them: each game says what just
 * happened (`GameRoom.daily`), and a task that is not yet full takes it. The day the last
 * one fills is a day done: the streak grows if yesterday was one too, and seven days done
 * make a Regular.
 *
 * A player's progress is kept on their profile, so it carries across tabs, islands and a
 * restart the way a stamp does; tomorrow starts from nothing.
 */

import { REGULAR_DAYS, dailyTasks, dayBefore, jstDay, type DailyKind, type ProfileView } from '@nagisa/shared';
import type { Player } from '../player.js';
import type { ProfileRecord } from '../persistence.js';
import { awardBadge } from './profiles.js';
import type { GameRoom } from './context.js';

/** Count something a player just did towards today's tasks. `zone` names the place, for `zones`. */
export function recordDaily(room: GameRoom, player: Player, kind: DailyKind, now: number, zone?: string): void {
  const day = jstDay(now);
  const tasks = dailyTasks(day);
  const index = tasks.findIndex((t) => t.kind === kind);
  if (index < 0) return;
  const rec = player.profile;
  if (!rec.daily || rec.daily.day !== day) rec.daily = { day, progress: tasks.map(() => 0), zones: [], done: false };
  const today = rec.daily;
  if (today.progress[index] >= tasks[index].goal) return;
  if (kind === 'zones') {
    // Places, not steps: walking back and forth across one border is one place.
    if (!zone || today.zones.includes(zone)) return;
    today.zones.push(zone);
    today.progress[index] = today.zones.length;
  } else {
    today.progress[index]++;
  }

  if (!today.done && tasks.every((t, i) => today.progress[i] >= t.goal)) {
    today.done = true;
    rec.dailyStreak = rec.dailyLast === dayBefore(day) ? rec.dailyStreak + 1 : 1;
    rec.dailyLast = day;
    rec.dailyDays++;
    if (rec.dailyDays >= REGULAR_DAYS && awardBadge(rec, 'regular')) {
      room.celebrate(player, ['regular']);
      room.persist();
      return;
    }
  }
  room.pushProfile(player);
  room.persist();
}

/** Today's tasks as a profile shows them: a day not started yet is all zeros. */
export function dailyView(rec: ProfileRecord, now = Date.now()): Pick<ProfileView, 'daily' | 'dailyStreak' | 'dailyDays'> {
  const day = jstDay(now);
  const mine = rec.daily && rec.daily.day === day ? rec.daily : null;
  return {
    daily: {
      day,
      tasks: dailyTasks(day).map((t, i) => ({ ...t, progress: mine?.progress[i] ?? 0 })),
      done: mine?.done ?? false,
    },
    // A streak is only still going if its last day was today or yesterday.
    dailyStreak: rec.dailyLast === day || rec.dailyLast === dayBefore(day) ? rec.dailyStreak : 0,
    dailyDays: rec.dailyDays,
  };
}
