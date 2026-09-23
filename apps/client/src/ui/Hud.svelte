<script lang="ts">
  /**
   * Hud — the persistent in-world layer, shown while `$appPhase === 'world'`.
   *
   * This is the "always on" surface, so it is held to the tightest budget in the whole
   * overlay: the headcount and four small icon buttons top-right, and one emote button plus
   * an occasional contextual prompt bottom-centre. Nothing here is a panel — the icon
   * buttons only *open* panels, which live in Panels.svelte and are absent from the screen
   * until requested.
   *
   * ### The fourth button
   *
   * People, activities and settings are what a visit is mostly made of, so they stay in the
   * row. The collection book, the island panel and the camera are reached through one
   * "more" button that folds out a short labelled list. Six icons in a row is a toolbar,
   * and on a 360 px phone it is a wall; the labels in the fold-out also say what each thing
   * is, which three more unexplained glyphs would not. It is a disclosure (a button with
   * `aria-expanded` and a list of ordinary buttons), not an ARIA menu, because it needs
   * none of a menu's arrow-key contract and pretending otherwise would be worse than not.
   *
   * The top-*left* corner is the minimap's, and the name of the place you are standing in
   * goes underneath it (see Minimap.svelte) rather than here. Two facts about your
   * location belong next to each other; the headcount is a fact about the room, so it
   * moved across to sit with the button that lists the people in it.
   *
   * The host button is the one piece of chrome that appears/disappears based on role
   * (`$isHost`), rather than always being present and disabled — an inert icon would imply
   * "there is a host feature here you don't have", which is a worse default than simply not
   * showing it.
   *
   * ### Bottom centre
   *
   * The interaction prompt names what is in reach, in the current language: it is
   * re-derived from the interactable's effect rather than read from the label stored when
   * it was found, so switching language with a prompt up changes it at once. While a line
   * is in the water the fishing HUD shows its own strike and reel controls, so the prompt
   * (and the firework button) step aside rather than offer a second, competing button.
   *
   * The firework button exists only while you stand on a shore fireworks go up from. It
   * rests for as long as the server's own per-person interval after each launch, so a
   * second press does not earn a refusal notice.
   */
  import {
    currentZone,
    population,
    isHost,
    openPanel,
    interactPrompt,
    emoteOpen,
    connectionState,
    connectionTroubled,
    friends,
    replacedElsewhere,
    devMode,
    settings,
    self,
    fishing,
    onFireworkShore,
    onDanceFloor,
    dancing,
    togglePanel,
    cmd,
  } from '../state/stores.js';
  import { interactLabel, lang, t, zoneName } from '../i18n/index.js';

  /** The server allows one firework per person every six seconds. */
  const FIREWORK_REST_MS = 6000;

  let moreOpen = $state(false);
  let moreEl: HTMLElement | undefined = $state();
  let moreButton: HTMLButtonElement | undefined = $state();
  let fireworkResting = $state(false);

  const lineOut = $derived($fishing.phase === 'waiting' || $fishing.phase === 'bite');

  const promptLabel = $derived.by(() => {
    const prompt = $interactPrompt;
    if (!prompt) return '';
    if (prompt.kind === 'sit' && $self.seated) return $t('prompt.stand');
    return interactLabel(prompt.effect, prompt.kind, $lang);
  });

  const zoneSecondary = $derived(
    $currentZone && $lang !== 'ja' && $currentZone.nameJa !== zoneName($currentZone.id, $lang)
      ? $currentZone.nameJa
      : '',
  );

  function toggleMore(): void {
    moreOpen = !moreOpen;
    // One thing open at a time: the fold-out and a panel never share the corner.
    if (moreOpen) openPanel.set(null);
  }

  function openFromMore(id: 'collection' | 'island'): void {
    moreOpen = false;
    togglePanel(id);
  }

  function photo(): void {
    moreOpen = false;
    cmd().takePhoto();
  }

  function sendFirework(): void {
    if (fireworkResting) return;
    cmd().firework();
    fireworkResting = true;
    setTimeout(() => (fireworkResting = false), FIREWORK_REST_MS);
  }

  $effect(() => {
    if (!moreOpen) return;
    function onKeydown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      moreOpen = false;
      moreButton?.focus();
    }
    function onPointerdown(e: PointerEvent): void {
      if (moreEl && e.target instanceof Node && !moreEl.contains(e.target)) moreOpen = false;
    }
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('pointerdown', onPointerdown);
    return () => {
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('pointerdown', onPointerdown);
    };
  });
</script>

<!--
  The place name normally lives under the minimap, in Minimap.svelte, so that "where am I"
  and "where is that" are one glance rather than two corners. This is the fallback for a
  session with the minimap switched off, which would otherwise lose the name entirely.
