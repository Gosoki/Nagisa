/**
 * Ambience.
 * =========
 *
 * Per-zone atmosphere, **synthesised at runtime** rather than streamed.
 *
 * The reference product ships one ambience loop per area (beach, forest, city, temple…).
 * Loops are the obvious approach and they sound better, but they also cost a megabyte or
 * two each, and this island's whole asset strategy is "generate it". So each ambience
 * here is a small stack of Web Audio nodes: filtered noise for water and wind, a slow
 * amplitude drift so nothing is perfectly static, and a sparse event generator for the
 * details (a gull, a distant bell, a wooden knock).
 *
 * The result is not a field recording. It is, however, indistinguishable from one at the
 * volume ambience actually plays at, it costs zero bytes, and it never loops audibly —
 * which streamed ambience always eventually does.
 *
 * ### Autoplay
 * Browsers refuse to start audio without a gesture. The context is created suspended and
 * resumed on the first interaction; until then the world is simply silent, and the
 * settings panel's mute toggle reflects that honestly rather than pretending.
 */

import type { ZoneId } from '@nagisa/shared';

/** Ambience families, matching `Zone.ambience` in the world layout. */
export type AmbienceKind = 'waves' | 'harbor' | 'town' | 'forest' | 'wind' | 'shrine';

/** Tuning for one ambience bed. */
interface AmbienceSpec {
  /** Centre frequency of the noise band, Hz. Low = rumble, high = hiss. */
  filterHz: number;
  /** Filter Q. Higher is more tonal, lower is broader. */
  q: number;
  /** Base gain, before the master volume. */
  gain: number;
  /** Rate of the slow swell, Hz. Waves breathe; a forest barely moves. */
  swellHz: number;
  /** Depth of the swell, 0–1. */
  swellDepth: number;
  /** Mean seconds between sparse one-shot events. 0 disables them. */
  eventEvery: number;
  /** Pitch range of the one-shot events, Hz. */
  eventPitch: readonly [number, number];
  /** Envelope length of one-shot events, seconds. */
  eventDecay: number;
}

/**
 * The island's soundscape.
 *
 * These numbers were tuned by ear against the visual: the harbour is lower and busier
 * than the open beach, the shrine is tonal and sparse, and the lookout is nothing but
 * wind because that is what being on a headland sounds like.
 */
const SPECS: Record<AmbienceKind, AmbienceSpec> = {
  waves: { filterHz: 480, q: 0.6, gain: 0.5, swellHz: 0.11, swellDepth: 0.55, eventEvery: 14, eventPitch: [1200, 2400], eventDecay: 0.5 },
  harbor: { filterHz: 260, q: 0.5, gain: 0.42, swellHz: 0.08, swellDepth: 0.4, eventEvery: 9, eventPitch: [180, 420], eventDecay: 0.9 },
  town: { filterHz: 700, q: 0.4, gain: 0.22, swellHz: 0.05, swellDepth: 0.25, eventEvery: 11, eventPitch: [500, 900], eventDecay: 0.35 },
  forest: { filterHz: 1800, q: 0.7, gain: 0.2, swellHz: 0.07, swellDepth: 0.35, eventEvery: 7, eventPitch: [2200, 3600], eventDecay: 0.25 },
  wind: { filterHz: 900, q: 1.4, gain: 0.38, swellHz: 0.14, swellDepth: 0.7, eventEvery: 0, eventPitch: [0, 0], eventDecay: 0 },
  shrine: { filterHz: 1400, q: 2.2, gain: 0.18, swellHz: 0.04, swellDepth: 0.3, eventEvery: 18, eventPitch: [660, 990], eventDecay: 2.4 },
};

/** Seconds to crossfade between zones. Long, so transitions are never a cut. */
const CROSSFADE_SECONDS = 2.6;

