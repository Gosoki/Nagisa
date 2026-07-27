/**
 * Remote players.
 * ===============
 *
 * Everyone who is not you. This module turns a 10 Hz stream of quantised transforms into
 * characters that walk smoothly at 60 fps.
 *
 * ### Interpolation, not extrapolation
 * Each remote player keeps a small buffer of timestamped snapshots and is rendered at
 * `now - INTERPOLATION_DELAY_MS`, i.e. deliberately ~200 ms in the past. That delay
 * guarantees there are always two real samples to interpolate between, so remote motion
 * is smooth and *correct* rather than smooth and guessed.
 *
 * The alternative — extrapolating forward from the last known velocity — hides latency
 * but produces the rubber-banding everyone recognises from bad multiplayer: a player
 * walks through a wall, then snaps back. In a world whose entire proposition is calm,
 * visible wrongness costs more than 200 ms of honest lag.
 *
 * ### Animation is derived, not networked
 * The wire carries an `AnimState`, but walk *speed* is recovered from the interpolated
 * motion itself. That means a remote character's legs always match the distance it is
 * actually covering — no skating, no matter how the packets arrived.
 */

import * as THREE from 'three';
import { AnimState, PROTOCOL, type PlayerId, type PlayerView, type Vec3 } from '@nagisa/shared';
import { Character } from './character.js';

/** One networked sample. */
interface Sample {
  /** Local clock time this sample is valid *for*, ms. */
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: AnimState;
}

/** Samples older than this are discarded. Two seconds is far more than we ever need. */
const BUFFER_MS = 2000;

/**
 * One remote islander: a character, its sample buffer and its name tag anchor.
 */
class RemotePlayer {
  readonly character: Character;
  readonly samples: Sample[] = [];

  /** Latest server-reported metadata. Drives the UI's presence list. */
  view: PlayerView;

  /** Smoothed world position, for name-tag projection and proximity checks. */
  readonly position = new THREE.Vector3();

  /** True while the server says this player's session is disconnected but recoverable. */
  away = false;

  constructor(view: PlayerView) {
    this.view = view;
    this.character = new Character(view.appearance);
    this.position.set(view.pos[0], view.pos[1], view.pos[2]);
    this.character.root.position.copy(this.position);
    this.character.root.rotation.y = view.yaw;
    this.character.root.name = `player:${view.id}`;
    // Seed the buffer so the first interpolation has something to work with rather than
    // sliding in from the origin.
    this.samples.push({
      time: performance.now(),
      x: view.pos[0],
      y: view.pos[1],
      z: view.pos[2],
      yaw: view.yaw,
      anim: view.anim,
    });
  }

  /** Append a transform sample. */
  push(pos: Vec3, yaw: number, anim: AnimState, arrivalTime: number): void {
    const last = this.samples[this.samples.length - 1];
    // Out-of-order or duplicate frames: keep the newest and drop the rest.
    if (last && arrivalTime <= last.time) return;
    this.samples.push({ time: arrivalTime, x: pos[0], y: pos[1], z: pos[2], yaw, anim });
    // Trim from the front. Cheap because the buffer is tiny.
    const cutoff = arrivalTime - BUFFER_MS;
    while (this.samples.length > 2 && this.samples[0].time < cutoff) this.samples.shift();
  }

  /**
   * Position the character at `renderTime`.
   *
   * Three cases, in order of how often they happen:
   * 1. `renderTime` falls between two samples → interpolate. The normal path.
   * 2. `renderTime` is past the newest sample → hold the newest position. This is a
   *    stall (packet loss, or the player genuinely stopped); holding is correct and
   *    invisible, whereas extrapolating would drift them into a wall.
   * 3. `renderTime` is before the oldest sample → we joined mid-flight; use the oldest.
   */
  interpolate(renderTime: number, dt: number): void {
    const s = this.samples;
    if (s.length === 0) return;

    let target: { x: number; y: number; z: number; yaw: number; anim: AnimState };

    if (renderTime >= s[s.length - 1].time) {
      target = s[s.length - 1];
    } else if (renderTime <= s[0].time) {
      target = s[0];
    } else {
      // Linear scan from the end: the sample we want is almost always the last pair.
      let i = s.length - 1;
      while (i > 0 && s[i - 1].time > renderTime) i--;
      const a = s[i - 1];
      const b = s[i];
      const span = b.time - a.time || 1;
      const t = (renderTime - a.time) / span;
      target = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        // Yaw needs shortest-arc interpolation or characters spin through 350° when
        // they cross the ±π seam.
        yaw: lerpAngle(a.yaw, b.yaw, t),
        anim: b.anim,
      };
    }

    // Distance covered this frame recovers the real ground speed.
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const moved = Math.hypot(dx, dz);
    const speed = dt > 0 ? moved / dt : 0;

