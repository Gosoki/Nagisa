<script lang="ts">
  /**
   * Overlay — the root of the interface.
   *
   * Mounted once, over the WebGL canvas, by `mountOverlay()` (see ./index.ts). It has
   * exactly two jobs:
   *
   * 1. Inject the shared design tokens as CSS custom properties, once, so every
   *    descendant can write `var(--ui-ink)` / `var(--sp-md)` / `var(--mo-calm)` without
   *    each importing the token module itself.
   * 2. Switch between the three phases of a session (`$appPhase`) and, once in the
   *    world, mount the small set of always-present layers.
   *
   * The single most important line below is `pointer-events: none` on the root element.
   * Without it, an invisible full-viewport div sits on top of the 3D canvas and the world
   * stops receiving drag/click input — the classic "overlay bug". Every control that
   * needs the pointer (buttons, panels, the entry form, the toast region) opts back in
   * locally with its own `pointer-events: auto`, which is also why each child component
   * sets that itself rather than inheriting a blanket rule from here.
   *
   * Layering uses the named z-index tokens (`--z-*`) exclusively, per component, rather
   * than relying on DOM order — that keeps stacking correct (toast above panel above hud)
   * even though 'loading'/'entry'/'world' never actually overlap in practice.
   */
  import { tokensToCss } from '@nagisa/shared';
  import { appPhase, stickState } from '../state/stores.js';
  import Loader from './Loader.svelte';
  import Entry from './Entry.svelte';
  import Hud from './Hud.svelte';
  import ZoneCard from './ZoneCard.svelte';
  import NextUp from './NextUp.svelte';
  import Announcements from './Announcements.svelte';
  import Panels from './Panels.svelte';
  import EmoteWheel from './EmoteWheel.svelte';
  import Joystick from './Joystick.svelte';

  /**
   * Virtual-stick drag state for touch movement.
   *
   * Read from the `stickState` store, which the input layer writes on each pointer move
   * of an active drag. It is a store rather than a prop because the alternative is
   * re-rendering this component on every pointer event; `null` — the desktop case, and
   * the case whenever no finger is down — costs nothing.
   */
  const stick = stickState;

  /**
   * The loader needs to fade out rather than vanish, but Svelte only keeps a block
   * mounted while its `{#if}` condition holds. So this stays true for a short grace
   * window after the phase leaves 'loading', giving Loader's own CSS transition (see
   * Loader.svelte) time to run before the component is actually torn down.
   */
  let showLoader = $state(true);
  $effect(() => {
    if ($appPhase === 'loading') {
      showLoader = true;
      return;
    }
    if (!showLoader) return;
    // 480ms covers Loader's `--mo-calm` opacity transition with a small safety margin.
    const timer = setTimeout(() => {
      showLoader = false;
    }, 480);
    return () => clearTimeout(timer);
  });

  // Inject the token stylesheet once, imperatively. This (rather than binding the CSS
  // string into a `<svelte:head><style>{@html ...}</style></svelte:head>` template
  // expression) is deliberate: it runs exactly once regardless of reactivity, and the
  // usage is a plain function call the TypeScript checker can see, not an expression
  // buried inside a special-cased template tag.
  $effect(() => {
    const style = document.createElement('style');
    style.textContent = tokensToCss();
    document.head.appendChild(style);
    return () => style.remove();
  });
</script>

<div class="overlay">
  {#if showLoader}
    <Loader active={$appPhase === 'loading'} />
  {/if}

  {#if $appPhase === 'entry'}
    <Entry />
  {:else if $appPhase === 'world'}
    <Hud />
    <Joystick stick={$stick} />
    <ZoneCard />
    <NextUp />
    <Announcements />
    <Panels />
    <EmoteWheel />
  {/if}
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    /* The load-bearing line — see the header comment. */
    pointer-events: none;
    font-family: var(--font-sans);
    color: var(--ui-ink);
  }
</style>
