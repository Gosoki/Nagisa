/**
 * Render pipeline.
 * ================
 *
 * Owns the WebGL context, the camera, the ink pass and the frame loop. Everything else in
 * the client is a subscriber: the scene director, the character controller and the netcode
 * all receive their update calls from here, in a fixed order, so frame behaviour is
 * reproducible.
 *
 * ### Loop structure
 *
 * A **fixed-step accumulator** drives simulation (character physics, interpolation clocks)
 * at a constant 60 Hz regardless of display rate, while rendering happens once per
 * animation frame. Without this, a 144 Hz monitor and a 30 fps phone would run the
 * character controller at different speeds — the classic browser-game bug where movement
 * is faster on better hardware.
 *
 * ### Rendering
 *
 * The world is drawn through {@link InkPass}: a multiple-render-target geometry pass
 * followed by one fullscreen composite that detects contours, draws them in ink, grades
 * the result and lays paper grain over it. There is no `EffectComposer` chain — the ink
 * pass *is* the post chain, and stacking three.js's passes behind it would mean an extra
 * full-resolution read/write per effect for a look that is already finished.
 *
 * Tone mapping and output colour space are handled inside the composite shader rather than
 * by `WebGLRenderer`, because the geometry buffer is a linear half-float target that the
 * renderer never presents directly. See the display-space section of `ink-pass.ts`.
 *
 * ### The WebGL2 requirement
 *
 * Multiple render targets need WebGL2. Every browser that can run this world has had it
 * for years, but if the context comes back WebGL1 the pipeline falls back to rendering the
 * scene straight to the canvas: flat shading, no contours, still playable. That is a
 * degradation, not a second art direction, and `hasInk` says which one is running.
 */

import * as THREE from 'three';
import { OCEAN_RADIUS, SCENE_COLORS } from '@nagisa/shared';
import { AdaptiveResolution, type QualitySettings } from './quality.js';
import { DEFAULT_INK_SETTINGS, InkPass } from './ink/ink-pass.js';
import { setInkCamera } from './ink/ink-material.js';

/** A subscriber to the frame loop. Lower `order` runs first. */
export interface FrameSubscriber {
  readonly order: number;
  /**
   * Fixed-step simulation. Called zero or more times per frame with a constant `dt`.
   * Put anything physical here.
   */
  fixedUpdate?(dt: number): void;
  /**
   * Per-frame update, with the real elapsed time and the fractional position between
   * fixed steps. Put anything visual here — interpolation, camera, animation blending.
   */
  update?(dt: number, alpha: number): void;
}

/** Simulation step, seconds. 60 Hz. */
const FIXED_DT = 1 / 60;

