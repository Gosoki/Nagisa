/**
 * What a game may ask of the room it runs in.
 * ============================================
 *
 * The games (`fishing.ts`, `janken.ts`, `quiz.ts`, …) are written against this narrow
 * interface rather than against `Room` itself: it keeps each one testable with a small fake,
 * keeps the import graph acyclic, and makes it obvious from one screen of code everything a
 * game is able to do to the world.
 */

import type {
  AnnouncementView,
  BadgeId,
  DailyKind,
  ErrorCode,
  PlayerId,
  QuizView,
  RoomId,
  ServerMessage,
  WorldEvent,
} from '@nagisa/shared';
import type { ActivityManager } from '../activity.js';
import type { Player } from '../player.js';

export interface GameRoom {
  readonly id: RoomId;
  readonly activities: ActivityManager;

  /** A player in this room, connected or in their grace window. */
  getPlayer(id: PlayerId): Player | undefined;
  /** Everyone in the room. */
  allPlayers(): Iterable<Player>;

  /** Send one player a message on their socket, if they have one right now. */
  sendTo(id: PlayerId, msg: ServerMessage): void;
  /**
   * Refuse a request in the player's own language: an `error` frame carrying `key` (and
   * `params`), which the client looks up as `error.<key>`.
   */
  refuse(id: PlayerId, key: string, params?: Record<string, string | number>, code?: ErrorCode): void;

  /** Broadcast a one-shot world event in the next tick's delta. */
  emitEvent(event: WorldEvent): void;
  /** Queue a non-transform player field change for the next delta (e.g. a new title). */
  markPlayerChanged(id: PlayerId, patch: Record<string, unknown>): void;

  /** Send a player their profile again, after it changed. */
  pushProfile(player: Player): void;
  /** Give badges already added to the player's profile their moment: a `badge` event each, and a profile push. */
  celebrate(player: Player, badges: readonly BadgeId[]): void;

  /** The quiz view changed (null = over). */
  setQuiz(view: QuizView | null): void;
  /** An announcement from the island itself rather than a person. */
  announceSystem(text: string, scope: AnnouncementView['scope'], priority?: AnnouncementView['priority']): void;

  /** Count something a player just did towards today's tasks (see `games/daily.ts`). */
  daily(player: Player, kind: DailyKind, zone?: string): void;

  /** Ask for a save soon. */
  persist(): void;

  /** Randomness, injectable so tests can pin it. */
  random(): number;
}
