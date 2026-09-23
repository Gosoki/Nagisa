<script lang="ts">
  /**
   * WelcomeCard — the first thing said to someone who has just come ashore for the first time.
   *
   * The island explains most of itself: prompts appear where there is something to do, the
   * Next Up strip says what is on, a person can be clicked. What it cannot show is the handful
   * of controls that make the rest discoverable, and that the day runs on its own clock. So
   * this says those, once, in five lines, and gets out of the way. It is remembered per browser
   * (a convenience: if storage is unavailable it simply shows again), and the settings panel
   * can bring it back.
   *
   * Touch and pointer get different words for moving and looking, because they are different
   * hands.
   */
  import { onMount } from 'svelte';
  import { connectionState, welcomeOpen } from '../state/stores.js';
  import { t } from '../i18n/index.js';

  const SEEN_KEY = 'nagisa.welcomed';

  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  onMount(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      /* Storage refused: show it; there is no remembering either way. */
    }
    if (!seen) welcomeOpen.set(true);
  });

  function close(): void {
    welcomeOpen.set(false);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* Not remembered; shown again next time, which is harmless. */
    }
  }

  function onKey(e: KeyboardEvent): void {
    if ($welcomeOpen && $connectionState !== 'closed' && e.key === 'Escape') close();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- Stood aside while the connection is closed: the card that says so is the one thing to do. -->
{#if $welcomeOpen && $connectionState !== 'closed'}
  <div class="welcome" role="dialog" aria-modal="false" aria-labelledby="welcome-title">
    <h2 class="title" id="welcome-title">{$t('welcome.title')}</h2>
    <ul class="lines">
      <li>{touch ? $t('welcome.moveTouch') : $t('welcome.moveKeys')}</li>
      <li>{touch ? $t('welcome.useTouch') : $t('welcome.useKeys')}</li>
      <li>{$t('welcome.people')}</li>
      <li>{$t('welcome.day')}</li>
      <li>{$t('welcome.today')}</li>
    </ul>
    <button type="button" class="go" onclick={close}>{$t('welcome.go')}</button>
  </div>
{/if}

<style>
  .welcome {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: var(--z-hud);
    pointer-events: auto;
    width: min(380px, calc(100vw - 2 * var(--sp-md)));
    box-sizing: border-box;
    padding: var(--sp-lg) var(--sp-lg) var(--sp-md);
    border-radius: var(--r-panel);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
  }

  .title {
    margin: 0 0 var(--sp-sm);
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--ui-ink);
  }

  .lines {
    margin: 0 0 var(--sp-md);
    padding-left: 1.1em;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--ui-ink-muted);
  }

  .go {
    display: block;
    margin-left: auto;
    border: none;
    border-radius: 999px;
    padding: 8px 18px;
    background: var(--ui-accent);
    color: var(--ui-surface-raised);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .go:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }
</style>