/** Never simulate more than this many steps in one frame; beyond it we accept slowdown. */
const MAX_STEPS_PER_FRAME = 5;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private ink: InkPass | null = null;
  private readonly adaptive: AdaptiveResolution;
  private readonly settings: QualitySettings;

  private subscribers: FrameSubscriber[] = [];
  private accumulator = 0;
  private lastTime = 0;
  private rafHandle = 0;
  private running = false;

  /** Rolling frame-rate readout, published to the UI. */
  private fpsAccum = 0;
  private fpsFrames = 0;
  private _fps = 60;

  /** Set while the tab is hidden; we stop rendering but keep the netcode alive. */
  private hidden = false;

  constructor(container: HTMLElement, settings: QualitySettings) {
    this.settings = settings;
    this.adaptive = new AdaptiveResolution(settings);

    this.canvas = document.createElement('canvas');
    container.prepend(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      // Antialiasing is off: MSAA on a full-resolution buffer is expensive, and the toon
      // look tolerates the softness that adaptive DPR introduces far better than it
      // tolerates a halved frame rate.
      antialias: false,
      // We never read pixels back or composite over DOM content behind the canvas.
      alpha: false,
      // `high-performance` asks laptops to use the discrete GPU rather than the iGPU.
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });

    this.renderer.setPixelRatio(this.adaptive.value);
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    // Tone mapping and the linear→sRGB conversion happen in the ink composite, which is
    // the pass that actually reaches the canvas. Leaving three's own tone mapping on would
    // apply the curve twice: once when the geometry pass writes the half-float buffer and
    // again when the composite presents it.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    if (settings.shadows) {
      this.renderer.shadowMap.enabled = true;
      // PCF soft is the cheapest filter that does not show stair-stepping on the long,
      // low shadows a late-afternoon sun casts across the plaza.
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SCENE_COLORS.skyHorizon);
    // Fog is applied inside the ink material rather than by three: the geometry pass has
    // to write the *unfogged* depth and normal into the info buffer while writing the
    // fogged colour, and three's fog chunk would have no way to know the difference.

    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.5,
      OCEAN_RADIUS * 1.4,
    );
    this.camera.position.set(0, 12, 24);

    setInkCamera(this.camera.near, this.camera.far);
    this.buildInkPass();

    this.observeResize(container);
    this.observeVisibility();
  }

  /** Current smoothed frame rate, for the debug readout and telemetry. */
  get fps(): number {
    return this._fps;
  }

  /** Current adaptive pixel ratio. */
  get pixelRatio(): number {
    return this.adaptive.value;
  }

  // -------------------------------------------------------------------------
  // The ink pass
  // -------------------------------------------------------------------------

  private buildInkPass(): void {
    if (!this.renderer.capabilities.isWebGL2) {
      console.warn('[render] WebGL2 unavailable — contours disabled, rendering flat');
      return;
    }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    // Line weight is a quality setting: a thicker line on a low-resolution buffer keeps
    // the drawing legible where a hairline would break up into dashes.
    const settings = {
      ...DEFAULT_INK_SETTINGS,
      thickness: this.settings.tier === 'low' ? 1.25 : 1.0,
      paper: this.settings.postProcessing ? DEFAULT_INK_SETTINGS.paper : 0.2,
    };
    this.ink = new InkPass(this.renderer, size.x, size.y, settings);
    this.ink.setCameraPlanes(this.camera.near, this.camera.far);
  }

  /** True when the contour pipeline is running (i.e. WebGL2 was available). */
  get hasInk(): boolean {
    return this.ink !== null;
  }

  /** Show one contour detector's raw contribution. See `InkPass.setDebug`. */
  setInkDebug(mode: 'off' | 'all' | 'depth' | 'normal' | 'id' | 'rawDepth' | 'rawNormal'): void {
    this.ink?.setDebug(mode);
  }

  /** Runtime access to the ink uniforms, for the settings panel and the day cycle. */
  get inkUniforms(): Record<string, THREE.IUniform> | null {
    return this.ink?.uniforms ?? null;
  }

  /**
   * Adjust the warmth of the grade with the day cycle. Kept under the old name so the
   * app's per-frame call site does not need to know what the post chain is made of.
   */
  setBloomStrength(strength: number): void {
    const uniforms = this.ink?.uniforms;
    if (uniforms) uniforms.uWarmth.value = 0.35 + strength * 0.8;
  }

  // -------------------------------------------------------------------------
  // Subscribers
  // -------------------------------------------------------------------------

  /** Register a frame subscriber. Returns an unsubscribe function. */
  add(sub: FrameSubscriber): () => void {
    this.subscribers.push(sub);
    this.subscribers.sort((a, b) => a.order - b.order);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== sub);
    };
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.tick);

    const frameMs = now - this.lastTime;
    this.lastTime = now;

    // A hidden tab gets its rAF throttled to ~1 Hz. Rendering that frame is pointless
    // and the huge dt would launch the character into orbit, so we skip the whole frame.
    if (this.hidden) return;

    // Clamp: after a stall (alt-tab, GC, a slow asset build) we must not try to catch up
    // by simulating three seconds of movement in one frame.
    const dt = Math.min(frameMs / 1000, 0.25);

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      for (const sub of this.subscribers) sub.fixedUpdate?.(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    // If we hit the step ceiling, drop the backlog rather than accumulating debt that
    // would make the next frames worse.
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    const alpha = this.accumulator / FIXED_DT;
    for (const sub of this.subscribers) sub.update?.(dt, alpha);

    if (this.ink) this.ink.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);

    this.trackPerformance(frameMs);
  };

  private trackPerformance(frameMs: number): void {
    this.fpsAccum += frameMs;
    this.fpsFrames++;
    if (this.fpsAccum >= 500) {
      this._fps = Math.round((this.fpsFrames * 1000) / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    const next = this.adaptive.sample(frameMs);
    if (next !== null) {
      this.renderer.setPixelRatio(next);
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.ink?.setSize(size.x, size.y);
    }
  }

  // -------------------------------------------------------------------------
  // Resize & visibility
  // -------------------------------------------------------------------------

  private observeResize(container: HTMLElement): void {
    const apply = (): void => {
      const w = container.clientWidth;
      const h = Math.max(1, container.clientHeight);
      this.camera.aspect = w / h;
      // On phones in portrait a 50° horizontal-equivalent FOV crops the world badly.
      // Widening the vertical FOV on tall viewports keeps the same amount of island on
      // screen as on a desktop.
      this.camera.fov = h > w ? 62 : 50;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.ink?.setSize(size.x, size.y);
      // A resize changes the pixel cost per frame, so let the controller re-converge.
      this.adaptive.unsettle();
    };
    // ResizeObserver rather than `window.onresize`: it also fires for the mobile URL bar
    // collapsing, which `resize` does not reliably do on iOS.
    new ResizeObserver(apply).observe(container);
    apply();
  }

  private observeVisibility(): void {
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      // Reset the clock so the first visible frame after a return has a sane dt.
      this.lastTime = performance.now();
      this.accumulator = 0;
    });
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Release the GL context and every GPU resource. Called on full app teardown. */
  dispose(): void {
    this.stop();
    this.ink?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  /** Quality settings this pipeline was built with. Read-only for subscribers. */
  get quality(): QualitySettings {
    return this.settings;
  }
}
