<script lang="ts">
  /**
   * Loader — shown while `$appPhase === 'loading'`.
   *
   * This is the very first thing anyone sees, so it gets the most restraint of any
   * screen in the overlay: full-bleed paper, one small ink-stroke mark, a quiet progress
   * label, and a hairline rule. Nothing about it should read as a "loading screen" in the
   * app/game sense — no spinner, no percentage counter, no bouncing dots.
   *
   * The mark is three horizontal wave strokes (渚 — Nagisa means "shore, where the water
   * meets the land") drawn as plain SVG paths with a very slow, small horizontal drift.
   * The drift is intentionally subtle: rule 6 is "calm motion", and a loader mark that
   * pulses or bounces would be the first thing to break that promise.
   *
   * Fade-out is driven by the `active` prop rather than this component's own lifecycle:
   * Overlay.svelte keeps this mounted for a short grace window after `$appPhase` leaves
   * 'loading' specifically so this CSS opacity transition has time to finish before the
   * DOM node is removed.
   */
  import { loadProgress } from '../state/stores.js';

  let { active }: { active: boolean } = $props();
</script>

<div class="loader" class:hidden={!active} role="status" aria-live="polite">
  <svg class="mark" viewBox="0 0 120 60" width="72" height="36" aria-hidden="true">
    <path class="wave wave-1" d="M4 20 Q 20 10, 36 20 T 68 20 T 100 20 T 116 20" />
    <path class="wave wave-2" d="M4 32 Q 20 22, 36 32 T 68 32 T 100 32 T 116 32" />
    <path class="wave wave-3" d="M4 44 Q 20 34, 36 44 T 68 44 T 100 44 T 116 44" />
  </svg>

  <p class="label">{$loadProgress.label}</p>

  <div class="rule">
    <div class="rule-fill" style:width="{Math.round(Math.min(1, Math.max(0, $loadProgress.value)) * 100)}%"></div>
  </div>
</div>

<style>
  .loader {
    position: fixed;
    inset: 0;
    z-index: var(--z-loader);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-lg);
    background: var(--ui-surface);
    opacity: 1;
    transition: opacity var(--mo-calm);
  }

  .loader.hidden {
    opacity: 0;
  }

  .mark {
    overflow: visible;
  }

  .wave {
    fill: none;
    stroke: var(--ui-ink);
    stroke-width: 2;
    stroke-linecap: round;
    opacity: 0.55;
    animation: drift 5.5s ease-in-out infinite;
  }

  .wave-2 {
    opacity: 0.35;
    animation-duration: 6.5s;
    animation-delay: -1.2s;
  }

  .wave-3 {
    opacity: 0.22;
    animation-duration: 7.5s;
    animation-delay: -2.6s;
  }

  @keyframes drift {
    0%,
    100% {
      transform: translateX(0);
    }
    50% {
      transform: translateX(4px);
    }
  }

  .label {
    margin: 0;
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-ink-muted);
  }

  .rule {
    width: 128px;
    height: 1px;
    background: var(--ui-line);
    overflow: hidden;
  }

  .rule-fill {
    height: 100%;
    background: var(--ui-ink-faint);
    transition: width var(--mo-slow);
  }

  @media (prefers-reduced-motion: reduce) {
    .wave {
      animation: none;
    }
  }
</style>
