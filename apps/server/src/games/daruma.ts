/**
 * だるまさんがころんだ.
 * ====================
 *
 * The playground game, on the beach. At the far end of a lane stands the oni — a big red
 * daruma. It turns its back and chants "da-ru-ma-sa-n-ga-ko-ro-n-da", and while it chants the
 * racers creep toward it from the start line; on the last syllable it turns round, and anyone
 * it sees moving goes back to the start. The first over the goal line wins, and the island
 * keeps three places.
 *
 * ```
 * lobby 30 s ─► walk 2–5 s ─► look 2–3 s ─┬─► walk …   (while anyone is racing, fewer than three are
 *                                          │            home, and the race has time left)
 *                                          └─► finished 8 s ─► gone, activity ended
 * ```
 *
 * ### Who races
 *
 * Whoever has joined the activity as a participant when the lobby closes — not everyone on the
 * beach, who may be there for the fish or the sunset. They are put on the start line, each on
 * a place of their own (`darumaStartSpot`). From then on a racer drops out by leaving the
 * room, leaving the activity or going over to watching, or wandering well off the lane — gone
 * to do something else, and no longer held to the game's pace. Joining after the lobby closes
 * makes you a spectator. If nobody has joined when the lobby closes it opens again, for as
 * long as a whole race would still fit before the activity's end; otherwise the game is over.
 *
 * ### What the oni sees
 *
 * Everything is judged on the room's tick from each racer's **last validated position**, like
 * the quiz's answers. A look opens with {@link LOOK_GRACE_MS} of grace — the turn is on every
 * screen at the same moment on the server's clock, but a person needs a moment to stop and
 * their last steps a moment to arrive — after which each racer's position is taken, and
 * anyone who then strays more than {@link STILL_TOLERANCE_M} from it is caught. Only *where*
 * someone stands counts: turning on the spot, dancing or hopping in place is not moving, and
 * the idle reports that repeat a position change nothing. Nobody who is not racing is judged,
 * whatever they do on the lane.
 *
 * Racers are also held to the careful step (`DARUMA_STEP_SPEED`, which the client caps itself
 * at): each is measured from where they stood when the oni last turned its back, and one who
 * has got further than the step allows in the time since is caught as well. A client that
 * keeps the rules never meets this; it is what stops a modified one sprinting the chant.
 *
 * Caught means sent back: the server moves them to their start place (`GameRoom.relocate`)
 * and they carry on from there. Crossing the goal line within the lane's width is a place.
 *
 * One race runs at a time (there is one course), and nothing is persisted: a race live across
 * a restart is over, like a quiz.
 */

import {
  DARUMA_COURSE,
  DARUMA_PLACES,
  DARUMA_STEP_SPEED,
  darumaCourseAt,
  darumaCourseLength,
  darumaStartSpot,
  heightAt,
  type ActivityId,
  type DarumaView,
  type PlayerId,
} from '@nagisa/shared';
import type { Player } from '../player.js';
import { awardBadge } from './profiles.js';
import type { GameRoom } from './context.js';

export const LOBBY_MS = 30_000;
/** How long the oni chants, ms: its pace changes every time, as a real oni's does. */
export const WALK_MIN_MS = 2_000;
export const WALK_MAX_MS = 5_000;
/** How long it looks, ms. */
export const LOOK_MIN_MS = 2_000;
export const LOOK_MAX_MS = 3_000;
/**
 * How long after the turn, ms, before a racer's position is taken as the one they must hold.
 * Reaction, the last steps' slide, and a report on its way up — for someone who stopped when
 * the oni turned — all fit in it; a racer still walking when it runs out does not.
 */
export const LOOK_GRACE_MS = 400;
/**
 * The most the grace is lengthened for a slow line, ms: half the round trip the client last
 * reported (`Player.rttMs`) — the time its stop takes to reach the server — up to this.
 */
export const LOOK_LATENCY_MAX_MS = 300;
/** How far a racer may shift, metres, once the grace is over, before the oni counts it as moving. */
export const STILL_TOLERANCE_M = 0.6;
/** Slack on the careful step, metres: a report's jitter and a step already in the air when the chant began. */
export const STEP_SLACK_M = 1.5;
/** The longest a race runs, ms. */
export const RACE_MS = 180_000;
export const FINISHED_MS = 8_000;
/** How far off the lane — to either side — a racer may wander before they have left the race, metres. */
export const OFF_COURSE_M = 3;
/** How far back behind the start line, metres. The last row of start places is 3.4 m back. */
const BEHIND_START_M = 6;
/** How far past the lane's edge a racer may cross the goal line and still be over it, metres. */
const FINISH_SLACK_M = 1;
/** First home only earns the badge when there was somebody to beat. */
const MIN_FIELD_FOR_BADGE = 2;

