/**
 * Quality tiers and adaptive resolution.
 * ======================================
 *
 * A browser world has no install step and therefore no hardware survey: the first frame
 * has to look right on a five-year-old phone and on a desktop GPU, and we find out which
 * one we are on only by rendering.
 *
 * The strategy has two halves:
 *
 * 1. **A static tier guess at boot** from cheap signals (device memory, core count,
 *    coarse pointer, WebGL limits). This sets scene *content* — how many trees, whether
 *    shadows exist, how far the terrain meshes — because content cannot be changed
 *    cheaply mid-session.
 *
 * 2. **Adaptive device-pixel-ratio at runtime.** Resolution is the one knob that can be
 *    turned every frame without rebuilding anything, so it absorbs all the variance.
 *    We measure a rolling average frame time and walk the DPR up or down toward the
 *    target frame rate.
 *
 * The controller deliberately settles: once it has found a stable DPR it stops
 * adjusting, because a resolution that keeps breathing is more distracting than one
 * that is slightly too low. This mirrors the reference product, which stops its own
 * adaptive DPR after it converges.
 */

/** Content tiers. `low` must be playable on a 2019 mid-range Android. */
export type QualityTier = 'low' | 'medium' | 'high';

export interface QualitySettings {
  tier: QualityTier;
  /** Upper bound for adaptive DPR. Never exceeds the device's real pixel ratio. */
  maxPixelRatio: number;
  /** Lower bound. Below this the world looks broken rather than merely soft. */
  minPixelRatio: number;
  /** Whether the sun casts real shadows. The single most expensive feature. */
  shadows: boolean;
  /** Shadow map resolution, if enabled. */
  shadowMapSize: number;
  /** Vertices per side of the terrain mesh. Quadratic cost — treat with respect. */
  terrainResolution: number;
  /** Multiplier on procedural vegetation counts. */
  scatterDensity: number;
  /** Distance at which props stop being drawn, metres. */
  drawDistance: number;
  /** Whether the water surface animates its vertices. */
  animatedWater: boolean;
  /** Maximum remote players rendered with full character detail. */
  maxDetailedCharacters: number;
  /** Enable the post-processing chain at all. */
  postProcessing: boolean;
}

/** True for phones and tablets — coarse pointer plus no hover is the reliable test. */
export function isTouchDevice(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * Best-effort "this device will struggle" signal.
 *
 * `deviceMemory` is Chromium-only and rounded, and `hardwareConcurrency` lies on some
 * phones — which is why this only picks a *starting* tier that adaptive DPR then
 * corrects. Being wrong here costs a few seconds of soft image, not a broken session.
 */
export function isLowMemoryDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = nav.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  return memory <= 4 || cores <= 4;
}

/** Pick the starting tier. Called once, before the scene is built. */
export function detectTier(): QualityTier {
  const touch = isTouchDevice();
  const weak = isLowMemoryDevice();
  if (touch && weak) return 'low';
  if (touch || weak) return 'medium';
  return 'high';
}

/** Settings for each tier. These numbers are the island's entire performance budget. */
export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    maxPixelRatio: 1.0,
    minPixelRatio: 0.6,
    shadows: false,
    shadowMapSize: 0,
    terrainResolution: 160,
    scatterDensity: 0.35,
    drawDistance: 240,
    animatedWater: false,
    maxDetailedCharacters: 12,
    postProcessing: false,
  },
  medium: {
    tier: 'medium',
    maxPixelRatio: 1.5,
    minPixelRatio: 0.75,
    shadows: true,
    shadowMapSize: 1024,
    terrainResolution: 240,
    scatterDensity: 0.7,
    drawDistance: 400,
    animatedWater: true,
    maxDetailedCharacters: 28,
    postProcessing: true,
  },
  high: {
    tier: 'high',
    maxPixelRatio: 2.0,
    minPixelRatio: 0.9,
    shadows: true,
    shadowMapSize: 2048,
    terrainResolution: 340,
    scatterDensity: 1.0,
    drawDistance: 700,
    animatedWater: true,
    maxDetailedCharacters: 60,
    postProcessing: true,
  },
};

