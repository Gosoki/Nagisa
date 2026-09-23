/**
 * The island's weather.
 * =====================
 *
 * One sky for everyone, worked out from the clock alone: the day is cut into blocks of
 * {@link WEATHER_BLOCK_MS}, and each block's weather is a hash of its index. Every client and
 * the server arrive at the same answer from the same (server) time, so nothing about the
 * weather is ever sent — the same trick as the island's day (`island-time.ts`).
 *
 * Mostly fair, sometimes grey, now and then rain. The change between two blocks is eased over
 * {@link WEATHER_BLEND_MS}, so the sky clouds over rather than switching.
 *
 * What it does: the sky and the light follow it and rain falls around you (client), and in
 * the rain the fish bite sooner (server, `games/fishing.ts`).
 */

export type Weather = 'clear' | 'cloudy' | 'rain';

/** How long one spell of weather lasts, ms. Six to an island day. */
export const WEATHER_BLOCK_MS = 15 * 60_000;

/** How long the sky takes to go from one spell to the next, ms. */
export const WEATHER_BLEND_MS = 90_000;

/** In the rain, the wait for a bite is this fraction of a dry one. */
export const RAIN_BITE_FACTOR = 0.7;

/** A well-mixed 32-bit hash of an integer, as a number in [0, 1). */
function unit(n: number): number {
  let t = Math.imul(n | 0, 0x9e3779b1) >>> 0;
  t ^= t >>> 16;
  t = Math.imul(t, 0x85ebca6b) >>> 0;
  t ^= t >>> 13;
  t = Math.imul(t, 0xc2b2ae35) >>> 0;
  t ^= t >>> 16;
  return (t >>> 0) / 4294967296;
}

/** The weather of block `index` (`floor(ms / WEATHER_BLOCK_MS)`). */
export function weatherOfBlock(index: number): Weather {
  const r = unit(index);
  if (r < 0.15) return 'rain';
  if (r < 0.4) return 'cloudy';
  return 'clear';
}

/** The weather at server time `ms`. */
export function weatherAt(ms: number): Weather {
  return weatherOfBlock(Math.floor(ms / WEATHER_BLOCK_MS));
}

const LEVELS: Record<Weather, { cloud: number; rain: number }> = {
  clear: { cloud: 0, rain: 0 },
  cloudy: { cloud: 0.75, rain: 0 },
  rain: { cloud: 1, rain: 1 },
};

/**
 * The weather at `ms` as two continuous levels, 0–1 — how overcast, how hard it is raining —
 * eased from the previous spell over the first {@link WEATHER_BLEND_MS} of this one.
 */
export function weatherLevels(ms: number): { weather: Weather; cloud: number; rain: number } {
  const index = Math.floor(ms / WEATHER_BLOCK_MS);
  const weather = weatherOfBlock(index);
  const now = LEVELS[weather];
  const before = LEVELS[weatherOfBlock(index - 1)];
  const x = Math.min(1, Math.max(0, (ms - index * WEATHER_BLOCK_MS) / WEATHER_BLEND_MS));
  const k = x * x * (3 - 2 * x);
  return {
    weather,
    cloud: before.cloud + (now.cloud - before.cloud) * k,
    rain: before.rain + (now.rain - before.rain) * k,
  };
}
