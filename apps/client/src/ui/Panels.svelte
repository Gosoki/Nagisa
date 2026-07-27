<script lang="ts">
  /**
   * Panels — the single small paper panel anchored under the top-right icon buttons.
   *
   * `$openPanel` (stores.ts) is a single nullable value by construction — "only ever one
   * [panel], and null most of the time" — so this component doesn't need to coordinate
   * multiple panels at once, only pick which body to show inside one shell. The shell
   * (positioning, sizing, shadow, close affordances) lives here; each panel's own content
   * lives in its own file (PeoplePanel / ActivitiesPanel / SettingsPanel / HostPanel) so
   * none of them has to duplicate the max-width/scroll/close behaviour.
   *
   * Two ways to close, both keyboard- and pointer-friendly: Escape, and a pointerdown
   * anywhere outside the panel. The outside-click listener is attached to `window` only
   * while a panel is open, rather than as a permanent full-screen backdrop div — an
   * always-present invisible catcher would be exactly the "stray full-screen div" bug the
   * root Overlay is built to avoid.
   */
  import { openPanel } from '../state/stores.js';
  import PeoplePanel from './PeoplePanel.svelte';
  import ActivitiesPanel from './ActivitiesPanel.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import HostPanel from './HostPanel.svelte';

  const TITLES = {
    people: 'People',
    activities: 'Activities',
    settings: 'Settings',
    host: 'Host',
  } as const;

  let panelEl: HTMLElement | undefined = $state();

  function close(): void {
    openPanel.set(null);
  }

  $effect(() => {
    if ($openPanel === null) return;

    function onKeydown(e: KeyboardEvent): void {
      if (e.key === 'Escape') close();
    }
    function onPointerdown(e: PointerEvent): void {
      if (panelEl && e.target instanceof Node && !panelEl.contains(e.target)) close();
    }

    window.addEventListener('keydown', onKeydown);
    window.addEventListener('pointerdown', onPointerdown);
    return () => {
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('pointerdown', onPointerdown);
    };
  });
</script>

{#if $openPanel}
  <div class="panel" role="dialog" aria-label={TITLES[$openPanel]} bind:this={panelEl}>
    <div class="header">
      <span class="title">{TITLES[$openPanel]}</span>
      <button type="button" class="close" aria-label="Close panel" onclick={close}>×</button>
    </div>

    {#if $openPanel === 'people'}
      <PeoplePanel />
    {:else if $openPanel === 'activities'}
      <ActivitiesPanel />
    {:else if $openPanel === 'settings'}
      <SettingsPanel />
    {:else if $openPanel === 'host'}
      <HostPanel />
    {/if}
  </div>
{/if}

<style>
  .panel {
    position: fixed;
    top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 40px);
    right: max(var(--sp-md), env(safe-area-inset-right));
    z-index: var(--z-panel);
    pointer-events: auto;
    width: min(300px, calc(100vw - 2 * var(--sp-md)));
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-panel);
    padding: var(--sp-sm) var(--sp-md) var(--sp-md);
    animation: settle var(--mo-calm) both;
  }

  @keyframes settle {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: var(--sp-xs);
    margin-bottom: var(--sp-xs);
    border-bottom: 1px solid var(--ui-line);
  }

  .title {
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-ink-muted);
  }

  .close {
    border: none;
    background: transparent;
    color: var(--ui-ink-faint);
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 0 2px;
    cursor: pointer;
  }

  .close:hover {
    color: var(--ui-ink);
  }

  .close:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }
</style>
