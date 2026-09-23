<script lang="ts">
  /**
   * Panels — the single small paper panel anchored under the top-right icon buttons.
   *
   * `$openPanel` (stores.ts) is a single nullable value by construction — "only ever one
   * [panel], and null most of the time" — so this component doesn't need to coordinate
   * multiple panels at once, only pick which body to show inside one shell. The shell
   * (positioning, sizing, shadow, close affordances) lives here; each panel's own content
   * lives in its own file (PeoplePanel / ActivitiesPanel / SettingsPanel / HostPanel, and
   * the games' BoardPanel / CollectionPanel / IslandPanel) so none of them has to duplicate
   * the max-width/scroll/close behaviour.
   *
   * The three game panels get a slightly wider shell: a stamp card, a fish book and an
   * invite link want a few more columns than a list of names. The shell is capped to the
   * viewport height and scrolls as a whole, so a long collection book still ends on screen
   * on a phone held sideways.
   *
   * Two ways to close, both keyboard- and pointer-friendly: Escape, and a pointerdown
   * anywhere outside the panel. The outside-click listener is attached to `window` only
   * while a panel is open, rather than as a permanent full-screen backdrop div — an
   * always-present invisible catcher would be exactly the "stray full-screen div" bug the
   * root Overlay is built to avoid. A pointerdown on a control marked `data-panel-toggle`
   * (the HUD's panel buttons) is left to that control, so pressing the button of the open
   * panel closes it instead of closing and immediately re-opening it.
   */
  import { openPanel, type PanelId } from '../state/stores.js';
  import { t } from '../i18n/index.js';
  import PeoplePanel from './PeoplePanel.svelte';
  import ActivitiesPanel from './ActivitiesPanel.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import HostPanel from './HostPanel.svelte';
  import NotesPanel from './NotesPanel.svelte';
  import BoardPanel from './BoardPanel.svelte';
  import CollectionPanel from './CollectionPanel.svelte';
  import IslandPanel from './IslandPanel.svelte';

  const TITLE_KEYS: Record<Exclude<PanelId, null>, string> = {
    people: 'panel.people',
    activities: 'panel.activities',
    settings: 'panel.settings',
    host: 'panel.host',
    notes: 'panel.notes',
    board: 'panel.board',
    collection: 'panel.collection',
    island: 'panel.island',
  };

  /** Panels whose contents are laid out in more than one column. */
  const WIDE: ReadonlySet<PanelId> = new Set<PanelId>(['board', 'collection', 'island']);

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
      if (!(e.target instanceof Node) || !panelEl || panelEl.contains(e.target)) return;
      if (e.target instanceof Element && e.target.closest('[data-panel-toggle]')) return;
      close();
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
  <div
    class="panel"
    class:wide={WIDE.has($openPanel)}
    role="dialog"
    aria-label={$t(TITLE_KEYS[$openPanel])}
    bind:this={panelEl}
  >
    <div class="header">
      <span class="title">{$t(TITLE_KEYS[$openPanel])}</span>
      <button type="button" class="close" aria-label={$t('panel.close')} onclick={close}>×</button>
    </div>

    {#if $openPanel === 'people'}
      <PeoplePanel />
    {:else if $openPanel === 'activities'}
      <ActivitiesPanel />
    {:else if $openPanel === 'settings'}
      <SettingsPanel />
    {:else if $openPanel === 'host'}
      <HostPanel />
    {:else if $openPanel === 'notes'}
      <NotesPanel />
    {:else if $openPanel === 'board'}
      <BoardPanel />
    {:else if $openPanel === 'collection'}
      <CollectionPanel />
    {:else if $openPanel === 'island'}
      <IslandPanel />
    {/if}
  </div>
{/if}

<style>
  .panel {
    --panel-top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 40px);
    position: fixed;
    top: var(--panel-top);
    right: max(var(--sp-md), env(safe-area-inset-right));
    z-index: var(--z-panel);
    pointer-events: auto;
    /* Content-box: the viewport less both margins and both paddings. */
    width: min(300px, calc(100vw - 4 * var(--sp-md)));
    /* The viewport below the panel's top, less its own vertical padding (content-box). */
    --panel-room: calc(var(--panel-top) + max(var(--sp-md), env(safe-area-inset-bottom)) + var(--sp-sm) + var(--sp-md));
    max-height: calc(100vh - var(--panel-room));
    max-height: calc(100dvh - var(--panel-room));
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-panel);
    padding: var(--sp-sm) var(--sp-md) var(--sp-md);
    animation: settle var(--mo-calm) both;
  }

  .panel.wide {
    width: min(372px, calc(100vw - 4 * var(--sp-md)));
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
