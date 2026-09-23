/**
 * The island's day — keeping every room's programme materialised.
 * ================================================================
 *
 * The map says what happens when (`MapWorld.programme`: template + minute of the island day);
 * this keeps the next stretch of it on each room's board as real activities, day after day,
 * for as long as the room exists. The previous design seeded one of each template at first
 * boot and then nothing: two hours later the board was empty for good, and a second shard
 * never had anything on it at all.
 *
 * Each slot is identified as `template@startsAt`. An activity carries the slot it was made
 * for, and a slot that already has one is never filled twice — so the scheduler can run as
 * often as it likes, across restarts (the slot is persisted), without duplicating anything.
 *
 * Only slots whose *end* is still ahead and whose start is within {@link HORIZON_MS} are
 * made. That keeps the board to what is on in the next hour, and means a room that was
 * asleep does not wake up to a pile of past events.
 */

import { ISLAND_DAY_MS, PROGRAMME, getTemplate, islandDayStart } from '@nagisa/shared';
import type { ActivityManager } from './activity.js';

/** How far ahead activities are put on the board. A little over half an island day. */
export const HORIZON_MS = 55 * 60 * 1000;

/** Slot identity. Deterministic, so the same slot is recognised across restarts. */
export function slotKey(templateId: string, startsAt: number): string {
  return `${templateId}@${startsAt}`;
}

/**
 * Put every programme slot starting within the horizon (and not yet over) on the board.
 * Returns how many were created. Cheap: a few dozen comparisons.
 */
export function materialiseProgramme(activities: ActivityManager, nowMs: number): number {
  let created = 0;
  const today = islandDayStart(nowMs);
  // Yesterday's late slots can still be running; tomorrow's early ones can be inside the horizon.
  for (const dayStart of [today - ISLAND_DAY_MS, today, today + ISLAND_DAY_MS]) {
    for (const slot of PROGRAMME) {
      const template = getTemplate(slot.template);
      if (!template) continue;
      const startsAt = dayStart + Math.round(slot.at * 60_000);
      const endsAt = startsAt + template.durationMin * 60_000;
      if (endsAt <= nowMs || startsAt > nowMs + HORIZON_MS) continue;
      const key = slotKey(template.id, startsAt);
      if (activities.hasSlot(key)) continue;
      activities.createFromTemplate(template.id, startsAt, key);
      created++;
    }
  }
  return created;
}