export class DarumaRunner {
  private phase: DarumaView['phase'] = 'lobby';
  private startedAt: number;
  private endsAt: number;
  private raceStartedAt = 0;
  private raceEndsAt = 0;
  /** Everyone who set off, in order: a racer's index here is their start place. */
  private readonly field: PlayerId[] = [];
  private readonly racing = new Set<PlayerId>();
  private readonly places: Array<{ id: PlayerId; name: string; ms: number }> = [];
  /** Sent back in this phase. */
  private caught: PlayerId[] = [];
  /** Where each racer stood when the oni last turned its back (or they were put back), and when. */
  private readonly setOff = new Map<PlayerId, { x: number; z: number; at: number }>();
  /** Where each racer stood when this look's grace ran out: where they must stay. */
  private readonly still = new Map<PlayerId, { x: number; z: number }>();
  private done = false;

  constructor(
    private readonly room: GameRoom,
    readonly activity: ActivityId,
    now: number,
  ) {
    this.startedAt = now;
    this.endsAt = now + LOBBY_MS;
    this.publish();
  }

  /** True once the finished card has been shown; the room then ends the activity. */
  get finished(): boolean {
    return this.done;
  }

  /** Judge, and advance if the current phase is over. Called every room tick. */
  tick(now: number): void {
    if (this.done) return;
    if (this.phase === 'walk' || this.phase === 'look') {
      this.judge(now);
      if (this.racing.size === 0 || this.places.length >= DARUMA_PLACES || now >= this.raceEndsAt) {
        this.finish(now);
        return;
      }
    }
    if (now < this.endsAt) return;
    switch (this.phase) {
      case 'lobby':
        this.begin(now);
        return;
      case 'walk':
        this.turn();
        return;
      case 'look':
        this.chant(now);
        return;
      case 'finished':
        this.done = true;
        this.room.setDaruma(null);
        return;
    }
  }

  /** A player left the room: if they were racing, they are out of it. */
  onLeave(id: PlayerId): void {
    if (this.drop(id)) this.publish();
  }

  /**
   * A racer came back from a dropped connection. Their client went on walking while it was
   * cut off, and the server held them where they were: put the client back there (fenced, so
   * its first reports from further on are answered, not judged).
   */
  onResume(p: Player): void {
    if (this.racing.has(p.id)) this.room.relocate(p, [p.pos[0], p.pos[1], p.pos[2]], p.yaw);
  }

  /** Stop without ceremony (the activity was ended or cancelled under us). */
  abort(): void {
    if (this.done) return;
    this.done = true;
    this.room.setDaruma(null);
  }

  view(): DarumaView {
    const v: DarumaView = {
      activity: this.activity,
      phase: this.phase,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      racing: [...this.racing],
      places: this.places.map(({ id, name }) => ({ id, name })),
    };
    if (this.field.length > 0) v.raceEndsAt = this.raceEndsAt;
    if (this.caught.length > 0) v.caught = [...this.caught];
    return v;
  }

  // -----------------------------------------------------------------------------------------

  /** The lobby closes: the participants go to the start line, and the oni turns its back. */
  private begin(now: number): void {
    for (const p of this.room.allPlayers()) {
      if (!p.away && p.activity === this.activity && p.mode === 'participant') this.field.push(p.id);
    }
    const end = this.room.activities.get(this.activity)?.endsAt ?? Infinity;
    if (this.field.length === 0) {
      // Nobody yet. Wait for someone while a whole race still fits; after that there is not
      // time for one, and the game is over.
      if (now + LOBBY_MS + RACE_MS + FINISHED_MS <= end) {
        this.startedAt = now;
        this.endsAt = now + LOBBY_MS;
        this.publish();
      } else {
        this.finish(now);
      }
      return;
    }
    this.raceStartedAt = now;
    // The finished card has to be read before the clock ends the activity under it.
    this.raceEndsAt = Math.min(now + RACE_MS, end - FINISHED_MS);
    for (const id of this.field) {
      const p = this.room.getPlayer(id);
      if (!p) continue;
      this.racing.add(id);
      this.sendBack(p, now);
    }
    this.chant(now);
  }

  /** The oni turns its back and chants. Every racer's careful step is measured from here. */
  private chant(now: number): void {
    this.phase = 'walk';
    this.startedAt = now;
    this.endsAt = now + WALK_MIN_MS + Math.floor(this.room.random() * (WALK_MAX_MS - WALK_MIN_MS));
    this.caught = [];
    this.still.clear();
    for (const id of this.racing) {
      const p = this.room.getPlayer(id);
      if (p) this.setOff.set(id, { x: p.pos[0], z: p.pos[2], at: now });
    }
    this.publish();
  }

  /**
   * The oni turns round. The look starts when the chant was due to end — the moment every
   * client showed the turn, on the server's clock — not whenever this tick got round to it,
   * so the grace is the same for everyone.
   */
  private turn(): void {
    const at = this.endsAt;
    this.phase = 'look';
    this.startedAt = at;
    this.endsAt = at + LOOK_MIN_MS + Math.floor(this.room.random() * (LOOK_MAX_MS - LOOK_MIN_MS));
    this.caught = [];
    this.still.clear();
    this.publish();
  }

