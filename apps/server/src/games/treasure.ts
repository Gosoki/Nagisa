/**
 * The treasure hunt.
 * ==================
 *
 * While an activity with `feature: 'treasure'` is live, {@link TREASURE_COUNT} things are
 * buried at random places on the island. Anyone in the room may dig, anywhere, once every
 * {@link DIG_COOLDOWN_MS}: a dig within {@link TREASURE_FIND_RADIUS} of one brings it up,
 * and any other dig is told how close the nearest one still buried is (see `digHeat`). The
 * spots never leave the server; every dig is judged from where the server has the digger
 * standing, so the only way to find one is to go there.
 *
 * Everyone hears about every dig, heat included — a crowd converging on the person whose
 * spade just came up hot is most of the fun. Finds score on the activity's `board`; the hunt
 * ends when the last one is up, or when its time runs out, and the island hears the podium.
 *
 * One hunt runs at a time (there is one set of spots); the room calls off a second, as it
 * does a second quiz. Nothing is persisted: a hunt live across a restart is over, like a quiz.
 */

import {
  ActivityState,
  DIG_COOLDOWN_MS,
  ISLAND_EXTENT,
  TREASURE_COUNT,
  TREASURE_FIND_RADIUS,
  TREASURE_HUNTER_FINDS,
  digHeat,
  heightAt,
  canEnterFrom,
  isWalkable,
  onMapChange,
  spawnPoint,
  type ActivityId,
  type PlayerId,
} from '@nagisa/shared';
import type { Activity } from '../activity.js';
import type { Player } from '../player.js';
import { awardBadge } from './profiles.js';
import type { GameRoom } from './context.js';

/**
 * How long someone who has just arrived waits before their first dig, ms. Arriving may put
 * you anywhere you last stood (`hello.at`), so without it a script could reconnect its way
 * round the island digging once per landing.
 */
export const ARRIVAL_DIG_DELAY_MS = 5_000;

/** Buried things are at least this far apart, metres, so one lucky dig does not find two. */
const MIN_APART_M = 30;
/** And at least this far from the harbour where people arrive. */
const SPAWN_CLEARANCE_M = 12;

interface Spot {
  x: number;
  z: number;
}

export class TreasureHunt {
  /** The live hunt, if any. */
  private activity: ActivityId | null = null;
  private spots: Spot[] = [];
  private readonly finds = new Map<PlayerId, { name: string; count: number }>();
  /** Last dig by visitor key (or by player, without one): a new connection is the same spade. */
  private readonly lastDig = new Map<string, number>();

  constructor(private readonly room: GameRoom) {}

  /** The hunt that is running, if any. */
  get running(): ActivityId | null {
    return this.activity;
  }

  /** Bury the treasure. Called when a hunt goes live; false if one is already running. */
  start(activity: Activity): boolean {
    if (this.activity) return false;
    this.activity = activity.id;
    this.spots = bury(TREASURE_COUNT, () => this.room.random());
    this.finds.clear();
    this.publish(activity);
    return true;
  }

  /** Dig where the player stands. */
  dig(player: Player, now: number): void {
    const activity = this.activity ? this.room.activities.get(this.activity) : undefined;
    if (!activity || activity.state !== ActivityState.Live || this.spots.length === 0) {
      this.room.refuse(player.id, 'no_hunt');
      return;
    }
    const settled = player.arrivedAt + ARRIVAL_DIG_DELAY_MS - now;
    if (settled > 0) {
      this.room.refuse(player.id, 'cooldown', { seconds: Math.ceil(settled / 1000) });
      return;
    }
    const spade = player.visitorHash ?? player.id;
    const last = this.lastDig.get(spade) ?? -Infinity;
    if (now - last < DIG_COOLDOWN_MS) {
      this.room.refuse(player.id, 'cooldown', { seconds: Math.ceil((DIG_COOLDOWN_MS - (now - last)) / 1000) });
      return;
    }
    this.lastDig.set(spade, now);

    const [px, , pz] = player.pos;
    let nearest = -1;
    let best = Infinity;
    this.spots.forEach((s, i) => {
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });

    if (best > TREASURE_FIND_RADIUS) {
      const heat = digHeat(best);
      this.room.sendTo(player.id, { t: 'dig', result: heat, left: this.spots.length });
      this.room.emitEvent({ k: 'dig', by: player.id, heat });
      return;
    }

    const [found] = this.spots.splice(nearest, 1);
    const left = this.spots.length;
    this.room.sendTo(player.id, { t: 'dig', result: 'found', left });
    this.room.emitEvent({ k: 'treasure', by: player.id, pos: [found.x, heightAt(found.x, found.z), found.z], left });

    const score = this.finds.get(player.id) ?? { name: player.name, count: 0 };
    score.count++;
    score.name = player.name;
    this.finds.set(player.id, score);
    this.publish(activity);

    const rec = player.profile;
    rec.treasures++;
    if (rec.treasures >= TREASURE_HUNTER_FINDS && awardBadge(rec, 'treasure')) this.room.celebrate(player, ['treasure']);
    else this.room.pushProfile(player);
    this.room.persist();

    // The last one up ends it: there is nothing left to dig for.
    if (left === 0) this.room.activities.transition(activity, ActivityState.Ended);
  }

