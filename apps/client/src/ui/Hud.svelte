<script lang="ts">
  /**
   * Hud — the persistent in-world layer, shown while `$appPhase === 'world'`.
   *
   * This is the "always on" surface, so it is held to the tightest budget in the whole
   * overlay: the headcount and up to four small icon buttons top-right, and one emote
   * button plus an occasional contextual prompt bottom-centre. Nothing here is a panel —
   * the icon buttons only *open* panels, which live in Panels.svelte and are absent from
   * the screen until requested.
   *
   * The top-*left* corner is the minimap's, and the name of the place you are standing in
   * goes underneath it (see Minimap.svelte) rather than here. Two facts about your
   * location belong next to each other; the headcount is a fact about the room, so it
   * moved across to sit with the button that lists the people in it.
   *
   * The host button is the one piece of chrome that appears/disappears based on state
   * (`$isHost`), rather than always being present and disabled — an inert 4th icon would
   * imply "there is a host feature here you don't have", which is a worse default than
   * simply not showing it.
   */
  import {
    currentZone,
    population,
    isHost,
    openPanel,
    interactPrompt,
    emoteOpen,
    connectionTroubled,
    devMode,
    settings,
    togglePanel,
    cmd,
  } from '../state/stores.js';
</script>

<!--
  The place name normally lives under the minimap, in Minimap.svelte, so that "where am I"
  and "where is that" are one glance rather than two corners. This is the fallback for a
  session with the minimap switched off, which would otherwise lose the name entirely.