  /** Every racer, where they stand now: dropped out, caught, home, or still going. */
  private judge(now: number): void {
    const course = DARUMA_COURSE;
    if (!course) return;
    const length = darumaCourseLength();
    const look = this.phase === 'look' && now < this.endsAt;
    let changed = false;
    /** Over the line this tick, and how far over: when several are, the furthest is first. */
    const home: Array<{ p: Player; along: number }> = [];
    for (const id of [...this.racing]) {
      const p = this.room.getPlayer(id);
      // Gone (normally `onLeave` has said so already), gone over to watching, or left the
      // activity altogether: out of the race.
      if (!p || p.activity !== this.activity || p.mode !== 'participant') {
        changed = this.drop(id) || changed;
        continue;
      }
      const [x, , z] = p.pos;
      const at = darumaCourseAt(x, z);
      if (!at) continue;
      // Wandered well off the lane: off to do something else, and not to be held to the step
      // there. (Nor can it be a way round: the step holds wherever a racer walks.)
      if (Math.abs(at.across) > course.halfWidth + OFF_COURSE_M || at.along < -BEHIND_START_M) {
        changed = this.drop(id) || changed;
        continue;
      }
      const from = this.setOff.get(id);
      if (from && Math.hypot(x - from.x, z - from.z) > DARUMA_STEP_SPEED * ((now - from.at) / 1000) + STEP_SLACK_M) {
        this.catch(p, now);
        changed = true;
        continue;
      }
      if (look && now >= this.startedAt + LOOK_GRACE_MS + Math.min(LOOK_LATENCY_MAX_MS, p.rttMs / 2)) {
        const base = this.still.get(id);
        if (!base) {
          this.still.set(id, { x, z });
        } else if (Math.hypot(x - base.x, z - base.z) > STILL_TOLERANCE_M) {
          this.catch(p, now);
          changed = true;
          continue;
        }
      }
      if (at.along >= length && Math.abs(at.across) <= course.halfWidth + FINISH_SLACK_M) home.push({ p, along: at.along });
    }
    // Never more places than there are: a crowd over the line together is placed by how far
    // over each got, and whoever did not make the last place is still racing (and home next tick).
    home.sort((a, b) => b.along - a.along);
    for (const { p } of home.slice(0, DARUMA_PLACES - this.places.length)) {
      this.place(p, now);
      changed = true;
    }
    if (changed) this.publish();
  }

  /** Seen moving: back to the start. */
  private catch(p: Player, now: number): void {
    if (!this.caught.includes(p.id)) this.caught.push(p.id);
    this.sendBack(p, now);
  }

  /** Put a racer on their start place, and measure their step — and their stillness — from there. */
  private sendBack(p: Player, now: number): void {
    const spot = darumaStartSpot(Math.max(0, this.field.indexOf(p.id)));
    if (!spot) return;
    this.room.relocate(p, [spot.x, heightAt(spot.x, spot.z), spot.z], spot.yaw);
    this.setOff.set(p.id, { x: spot.x, z: spot.z, at: now });
    if (this.still.has(p.id)) this.still.set(p.id, { x: spot.x, z: spot.z });
  }

  /** Over the line. */
  private place(p: Player, now: number): void {
    // Somebody to beat: another racer still in it as the winner gets home, not just at the start.
    const rivalled = this.racing.size >= MIN_FIELD_FOR_BADGE;
    this.drop(p.id);
    this.places.push({ id: p.id, name: p.name, ms: now - this.raceStartedAt });
    const activity = this.room.activities.get(this.activity);
    if (activity) {
      // The board's unit is seconds from the start of the race, to a tenth.
      activity.board = this.places.map((s) => ({ id: s.id, name: s.name, score: Math.round(s.ms / 100) / 10 }));
      this.room.activities.notifyChanged(activity);
    }
    if (this.places.length === 1 && rivalled && awardBadge(p.profile, 'daruma')) {
      this.room.celebrate(p, ['daruma']);
      this.room.persist();
    }
  }

  /** Out of the race, for whatever reason. True if they were in it. */
  private drop(id: PlayerId): boolean {
    this.setOff.delete(id);
    this.still.delete(id);
    return this.racing.delete(id);
  }

  private finish(now: number): void {
    this.phase = 'finished';
    this.startedAt = now;
    this.endsAt = now + FINISHED_MS;
    this.caught = [];
    this.publish();
    if (this.places.length === 0) return;
    // Names and medals read the same in every language.
    const medals = ['🏆', '🥈', '🥉'];
    const line = this.places.map((s, i) => `${medals[i]} ${s.name}`).join('  ·  ');
    this.room.announceSystem(`🏁 ${line}`, { kind: 'zone', zone: DARUMA_COURSE?.zone ?? 'beach' });
  }

  private publish(): void {
    this.room.setDaruma(this.view());
  }
}
