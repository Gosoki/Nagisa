<script module lang="ts">
  /**
   * Screen-space snapshot of one active virtual-stick drag. Pixel coordinates, not
   * normalised — the input layer already knows its own touch geometry, so this stays a
   * dumb transport shape rather than a second copy of stick math.
   */
  export interface StickState {
    originX: number;
    originY: number;
    currentX: number;
    currentY: number;
  }
</script>

<script lang="ts">
  /**
   * Joystick — the virtual movement stick, touch only.
   *
   * Appears exactly when `stick` is non-null, which the input layer only ever sets while
   * a touch drag is active in the movement zone — so "touch only" falls out of the data
   * rather than needing a device check here (this file may not import the engine/input
   * layer to test for touch itself; see the component contract in stores.ts).
   *
   * `stick` is NOT one of the stores in state/stores.ts. That file is the fixed contract
   * for state shared between the engine and the interface, and per-frame drag coordinates
   * are too hot and too local to belong there. Instead this component takes `stick` as a
   * plain prop; the input layer (outside this deliverable) is expected to feed it in,
   * for example by re-rendering Overlay with an updated prop each time the drag moves.
   *
   * Rendering is two thin rings — a fixed base where the thumb was first pressed, and a
   * thumb that follows the finger, clamped to a maximum travel radius so the stick reads
   * as a stick and not a runaway cursor. Both are drawn at low opacity in `--ui-ink`:
   * this is a functional affordance, not a decorated game-HUD control, so it should all
   * but disappear when the thumb is centred.
   */
  let { stick }: { stick: StickState | null } = $props();

  /** Maximum distance the thumb ring travels from the base, in CSS px. */
  const MAX_TRAVEL = 38;

  const thumbOffset = $derived.by(() => {
    if (!stick) return { x: 0, y: 0 };
    const dx = stick.currentX - stick.originX;
    const dy = stick.currentY - stick.originY;
    const dist = Math.hypot(dx, dy);
    if (dist <= MAX_TRAVEL || dist === 0) return { x: dx, y: dy };
    const k = MAX_TRAVEL / dist;
    return { x: dx * k, y: dy * k };
  });
</script>

{#if stick}
  <div class="joystick" aria-hidden="true">
    <div class="base" style:left="{stick.originX}px" style:top="{stick.originY}px"></div>
    <div
      class="thumb"
      style:left="{stick.originX + thumbOffset.x}px"
      style:top="{stick.originY + thumbOffset.y}px"
    ></div>
  </div>
{/if}

<style>
  .joystick {
    position: fixed;
    inset: 0;
    z-index: var(--z-hud);
    pointer-events: none;
  }

  .base,
  .thumb {
    position: absolute;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    border: 1.5px solid var(--ui-ink);
    opacity: 0.22;
  }

  .base {
    width: 76px;
    height: 76px;
  }

  .thumb {
    width: 34px;
    height: 34px;
    background: var(--ui-ink);
    opacity: 0.18;
    border: none;
    /* Thumb motion tracks the finger directly; a calm transition here would lag input. */
    transition: none;
  }
</style>
