/**
 * Fishing — and the derby that scores it.
 * ========================================
 *
 * The flow, from one player's side:
 *
 * ```
 * cast at a spot ─► waiting ─(2.5–9 s)─► bite ─(hook within the window)─► caught
 *                      │                   └─(window passes)──────────► escaped/late
 *                      └─(hook too soon)──────────────────────────────► escaped/early
 * ```
 *
 * The wait for a bite is 2.5–9 s, shorter in the rain (see `weather.ts`).
 *
 * The server decides everything that could be argued about: when the bite comes, whether
 * the strike was in time, and what was on the end of the line. The client only says "cast"
 * and "now". Bites are driven by the room's tick (100 ms), not by per-line timers, so there is
 * nothing to cancel when a player leaves beyond deleting their line.
 *
 * ### The derby
 *
 * While an activity with `feature: 'derby'` is live, every catch by someone attending it
 * scores their biggest single fish in centimetres. The top five ride on the activity as its
 * `board`; when it ends, the winner gets the Derby Champion badge and the island hears the
 * podium.
 */

import {
  ActivityState,
  getInteractable,
  interactablePosition,
  islandDayStart,
  isIslandNight,
  rollCatch,
  weatherAt,
  RAIN_BITE_FACTOR,
  type ActivityId,
  type PlayerId,
} from '@nagisa/shared';
import type { Activity } from '../activity.js';
import type { Player } from '../player.js';
import { awardBadge, awardFishingBadges } from './profiles.js';
import type { GameRoom } from './context.js';

/** Bite comes this long after the cast, uniformly. */
const BITE_MIN_MS = 2500;
const BITE_MAX_MS = 9000;
/** How long the float stays under. */
export const BITE_WINDOW_MS = 1200;
/** Allowance for the strike's trip across the network. Generous: this is not a reflex test. */
const HOOK_SLACK_MS = 350;
/** How far past a spot's range a player may drift before the line comes in. */
const DRIFT_SLOP_M = 1.5;
/** A "record" must also be a genuinely big one for its kind: this far up its size range. */
const RECORD_FRACTION = 0.6;

interface Line {
  spot: string;
  habitat: 'harbor' | 'beach';
  x: number;
  z: number;
  reach: number;
  biteAt: number;
  phase: 'waiting' | 'bite';
}

export class Fishing {
  private readonly lines = new Map<PlayerId, Line>();
  /** Biggest of each species landed in this room during the current island day. */
  private records = new Map<string, number>();
  private recordsDay = 0;
  /** Derby scores by activity: player → biggest fish (cm), and their name at the time. */
  private readonly derbies = new Map<ActivityId, Map<PlayerId, { name: string; best: number }>>();

  constructor(private readonly room: GameRoom) {}

  isFishing(id: PlayerId): boolean {
    return this.lines.has(id);
  }

  /** Cast at `spotId`. */
  cast(player: Player, spotId: string, now: number): void {
    const spot = getInteractable(spotId);
    if (!spot || spot.effect !== 'fish') {
      this.room.refuse(player.id, 'not_found');
      return;
    }
    const at = interactablePosition(spot);
    if (Math.hypot(player.pos[0] - at.x, player.pos[2] - at.z) > spot.range + DRIFT_SLOP_M) {
      this.room.refuse(player.id, 'too_far');
      return;
    }
    const existing = this.lines.get(player.id);
    if (existing) {
      // A repeated cast (a double tap, a resend) is answered with where things stand.
      this.room.sendTo(player.id, { t: 'fish', phase: existing.phase, spot: existing.spot, window: BITE_WINDOW_MS });
      return;
    }
    this.lines.set(player.id, {
      spot: spot.id,
      habitat: spot.habitat ?? 'harbor',
      x: at.x,
      z: at.z,
      reach: spot.range + DRIFT_SLOP_M,
      // Fish bite sooner in the rain (the one thing the weather changes on the server).
      biteAt: now + (BITE_MIN_MS + this.room.random() * (BITE_MAX_MS - BITE_MIN_MS)) * (weatherAt(now) === 'rain' ? RAIN_BITE_FACTOR : 1),
      phase: 'waiting',
    });
    this.room.sendTo(player.id, { t: 'fish', phase: 'waiting', spot: spot.id });
  }

  /** Strike. */
  hook(player: Player, now: number): void {
    const line = this.lines.get(player.id);
    if (!line) {
      this.room.sendTo(player.id, { t: 'fish', phase: 'idle' });
      return;
    }
    this.lines.delete(player.id);
    if (line.phase === 'waiting') {
      this.room.sendTo(player.id, { t: 'fish', phase: 'escaped', reason: 'early' });
      return;
    }
    if (now > line.biteAt + BITE_WINDOW_MS + HOOK_SLACK_MS) {
      this.room.sendTo(player.id, { t: 'fish', phase: 'escaped', reason: 'late' });
      return;
    }
    this.land(player, line, now);
  }

  /** Reel in on purpose. */
  stop(player: Player): void {
    if (this.lines.delete(player.id)) this.room.sendTo(player.id, { t: 'fish', phase: 'idle' });
  }