  /** A hunt ended or was called off: tell the island who found what, and forget the spots. */
  finish(activity: Activity, ended: boolean): void {
    if (this.activity !== activity.id) return;
    this.activity = null;
    this.spots = [];
    this.lastDig.clear();
    const podium = [...this.finds.values()].sort((a, b) => b.count - a.count).slice(0, 3);
    this.finds.clear();
    if (!ended || podium.length === 0) return;
    // Names and numbers read the same in every language; the medals do the rest.
    const medals = ['🏆', '🥈', '🥉'];
    const line = podium.map((s, i) => `${medals[i]} ${s.name} ×${s.count}`).join('  ·  ');
    this.room.announceSystem(`💎 ${line}`, { kind: 'island' }, 'high');
  }

  onLeave(id: PlayerId): void {
    this.lastDig.delete(id);
  }

  /** Put the scores and what is left on the activity, for the board. */
  private publish(activity: Activity): void {
    activity.left = this.spots.length;
    activity.board = [...this.finds.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([id, s]) => ({ id, name: s.name, score: s.count }));
    this.room.activities.notifyChanged(activity);
  }
}

/**
 * The grid the island is searched on for places to bury things, metres: the step the routing
 * samples a straight line at, finer than a character is wide, so the search cannot step over
 * a wall a player would have to walk round.
 */
const GROUND_STEP = 1;

let ground: Spot[] | null = null;
// Another island is other places.
onMapChange(() => {
  ground = null;
});

/**
 * Every place a thing may be buried: open ground above the waterline, clear of where people
 * arrive, and reachable on foot from where they do — found by walking the island on a
 * one-metre grid from the arrival points, stepping only where the movement rules
 * (`canEnterFrom`) would let a player step. Thousands of places, so no hunt tells you
 * where the next one is, and worked out once: the island does not change while the server
 * runs, and a hunt goes live in every room on the same tick, so the search (a couple of
 * seconds) must not be paid for there. `index.ts` does it at boot.
 */
export function treasureGround(): readonly Spot[] {
  if (ground) return ground;
  const spawns = Array.from({ length: 8 }, (_, i) => spawnPoint(i).pos);
  const n = Math.ceil((2 * ISLAND_EXTENT) / GROUND_STEP) + 1;
  const at = (i: number): number => -ISLAND_EXTENT + i * GROUND_STEP;
  const seen = new Uint8Array(n * n);
  const queue: number[] = [];
  for (const [sx, , sz] of spawns) {
    const ci = Math.round((sx + ISLAND_EXTENT) / GROUND_STEP);
    const cj = Math.round((sz + ISLAND_EXTENT) / GROUND_STEP);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= n || j >= n || seen[i * n + j]) continue;
        if (!isWalkable(at(i), at(j)) || !canEnterFrom(sx, sz, at(i), at(j))) continue;
        seen[i * n + j] = 1;
        queue.push(i * n + j);
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = Math.floor(queue[head] / n);
    const j = queue[head] % n;
    for (const [ni, nj] of [
      [i + 1, j],
      [i - 1, j],
      [i, j + 1],
      [i, j - 1],
    ]) {
      if (ni < 0 || nj < 0 || ni >= n || nj >= n || seen[ni * n + nj]) continue;
      if (!canEnterFrom(at(i), at(j), at(ni), at(nj))) continue;
      seen[ni * n + nj] = 1;
      queue.push(ni * n + nj);
    }
  }
  const found: Spot[] = [];
  for (const cell of queue) {
    const x = at(Math.floor(cell / n));
    const z = at(cell % n);
    if (!isWalkable(x, z) || heightAt(x, z) < 0) continue;
    if (spawns.some(([sx, , sz]) => Math.hypot(sx - x, sz - z) < SPAWN_CLEARANCE_M)) continue;
    found.push({ x, z });
  }
  ground = found;
  return ground;
}

/**
 * Pick `count` places to bury things from {@link treasureGround}, apart from each other and
 * somewhere inside their grid square rather than on its corner. Exported for the tests.
 */
export function bury(count: number, random: () => number): Array<{ x: number; z: number }> {
  const candidates = treasureGround();
  const spots: Spot[] = [];
  for (let tries = 0; spots.length < count && tries < 400; tries++) {
    const cell = candidates[Math.floor(random() * candidates.length)];
    if (!cell) continue;
    const x = cell.x + (random() - 0.5) * GROUND_STEP;
    const z = cell.z + (random() - 0.5) * GROUND_STEP;
    const s = isWalkable(x, z) ? { x, z } : { ...cell };
    if (spots.some((t) => Math.hypot(t.x - s.x, t.z - s.z) < MIN_APART_M)) continue;
    spots.push(s);
  }
  return spots;
}
