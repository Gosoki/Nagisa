/**
 * Game effects — the world answering.
 * ===================================
 *
 * Everything the games put *in the world*, as opposed to on the interface: a bell's note
 * carrying across the water and rings spreading from its tower, fireworks over the bay, a
 * float bobbing off the pier and a fish leaping out of the splash, the ○× circles painted
 * on the plaza, paper lanterns carried up the shrine path, the concert's music on the
 * beach, the lighthouse beam coming round, an emote glyph rising over a head.
 *
 * The app owns one {@link GameFx}. It feeds it the world events the server broadcasts and
 * calls `update` once a frame; the effects read the rest (the quiz, activities, your own
 * line) straight from the stores, the same way the interface does.
 *
 * The contract with the app is {@link FxHost}: what the effects may ask of the world
 * without importing the app.
 *
 * ### Layout
 *
 * One module per thing the island does — `bells`, `fireworks`, `fishing`, `quiz-arena`,
 * `emotes`, `lanterns`, `lighthouse`, `music` — over two shared ones: `materials`, which is
 * how an effect is drawn through the ink pipeline without disturbing it, and `audio`, which
 * is how a sound is placed in it. This file only routes: stores and events in, one update
 * out, and everything given back on `dispose`.
 *
 * ### Calm is a budget
 *
 * Nothing here flashes, pulses quickly or asks for attention; every change of state is one
 * slow ease. That is the art direction, and it is also the performance plan: pools sized
 * by quality tier, motion computed in shaders, no allocation in the per-frame path.
 */

import * as THREE from 'three';
import {
  ActivityState,
  QUIZ_ARENA,
  stagePosition,
  type ActivityId,
  type ActivityView,
  type DigHeat,
  type Emote,
  type PlayerId,
  type WorldEvent,
} from '@nagisa/shared';
import type { QualitySettings } from '../engine/quality.js';
import type { Character } from '../character/character.js';
import { activities, fishing, players, quiz, self } from '../state/stores.js';
import { Bells } from './bells.js';
import { EmoteFloats } from './emotes.js';
import { Fireworks } from './fireworks.js';
import { Fishing } from './fishing.js';
import { Lanterns } from './lanterns.js';
import { LighthouseBeam } from './lighthouse.js';
import { Concert } from './music.js';
import { QuizArena } from './quiz-arena.js';
import { Rain } from './rain.js';

/** What a dig's heat looks like over the digger's head. ♨ is a hot spring: warm. */
const HEAT_GLYPH: Record<DigHeat, string> = { hot: '🔥', warm: '♨️', cool: '💧', cold: '❄️' };

/** How high over a find its gold burst goes, metres above the ground. Low: it is a small one. */
const TREASURE_BURST_HEIGHT = 7;