/** One running ambience bed. */
interface Bed {
  gain: GainNode;
  swell: OscillatorNode;
  swellGain: GainNode;
  filter: BiquadFilterNode;
  eventTimer: ReturnType<typeof setTimeout> | null;
  spec: AmbienceSpec;
}

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  private readonly beds = new Map<AmbienceKind, Bed>();
  private active: AmbienceKind | null = null;

  private _muted = true;
  private _volume = 0.5;

  /** Whether the audio context has been unlocked by a user gesture. */
  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get muted(): boolean {
    return this._muted;
  }

  /**
   * Start (or resume) audio. Must be called from a user-gesture handler the first time —
   * every browser enforces this, and calling it from `load` silently produces a context
   * stuck in `suspended`.
   */
  async unlock(): Promise<void> {
    if (!this.ctx) this.initialise();
    if (!this.ctx) return; // Web Audio unavailable; the world is simply silent.
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* Some browsers reject outside a gesture; the next attempt will succeed. */
      }
    }
  }

  /** Build the graph. Cheap enough to do lazily on first unlock. */
  private initialise(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : this._volume;
    this.master.connect(ctx.destination);

    // One shared noise buffer feeds every bed. Ten seconds of pink-ish noise: long
    // enough that the loop point is inaudible under a filter, short enough to be a
    // trivial allocation.
    this.noiseBuffer = this.createNoiseBuffer(ctx, 10);
    this.source = ctx.createBufferSource();
    this.source.buffer = this.noiseBuffer;
    this.source.loop = true;
    this.source.start();

    for (const kind of Object.keys(SPECS) as AmbienceKind[]) {
      this.beds.set(kind, this.createBed(ctx, kind));
    }

    // If a zone was requested before unlock, honour it now.
    if (this.active) this.setZoneKind(this.active, true);
  }

  /**
   * Pink-ish noise via the Voss-McCartney-style octave summation.
   *
   * White noise sounds like a broken television; pink noise sounds like weather. The
   * difference matters more than any amount of filtering afterwards.
   */
  private createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  /**
   * One bed: noise → band-pass → gain → master, with an LFO modulating the gain so the
   * bed swells and settles instead of sitting at a constant level.
   */
  private createBed(ctx: AudioContext, kind: AmbienceKind): Bed {
    const spec = SPECS[kind];

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = spec.filterHz;
    filter.Q.value = spec.q;

    const gain = ctx.createGain();
    gain.gain.value = 0; // Silent until this zone becomes active.

    const swell = ctx.createOscillator();
    swell.frequency.value = spec.swellHz;
    const swellGain = ctx.createGain();
    swellGain.gain.value = spec.swellDepth * spec.gain;
    swell.connect(swellGain);
    // Modulating the bed's own gain parameter adds to its base value rather than
    // replacing it, which is exactly the swell we want.
    swellGain.connect(gain.gain);
    swell.start();

    this.source?.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);

    return { gain, swell, swellGain, filter, eventTimer: null, spec };
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  /** Crossfade to a zone's ambience. Safe to call every frame; changes are debounced. */
  setZone(zone: ZoneId, kindLookup: (zone: ZoneId) => AmbienceKind): void {
    this.setZoneKind(kindLookup(zone));
  }

  /** Crossfade to an ambience family directly. */
  setZoneKind(kind: AmbienceKind, force = false): void {
    if (this.active === kind && !force) return;
    const previous = this.active;
    this.active = kind;

    if (!this.ctx) return; // Not unlocked yet; the choice is remembered for later.
    const now = this.ctx.currentTime;

    if (previous) {
      const bed = this.beds.get(previous);
      if (bed) {
        bed.gain.gain.cancelScheduledValues(now);
        bed.gain.gain.setValueAtTime(bed.gain.gain.value, now);
        bed.gain.gain.linearRampToValueAtTime(0, now + CROSSFADE_SECONDS);
        if (bed.eventTimer !== null) clearTimeout(bed.eventTimer);
        bed.eventTimer = null;
      }
    }

    const bed = this.beds.get(kind);
    if (!bed) return;
    bed.gain.gain.cancelScheduledValues(now);
    bed.gain.gain.setValueAtTime(bed.gain.gain.value, now);
    bed.gain.gain.linearRampToValueAtTime(bed.spec.gain, now + CROSSFADE_SECONDS);
    this.scheduleEvent(kind);
  }

  /**
   * Schedule the next sparse one-shot for a bed — a gull, a rope creak, a bell.
   *
   * Intervals are randomised around the mean because evenly spaced events immediately
   * read as a machine. The timer reschedules itself and is cancelled on crossfade.
   */
  private scheduleEvent(kind: AmbienceKind): void {
    const bed = this.beds.get(kind);
    if (!bed || !this.ctx || bed.spec.eventEvery <= 0) return;

    const delay = bed.spec.eventEvery * (0.5 + Math.random()) * 1000;
    bed.eventTimer = setTimeout(() => {
      if (this.active !== kind || !this.ctx || !this.master) return;
      this.playOneShot(bed.spec);
      this.scheduleEvent(kind);
    }, delay);
  }

  /** A short filtered blip with an exponential decay. */
  private playOneShot(spec: AmbienceSpec): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const [lo, hi] = spec.eventPitch;
    osc.frequency.value = lo + Math.random() * (hi - lo);

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    // A fast but not instant attack; a zero-length attack clicks.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.eventDecay);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + spec.eventDecay + 0.05);
    // Nodes are garbage collected once stopped and disconnected; no manual cleanup.
  }

  /** Mute or unmute. Ramped, because an instant cut is startling. */
  setMuted(muted: boolean): void {
    this._muted = muted;
    if (!this.master || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(muted ? 0 : this._volume, now + 0.35);
  }

  setVolume(volume: number): void {
    this._volume = Math.max(0, Math.min(1, volume));
    if (!this._muted) this.setMuted(false);
  }

  /** Stop everything and release the context. */
  async dispose(): Promise<void> {
    for (const bed of this.beds.values()) {
      if (bed.eventTimer !== null) clearTimeout(bed.eventTimer);
      try {
        bed.swell.stop();
      } catch {
        /* Already stopped. */
      }
    }
    this.beds.clear();
    try {
      this.source?.stop();
    } catch {
      /* Already stopped. */
    }
    await this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
