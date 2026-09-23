/**
 * Game effects — the world answering.
 * ===================================
 *
 * Everything the games put *in the world*, as opposed to on the interface: a bell swinging
 * and its note carrying across the water, fireworks over the bay, a float bobbing off the
 * pier and a fish leaping out of the splash, the ○× circles painted on the plaza, paper
 * lanterns carried up the shrine path, the concert's music on the beach, the lighthouse
 * lamp coming round, an emote glyph rising over a head.
 *
 * The app owns one {@link GameFx}. It feeds it the world events the server broadcasts and
 * calls `update` once a frame; the effects read the rest (the quiz, activities, your own
 * line) straight from the stores, the same way the interface does.
 *
 * The contract with the app is {@link FxHost}: what the effects may ask of the world
 * without importing the app.
 */

import * as THREE from 'three';
import type { Emote, PlayerId, WorldEvent } from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';
import type { Character } from '../character/character.js';

/** What the effects layer may ask of the rest of the client. */
export interface FxHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly quality: QualitySettings;
  /** Feet position of a player — remote or yourself — or null if unknown or out of range. */
  playerPosition(id: PlayerId): THREE.Vector3 | null;
  /** The character rig of a player (yourself included), for props held in the hand. */
  characterOf(id: PlayerId): Character | null;
  /** Your own player id, once the handshake is done. */
  selfId(): PlayerId | null;
  /** Server epoch ms, best estimate. */
  serverNow(): number;
  /**
   * Where one-shot sounds go: the ambience's context and master bus, so mute and volume
   * apply. Null while audio is still locked (before the first gesture) or unavailable.
   */
  sfx(): { ctx: AudioContext; out: AudioNode } | null;
}

export class GameFx {
  /** Everything the effects draw hangs off this group, added to the scene by the app. */
  readonly group = new THREE.Group();

  constructor(private readonly host: FxHost) {
    this.group.name = 'game-fx';
    void this.host;
  }

  /** A world event arrived (bell, firework, catch, …). */
  onEvent(_event: WorldEvent): void {
    /* implemented by the effects layer */
  }

  /** Someone emoted (you included); float the glyph over their head. */
  onEmote(_id: PlayerId, _emote: Emote): void {
    /* implemented by the effects layer */
  }

  /** Once a frame, after the characters have moved. `elapsed` is seconds since boot. */
  update(_dt: number, _elapsed: number): void {
    /* implemented by the effects layer */
  }

  dispose(): void {
    this.group.clear();
  }
}
