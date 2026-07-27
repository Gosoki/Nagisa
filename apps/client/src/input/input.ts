/**
 * Input.
 * ======
 *
 * Collapses keyboard, mouse, touch and gamepad into one small, polled state object:
 * a 2D movement vector, a 2D look delta, and a couple of edge-triggered actions. The
 * character controller reads that and knows nothing about devices.
 *
 * ### Design notes
 *
 * - **No pointer lock.** The reference product lets you drag to look and keeps the
 *   cursor. Pointer lock is a modal state with an escape-key ritual attached, and modal
 *   states are exactly what a calm, drop-in world should not have.
 *
 * - **Touch is split by screen half.** The left half is a floating virtual stick that
 *   appears where your thumb lands; the right half orbits the camera. This is the
 *   convention every touch 3D app converges on because it needs no on-screen furniture
 *   until the moment you touch it.
 *
 * - **Edge-triggered actions are consumed.** `consumeJump()` returns true once per
 *   press. Polling a boolean that stays true for the duration of a keypress causes the
 *   classic "held space = repeated jumps" bug.
 *
 * - **Input is ignored while typing.** Any keyboard event whose target is an input,
 *   textarea or contenteditable belongs to the UI, not the world. Without this, naming
 *   yourself "Sawada" walks you into the sea.
 */

/** Normalised movement intent, both components in [-1, 1]. */
export interface MoveVector {
  x: number;
  y: number;
}

/** Live state of the on-screen stick, for the UI to draw. `null` when inactive. */
export interface StickState {
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
}

/** Radius of the virtual stick in CSS pixels — the distance for full deflection. */
const STICK_RADIUS = 56;

export class Input {
  /** Movement intent in local space: +y forward, +x right. */
  readonly move: MoveVector = { x: 0, y: 0 };

  /** Look delta accumulated since the last frame, in radians. Consumed by the camera. */
  readonly look: MoveVector = { x: 0, y: 0 };

  /** True while a run modifier is held. */
  run = false;

  private keys = new Set<string>();
  private jumpQueued = false;
  private interactQueued = false;

  /** Pointer id currently orbiting the camera, or null. */
  private lookPointer: number | null = null;
  private lastLookX = 0;
  private lastLookY = 0;

  /** Pointer id driving the virtual stick, or null. */
  private stickPointer: number | null = null;
  private stick: StickState | null = null;

  /** Callback so the UI can render the stick without polling every frame. */
  onStickChange: ((state: StickState | null) => void) | null = null;

  private readonly detachers: Array<() => void> = [];

  constructor(private readonly element: HTMLElement) {
    this.attach();
  }

