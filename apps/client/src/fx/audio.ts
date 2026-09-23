/**
 * Sounds the games make in the world.
 * ===================================
 *
 * All synthesised, like the ambience: a temple bell, a firework's boom and crackle, a small
 * splash, and the plucked strings of the beach concert. No files.
 *
 * Everything goes out through the ambience's master bus (`FxHost.sfx()`), so the mute
 * toggle and the volume apply to it exactly as to the waves — and nothing here ever
 * creates an audio context of its own. When audio is locked or unavailable the host
 * returns null and the effect is simply silent.
 *
 * ### Placing a sound
 *
 * {@link placeSound} builds the three nodes that put a sound somewhere: a gain for
 * distance, a stereo pan for bearing, and a low-pass for the air — a bell across the bay
 * is not only quieter than one beside you but duller, and that dullness is most of what
 * makes it sound far away. Web Audio's `PannerNode` would do the first two with HRTF, at
 * a cost per voice and with a character that is wrong for a drawn world; a pan and a
 * filter are cheap, predictable and soft.
 *
 * Sounds are placed once, when they start. A bell rings for ten seconds while you walk,
 * and in principle should move in the ear as you do; in practice nobody can tell, and
 * re-placing every voice every frame is exactly the kind of work this layer avoids.
 */

import * as THREE from 'three';
import { smoothstep } from './materials.js';

/** Where sounds go: the ambience's context and master bus. */
export interface SoundOut {
  ctx: AudioContext;
  out: AudioNode;
}

/** The ear: the camera, which is what the player is looking and listening from. */
const toSource = new THREE.Vector3();
const right = new THREE.Vector3();

/** How loud, how far round and how dull a sound at `source` is from `camera`. */
export function hearing(
  source: THREE.Vector3,
  camera: THREE.Camera,
  maxDistance: number,
  reference = 14,
): { gain: number; pan: number; cutoff: number } {
  toSource.subVectors(source, camera.position);
  const distance = toSource.length();
  // Inverse-distance rolloff, then a fade to nothing well before the limit so the edge of
  // earshot is a fade and not a line on the map.
  const gain = (reference / (reference + distance)) * (1 - smoothstep(maxDistance * 0.6, maxDistance, distance));
  right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  toSource.y = 0;
  const flat = toSource.length();
  // Never fully one-sided: a sound hard in one ear reads as a fault in the headphones.
  const pan = flat > 0.001 ? Math.max(-1, Math.min(1, toSource.dot(right) / flat)) * 0.7 : 0;
  const cutoff = 14000 - 12000 * Math.min(1, distance / maxDistance);
  return { gain, pan, cutoff };
}

/**
 * Build distance → bearing → air for one sound and return its input, or null if it is out
 * of earshot. Connect a voice to the result; it is released with the voice.
 */
export function placeSound(
  sound: SoundOut,
  source: THREE.Vector3,
  camera: THREE.Camera,
  maxDistance: number,
  level: number,
): AudioNode | null {
  const { gain, pan, cutoff } = hearing(source, camera, maxDistance);
  if (gain * level < 0.002) return null;
  const { ctx } = sound;
  const input = ctx.createGain();
  input.gain.value = gain * level;
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = cutoff;
  input.connect(panner);
  panner.connect(air);
  air.connect(sound.out);
  return input;
}

// ---------------------------------------------------------------------------
// Shared buffers
// ---------------------------------------------------------------------------

/**
 * Noise and crackle, rendered once per context. A `WeakMap` so a context that is closed
 * and replaced takes its buffers with it.
 */
const noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();
const crackleBuffers = new WeakMap<AudioContext, AudioBuffer>();

function noise(ctx: AudioContext): AudioBuffer {
  let buffer = noiseBuffers.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buffer);
  }
  return buffer;
}

/**
 * The crackle after a burst: a scatter of tiny clicks thinning out over a second and a
 * half, which is what a sky full of burning stars sounds like from a beach.
 */
function crackle(ctx: AudioContext): AudioBuffer {
  let buffer = crackleBuffers.get(ctx);
  if (!buffer) {
    const length = Math.floor(ctx.sampleRate * 1.6);
    buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let n = 0; n < 70; n++) {
      // Denser early, sparse late.
      const at = Math.floor(Math.pow(Math.random(), 1.7) * (length - 400));
      const size = 60 + Math.floor(Math.random() * 180);
      const level = 0.3 + Math.random() * 0.7;
      for (let i = 0; i < size; i++) data[at + i] += (Math.random() * 2 - 1) * level * (1 - i / size);
    }
    crackleBuffers.set(ctx, buffer);
  }
  return buffer;
}

