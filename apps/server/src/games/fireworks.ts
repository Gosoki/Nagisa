/**
 * Fireworks.
 * ==========
 *
 * Anyone standing on a firework shore (`MapWorld.fireworks.zones`) may send one up; while a
 * fireworks activity is live the island sends up its own show as well. Every firework is one
 * `firework` world event carrying where it goes up, how high it bursts, its colour and its
 * shape — the clients draw it and time the boom by their own distance from it.
 *
 * The server picks the launch site (the nearest of the map's offshore sites, jittered) so a
 * client can never put a firework somewhere odd, and two limits keep the sky from turning
 * into a strobe: one per player every {@link PLAYER_COOLDOWN_MS}, and at most
 * {@link ROOM_BURST} per {@link ROOM_WINDOW_MS} in the whole room.
 */

import { ActivityState, FIREWORKS, type PlayerId } from '@nagisa/shared';
import type { Player } from '../player.js';
import type { GameRoom } from './context.js';

export const PLAYER_COOLDOWN_MS = 6_000;
export const ROOM_BURST = 8;
export const ROOM_WINDOW_MS = 10_000;
/** How far a launch strays from its site, metres. */
const JITTER_M = 7;
const MIN_HEIGHT = 28;
const MAX_HEIGHT = 42;
export const PATTERNS = 4;
/** The show's rhythm while a fireworks activity is live, ms between launches. */
const SHOW_MIN_GAP_MS = 1_200;
const SHOW_MAX_GAP_MS = 3_000;

export class Fireworks {
  private readonly lastByPlayer = new Map<PlayerId, number>();
  private recent: number[] = [];
  private nextShowAt = 0;

  constructor(private readonly room: GameRoom) {}

  /** A player asks to send one up. */
  launch(player: Player, now: number, hue?: unknown, pattern?: unknown): void {
    const shores = FIREWORKS;
    if (!shores || !player.zone || !shores.zones.includes(player.zone)) {
      this.room.refuse(player.id, 'not_here');
      return;
    }
    const last = this.lastByPlayer.get(player.id) ?? -Infinity;
    if (now - last < PLAYER_COOLDOWN_MS) {
      this.room.refuse(player.id, 'cooldown', { seconds: Math.ceil((PLAYER_COOLDOWN_MS - (now - last)) / 1000) });
      return;
    }
    this.prune(now);
    if (this.recent.length >= ROOM_BURST) {
      const wait = ROOM_WINDOW_MS - (now - this.recent[0]);
      this.room.refuse(player.id, 'cooldown', { seconds: Math.max(1, Math.ceil(wait / 1000)) });
      return;
    }
    this.lastByPlayer.set(player.id, now);
    this.send(now, player.pos[0], player.pos[2], player.id, hue, pattern);
    this.room.daily(player, 'firework');
  }

  /** The show, while a fireworks activity is live. Called every room tick. */
  tick(now: number): void {
    const live = this.room.activities.list().some((a) => a.feature === 'fireworks' && a.state === ActivityState.Live);
    if (!live || !FIREWORKS || FIREWORKS.sites.length === 0) return;
    if (now < this.nextShowAt) return;
    this.nextShowAt = now + SHOW_MIN_GAP_MS + this.room.random() * (SHOW_MAX_GAP_MS - SHOW_MIN_GAP_MS);
    const [sx, sz] = FIREWORKS.sites[Math.floor(this.room.random() * FIREWORKS.sites.length) % FIREWORKS.sites.length];
    this.send(now, sx, sz, null);
  }

  /** Forget a player's cooldown when they go. */
  onLeave(id: PlayerId): void {
    this.lastByPlayer.delete(id);
  }

  private prune(now: number): void {
    this.recent = this.recent.filter((t) => now - t < ROOM_WINDOW_MS);
  }

  /** Put one up from the site nearest (x, z). */
  private send(now: number, x: number, z: number, by: PlayerId | null, hue?: unknown, pattern?: unknown): void {
    const sites = FIREWORKS?.sites ?? [];
    if (sites.length === 0) return;
    let best = sites[0];
    let bestD = Infinity;
    for (const s of sites) {
      const d = Math.hypot(s[0] - x, s[1] - z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    const r = this.room.random.bind(this.room);
    const angle = r() * Math.PI * 2;
    const dist = r() * JITTER_M;
    // The show does not spend the players' budget; only people's own launches count toward it.
    if (by) this.recent.push(now);
    this.room.emitEvent({
      k: 'firework',
      x: Math.round((best[0] + Math.cos(angle) * dist) * 10) / 10,
      z: Math.round((best[1] + Math.sin(angle) * dist) * 10) / 10,
      h: Math.round(MIN_HEIGHT + r() * (MAX_HEIGHT - MIN_HEIGHT)),
      hue: typeof hue === 'number' && Number.isFinite(hue) ? Math.min(1, Math.max(0, hue)) : Math.round(r() * 100) / 100,
      pattern:
        typeof pattern === 'number' && Number.isInteger(pattern) && pattern >= 0 && pattern < PATTERNS
          ? pattern
          : Math.floor(r() * PATTERNS) % PATTERNS,
      at: now,
      by,
    });
  }
}
