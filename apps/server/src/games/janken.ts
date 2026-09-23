/**
 * Janken — rock, paper, scissors between two people standing near each other.
 * ============================================================================
 *
 * ```
 * challenge ─► invited (15 s to answer) ─accept─► playing (8 s to throw) ─► result
 *                  └─decline / silence─► cancelled          │ tie ─► 2 s ─► playing again
 * ```
 *
 * Both hands are held by the server until both are in (or the clock runs out), so neither
 * side can wait to see the other's throw. A missing throw at the deadline forfeits; two
 * missing throws cancel. Ties replay up to {@link MAX_TIES} times, then the duel is a draw.
 *
 * A player is in at most one duel at a time. Leaving, dropping or walking off (more than
 * {@link WALK_OFF_M}) cancels it for both, with a reason each can be told.
 */

import { HANDS, type Hand, type PlayerId, type ServerJanken } from '@nagisa/shared';
import { randomUUID } from 'node:crypto';
import type { Player } from '../player.js';
import { awardJankenBadge } from './profiles.js';
import type { GameRoom } from './context.js';

/** How close two people must be to start a duel. Conversational range, give or take. */
export const CHALLENGE_RANGE_M = 12;
/** How far apart they may drift during one before it is off. */
const WALK_OFF_M = 25;
const ANSWER_MS = 15_000;
const THROW_MS = 8_000;
/** Pause after a tied round so both can see the hands before the next one starts. */
const TIE_PAUSE_MS = 2_000;
export const MAX_TIES = 3;

type Phase = 'invited' | 'playing' | 'pause';

interface Duel {
  id: string;
  a: PlayerId; // challenger
  b: PlayerId; // challenged
  phase: Phase;
  deadline: number;
  round: number;
  ties: number;
  ha: Hand | null;
  hb: Hand | null;
}

/** Who wins a round: 'a', 'b' or null for a tie. */
export function judge(ha: Hand, hb: Hand): 'a' | 'b' | null {
  if (ha === hb) return null;
  const beats: Record<Hand, Hand> = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  return beats[ha] === hb ? 'a' : 'b';
}

export class Janken {
  private readonly duels = new Map<string, Duel>();
  private readonly byPlayer = new Map<PlayerId, string>();

  constructor(private readonly room: GameRoom) {}

  inDuel(id: PlayerId): boolean {
    return this.byPlayer.has(id);
  }

