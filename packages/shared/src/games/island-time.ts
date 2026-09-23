/**
 * Island time.
 * ============
 *
 * The island keeps one clock for everybody: a full day and night every
 * {@link ISLAND_DAY_MS}, derived from server epoch time and nothing else. The client's sky
 * reads it to decide where the sun is; the server's scheduler reads it to put the fishing
 * derby at dawn and the fireworks after dark. Both must agree to the second, which is why
 * the definition lives here and not in either of them.
 *
 * `t` is the normalised position in the cycle: 0 = midnight, 0.25 = dawn, 0.5 = noon,
 * 0.75 = dusk.
 */

/** One island day, in real milliseconds. Ninety minutes: long enough to live in, short enough to see turn. */
export const ISLAND_DAY_MS = 90 * 60 * 1000;

/** Normalised time of day, 0–1, for a server epoch time. */
export function islandTimeOfDay(serverTimeMs: number): number {
  const m = serverTimeMs % ISLAND_DAY_MS;
  return (m < 0 ? m + ISLAND_DAY_MS : m) / ISLAND_DAY_MS;
}

/** Island clock as `[hour, minute]`, 24-hour. */
export function islandClock(serverTimeMs: number): [number, number] {
  const minutes = Math.floor(islandTimeOfDay(serverTimeMs) * 24 * 60);
  return [Math.floor(minutes / 60), minutes % 60];
}

/**
 * Whether it is dark on the island.
 *
 * Matches the sky's own stops: the lamps come up past t≈0.80 and go down before t≈0.22.
 * Fireworks are allowed at any hour, but only the dark hours are *for* them.
 */
export function isIslandNight(serverTimeMs: number): boolean {
  const t = islandTimeOfDay(serverTimeMs);
  return t >= 0.8 || t < 0.22;
}

/**
 * Epoch ms at which the island day containing `serverTimeMs` began (its midnight).
 * The scheduler lays each day's programme out from here.
 */
export function islandDayStart(serverTimeMs: number): number {
  return serverTimeMs - (((serverTimeMs % ISLAND_DAY_MS) + ISLAND_DAY_MS) % ISLAND_DAY_MS);
}

/**
 * The calendar day a daily ritual belongs to, as `YYYY-MM-DD` in Japan Standard Time.
 *
 * The omikuji is "once a day", and which day it is has to be one answer for everyone, in
 * whatever time zone they are sitting. The island is Japanese, so Japan's midnight is the
 * one that counts. JST has no daylight saving, so a fixed +9 h offset is exact.
 */
export function jstDay(epochMs: number): string {
  const d = new Date(epochMs + 9 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