    this.position.set(target.x, target.y, target.z);
    this.character.root.position.copy(this.position);
    this.character.root.rotation.y = target.yaw;

    // Trust the networked state for anything that is not locomotion (sitting, bowing),
    // and derive locomotion from observed speed so legs never skate.
    if (
      target.anim === AnimState.Idle ||
      target.anim === AnimState.Walk ||
      target.anim === AnimState.Run
    ) {
      this.character.setAnim(speed < 0.4 ? AnimState.Idle : speed < 4.2 ? AnimState.Walk : AnimState.Run);
    } else {
      this.character.setAnim(target.anim);
    }
  }
}

/** Shortest-arc angle interpolation. */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

/**
 * Manages every remote player in the room.
 *
 * Owns their scene objects, their interpolation and their LOD. The netcode calls the
 * mutation methods; the frame loop calls {@link update}.
 */
export class RemotePlayers {
  readonly group = new THREE.Group();
  private readonly players = new Map<PlayerId, RemotePlayer>();

  constructor(private readonly maxDetailed: number) {
    this.group.name = 'remote-players';
  }

  get count(): number {
    return this.players.size;
  }

  /** Snapshot of every remote player's metadata, for the UI's presence list. */
  views(): PlayerView[] {
    return [...this.players.values()].map((p) => p.view);
  }

  /** World position of a player, or null if they are not present. */
  positionOf(id: PlayerId): THREE.Vector3 | null {
    return this.players.get(id)?.position ?? null;
  }

  /** Add a player. Idempotent — a duplicate join is treated as a metadata update. */
  add(view: PlayerView): void {
    const existing = this.players.get(view.id);
    if (existing) {
      this.updateMeta(view);
      return;
    }
    const player = new RemotePlayer(view);
    this.players.set(view.id, player);
    this.group.add(player.character.root);
  }

  /** Remove a player and release their geometry. */
  remove(id: PlayerId): void {
    const player = this.players.get(id);
    if (!player) return;
    player.character.dispose();
    this.players.delete(id);
  }

  /** Apply a transform sample from a delta frame. */
  applyTransform(id: PlayerId, pos: Vec3, yaw: number, anim: AnimState): void {
    const player = this.players.get(id);
    if (!player) return;
    player.push(pos, yaw, anim, performance.now());
  }

  /** Apply non-transform metadata (zone, activity, role, away). */
  updateMeta(patch: Partial<PlayerView> & { id: PlayerId }): void {
    const player = this.players.get(patch.id);
    if (!player) return;
    player.view = { ...player.view, ...patch };
    if (patch.away !== undefined) {
      player.away = patch.away;
      // Disconnected-but-recoverable players fade rather than vanish: if they are back
      // in ten seconds, they should still be standing where you last saw them.
      player.character.root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mat = obj.material as THREE.Material;
          mat.transparent = patch.away === true;
          mat.opacity = patch.away ? 0.45 : 1;
        }
      });
    }
  }

  /** Play a one-shot emote animation on a player. */
  playEmote(id: PlayerId, anim: AnimState): void {
    this.players.get(id)?.character.playEmote(anim);
  }

  /** Replace the entire roster from a snapshot. */
  reset(views: PlayerView[]): void {
    const incoming = new Set(views.map((v) => v.id));
    for (const id of [...this.players.keys()]) {
      if (!incoming.has(id)) this.remove(id);
    }
    for (const v of views) this.add(v);
  }

  /** Remove everyone. Used on room switch and teardown. */
  clear(): void {
    for (const id of [...this.players.keys()]) this.remove(id);
  }

  /**
   * Advance every remote player.
   *
   * LOD is applied by *rank*, not by a fixed distance: the nearest `maxDetailed`
   * characters animate and the rest hold a static pose. That keeps the cost of a crowd
   * flat — an eighty-person plaza costs the same as a twenty-person one — which is what
   * makes "the world should feel populated" affordable on a phone.
   */
  update(dt: number, cameraPosition: THREE.Vector3): void {
    const renderTime = performance.now() - PROTOCOL.INTERPOLATION_DELAY_MS;

    // Interpolation is cheap and must happen for everyone, or distant players teleport
    // when they come back into detail range.
    const ranked: Array<{ p: RemotePlayer; d: number }> = [];
    for (const p of this.players.values()) {
      p.interpolate(renderTime, dt);
      p.character.updateLod(cameraPosition);
      ranked.push({ p, d: p.position.distanceToSquared(cameraPosition) });
    }

    if (ranked.length <= this.maxDetailed) {
      for (const { p } of ranked) p.character.update(dt);
      return;
    }

    // Partial selection: we only need the nearest N, so a full sort is wasteful, but at
    // our population ceiling (~120) a sort is a few microseconds and far more readable.
    ranked.sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.maxDetailed; i++) ranked[i].p.character.update(dt);
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
