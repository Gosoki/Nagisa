/**
 * The small things you do at a place: ring a bell, draw a fortune, stamp your card, roll a die.
 * =============================================================================================
 *
 * Each is one request, one answer and (mostly) one world event. They share nothing but their
 * size, and live together so that `handlers.ts` has one place to hand an interactable's effect
 * to.
 */

import {
  STAMP_ZONES,
  drawOmikuji,
  jstDay,
  type Interactable,
  type PlayerId,
} from '@nagisa/shared';
import type { Player } from '../player.js';
import { awardBadge, stampCardComplete } from './profiles.js';
import type { GameRoom } from './context.js';

/** A bell rests this long between rings. Room-wide: it is one bell, however many hands. */
export const BELL_REST_MS = 3_000;
/** One die per player this often. */
export const DICE_COOLDOWN_MS = 2_000;
export const DICE_DEFAULT_SIDES = 100;
export const DICE_MAX_SIDES = 1000;

export class Interactions {
  private readonly bellRungAt = new Map<string, number>();
  private readonly lastRoll = new Map<PlayerId, number>();

  constructor(private readonly room: GameRoom) {}

  /** Ring a bell. Everyone in the room hears about it; clients decide who is in earshot. */
  ringBell(player: Player, bell: Interactable, now: number): void {
    const last = this.bellRungAt.get(bell.id) ?? -Infinity;
    if (now - last < BELL_REST_MS) {
      this.room.refuse(player.id, 'cooldown', { seconds: Math.ceil((BELL_REST_MS - (now - last)) / 1000) });
      return;
    }
    this.bellRungAt.set(bell.id, now);
    this.room.emitEvent({ k: 'bell', id: bell.id, by: player.id });
    this.room.daily(player, 'bell');
  }

  /**
   * Draw the day's fortune. The day is Japan's calendar day; a second draw the same day gets
   * the same slip back (marked `again`) and does not announce itself twice.
   */
  drawOmikuji(player: Player, now: number): void {
    const rec = player.profile;
    const day = jstDay(now);
    if (rec.omikuji && rec.omikuji.day === day) {
      const { fortune, item, direction } = rec.omikuji;
      this.room.sendTo(player.id, { t: 'omikuji', fortune, item, direction, again: true });
      return;
    }
    const slip = drawOmikuji(() => this.room.random());
    rec.omikuji = { day, ...slip };
    this.room.sendTo(player.id, { t: 'omikuji', ...slip, again: false });
    this.room.emitEvent({ k: 'omikuji', by: player.id, fortune: slip.fortune });
    this.room.daily(player, 'omikuji');
    // Index 0 is 大吉.
    if (slip.fortune === 0 && awardBadge(rec, 'lucky')) this.room.celebrate(player, ['lucky']);
    else this.room.pushProfile(player);
    this.room.persist();
  }

  /** Stamp this place on the player's card. */
  stamp(player: Player, stand: Interactable): void {
    const rec = player.profile;
    if (!STAMP_ZONES.includes(stand.zone)) {
      this.room.refuse(player.id, 'not_found');
      return;
    }
    if (rec.stamps.includes(stand.zone)) {
      this.room.refuse(player.id, 'already_stamped');
      return;
    }
    rec.stamps.push(stand.zone);
    const complete = stampCardComplete(rec);
    this.room.emitEvent({ k: 'stamp', by: player.id, zone: stand.zone, complete });
    if (complete && awardBadge(rec, 'walker')) this.room.celebrate(player, ['walker']);
    else this.room.pushProfile(player);
    this.room.persist();
  }

  /** Roll a die for everyone to see. */
  roll(player: Player, sides: unknown, now: number): void {
    const last = this.lastRoll.get(player.id) ?? -Infinity;
    if (now - last < DICE_COOLDOWN_MS) {
      this.room.refuse(player.id, 'cooldown', { seconds: Math.ceil((DICE_COOLDOWN_MS - (now - last)) / 1000) });
      return;
    }
    const n =
      sides === undefined || sides === null
        ? DICE_DEFAULT_SIDES
        : typeof sides === 'number' && Number.isInteger(sides) && sides >= 2 && sides <= DICE_MAX_SIDES
          ? sides
          : null;
    if (n === null) {
      this.room.refuse(player.id, 'invalid');
      return;
    }
    this.lastRoll.set(player.id, now);
    const value = 1 + Math.min(n - 1, Math.floor(this.room.random() * n));
    this.room.emitEvent({ k: 'dice', by: player.id, value, sides: n });
  }

  onLeave(id: PlayerId): void {
    this.lastRoll.delete(id);
  }
}