/** A burst of the shared noise through a filter and an envelope, into `into`. */
function noiseBurst(
  ctx: AudioContext,
  into: AudioNode,
  when: number,
  filter: BiquadFilterType,
  frequency: number,
  q: number,
  level: number,
  attack: number,
  decay: number,
): void {
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx);
  // Looped, because the random start below can leave less buffer than the envelope is long.
  source.loop = true;
  const shape = ctx.createBiquadFilter();
  shape.type = filter;
  shape.frequency.value = frequency;
  shape.Q.value = q;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0, when);
  envelope.gain.linearRampToValueAtTime(level, when + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  source.connect(shape);
  shape.connect(envelope);
  envelope.connect(into);
  // Start at a random point in the buffer so two bursts are never the same noise.
  source.start(when, Math.random() * 1.2);
  source.stop(when + attack + decay + 0.05);
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/**
 * Partials of a bronze bell, as (ratio to the strike note, level, seconds to die away).
 *
 * Bells are inharmonic — that is the whole sound. These follow the classic tuned-bell
 * series (hum an octave down, prime, a minor-third tierce, quint, nominal) and then the
 * cluster above it, with the low partials ringing longest. The prime is doubled a few
 * cents sharp, and the beat between the two is the slow *wow* a temple bell has as it
 * dies away.
 */
const BELL_PARTIALS: readonly (readonly [number, number, number])[] = [
  [0.5, 0.34, 11],
  [1.0, 0.5, 8],
  [1.0035, 0.3, 8],
  [1.19, 0.26, 5.5],
  [1.5, 0.16, 4.5],
  [2.0, 0.22, 3.6],
  [2.51, 0.1, 2.6],
  [2.74, 0.07, 2.2],
  [3.36, 0.05, 1.5],
  [4.19, 0.035, 1.0],
];

/**
 * A temple bell struck once. `note` is the strike note in Hz; bigger bells are lower.
 * The strike is a padded wooden beam, not a hammer — a short, dull thump under the first
 * moment of the ring, and a slow attack on the partials so nothing clicks.
 */
export function bellVoice(ctx: AudioContext, into: AudioNode, note: number): void {
  const now = ctx.currentTime + 0.02;
  for (const [ratio, level, decay] of BELL_PARTIALS) {
    const osc = ctx.createOscillator();
    osc.frequency.value = note * ratio;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(level * 0.35, now + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    osc.connect(envelope);
    envelope.connect(into);
    osc.start(now);
    osc.stop(now + decay + 0.05);
  }
  noiseBurst(ctx, into, now, 'lowpass', 380, 0.7, 0.22, 0.004, 0.14);
}

/**
 * A firework's report: a low, soft thump and a rumble behind it, then the crackle. Heard,
 * not felt — at the distance anyone watches from, a shell is a dull boom, and this is a
 * world where the loudest thing is supposed to be the sea.
 */
export function boomVoice(ctx: AudioContext, into: AudioNode, when: number, crackles: boolean): void {
  const thump = ctx.createOscillator();
  thump.frequency.setValueAtTime(68, when);
  thump.frequency.exponentialRampToValueAtTime(34, when + 0.5);
  const thumpEnvelope = ctx.createGain();
  thumpEnvelope.gain.setValueAtTime(0, when);
  thumpEnvelope.gain.linearRampToValueAtTime(0.5, when + 0.012);
  thumpEnvelope.gain.exponentialRampToValueAtTime(0.0001, when + 0.7);
  thump.connect(thumpEnvelope);
  thumpEnvelope.connect(into);
  thump.start(when);
  thump.stop(when + 0.75);

  noiseBurst(ctx, into, when, 'lowpass', 260, 0.5, 0.55, 0.01, 1.6);

  if (crackles) {
    const source = ctx.createBufferSource();
    source.buffer = crackle(ctx);
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 1800;
    const level = ctx.createGain();
    level.gain.value = 0.16;
    source.connect(high);
    high.connect(level);
    level.connect(into);
    source.start(when + 0.35);
  }
}

/** A small splash: the float going under, or a fish breaking the surface. */
export function splashVoice(ctx: AudioContext, into: AudioNode, big: boolean): void {
  const now = ctx.currentTime + 0.01;
  noiseBurst(ctx, into, now, 'bandpass', big ? 900 : 1500, 0.9, big ? 0.5 : 0.3, 0.006, big ? 0.45 : 0.22);
  // The "plop" under it: a short falling tone, which is what makes noise read as water.
  const plop = ctx.createOscillator();
  plop.frequency.setValueAtTime(big ? 420 : 620, now);
  plop.frequency.exponentialRampToValueAtTime(big ? 160 : 260, now + 0.12);
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0, now);
  envelope.gain.linearRampToValueAtTime(0.12, now + 0.008);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  plop.connect(envelope);
  envelope.connect(into);
  plop.start(now);
  plop.stop(now + 0.2);
}

/**
 * One plucked string, rendered by Karplus–Strong: a burst of noise circulating in a delay
 * line one period long, averaged with its neighbour on every pass. The averaging is a
 * low-pass, so high harmonics die first and the tone mellows as it rings — which is how a
 * plucked silk string behaves, and is the whole of the koto's sound at this level of
 * detail.
 *
 * The excitation is itself low-passed: a finger pick on silk, not a plectrum on steel.
 * Rendered once per pitch per context and replayed, so a note costs one buffer source.
 */
const plucks = new WeakMap<AudioContext, Map<number, AudioBuffer>>();

export function pluckBuffer(ctx: AudioContext, frequency: number): AudioBuffer {
  let byPitch = plucks.get(ctx);
  if (!byPitch) {
    byPitch = new Map();
    plucks.set(ctx, byPitch);
  }
  const key = Math.round(frequency * 100);
  const known = byPitch.get(key);
  if (known) return known;

  const rate = ctx.sampleRate;
  const length = Math.floor(rate * 3.2);
  const buffer = ctx.createBuffer(1, length, rate);
  const out = buffer.getChannelData(0);
  const period = Math.max(2, Math.round(rate / frequency - 0.5));

  let soft = 0;
  for (let i = 0; i < period; i++) {
    soft += ((Math.random() * 2 - 1) - soft) * 0.45;
    out[i] = soft;
  }
  // A touch under 1: the string loses a little on every pass as well as to the averaging.
  const damping = 0.9986;
  out[period] = damping * out[0];
  for (let i = period + 1; i < length; i++) {
    out[i] = damping * 0.5 * (out[i - period] + out[i - period - 1]);
  }
  // Fade the first few milliseconds in and the tail out, so neither end clicks.
  const attack = Math.floor(rate * 0.003);
  for (let i = 0; i < attack; i++) out[i] *= i / attack;
  const tail = Math.floor(rate * 0.4);
  for (let i = 0; i < tail; i++) out[length - 1 - i] *= i / tail;

  byPitch.set(key, buffer);
  return buffer;
}
