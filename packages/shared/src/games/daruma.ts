/**
 * だるまさんがころんだ: the rules both sides need.
 * ================================================
 *
 * The oni — a big red daruma at the far end of a lane on the beach — turns its back and
 * chants "da-ru-ma-sa-n-ga-ko-ro-n-da"; while it chants, the racers creep toward it. When it
 * turns round, anyone it sees moving goes back to the start. First over the goal line wins,
 * and the island keeps three places.
 *
 * The server runs the race and judges every step from where it has each racer standing
 * (`apps/server/src/games/daruma.ts`); the client only walks. What both need is here: the
 * course's geometry, and the one speed they must agree on.
 *
 * ### The careful step
 *
 * The island's walk is 9 m/s and its run 18. A lane that fits on a beach is crossed at that
 * pace before the oni has finished one chant, and the game would be a sprint. So while a race
 * is on, a racer moves at {@link DARUMA_STEP_SPEED}: the client caps itself there, and the
 * server holds racers to it — for the same reason the movement contract's numbers live in one
 * place (`movement.ts`): if the two sides disagreed, honest players would be sent back for
 * walking.
 */

import { nearestWalkable } from '../terrain.js';
import { DARUMA_COURSE } from '../world.js';

/**
 * How fast a racer may go while a race is on, metres/second: a careful step. Chosen with the
 * course's length and the chant's in mind — the shipped lane takes four or five chants to
 * cross, which is about how long the game takes in a schoolyard.
 */
export const DARUMA_STEP_SPEED = 1.6;

/** How many places a race keeps. The race ends when they are filled. */
export const DARUMA_PLACES = 3;

/** How far beyond the goal line the oni stands, metres. */
const ONI_BEYOND_M = 2.5;

/** Start places: how far behind the line the first row stands, and the rows after it. */
const START_BEHIND_M = 1;
const START_ROW_GAP_M = 1.2;
const START_COLUMNS = 9;
const START_ROWS = 3;

/** The course's direction, start to goal, as a unit vector, and its length. */
function axis(): { ux: number; uz: number; length: number } | null {
  const c = DARUMA_COURSE;
  if (!c) return null;
  const length = Math.hypot(c.goal.x - c.start.x, c.goal.z - c.start.z);
  if (length === 0) return null;
  return { ux: (c.goal.x - c.start.x) / length, uz: (c.goal.z - c.start.z) / length, length };
}

/** Start line to goal line, metres. 0 on a map without a course. */
export function darumaCourseLength(): number {
  return axis()?.length ?? 0;
}

/**
 * Where (x, z) is on the course: `along` is metres from the start line toward the goal
 * (negative behind the start, past {@link darumaCourseLength} over the goal line), `across`
 * metres from the middle of the lane, one side positive and the other negative. Null on a map
 * without a course.
 */
export function darumaCourseAt(x: number, z: number): { along: number; across: number } | null {
  const c = DARUMA_COURSE;
  const a = axis();
  if (!c || !a) return null;
  const dx = x - c.start.x;
  const dz = z - c.start.z;
  return { along: dx * a.ux + dz * a.uz, across: dx * a.uz - dz * a.ux };
}

/**
 * Where the oni stands — a little way beyond the goal line, in the middle of the lane — and
 * the way it faces when it turns round to look back down the course (the world's yaw
 * convention: the direction `(sin yaw, cos yaw)`). While it chants it faces the other way.
 */
export function darumaOni(): { x: number; z: number; yaw: number } | null {
  const c = DARUMA_COURSE;
  const a = axis();
  if (!c || !a) return null;
  return { x: c.goal.x + a.ux * ONI_BEYOND_M, z: c.goal.z + a.uz * ONI_BEYOND_M, yaw: Math.atan2(-a.ux, -a.uz) };
}

/**
 * Where racer number `index` sets off from, and is sent back to: a place just behind the
 * start line, facing the goal. The first fills the middle of the lane and the rest spread out
 * to either side of it, a metre apart, then into a second and third row; beyond that the
 * places are shared, which on an island where nobody collides with anybody is only a crowd.
 */
export function darumaStartSpot(index: number): { x: number; z: number; yaw: number } | null {
  const c = DARUMA_COURSE;
  const a = axis();
  if (!c || !a) return null;
  const slots = START_COLUMNS * START_ROWS;
  const slot = ((Math.floor(index) % slots) + slots) % slots;
  const k = slot % START_COLUMNS;
  const row = Math.floor(slot / START_COLUMNS);
  // Middle out: 0, −1, +1, −2, +2, …
  const offset = k === 0 ? 0 : k % 2 === 1 ? -(k + 1) / 2 : k / 2;
  const spacing = (c.halfWidth - 0.5) / ((START_COLUMNS - 1) / 2);
  const across = offset * spacing;
  const behind = START_BEHIND_M + row * START_ROW_GAP_M;
  // `across` is measured along (uz, −ux); see `darumaCourseAt`.
  const [x, z] = nearestWalkable(c.start.x - a.ux * behind + a.uz * across, c.start.z - a.uz * behind - a.ux * across);
  return { x, z, yaw: Math.atan2(a.ux, a.uz) };
}
