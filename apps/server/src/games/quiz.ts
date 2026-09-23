/**
 * The ○× quiz.
 * ============
 *
 * A statement goes up; contestants run to the ○ circle if it is true and the × circle if it
 * is false; when the countdown ends the server looks at where everybody is standing. Wrong
 * (or in neither circle) is out. Last one standing wins.
 *
 * ```
 * lobby 20 s ─► question 15 s ─► reveal 6 s ─┬─► question …   (while ≥ 2 in and rounds left)
 *                                            └─► finished 8 s ─► gone, activity ended
 * ```
 *
 * Answers are read from each contestant's **last validated position** — the same one the
 * movement validator accepted — so an answer is exactly as trustworthy as the movement that
 * carried the player there. The phases are driven by the room's tick against wall-clock
 * `endsAt`, which the clients count down to on the server's clock.
 *
 * Two rules keep it fun rather than punishing:
 * - if *everyone* still in answers wrongly, nobody goes out that round;
 * - after {@link ROUNDS} statements, everyone still in wins.
 */

import {
  QUIZ_ARENA,
  QUIZ_BANK,
  quizSide,
  zoneAt,
  type ActivityId,
  type PlayerId,
  type QuizView,
} from '@nagisa/shared';
import { awardBadge } from './profiles.js';
import type { GameRoom } from './context.js';

export const LOBBY_MS = 20_000;
export const QUESTION_MS = 15_000;
export const REVEAL_MS = 6_000;
export const FINISHED_MS = 8_000;
export const ROUNDS = 8;
/** A win only earns the badge when there was somebody to beat. */
const MIN_FIELD_FOR_BADGE = 2;

export class QuizRunner {
  private phase: QuizView['phase'] = 'lobby';
  private round = 0;
  private endsAt: number;
  private questionId: string | null = null;
  private answer: boolean | null = null;
  private readonly asked = new Set<string>();
  /** Everyone who started. */
  private readonly field = new Set<PlayerId>();
  private alive = new Set<PlayerId>();
  private fell: PlayerId[] = [];
  /** The last judged round had nobody right, so nobody went out. */
  private replay = false;
  private winners: PlayerId[] = [];
  private done = false;

  constructor(
    private readonly room: GameRoom,
    readonly activity: ActivityId,
    now: number,
  ) {
    this.endsAt = now + LOBBY_MS;
    this.publish();
  }

  /** True once the finished card has been shown; the room then ends the activity. */
  get finished(): boolean {
    return this.done;
  }

  /** Advance if the current phase is over. Called every room tick. */
  tick(now: number): void {
    if (this.done || now < this.endsAt) return;
    switch (this.phase) {
      case 'lobby':
        this.gatherField();
        if (this.alive.size === 0) {
          this.finish(now);
          return;
        }
        this.ask(now);
        return;
      case 'question':
        this.judge(now);
        return;
      case 'reveal':
        if (this.alive.size <= 1 || this.round >= ROUNDS || !this.hasQuestionsLeft()) this.finish(now);
        else this.ask(now);
        return;
      case 'finished':
        this.done = true;
        this.room.setQuiz(null);
        return;
    }
  }

  /** A contestant left the room: they are out. */
  onLeave(id: PlayerId): void {
    if (this.alive.delete(id)) this.publish();
  }

  /** Stop without ceremony (the activity was ended or cancelled under us). */
  abort(): void {
    if (this.done) return;
    this.done = true;
    this.room.setQuiz(null);
  }

  view(): QuizView {
    const v: QuizView = {
      activity: this.activity,
      phase: this.phase,
      round: this.round,
      totalRounds: ROUNDS,
      questionId: this.questionId,
      endsAt: this.endsAt,
      alive: [...this.alive],
    };
    if (this.phase === 'reveal' || this.phase === 'finished') v.answer = this.answer ?? undefined;
    if (this.phase === 'reveal') {
      v.fell = [...this.fell];
      if (this.replay) v.replay = true;
    }
    if (this.phase === 'finished') v.winners = [...this.winners];
    return v;
  }

  // -----------------------------------------------------------------------------------------

  /**
   * The field: everyone connected who is standing in the arena's zone, or who joined the
   * quiz as a participant wherever they are (they are warned by their own HUD).
   */
  private gatherField(): void {
    const zone = QUIZ_ARENA?.zone;
    for (const p of this.room.allPlayers()) {
      if (p.away) continue;
      const here = zone !== undefined && zoneAt(p.pos[0], p.pos[2]) === zone;
      const attending = p.activity === this.activity && p.mode === 'participant';
      if (here || attending) {
        this.field.add(p.id);
        this.alive.add(p.id);
      }
    }
  }

  private hasQuestionsLeft(): boolean {
    return this.asked.size < QUIZ_BANK.length;
  }

  private ask(now: number): void {
    const pool = QUIZ_BANK.filter((q) => !this.asked.has(q.id));
    const q = pool[Math.min(pool.length - 1, Math.floor(this.room.random() * pool.length))];
    this.asked.add(q.id);
    this.round++;
    this.phase = 'question';
    this.questionId = q.id;
    this.answer = q.answer;
    this.fell = [];
    this.endsAt = now + QUESTION_MS;
    this.publish();
  }

  private judge(now: number): void {
    const want = this.answer ? 'o' : 'x';
    // Whoever is not here to answer — dropped, or gone — is out whatever else happens.
    const present = new Set<PlayerId>();
    const right = new Set<PlayerId>();
    for (const id of this.alive) {
      const p = this.room.getPlayer(id);
      if (!p || p.away) continue;
      present.add(id);
      if (quizSide(p.pos[0], p.pos[2]) === want) right.add(id);
    }
    // Everyone here was wrong: none of them goes out. A quiz that ends with no winner because
    // one statement was hard is no fun for anyone.
    this.replay = right.size === 0 && present.size > 0;
    const survivors = this.replay ? present : right;
    this.fell = [...this.alive].filter((id) => !survivors.has(id));
    this.alive = survivors;
    this.phase = 'reveal';
    this.endsAt = now + REVEAL_MS;
    this.publish();
  }

  private finish(now: number): void {
    this.phase = 'finished';
    this.winners = [...this.alive];
    this.endsAt = now + FINISHED_MS;
    this.publish();

    if (this.winners.length === 0) return;
    const earnsBadge = this.field.size >= MIN_FIELD_FOR_BADGE;
    for (const id of this.winners) {
      const p = this.room.getPlayer(id);
      if (!p) continue;
      p.profile.quizWins++;
      if (earnsBadge && awardBadge(p.profile, 'quiz-champ')) this.room.celebrate(p, ['quiz-champ']);
      else this.room.pushProfile(p);
    }
    const names = this.winners.map((id) => this.room.getPlayer(id)?.name).filter(Boolean);
    this.room.announceSystem(`👑 ○×  ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` +${names.length - 6}` : ''}`, {
      kind: 'zone',
      zone: QUIZ_ARENA?.zone ?? 'plaza',
    });
    this.room.persist();
  }

  private publish(): void {
    this.room.setQuiz(this.view());
  }
}
