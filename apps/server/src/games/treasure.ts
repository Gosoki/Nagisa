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
  isWalkable,
  routeTo,
  spawnPoint,
  type ActivityId,
  type PlayerId,
} from '@nagisa/shared';
import type { Activity } from '../activity.js';
import type { Player } from '../player.js';
import { awardBadge } from './profiles.js';
import type { GameRoom } from './context.js';

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
  private readonly lastDig = new Map<PlayerId, number>();

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
    const last = this.lastDig.get(player.id) ?? -Infinity;
    if (now - last < DIG_COOLDOWN_MS) {
      this.room.refuse(player.id, 'cooldown', { seconds: Math.ceil((DIG_COOLDOWN_MS - (now - last)) / 1000) });
      return;
    }
    this.lastDig.set(player.id, now);

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
 * Pick `count` places to bury things: open ground anyone can walk to from the harbour, apart
 * from each other and from where people arrive. Exported for the tests.
 */
export function bury(count: number, random: () => number): Array<{ x: number; z: number }> {
  const spawns = Array.from({ length: 8 }, (_, i) => spawnPoint(i).pos);
  const [hx, , hz] = spawns[0];
  const spots: Spot[] = [];
  for (let tries = 0; spots.length < count && tries < 4000; tries++) {
    const x = (random() * 2 - 1) * ISLAND_EXTENT;
    const z = (random() * 2 - 1) * ISLAND_EXTENT;
    if (!isWalkable(x, z) || heightAt(x, z) < 0) continue;
    if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < MIN_APART_M)) continue;
    if (spawns.some(([sx, , sz]) => Math.hypot(sx - x, sz - z) < SPAWN_CLEARANCE_M)) continue;
    // Walkable is not the same as reachable: a ledge nobody can climb onto is walkable too.
    if (!routeTo(hx, hz, x, z).length) continue;
    spots.push({ x, z });
  }
  return spots;
}
