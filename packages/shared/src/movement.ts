/**
 * The movement contract.
 * ======================
 *
 * The numbers that the client's predicted movement and the server's validator **must
 * agree on**. Not "should" — must. Every value here is used on both sides, and any
 * divergence between them is not a subtle physics discrepancy: it is the player being
 * teleported at random while running.
 *
 * ### Why this file exists
 *
 * Nagisa is client-predicted and server-authoritative. The client moves you immediately so
 * the world feels responsive; the server re-checks every reported transform and snaps you
 * back if it disagrees. That arrangement only works if both sides are enforcing the same
 * rule. When they are not, the client happily walks you somewhere it considers fine, the
 * server rejects it, and you are yanked backwards — which reads to a player as a random
 * forced respawn, with no clue that a walkability threshold is the cause.
 *
 * Three versions of exactly that bug shipped simultaneously, and all three came from the
 * same root cause — the two sides holding their own copies of these numbers:
 *
 * 1. The client waded to 1.25 m of water; the server rejected anything past 0.9 m.
 * 2. The client let a player *stand* on too-steep ground and slide off it over the next
 *    second; the server rejected the very first frame of it.
 * 3. The client's downhill slide impulse was applied *after* its speed clamp, so sliding
 *    could exceed the server's speed budget and earn a `speed` correction.
 *
 * So: the thresholds live here, `terrain.isWalkable` is the one predicate built from them,
 * the client obeys it as a **hard constraint** rather than a soft nudge, and
 * `world-smoke`'s walkability-contract check fails the build if the two ever drift apart
 * again.
 *
 * @see terrain.ts `isWalkable` — the predicate these numbers define
 * @see apps/client/src/character/local-player.ts — the client half
 * @see apps/server/src/player.ts — the server half
 */

/**
 * Ground speeds, metres per second.
 *
 * The server's budget is derived from `RUN` below rather than authored separately, so
 * making the character faster cannot, by construction, make the character get corrected.
 */
export const MOVE_SPEED = {
  /**
   * Ordinary walking — what used to be the run.
   *
   * The island is a hexagon 74 m to a side and the whole ring is meant to be under a minute,
   * so 4.2 m/s made the default pace of the world a trudge and holding the run key the
   * normal way to be anywhere. A world you have to hold a key to enjoy has the wrong default.
   */
  walk: 9.0,
  /** Running: twice the walk, held rather than toggled. */
  run: 18.0,
  /** Wading through shallow water. Slow enough to be a decision, not an obstacle. */
  wade: 2.0,
} as const;

/**
 * Ceiling the client clamps its own horizontal speed to, whatever produced it — input,
 * a downhill slide, a shove out of deep water.
 *
 * This is the belt to the braces: even if some future impulse forgets to respect
 * `MOVE_SPEED.run`, it cannot push the character past what the server will accept.
 */
export const MAX_CLIENT_SPEED = MOVE_SPEED.run;

/**
 * Horizontal speed the server allows, metres/second.
 *
 * Headroom over `MAX_CLIENT_SPEED` absorbs the things the client legitimately does that
 * are not steady-state running: the frame a slide impulse lands on, a jump arc's
 * horizontal carry, and the fact that the budget is measured between *arrival* times
 * rather than between simulation steps.
 */
export const MAX_SERVER_SPEED = MAX_CLIENT_SPEED + 2.5;

/** Vertical speed the server allows. Generous — the client owns its jump arc. */
export const MAX_SERVER_VERTICAL_SPEED = 16;

/** Jump take-off velocity, metres/second. */
export const JUMP_VELOCITY = 7.6;

/** Downward acceleration, metres/second². Higher than earth's; a floaty jump reads as a bug. */
export const GRAVITY = 22;