  /** The player moved: if they have walked off their spot, the line comes in. */
  onMove(player: Player): void {
    const line = this.lines.get(player.id);
    if (!line) return;
    if (Math.hypot(player.pos[0] - line.x, player.pos[2] - line.z) > line.reach) {
      this.lines.delete(player.id);
      this.room.sendTo(player.id, { t: 'fish', phase: 'escaped', reason: 'moved' });
    }
  }

  /** The player left or dropped: their line simply goes. */
  onLeave(id: PlayerId): void {
    this.lines.delete(id);
  }

  /** Bites and missed bites. Called every room tick. */
  tick(now: number): void {
    for (const [id, line] of this.lines) {
      if (line.phase === 'waiting' && now >= line.biteAt) {
        line.phase = 'bite';
        line.biteAt = now;
        this.room.sendTo(id, { t: 'fish', phase: 'bite', spot: line.spot, window: BITE_WINDOW_MS });
      } else if (line.phase === 'bite' && now > line.biteAt + BITE_WINDOW_MS + HOOK_SLACK_MS) {
        this.lines.delete(id);
        this.room.sendTo(id, { t: 'fish', phase: 'escaped', reason: 'late' });
      }
    }
  }

  private land(player: Player, line: Line, now: number): void {
    const { fish, sizeCm } = rollCatch(line.habitat, isIslandNight(now), () => this.room.random());

    // Today's records, per room. A new island day starts a new list.
    const day = islandDayStart(now);
    if (day !== this.recordsDay) {
      this.records = new Map();
      this.recordsDay = day;
    }
    const prevRecord = this.records.get(fish.id) ?? 0;
    const bigEnough = sizeCm >= fish.minCm + (fish.maxCm - fish.minCm) * RECORD_FRACTION;
    const record = fish.rarity !== 'junk' && sizeCm > prevRecord && bigEnough;
    if (sizeCm > prevRecord) this.records.set(fish.id, sizeCm);

    this.room.daily(player, 'fish');

    // The book.
    const rec = player.profile;
    const entry = rec.fish[fish.id];
    const newSpecies = !entry;
    const personalBest = !!entry && sizeCm > entry.best;
    rec.fish[fish.id] = { count: (entry?.count ?? 0) + 1, best: Math.max(entry?.best ?? 0, sizeCm) };
    rec.catches++;
    const badges = awardFishingBadges(rec);

    this.room.sendTo(player.id, {
      t: 'fish',
      phase: 'caught',
      spot: line.spot,
      fish: fish.id,
      size: sizeCm,
      newSpecies,
      record,
      personalBest,
    });
    this.room.emitEvent({ k: 'catch', by: player.id, fish: fish.id, size: sizeCm, record });
    this.scoreDerby(player, sizeCm, fish.rarity === 'junk');
    if (badges.length) this.room.celebrate(player, badges);
    else this.room.pushProfile(player);
    this.room.persist();
  }

  // --- The derby ----------------------------------------------------------------------------

  /** The live derby this player is attending, if any. */
  private derbyOf(player: Player): Activity | null {
    if (!player.activity || player.mode !== 'participant') return null;
    const a = this.room.activities.get(player.activity);
    return a && a.feature === 'derby' && a.state === ActivityState.Live ? a : null;
  }

  private scoreDerby(player: Player, sizeCm: number, junk: boolean): void {
    if (junk) return; // An old boot does not win a fishing competition.
    const derby = this.derbyOf(player);
    if (!derby) return;
    let scores = this.derbies.get(derby.id);
    if (!scores) {
      scores = new Map();
      this.derbies.set(derby.id, scores);
    }
    const prev = scores.get(player.id);
    if (prev && prev.best >= sizeCm) return;
    scores.set(player.id, { name: player.name, best: sizeCm });
    derby.board = [...scores.entries()]
      .sort((a, b) => b[1].best - a[1].best)
      .slice(0, 5)
      .map(([id, s]) => ({ id, name: s.name, score: s.best }));
    this.room.activities.notifyChanged(derby);
  }

  /** A derby ended: crown the winner, tell the island, forget the scores. */
  finishDerby(derby: Activity): void {
    const scores = this.derbies.get(derby.id);
    this.derbies.delete(derby.id);
    if (!scores || scores.size === 0) return;
    const podium = [...scores.entries()].sort((a, b) => b[1].best - a[1].best).slice(0, 3);
    const [winnerId] = podium[0];
    const winner = this.room.getPlayer(winnerId);
    if (winner && awardBadge(winner.profile, 'derby-champ')) this.room.celebrate(winner, ['derby-champ']);
    // Names and numbers read the same in every language; the medals do the rest.
    const medals = ['🏆', '🥈', '🥉'];
    const line = podium.map(([, s], i) => `${medals[i]} ${s.name} ${s.best} cm`).join('  ·  ');
    this.room.announceSystem(`🎣 ${line}`, { kind: 'island' }, 'high');
    this.room.persist();
  }
}
