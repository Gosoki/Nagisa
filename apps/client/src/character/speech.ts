/**
 * Speech bubbles.
 * ===============
 *
 * What someone just said, floating over their head for a few seconds.
 *
 * The chat log and the bubble are two views of the same message and both are necessary.
 * The log is the record — it survives, you can scroll it, it works when the speaker is
 * across the island. The bubble is the *attribution*: it puts the words on the body, so a
 * plaza with six people talking reads as six conversations rather than as one scrolling
 * column you have to match to names by hand. Chat rooms that ship only the log feel like
 * a text client with a 3D screensaver behind it.
 *
 * This class is only the bookkeeping — who said what, and until when. Drawing belongs to
 * {@link NameTags}, which already pools sprites and ranks them by distance, and which is
 * where the bubble has to live anyway so that it sits directly above its name tag.
 *
 * ### Duration
 *
 * Long enough to read at a glance, short enough that a busy plaza clears. Scaled by
 * length, because "hi" and a full sentence do not take the same time to read, and floored
 * so a one-word reply does not vanish before you look up.
 */

/** Seconds a bubble stays up, before the per-character extension. */
const BASE_SECONDS = 3.2;

/** Extra seconds per character. ~15 chars/second is a comfortable glance-read. */
const SECONDS_PER_CHAR = 1 / 15;

/** Never longer than this, however much someone types. */
const MAX_SECONDS = 9;

/**
 * Longest bubble text. Past this it is truncated with an ellipsis — the full line is in
 * the log, and a paragraph over someone's head is a wall, not a bubble.
 */
const MAX_BUBBLE_CHARS = 64;

interface Utterance {
  text: string;
  /** Epoch ms after which this bubble is gone. */
  until: number;
}

export class Speech {
  private readonly live = new Map<string, Utterance>();

  /** Record what a player said. Replaces any bubble they already had. */
  say(playerId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const shown =
      trimmed.length > MAX_BUBBLE_CHARS ? `${trimmed.slice(0, MAX_BUBBLE_CHARS - 1)}…` : trimmed;
    const seconds = Math.min(MAX_SECONDS, BASE_SECONDS + shown.length * SECONDS_PER_CHAR);
    this.live.set(playerId, { text: shown, until: Date.now() + seconds * 1000 });
  }

  /** Drop a player's bubble immediately — used when they leave the room. */
  clear(playerId: string): void {
    this.live.delete(playerId);
  }

  /**
   * What a player is currently saying, or null.
   *
   * Expiry is checked on read rather than on a timer: there is no work to do when nobody
   * is looking, and the read happens once per player per frame anyway.
   */
  textFor(playerId: string, now = Date.now()): string | null {
    const utterance = this.live.get(playerId);
    if (!utterance) return null;
    if (now >= utterance.until) {
      this.live.delete(playerId);
      return null;
    }
    return utterance.text;
  }

  /** True while anyone at all has a bubble up. */
  get active(): boolean {
    return this.live.size > 0;
  }
}