/** Resolve settings for a tier, clamped to what the device can actually display. */
export function settingsFor(tier: QualityTier): QualitySettings {
  const preset = { ...QUALITY_PRESETS[tier] };
  preset.maxPixelRatio = Math.min(preset.maxPixelRatio, window.devicePixelRatio || 1);
  preset.minPixelRatio = Math.min(preset.minPixelRatio, preset.maxPixelRatio);
  return preset;
}

/**
 * Walks the render resolution toward a target frame rate.
 *
 * Usage: call {@link sample} once per frame with the frame's duration; when it returns a
 * number, apply it as the renderer's pixel ratio.
 */
export class AdaptiveResolution {
  private readonly targetMs: number;
  private readonly min: number;
  private readonly max: number;

  /** Current ratio. Starts optimistic and comes down if the device cannot keep up. */
  private ratio: number;

  /** Exponential moving average of frame time, ms. */
  private avgMs = 16.7;

  /** Frames since the last adjustment — we never react to a single slow frame. */
  private sinceChange = 0;

  /** Consecutive adjustments in alternating directions; used to detect oscillation. */
  private flipFlops = 0;
  private lastDirection = 0;

  /** Once settled, the controller stops touching resolution for the rest of the session. */
  private settled = false;

  constructor(settings: QualitySettings, targetFps = 60) {
    this.targetMs = 1000 / targetFps;
    this.min = settings.minPixelRatio;
    this.max = settings.maxPixelRatio;
    this.ratio = settings.maxPixelRatio;
  }

  get value(): number {
    return this.ratio;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  /**
   * Feed one frame. Returns the new pixel ratio when it changed, otherwise `null`.
   *
   * Thresholds are asymmetric on purpose: we drop resolution readily (a stuttering world
   * is unpleasant immediately) and raise it reluctantly (a resolution that climbs and
   * then falls back is worse than one that stayed put).
   */
  sample(frameMs: number): number | null {
    if (this.settled) return null;

    // Ignore absurd frames — tab restore, GC pause, the user dragging the window.
    if (frameMs > 500) return null;

    this.avgMs += (frameMs - this.avgMs) * 0.06;
    this.sinceChange++;

    // Give the scene a second to warm up (shader compilation, first-frame uploads).
    if (this.sinceChange < 45) return null;

    let direction = 0;
    if (this.avgMs > this.targetMs * 1.35 && this.ratio > this.min) direction = -1;
    else if (this.avgMs < this.targetMs * 0.8 && this.ratio < this.max) direction = +1;

    if (direction === 0) {
      // Two quiet seconds at a stable resolution means we have found the right one.
      if (this.sinceChange > 180) this.settled = true;
      return null;
    }

    // Oscillating between two ratios means the device sits exactly on the boundary.
    // Settle at the lower of the two rather than flickering forever.
    if (direction !== 0 && this.lastDirection !== 0 && direction !== this.lastDirection) {
      this.flipFlops++;
      if (this.flipFlops >= 3) {
        this.ratio = Math.max(this.min, this.ratio - 0.1);
        this.settled = true;
        return this.ratio;
      }
    }
    this.lastDirection = direction;

    const step = direction < 0 ? 0.15 : 0.1;
    const next = Math.min(this.max, Math.max(this.min, this.ratio + direction * step));
    if (Math.abs(next - this.ratio) < 0.01) return null;

    this.ratio = next;
    this.sinceChange = 0;
    return this.ratio;
  }

  /** Force the controller back into adjusting, e.g. after a big scene change. */
  unsettle(): void {
    this.settled = false;
    this.sinceChange = 0;
    this.flipFlops = 0;
  }
}
