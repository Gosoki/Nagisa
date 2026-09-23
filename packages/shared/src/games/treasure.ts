/**
 * The treasure hunt: the rules both sides need.
 * ============================================
 *
 * While a hunt is live a few things are buried somewhere on the island. Nobody is told
 * where. Anyone may dig, anywhere; the sand answers with how close the nearest one still in
 * the ground is — hot, warm, cool or cold — and digging within reach of one brings it up.
 * The fun is in the triangulation, and in the crowd that gathers round someone whose spade
 * just came up hot.
 *
 * The server holds the spots and judges every dig from where it has the digger standing;
 * the client only says "dig". These are the numbers both of them show.
 */

/** How many things one hunt buries. */
export const TREASURE_COUNT = 3;

/** A dig this close to a treasure, metres, brings it up. */
export const TREASURE_FIND_RADIUS = 2.5;

/** One dig per person this often, ms. Slow enough that the sand is read, not scanned. */
export const DIG_COOLDOWN_MS = 1500;

/** How many finds, over all your hunts, make a Treasure Hunter. */
export const TREASURE_HUNTER_FINDS = 3;

/** What the sand says. */
export type DigHeat = 'hot' | 'warm' | 'cool' | 'cold';

/** The heat of a dig `distance` metres from the nearest treasure still buried. */
export function digHeat(distance: number): DigHeat {
  if (distance <= 8) return 'hot';
  if (distance <= 20) return 'warm';
  if (distance <= 40) return 'cool';
  return 'cold';
}