-->
{#if $currentZone && $settings.minimap === false}
  <div class="top-left">
    <div class="zone">
      <span class="zone-name">{zoneName($currentZone.id, $lang)}</span>
      {#if zoneSecondary}<span class="zone-ja" lang="ja">{zoneSecondary}</span>{/if}
    </div>
  </div>
{/if}

{#if $connectionState === 'closed'}
  <!-- Not retrying, so saying "reconnecting" would be a promise nothing keeps. -->
  <div class="closed" role="alert">
    <span>{$t($replacedElsewhere ? 'net.replaced' : 'net.closed')}</span>
    <button type="button" onclick={() => cmd().reconnect()}>{$t($replacedElsewhere ? 'net.useHere' : 'net.reload')}</button>
  </div>
{:else if $connectionTroubled}
  <p class="reconnecting" role="status">{$t('net.reconnecting')}</p>
{/if}


<div class="top-right" class:raised={moreOpen}>
  <!-- How many people are here, beside the button that says who they are. -->
  <div class="population" aria-label={$t('hud.population', { n: $population })}>
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
    aria-label={$friends.requests.length ? $t('panel.peopleAsks', { n: $friends.requests.length }) : $t('panel.people')}
    aria-pressed={$openPanel === 'people'}
    data-panel-toggle
    onclick={() => togglePanel('people')}
  >
    <!-- Someone asked to be friends: the notice was brief, the answer is in this panel. -->
    {#if $friends.requests.length}<span class="pip" aria-hidden="true"></span>{/if}
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
    aria-label={$t('panel.activities')}
    aria-pressed={$openPanel === 'activities'}
    data-panel-toggle
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
    aria-label={$t('panel.settings')}
    aria-pressed={$openPanel === 'settings'}
    data-panel-toggle
    onclick={() => togglePanel('settings')}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M6 5V13.5M6 13.5a2 2 0 100 4 2 2 0 000-4zM12 6.5a2 2 0 100 4 2 2 0 000-4zM12 10.5V19M18 5V9.5M18 9.5a2 2 0 100 4 2 2 0 000-4zM18 13.5V19" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  </button>

  <!-- Collection, island, camera: one button, a short labelled fold-out. -->
  <div class="more" bind:this={moreEl}>
    <button
      type="button"
      class="icon-btn"
      class:active={moreOpen || $openPanel === 'collection' || $openPanel === 'island'}
      aria-label={$t('hud.more')}
      aria-expanded={moreOpen}
      aria-controls="hud-more"
      bind:this={moreButton}
      onclick={toggleMore}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle cx="6" cy="12" r="1.5" fill="currentColor" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
        <circle cx="18" cy="12" r="1.5" fill="currentColor" />
      </svg>
    </button>

    {#if moreOpen}
      <div class="fold" id="hud-more">
        <button type="button" class="item" data-panel-toggle onclick={() => openFromMore('collection')}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M4.5 6c2.6-1.1 5.1-1 7.5.6 2.4-1.6 4.9-1.7 7.5-.6v12.5c-2.6-1.1-5.1-1-7.5.6-2.4-1.6-4.9-1.7-7.5-.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            <path d="M12 6.6V19" stroke="currentColor" stroke-width="1.5" />
          </svg>
          <span class="item-text">
            <span class="item-label">{$t('panel.collection')}</span>
            <span class="item-hint">{$t('hud.collectionHint')}</span>
          </span>
        </button>
        <button type="button" class="item" data-panel-toggle onclick={() => openFromMore('island')}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M6 15.5c1.6-4 3.6-6 6-6s4.4 2 6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <path d="M3.5 18.5c1.4-1 2.8-1 4.2 0s2.8 1 4.3 0 2.8-1 4.3 0 2.8 1 4.2 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <span class="item-text">
            <span class="item-label">{$t('panel.island')}</span>
            <span class="item-hint">{$t('hud.islandHint')}</span>
          </span>
        </button>
        <button type="button" class="item" onclick={photo}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <rect x="3.5" y="7" width="17" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M8.5 7l1.4-2.2h4.2L15.5 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            <circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
          <span class="item-text">
            <span class="item-label">{$t('hud.photo')}</span>
            <span class="item-hint">{$t('hud.photoHint')}</span>
          </span>
        </button>
      </div>
    {/if}
  </div>

  <!-- Developer placement notes. Absent unless ?dev=1 — see `devMode` in stores.ts. -->
  {#if devMode}
    <button
      type="button"
      class="icon-btn"
      class:active={$openPanel === 'notes'}
      aria-label={$t('panel.notes')}
      aria-pressed={$openPanel === 'notes'}
      data-panel-toggle
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
      aria-label={$t('hud.host')}
      aria-pressed={$openPanel === 'host'}
      data-panel-toggle
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
  {#if ($interactPrompt || $onFireworkShore || $onDanceFloor) && !lineOut}
    <div class="prompts">
      {#if $interactPrompt}
        <button type="button" class="prompt" onclick={() => cmd().interact()}>
          <span>{promptLabel}</span>
          <kbd class="key-hint">E</kbd>
        </button>
      {/if}
      {#if $onFireworkShore}
        <button type="button" class="prompt firework" disabled={fireworkResting} onclick={sendFirework}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2L18 18M6 18l2.8-2.8M15.2 8.8L18 6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
          <span>{$t('hud.firework')}</span>
        </button>
      {/if}
      {#if $onDanceFloor}
        <!-- Bon-odori at the concert: on the spot, on everyone's beat, until you walk off. -->
        <button type="button" class="prompt" class:active={$dancing} aria-pressed={$dancing} onclick={() => cmd().dance(!$dancing)}>
          <span aria-hidden="true">🏮</span>
          <span>{$dancing ? $t('hud.stopDance') : $t('hud.dance')}</span>
        </button>
      {/if}
    </div>
  {/if}

  <button
    type="button"
    class="emote-btn"
    class:active={$emoteOpen}
    aria-label={$t('hud.emotes')}
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

  /* In the middle, not in the top strip: the world has stopped, this is the one thing to do,
     and on a phone the strip is already full of the headcount and its buttons. */
  .closed {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: var(--z-hud);
    /* The overlay passes pointers through to the world; this card is meant to be pressed. */
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-sm);
    width: max-content;
    max-width: min(320px, calc(100vw - 2 * var(--sp-md)));
    padding: var(--sp-md);
    border-radius: var(--r-lg);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    font-size: var(--fs-sm);
    text-align: center;
    color: var(--ui-ink);
  }

  .closed button {
    flex: none;
    border: none;
    border-radius: 999px;
    padding: 6px 12px;
    background: var(--ui-accent);
    color: var(--ui-surface-raised);
    font: inherit;
    cursor: pointer;
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

  /* The fold-out must sit over the next-up strip, which shares the HUD layer. */
  .top-right.raised {
    z-index: var(--z-panel);
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

  .icon-btn {
    position: relative;
  }

  .pip {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ui-accent);
    box-shadow: 0 0 0 1.5px var(--ui-surface);
  }

  .icon-btn:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }

  .more {
    position: relative;
  }

  .fold {
    position: absolute;
    top: calc(100% + var(--sp-sm));
    right: 0;
    width: max-content;
    max-width: calc(100vw - 2 * var(--sp-md));
    display: flex;
    flex-direction: column;
    padding: var(--sp-xs);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-lg);
    animation: settle var(--mo-calm) both;
  }

  @keyframes settle {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    border: none;
    background: transparent;
    border-radius: var(--r-md);
    padding: 6px var(--sp-sm);
    color: var(--ui-ink-muted);
    text-align: left;
    cursor: pointer;
  }

  .item:hover {
    background: var(--ui-surface-sunk);
    color: var(--ui-ink);
  }

  .item:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: -2px;
  }

  .item svg {
    flex: none;
  }

  .item-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .item-label {
    font-size: var(--fs-sm);
    color: var(--ui-ink);
  }

  .item-hint {
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .bottom-center {
    position: fixed;
    bottom: max(var(--sp-lg), env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%);
    /* Sized to its contents, not to the half-viewport `left: 50%` leaves it, or two prompts
       side by side wrap into a column on a phone. */
    width: max-content;
    max-width: calc(100vw - 2 * var(--sp-md));
    z-index: var(--z-hud);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-sm);
    pointer-events: none;
  }

  /* On a phone the minimap has the bottom-left corner (see Minimap.svelte, 112 px there): the
     prompts keep to the width beside it and wrap, rather than being laid over the map when a
     label is long — the Japanese and English ones are. */
  @media (max-width: 640px) {
    .bottom-center {
      left: calc(var(--sp-md) + 112px + var(--sp-sm));
      right: var(--sp-md);
      transform: none;
      width: auto;
      max-width: none;
    }
  }

  .prompts {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--sp-xs);
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
    white-space: nowrap;
    cursor: pointer;
    animation: rise var(--mo-calm) both;
  }

  .prompt:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }

  .prompt.active {
    background: var(--ui-surface-raised);
    color: var(--ui-accent);
  }

  .firework svg {
    color: var(--ui-accent);
  }

  .firework:disabled {
    color: var(--ui-ink-faint);
    cursor: default;
  }

  .firework:disabled svg {
    color: inherit;
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