/** Rain heavier than this puts umbrellas up; lighter than the second takes them down. */
const UMBRELLAS_UP = 0.35;
const UMBRELLAS_DOWN = 0.2;
/** How often every figure is told whether its umbrella is up, seconds: newcomers included. */
const UMBRELLA_RECONCILE = 1;

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

  private readonly bells: Bells;
  private readonly fireworks: Fireworks;
  private readonly fishing: Fishing;
  private readonly emotes: EmoteFloats;
  private readonly lanterns: Lanterns;
  private readonly lighthouse: LighthouseBeam;
  private readonly concert: Concert;
  private readonly rain: Rain;
  /** Null on a map with no arena. */
  private readonly arena: QuizArena | null;

  private readonly unsubscribers: Array<() => void> = [];

  /** Umbrellas, in the rain: whether they are up, and when everyone was last told. */
  private rainLevel = 0;
  private umbrellas = false;
  private umbrellaTimer = 0;
  private playerIds: PlayerId[] = [];

  constructor(private readonly host: FxHost) {
    this.group.name = 'game-fx';
    this.bells = new Bells(host, this.group);
    this.fireworks = new Fireworks(host, this.group);
    this.fishing = new Fishing(host, this.group);
    this.emotes = new EmoteFloats(host, this.group);
    this.lanterns = new Lanterns(host, this.group);
    this.lighthouse = new LighthouseBeam(host);
    this.concert = new Concert(host, this.group);
    this.rain = new Rain(host, this.group);
    this.arena = QUIZ_ARENA ? new QuizArena(host, this.group) : null;

    this.unsubscribers.push(
      quiz.subscribe((view) => this.arena?.setQuiz(view)),
      fishing.subscribe((state) => this.fishing.setLocal(state)),
      activities.subscribe((list) => this.onActivities(list)),
      players.subscribe((list) => {
        this.fishing.setPlayers(list);
        this.lanterns.setPlayers(list);
        this.playerIds = list.map((p) => p.id);
      }),
      self.subscribe((state) => this.lanterns.setSelfActivity(state.activity)),
    );
  }

  /** A world event arrived (bell, firework, catch, …). */
  onEvent(event: WorldEvent): void {
    switch (event.k) {
      case 'bell':
        this.bells.ring(event.id);
        break;
      case 'firework':
        this.fireworks.launch(event);
        break;
      case 'catch':
        this.fishing.onCatch(event);
        break;
      case 'dig':
        // What the sand said, over the digger's head: a crowd reads it from across the plaza.
        this.emotes.showGlyph(event.by, HEAT_GLYPH[event.heat]);
        break;
      case 'treasure':
        // A find is a small celebration where it came up — a gold shell, seen island-wide.
        this.emotes.showGlyph(event.by, '💎');
        this.fireworks.launch({
          k: 'firework',
          x: event.pos[0],
          z: event.pos[2],
          h: event.pos[1] + TREASURE_BURST_HEIGHT,
          hue: 0.13,
          pattern: 0,
          at: this.host.serverNow(),
          by: event.by,
        });
        break;
      default:
        // Fortunes, stamps, dice, janken and badges are the interface's: lines and bubbles.
        break;
    }
  }

  /** How hard it is raining, 0–1 (`weatherLevels` in the shared package). */
  setRain(level: number): void {
    this.rain.setLevel(level);
    this.rainLevel = level;
  }

  /**
   * Umbrellas up when it rains properly, down when it has all but stopped — two thresholds,
   * so a drizzle on the edge does not flick them up and down. Everyone is told once a
   * second, which also catches whoever has just come into view.
   */
  private updateUmbrellas(dt: number): void {
    const up = this.umbrellas ? this.rainLevel > UMBRELLAS_DOWN : this.rainLevel > UMBRELLAS_UP;
    const changed = up !== this.umbrellas;
    this.umbrellas = up;
    this.umbrellaTimer -= dt;
    if (!changed && this.umbrellaTimer > 0) return;
    this.umbrellaTimer = UMBRELLA_RECONCILE;
    const self = this.host.selfId();
    if (self) this.host.characterOf(self)?.setUmbrella(up);
    for (const id of this.playerIds) this.host.characterOf(id)?.setUmbrella(up);
  }

  /** Someone emoted (you included); float the glyph over their head. */
  onEmote(id: PlayerId, emote: Emote): void {
    this.emotes.show(id, emote);
  }

  /** Once a frame, after the characters have moved. `elapsed` is seconds since boot. */
  update(dt: number, elapsed: number): void {
    this.arena?.update(dt);
    this.bells.update(dt);
    this.fireworks.update(elapsed);
    this.fishing.update(dt, elapsed);
    this.emotes.update(dt);
    this.lanterns.update(dt);
    this.lighthouse.update(dt);
    this.concert.update(dt);
    this.rain.update(elapsed);
    this.updateUmbrellas(dt);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.arena?.dispose();
    this.bells.dispose();
    this.fireworks.dispose();
    this.fishing.dispose();
    this.emotes.dispose();
    this.lanterns.dispose();
    this.lighthouse.dispose();
    this.concert.dispose();
    this.rain.dispose();
    this.group.clear();
  }

  /**
   * Which of the island's client-side features are running: an activity counts while it is
   * live. The quiz, the derby and the fireworks show need nothing here — the server runs
   * those and says what happens.
   */
  private onActivities(list: readonly ActivityView[]): void {
    const lanterns = new Set<ActivityId>();
    let lamp = false;
    let concert: ActivityView | null = null;
    for (const activity of list) {
      if (activity.state !== ActivityState.Live) continue;
      if (activity.feature === 'lanterns') lanterns.add(activity.id);
      else if (activity.feature === 'lamp') lamp = true;
      else if (activity.feature === 'concert') concert ??= activity;
    }
    this.lanterns.setLive(lanterns);
    this.lighthouse.setLive(lamp);
    this.concert.setStage(concert ? stagePosition(concert.zone) : null);
  }
}
