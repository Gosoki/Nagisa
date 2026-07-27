<script lang="ts">
  /**
   * NextUp — a small paper strip surfacing the single most relevant activity.
   *
   * `$nextUp` (stores.ts) already does the hard work of picking *one* activity out of
   * everything happening on the island — that priority logic is what keeps this a quiet
   * strip instead of an events dashboard, so this component's only job is to display its
   * choice and offer the one or two actions that make sense for its current state.
   *
   * Placed top-centre, under the zone label's row height, so it never collides with the
   * emote button/interact prompt that live bottom-centre in Hud.svelte. Renders nothing
   * at all when `$nextUp` is null — an empty strip would just be UI for its own sake.
   *
   * The relative time ("in 12 min") is recomputed every 10s, which is frequent enough to
   * feel alive without a per-second ticking clock — a countdown that visibly ticks down
   * digit-by-digit is exactly the kind of "demands attention" motion rule 6 rules out.
   */
  import { getZone, ActivityState } from '@nagisa/shared';
  import { nextUp, self, cmd } from '../state/stores.js';

  let now = $state(Date.now());

  $effect(() => {
    const interval = setInterval(() => {
      now = Date.now();
    }, 10_000);
    return () => clearInterval(interval);
  });

  const label = $derived.by(() => {
    const a = $nextUp;
    if (!a) return '';
    if (a.state === ActivityState.Live) return 'Live now';
    const diffMs = a.startsAt - now;
    if (diffMs <= 0) return 'Starting';
    const mins = Math.round(diffMs / 60_000);
    if (mins < 1) return 'Starting';
    if (mins < 60) return `in ${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
  });

  const venueName = $derived($nextUp ? (getZone($nextUp.zone)?.name ?? $nextUp.zone) : '');

  const joinable = $derived(
    $nextUp !== null && ($nextUp.state === ActivityState.Open || $nextUp.state === ActivityState.Live),
  );
  const attached = $derived($nextUp !== null && $self.activity === $nextUp.id);
</script>

{#if $nextUp}
  <div class="strip">
    <div class="text">
      <p class="title">{$nextUp.title}</p>
      <p class="meta">{venueName} · {label}</p>
    </div>

    {#if joinable}
      <div class="actions">
        {#if attached}
          <button type="button" class="action" onclick={() => cmd().leaveActivity()}>Leave</button>
        {:else}
          <button type="button" class="action primary" onclick={() => cmd().joinActivity($nextUp!.id, 'participant')}>
            Join
          </button>
          <button type="button" class="action" onclick={() => cmd().joinActivity($nextUp!.id, 'audience')}>
            Watch
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .strip {
    position: fixed;
    top: max(var(--sp-md), env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-hud);
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: var(--sp-md);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-lg);
    padding: 6px var(--sp-md);
    max-width: min(380px, 88vw);
    animation: settle var(--mo-calm) both;
  }

  @keyframes settle {
    from {
      opacity: 0;
      transform: translate(-50%, -4px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  .text {
    min-width: 0;
  }

  .title {
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    margin: 1px 0 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actions {
    display: flex;
    gap: var(--sp-xs);
    flex-shrink: 0;
  }

  .action {
    border: 1px solid var(--ui-line);
    background: transparent;
    border-radius: var(--r-sm);
    padding: 4px var(--sp-sm);
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    cursor: pointer;
    white-space: nowrap;
  }

  .action.primary {
    background: var(--ui-accent);
    border-color: var(--ui-accent);
    color: var(--ui-surface-raised);
    font-weight: 600;
  }

  .action:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }

  @media (max-width: 420px) {
    .strip {
      flex-direction: column;
      align-items: stretch;
      gap: var(--sp-xs);
    }
  }
</style>
