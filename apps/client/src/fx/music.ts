/**
 * The beach concert.
 * ==================
 *
 * While a `concert` activity is live, someone is playing on the beach stage: a musician
 * stands there, and plucked strings drift across the sand — a koto, near enough, in its
 * commonest tuning (hirajōshi), played slowly and sparsely. Short phrases that step
 * between neighbouring strings and settle on the tonic or the fifth, a long breath between
 * them, now and then a low string under the start of a phrase or a flick of a grace note.
 * Generated as it plays, so it never loops and is never the same twice.
 *
 * It is heard from where you stand: full at the stage, fading with distance, gone past
 * seventy metres, and panned to the side the stage is on. All the notes share one bus
 * whose distance, bearing and air are re-placed a few times a second — cheaper than
 * placing each note, and it follows you as you walk away, which a long-ringing note placed
 * once would not.
 *
 * The strings are Karplus–Strong (see `pluckBuffer`), rendered once per pitch.
 */

import * as THREE from 'three';
import { Character } from '../character/character.js';
import type { FxHost } from './index.js';
import { hearing, pluckBuffer } from './audio.js';

/** Hirajōshi on D: D E F A B♭, across two octaves and the D above. */
const NOTES: readonly number[] = (() => {
  const root = 146.83;
  const steps = [0, 2, 3, 7, 8];
  const out: number[] = [];
  for (let octave = 0; octave < 2; octave++) for (const s of steps) out.push(root * 2 ** ((octave * 12 + s) / 12));
  out.push(root * 4);
  return out;
})();

/** Scale degrees a phrase may come to rest on: the Ds and the A. */
const RESTS = [5, 8, 10];

/** How a phrase moves: mostly to a neighbouring string, sometimes one further. */
const STEPS = [-2, -1, -1, 1, 1, 2];

/** Note lengths inside a phrase, in beats. */
const LENGTHS = [1, 1, 1, 1.5, 0.5, 2];

/** Seconds per beat. Slow: this is music to sit on the sand to. */
const BEAT = 0.82;

/** Silent beyond this, metres. */
const EARSHOT = 70;

/** Overall level of the music bus at the stage. */
const LEVEL = 0.8;

/** How far ahead notes are scheduled, seconds, and how often the bus is re-placed. */
const LOOKAHEAD = 0.4;
const PLACE_INTERVAL = 0.15;

interface Bus {
  ctx: AudioContext;
  input: GainNode;
  panner: StereoPannerNode;
  air: BiquadFilterNode;
}

export class Concert {
  private stage: THREE.Vector3 | null = null;
  private facing = 0;
  private bus: Bus | null = null;
  /** When a bus that is fading out may be let go, in its context's time; 0 while playing. */
  private releaseAt = 0;

  private nextNote = 0;
  private phraseLeft = 0;
  private degree = 5;
  private placeTimer = 0;

  private musician: Character | null = null;

  constructor(
    private readonly host: FxHost,
    private readonly group: THREE.Group,
  ) {}

  /** Where the concert is being played, or null when none is live. */
  setStage(stage: { x: number; y: number; z: number; facing: number } | null): void {
    if (!stage) {
      this.stage = null;
      return;
    }
    this.stage = (this.stage ?? new THREE.Vector3()).set(stage.x, stage.y, stage.z);
    this.facing = stage.facing;
  }

  update(dt: number): void {
    this.updateMusician(dt);

    const sound = this.host.sfx();
    if (!sound) return;
    const { ctx } = sound;

    if (this.stage && !this.bus) {
      this.bus = this.openBus(sound.ctx, sound.out);
      this.nextNote = ctx.currentTime + 1;
      this.phraseLeft = 0;
      this.placeTimer = 0;
    }
    // Live again before the last fade finished: carry on with the same bus.
    if (this.stage) this.releaseAt = 0;
    const bus = this.bus;
    if (!bus) return;

    if (!this.stage) {
      // Over: let the last notes ring out under a fade, then let the bus go.
      if (this.releaseAt === 0) {
        bus.input.gain.setTargetAtTime(0, ctx.currentTime, 0.6);
        this.releaseAt = ctx.currentTime + 4;
      } else if (ctx.currentTime > this.releaseAt) {
        bus.input.disconnect();
        bus.air.disconnect();
        this.bus = null;
        this.releaseAt = 0;
      }
      return;
    }

    this.placeTimer -= dt;
    if (this.placeTimer <= 0) {
      this.placeTimer = PLACE_INTERVAL;
      this.place(bus, this.stage);
    }

    // Back from a hidden tab: the audio clock ran on while the frames did not. Pick up from
    // now rather than playing the missed minute all at once.
    if (this.nextNote < ctx.currentTime - 0.1) this.nextNote = ctx.currentTime + 0.3;
    while (this.nextNote < ctx.currentTime + LOOKAHEAD) this.scheduleNext(bus);
  }