-->
{#if $currentZone && $settings.minimap === false}
  <div class="top-left">
    <div class="zone">
      <span class="zone-name">{$currentZone.name}</span>
      <span class="zone-ja">{$currentZone.nameJa}</span>
    </div>
  </div>
{/if}

{#if $connectionTroubled}
  <p class="reconnecting" role="status">Reconnecting…</p>
{/if}


<div class="top-right">
  <!-- How many people are here, beside the button that says who they are. -->
  <div class="population" aria-label="{$population} on the island">
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <circle cx="12" cy="8" r="3.4" fill="currentColor" />
      <path d="M5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </svg>
    <span>{$population}</span>
  </div>

  <button
    type="button"
    class="icon-btn"
    class:active={$openPanel === 'people'}
    aria-label="People"
    aria-pressed={$openPanel === 'people'}
    onclick={() => togglePanel('people')}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="17" cy="9.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M3.5 19c0-3.4 2.5-5.6 5.5-5.6s5.5 2.2 5.5 5.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <path d="M15 19c0-2.4 1.3-4.4 3.2-5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  </button>

  <button
    type="button"
    class="icon-btn"
    class:active={$openPanel === 'activities'}
    aria-label="Activities"
    aria-pressed={$openPanel === 'activities'}
    onclick={() => togglePanel('activities')}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M4 9.5H20" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 3.2V6.5M16 3.2V6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  </button>

  <button
    type="button"
    class="icon-btn"
    class:active={$openPanel === 'settings'}
    aria-label="Settings"
    aria-pressed={$openPanel === 'settings'}
    onclick={() => togglePanel('settings')}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M6 5V13.5M6 13.5a2 2 0 100 4 2 2 0 000-4zM12 6.5a2 2 0 100 4 2 2 0 000-4zM12 10.5V19M18 5V9.5M18 9.5a2 2 0 100 4 2 2 0 000-4zM18 13.5V19" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  </button>

  <!-- Developer placement notes. Absent unless ?dev=1 — see `devMode` in stores.ts. -->
  {#if devMode}
    <button
      type="button"
      class="icon-btn"
      class:active={$openPanel === 'notes'}
      aria-label="Placement notes"
      aria-pressed={$openPanel === 'notes'}
      onclick={() => togglePanel('notes')}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M12 21s6.5-6.1 6.5-10.5a6.5 6.5 0 10-13 0C5.5 14.9 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        <circle cx="12" cy="10.3" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </button>
  {/if}

  {#if $isHost}
    <button
      type="button"
      class="icon-btn"
      class:active={$openPanel === 'host'}
      aria-label="Host controls"
      aria-pressed={$openPanel === 'host'}
      onclick={() => togglePanel('host')}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M6 20V5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path d="M6 5.5L17 8.5L6 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    </button>
  {/if}
</div>

<div class="bottom-center">
  {#if $interactPrompt}
    <button type="button" class="prompt" onclick={() => cmd().interact()}>
      <span>{$interactPrompt.label}</span>
      <kbd class="key-hint">E</kbd>
    </button>
  {/if}

  <button
    type="button"
    class="emote-btn"
    class:active={$emoteOpen}
    aria-label="Emotes"
    aria-pressed={$emoteOpen}
    onclick={() => emoteOpen.update((v) => !v)}
  >
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="9" cy="10.2" r="1" fill="currentColor" />
      <circle cx="15" cy="10.2" r="1" fill="currentColor" />
      <path d="M8.5 14.2c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  </button>
</div>

<style>
  .top-left {
    position: fixed;
    top: max(var(--sp-md), env(safe-area-inset-top));
    left: max(var(--sp-md), env(safe-area-inset-left));
    z-index: var(--z-hud);
    display: flex;
    flex-direction: column;
    gap: 2px;
    pointer-events: none;
  }

  .zone-name {
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-ink-muted);
  }

  .zone-ja {
    margin-left: var(--sp-xs);
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  /**
   * A pill, not bare text.
   *
   * Sitting in the top-left over a dark quay it was legible; moved up beside the icon
   * buttons it is over whatever the camera happens to be pointing at, and `--ui-ink-faint`
   * on pale stone is nothing at all. Everything else in this corner solves that by standing
   * on `--ui-surface`, so this does too — and matching the buttons' 32 px height is what
   * keeps the row on one baseline.
   */
  .population {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 32px;
    padding: 0 11px;
    border-radius: 999px;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--ui-ink-muted);
  }

  .reconnecting {
    position: fixed;
    top: max(var(--sp-md), env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-hud);
    margin: 0;
    font-size: var(--fs-xs);
    letter-spacing: 0.04em;
    color: var(--ui-warn);
    pointer-events: none;
  }

  .top-right {
    position: fixed;
    top: max(var(--sp-md), env(safe-area-inset-top));
    right: max(var(--sp-md), env(safe-area-inset-right));
    z-index: var(--z-hud);
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    pointer-events: auto;
  }

  .icon-btn {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    background: var(--ui-surface);
    color: var(--ui-ink-muted);
    box-shadow: var(--ui-shadow);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: color var(--mo-quick), background var(--mo-quick);
  }

  .icon-btn.active {
    color: var(--ui-ink);
    background: var(--ui-surface-raised);
  }

  .icon-btn:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }

  .bottom-center {
    position: fixed;
    bottom: max(var(--sp-lg), env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-hud);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-sm);
    pointer-events: none;
  }

  .prompt {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    border: none;
    border-radius: var(--r-lg);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    color: var(--ui-ink);
    font-size: var(--fs-sm);
    padding: 6px var(--sp-md);
    cursor: pointer;
    animation: rise var(--mo-calm) both;
  }

  .key-hint {
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    border: 1px solid var(--ui-line);
    border-radius: var(--r-sm);
    padding: 0 5px;
  }

  @media (pointer: coarse) {
    .key-hint {
      display: none;
    }
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .emote-btn {
    pointer-events: auto;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: var(--ui-surface);
    color: var(--ui-ink-muted);
    box-shadow: var(--ui-shadow);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: color var(--mo-quick), background var(--mo-quick);
  }

  .emote-btn.active {
    color: var(--ui-ink);
    background: var(--ui-surface-raised);
  }

  .emote-btn:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }
</style>