  challenge(a: Player, targetId: PlayerId, now: number): void {
    const b = this.room.getPlayer(targetId);
    if (!b || b.id === a.id) {
      this.room.refuse(a.id, 'invalid');
      return;
    }
    if (b.away) {
      this.room.refuse(a.id, 'not_found');
      return;
    }
    if (Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) > CHALLENGE_RANGE_M) {
      this.room.refuse(a.id, 'too_far');
      return;
    }
    if (this.byPlayer.has(a.id) || this.byPlayer.has(b.id)) {
      this.room.refuse(a.id, 'busy');
      return;
    }
    const duel: Duel = { id: randomUUID(), a: a.id, b: b.id, phase: 'invited', deadline: now + ANSWER_MS, round: 1, ties: 0, ha: null, hb: null };
    this.duels.set(duel.id, duel);
    this.byPlayer.set(a.id, duel.id);
    this.byPlayer.set(b.id, duel.id);
    this.tell(duel, b.id, { kind: 'invited', deadline: duel.deadline });
    this.tell(duel, a.id, { kind: 'waiting', deadline: duel.deadline });
  }

  respond(player: Player, duelId: string, accept: boolean, now: number): void {
    const duel = this.duels.get(duelId);
    if (!duel || duel.phase !== 'invited' || duel.b !== player.id) {
      this.room.refuse(player.id, 'not_found');
      return;
    }
    if (!accept) {
      this.cancel(duel, 'declined');
      return;
    }
    this.startRound(duel, now);
  }

  throwHand(player: Player, duelId: string, hand: Hand, now: number): void {
    const duel = this.duels.get(duelId);
    if (!duel || duel.phase !== 'playing' || (duel.a !== player.id && duel.b !== player.id)) {
      this.room.refuse(player.id, 'not_found');
      return;
    }
    if (!HANDS.includes(hand)) {
      this.room.refuse(player.id, 'invalid');
      return;
    }
    // First throw stands: a hand cannot be changed once it is in.
    if (duel.a === player.id && duel.ha === null) duel.ha = hand;
    if (duel.b === player.id && duel.hb === null) duel.hb = hand;
    if (duel.ha !== null && duel.hb !== null) this.resolve(duel, now);
  }

  /** Deadlines, pauses and people drifting apart. Called every room tick. */
  tick(now: number): void {
    for (const duel of [...this.duels.values()]) {
      const a = this.room.getPlayer(duel.a);
      const b = this.room.getPlayer(duel.b);
      if (!a || !b || a.away || b.away) {
        this.cancel(duel, 'left');
        continue;
      }
      if (Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) > WALK_OFF_M) {
        this.cancel(duel, 'far');
        continue;
      }
      if (now < duel.deadline) continue;
      if (duel.phase === 'invited') this.cancel(duel, 'timeout');
      else if (duel.phase === 'pause') this.startRound(duel, now);
      else this.resolve(duel, now);
    }
  }

  /** A player left the room or dropped: any duel they are in is off. */
  onLeave(id: PlayerId): void {
    const duelId = this.byPlayer.get(id);
    const duel = duelId ? this.duels.get(duelId) : undefined;
    if (duel) this.cancel(duel, 'left');
  }

  private startRound(duel: Duel, now: number): void {
    duel.phase = 'playing';
    duel.deadline = now + THROW_MS;
    duel.ha = null;
    duel.hb = null;
    for (const id of [duel.a, duel.b]) this.tell(duel, id, { kind: 'start', deadline: duel.deadline, round: duel.round });
  }

  private resolve(duel: Duel, now: number): void {
    const { ha, hb } = duel;
    if (ha === null && hb === null) {
      this.cancel(duel, 'timeout');
      return;
    }
    // A missing hand forfeits; otherwise the hands decide.
    const side = ha === null ? 'b' : hb === null ? 'a' : judge(ha, hb);
    const tie = side === null;
    const final = !tie || duel.ties >= MAX_TIES;
    const winner = side === 'a' ? duel.a : side === 'b' ? duel.b : null;

    this.tell(duel, duel.a, { kind: 'result', round: duel.round, mine: ha, theirs: hb, winner, final }, duel.b);
    this.tell(duel, duel.b, { kind: 'result', round: duel.round, mine: hb, theirs: ha, winner, final }, duel.a);

    if (!final) {
      duel.ties++;
      duel.round++;
      duel.phase = 'pause';
      duel.deadline = now + TIE_PAUSE_MS;
      return;
    }

    // Forfeits are not announced as if both had thrown: the event carries the hands only when
    // both exist, and a forfeited hand reads as the winner's alone.
    if (ha !== null && hb !== null) {
      this.room.emitEvent({ k: 'janken', a: duel.a, b: duel.b, ha, hb, winner });
      // A game played to the end counts for both, whoever won.
      for (const id of [duel.a, duel.b]) {
        const p = this.room.getPlayer(id);
        if (p) this.room.daily(p, 'janken');
      }
    }
    this.end(duel);
    if (winner) {
      const w = this.room.getPlayer(winner);
      if (w) {
        w.profile.jankenWins++;
        const badges = awardJankenBadge(w.profile);
        if (badges.length) this.room.celebrate(w, badges);
        else this.room.pushProfile(w);
        this.room.persist();
      }
    }
  }

  private cancel(duel: Duel, reason: NonNullable<ServerJanken['reason']>): void {
    this.end(duel);
    for (const id of [duel.a, duel.b]) this.tell(duel, id, { kind: 'cancelled', reason });
  }

  private end(duel: Duel): void {
    this.duels.delete(duel.id);
    if (this.byPlayer.get(duel.a) === duel.id) this.byPlayer.delete(duel.a);
    if (this.byPlayer.get(duel.b) === duel.id) this.byPlayer.delete(duel.b);
  }

  /** Send one side of the duel its view. `other` defaults to the opponent of `to`. */
  private tell(duel: Duel, to: PlayerId, body: Omit<ServerJanken, 't' | 'duel' | 'opponent' | 'opponentName'>, other?: PlayerId): void {
    const opponent = other ?? (to === duel.a ? duel.b : duel.a);
    this.room.sendTo(to, {
      t: 'janken',
      duel: duel.id,
      opponent,
      opponentName: this.room.getPlayer(opponent)?.name ?? '',
      ...body,
    });
  }
}
