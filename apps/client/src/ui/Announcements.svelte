<script lang="ts">
  /**
   * Announcements — the toast region.
   *
   * Two independent things render here, stacked:
   *
   * - `$currentToast`: a networked {@link AnnouncementView}, presented one at a time.
   *   The engine/store owns when it appears and clears (see stores.ts); this component
   *   only reacts to the value changing, re-running its entrance animation via a keyed
   *   block so two announcements arriving back-to-back both get noticed.
   * - `$notices`: purely local, ephemeral notices ("Checked in", "Reconnected"). They
   *   already know their own lifetime (`notify()` in stores.ts schedules their removal),
   *   so this is just a small stack that appears/disappears as the array changes.
   *
   * `role="status"` on the toast region is what makes this accessible without a visible
   * "dismiss" control: screen readers announce the region's content changes on their own.
   * Nothing here may capture pointer events outside its own small footprint — this is a
   * notice board, not a modal, and the world underneath must stay fully interactive.
   */
  import { currentToast, notices } from '../state/stores.js';
</script>

<div class="region" role="status" aria-live="polite">
  {#if $currentToast}
    {#key $currentToast.id}
      <div class="toast" class:high={$currentToast.priority === 'high'}>
        <p class="from">{$currentToast.fromName}</p>
        <p class="text">{$currentToast.text}</p>
      </div>
    {/key}
  {/if}
</div>

{#if $notices.length > 0}
  <div class="notice-stack" aria-hidden="true">
    {#each $notices as notice (notice.id)}
      <div class="notice tone-{notice.tone}">{notice.text}</div>
    {/each}
  </div>
{/if}

<style>
  .region {
    position: fixed;
    top: max(var(--sp-xxl), env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-toast);
    pointer-events: none;
    display: flex;
    justify-content: center;
  }

  .toast {
    pointer-events: none;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-md);
    padding: var(--sp-sm) var(--sp-lg);
    max-width: min(420px, 88vw);
    text-align: center;
    animation: drop-in var(--mo-calm) both;
  }

  .toast.high {
    font-weight: 600;
  }

  @keyframes drop-in {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .from {
    margin: 0 0 2px;
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-ink-muted);
  }

  .text {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--ui-ink);
  }

  .notice-stack {
    position: fixed;
    bottom: max(var(--sp-xl), env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-toast);
    pointer-events: none;
    display: flex;
    flex-direction: column-reverse;
    align-items: center;
    gap: var(--sp-xs);
  }

  .notice {
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-sm);
    padding: 6px var(--sp-md);
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    animation: rise-in var(--mo-calm) both;
  }

  .notice.tone-good {
    color: var(--ui-live);
  }

  .notice.tone-warn {
    color: var(--ui-warn);
  }

  @keyframes rise-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