  /** Current virtual-stick state, for the UI overlay. */
  get stickState(): StickState | null {
    return this.stick;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** True once per jump press. */
  consumeJump(): boolean {
    const q = this.jumpQueued;
    this.jumpQueued = false;
    return q;
  }

  /** True once per interact press. */
  consumeInteract(): boolean {
    const q = this.interactQueued;
    this.interactQueued = false;
    return q;
  }

  /** Queue a jump from the UI (the mobile jump button). */
  queueJump(): void {
    this.jumpQueued = true;
  }

  /** Queue an interaction from the UI (the mobile action button). */
  queueInteract(): void {
    this.interactQueued = true;
  }

  /** Zero the look delta. Called by the camera after it has applied it. */
  clearLook(): void {
    this.look.x = 0;
    this.look.y = 0;
  }

  /**
   * Release every held key. Called on window blur — otherwise alt-tabbing mid-stride
   * leaves the character walking forever.
   */
  releaseAll(): void {
    this.keys.clear();
    this.run = false;
    this.updateMoveFromKeys();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private attach(): void {
    const on = <K extends keyof WindowEventMap>(
      target: EventTarget,
      type: K | string,
      handler: (e: never) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, handler as EventListener, opts);
      this.detachers.push(() => target.removeEventListener(type, handler as EventListener, opts));
    };

    on(window, 'keydown', this.onKeyDown);
    on(window, 'keyup', this.onKeyUp);
    on(window, 'blur', this.releaseAll);
    on(this.element, 'pointerdown', this.onPointerDown);
    on(window, 'pointermove', this.onPointerMove);
    on(window, 'pointerup', this.onPointerUp);
    on(window, 'pointercancel', this.onPointerUp);
    // Suppress the context menu so a long-press on mobile does not interrupt a drag.
    on(this.element, 'contextmenu', (e: Event) => e.preventDefault());
  }

  /** True when the event belongs to the UI rather than the world. */
  private isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTypingTarget(e.target)) return;
    this.keys.add(e.code);
    if (e.code === 'Space') {
      // Space scrolls the page by default, which on a fixed-height canvas app does
      // nothing visible but does steal the event.
      e.preventDefault();
      this.jumpQueued = true;
    }
    if (e.code === 'KeyE' || e.code === 'Enter') this.interactQueued = true;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.run = true;
    this.updateMoveFromKeys();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.run = false;
    this.updateMoveFromKeys();
  };

  /** Map the held keys onto the movement vector. WASD and arrows are both supported. */
  private updateMoveFromKeys(): void {
    const k = this.keys;
    let x = 0;
    let y = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;

    // Normalise so diagonal movement is not 41% faster than cardinal movement.
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    // Only the keyboard writes here; touch writes directly in `onPointerMove`. If a
    // stick is active it owns the vector.
    if (this.stickPointer === null) {
      this.move.x = x;
      this.move.y = y;
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.isTypingTarget(e.target)) return;

    // Mouse always orbits — a desktop user has the keyboard for movement.
    if (e.pointerType === 'mouse') {
      this.lookPointer = e.pointerId;
      this.lastLookX = e.clientX;
      this.lastLookY = e.clientY;
      return;
    }

    // Touch: left half drives the stick, right half orbits.
    const half = this.element.clientWidth * 0.5;
    if (e.clientX < half && this.stickPointer === null) {
      this.stickPointer = e.pointerId;
      this.stick = { originX: e.clientX, originY: e.clientY, currentX: e.clientX, currentY: e.clientY };
      this.onStickChange?.(this.stick);
    } else if (this.lookPointer === null) {
      this.lookPointer = e.pointerId;
      this.lastLookX = e.clientX;
      this.lastLookY = e.clientY;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId === this.lookPointer) {
      // 0.0032 rad per pixel is roughly a full turn across a 2000 px drag: slow enough
      // to frame a view precisely, fast enough to turn around without a second swipe.
      this.look.x += (e.clientX - this.lastLookX) * 0.0032;
      this.look.y += (e.clientY - this.lastLookY) * 0.0032;
      this.lastLookX = e.clientX;
      this.lastLookY = e.clientY;
    }

    if (e.pointerId === this.stickPointer && this.stick) {
      this.stick.currentX = e.clientX;
      this.stick.currentY = e.clientY;

      let dx = e.clientX - this.stick.originX;
      let dy = e.clientY - this.stick.originY;
      const dist = Math.hypot(dx, dy);
      if (dist > STICK_RADIUS) {
        // Drag the origin along with the thumb once it leaves the ring, so the stick
        // never runs out of travel during a long drag.
        const excess = dist - STICK_RADIUS;
        this.stick.originX += (dx / dist) * excess;
        this.stick.originY += (dy / dist) * excess;
        dx = (dx / dist) * STICK_RADIUS;
        dy = (dy / dist) * STICK_RADIUS;
      }

      this.move.x = dx / STICK_RADIUS;
      // Screen +y is down; world forward is −y on screen.
      this.move.y = -dy / STICK_RADIUS;
      // Push past 85% deflection to run. No separate run button on touch.
      this.run = Math.hypot(this.move.x, this.move.y) > 0.85;
      this.onStickChange?.(this.stick);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.lookPointer) this.lookPointer = null;
    if (e.pointerId === this.stickPointer) {
      this.stickPointer = null;
      this.stick = null;
      this.move.x = 0;
      this.move.y = 0;
      this.run = false;
      this.onStickChange?.(null);
      // Restore any keyboard state that was held underneath.
      this.updateMoveFromKeys();
    }
  };

  /**
   * Poll connected gamepads and fold them into the movement vector.
   * Called once per frame; the Gamepad API has no events for axis motion.
   */
  pollGamepad(): void {
    if (typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (!pad) continue;
      const dead = 0.18;
      const lx = Math.abs(pad.axes[0] ?? 0) > dead ? pad.axes[0] : 0;
      const ly = Math.abs(pad.axes[1] ?? 0) > dead ? pad.axes[1] : 0;
      if (lx || ly) {
        this.move.x = lx;
        this.move.y = -ly;
      }
      const rx = Math.abs(pad.axes[2] ?? 0) > dead ? pad.axes[2] : 0;
      const ry = Math.abs(pad.axes[3] ?? 0) > dead ? pad.axes[3] : 0;
      this.look.x += rx * 0.045;
      this.look.y += ry * 0.045;
      if (pad.buttons[0]?.pressed) this.jumpQueued = true;
      if (pad.buttons[2]?.pressed) this.interactQueued = true;
      this.run = pad.buttons[10]?.pressed || (pad.buttons[6]?.value ?? 0) > 0.5;
      break; // One pad is enough; this is not a couch co-op game.
    }
  }

  dispose(): void {
    for (const off of this.detachers) off();
    this.detachers.length = 0;
  }
}