  dispose(): void {
    this.stage = null;
    this.bus?.input.disconnect();
    this.bus?.air.disconnect();
    this.bus = null;
    this.musician?.dispose();
    this.musician = null;
  }

  /** The bus: every note → distance → bearing → air → the ambience's master. */
  private openBus(ctx: AudioContext, out: AudioNode): Bus {
    const input = ctx.createGain();
    input.gain.value = 0;
    const panner = ctx.createStereoPanner();
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    input.connect(panner);
    panner.connect(air);
    air.connect(out);
    return { ctx, input, panner, air };
  }

  /** Re-place the bus for where you are now. */
  private place(bus: Bus, stage: THREE.Vector3): void {
    const now = bus.ctx.currentTime;
    const { gain, pan, cutoff } = hearing(stage, this.host.camera, EARSHOT, 10);
    bus.input.gain.setTargetAtTime(gain * LEVEL, now, 0.4);
    bus.panner.pan.setTargetAtTime(pan, now, 0.3);
    bus.air.frequency.setTargetAtTime(cutoff, now, 0.3);
  }

  /** The next event of the music: a rest before a phrase, or the phrase's next note. */
  private scheduleNext(bus: Bus): void {
    if (this.phraseLeft <= 0) {
      this.nextNote += 1.8 + Math.random() * 2.6;
      this.phraseLeft = 3 + Math.floor(Math.random() * 4);
      // Half the phrases open over a low string, the way a koto phrase so often starts.
      if (Math.random() < 0.5) this.pluck(bus, Math.random() < 0.6 ? 0 : 3, this.nextNote, 0.32);
      return;
    }

    const last = this.phraseLeft === 1;
    const velocity = 0.42 + Math.random() * 0.28;
    if (last) {
      this.degree = RESTS[Math.floor(Math.random() * RESTS.length)];
    } else {
      // Held inside the middle range: the low strings are for opening a phrase.
      this.degree = Math.min(10, Math.max(3, this.degree + STEPS[Math.floor(Math.random() * STEPS.length)]));
      if (Math.random() < 0.15) this.pluck(bus, Math.min(10, this.degree + 1), this.nextNote - 0.09, velocity * 0.45);
    }
    this.pluck(bus, this.degree, this.nextNote, velocity);
    // Resolving notes sometimes take a fourth below with them.
    if (last && Math.random() < 0.5) this.pluck(bus, this.degree - 2, this.nextNote + 0.03, velocity * 0.5);

    this.nextNote += BEAT * (last ? 2.5 : LENGTHS[Math.floor(Math.random() * LENGTHS.length)]);
    this.phraseLeft--;
  }

  private pluck(bus: Bus, degree: number, when: number, velocity: number): void {
    const { ctx } = bus;
    const source = ctx.createBufferSource();
    source.buffer = pluckBuffer(ctx, NOTES[degree]);
    // A hair of detune, so repeated notes are not identical.
    source.playbackRate.value = 1 + (Math.random() - 0.5) * 0.004;
    const level = ctx.createGain();
    level.gain.value = velocity;
    source.connect(level);
    level.connect(bus.input);
    source.start(Math.max(ctx.currentTime, when));
  }

  /**
   * The player on the stage: a figure in undyed cotton and a straw hat, standing at the
   * stage mark facing the sand while the concert is live, gone when it ends.
   */
  private updateMusician(dt: number): void {
    if (!this.stage) {
      if (this.musician) {
        this.musician.dispose();
        this.musician = null;
      }
      return;
    }
    if (!this.musician) {
      this.musician = new Character({ outfit: 2, skin: 1, accessory: 1 });
      this.musician.root.name = 'concert-musician';
      this.group.add(this.musician.root);
    }
    this.musician.root.position.copy(this.stage);
    this.musician.root.rotation.y = this.facing;
    this.musician.updateLod(this.host.camera.position);
    this.musician.update(dt);
  }
}
