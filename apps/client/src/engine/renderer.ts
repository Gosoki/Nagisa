/**
 * Render pipeline.
 * ================
 *
 * Owns the WebGL context, the camera, the post chain and the frame loop. Everything
 * else in the client is a subscriber: the scene director, the character controller and
 * the netcode all receive their update calls from here, in a fixed order, so frame
 * behaviour is reproducible.
 *
 * ### Loop structure
 * A **fixed-step accumulator** drives simulation (character physics, interpolation
 * clocks) at a constant 60 Hz regardless of display rate, while rendering happens once
 * per animation frame. Without this, a 144 Hz monitor and a 30 fps phone would run the
 * character controller at different speeds — the classic browser-game bug where movement
 * is faster on better hardware.
 *
 * ### Post-processing
 * Deliberately minimal: tone mapping plus a restrained bloom. The reference product's
 * atmosphere comes from its lighting and materials, not from screen-space effects, and
 * every pass added here is a full-resolution read/write that mobile GPUs pay for in
 * bandwidth. On the `low` tier the composer is skipped entirely and we render straight
 * to the canvas.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { OCEAN_RADIUS, SCENE_COLORS } from '@nagisa/shared';
import { AdaptiveResolution, type QualitySettings } from './quality.js';

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

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
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
    // ACES filmic keeps the bright sky and the sunlit sand from clipping to white while
    // leaving the toon ramp's midtones where the material author put them.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    if (settings.shadows) {
      this.renderer.shadowMap.enabled = true;
      // PCF soft is the cheapest filter that does not show stair-stepping on the long,
      // low shadows a late-afternoon sun casts across the plaza.
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SCENE_COLORS.skyHorizon);
    // Exponential fog matched to the horizon colour: the island's far shore dissolves
    // into haze instead of ending at a hard draw-distance edge.
    this.scene.fog = new THREE.FogExp2(SCENE_COLORS.fog, 0.0016);

    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.5,
      OCEAN_RADIUS * 1.4,
    );
    this.camera.position.set(0, 12, 24);

    if (settings.postProcessing) this.buildComposer();

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
  // Post-processing
  // -------------------------------------------------------------------------

  private buildComposer(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(size.x, size.y);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Bloom exists for exactly three things: the lighthouse lamp, lantern flames and
    // sun glitter on the water. The threshold is high so nothing else blooms — a low
    // threshold turns the whole toon-shaded island into a soft mess.
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      /* strength  */ 0.32,
      /* radius    */ 0.55,
      /* threshold */ 0.86,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  /** Adjust bloom with the day cycle — lamps matter at dusk, not at noon. */
  setBloomStrength(strength: number): void {
    if (this.bloomPass) this.bloomPass.strength = strength;
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

    if (this.composer) this.composer.render(dt);
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
      this.composer?.setSize(size.x, size.y);
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
      this.composer?.setSize(size.x, size.y);
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
    this.composer?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  /** Quality settings this pipeline was built with. Read-only for subscribers. */
  get quality(): QualitySettings {
    return this.settings;
  }
}
