<script lang="ts">
  /**
   * FishingHud — your line in the water, bottom-centre, just above the emote button.
   *
   * Three moments, and only three get anything on screen:
   *
   * - **waiting** — a quiet line saying so, and a way to reel in. Fishing is mostly waiting,
   *   and the card is sized for that: small enough to sit there for half a minute unnoticed.
   * - **bite** — the one moment in the whole interface that is *meant* to be seized, so the
   *   strike button is large and plain to hit with a thumb. A thin bar under it shrinks over
   *   the strike window. It is a CSS animation started at a negative delay computed from when
   *   the bite actually arrived (`biteAt`, `performance.now` time), so a card mounted a frame
   *   late is still honest about how long is left. The `E` key strikes too — that is handled
   *   by the app, and the hint is hidden on touch screens where there is no E.
   * - **caught** — a small catch card: what, how big, how rare, tinted with the species' own
   *   colour, and the three pieces of news that make a catch worth a second look. It clears
   *   itself (world-sync resets the line after a few seconds).
   *
   * An escape shows nothing here: world-sync already says so in a notice, once.
   *
   * Nothing pulses and nothing blinks. The bite is loud by being big, not by moving.
   */
  import { getFish, type FishRarity } from '@nagisa/shared';
  import { cmd, fishing } from '../state/stores.js';
  import { fishName, lang, t } from '../i18n/index.js';

  /** How many dots a rarity earns. Junk earns none — it is its own kind of rare. */
  const RARITY_DOTS: Record<FishRarity, number> = {
    common: 1,
    uncommon: 2,
    rare: 3,
    epic: 4,
    legendary: 5,
    junk: 0,
  };

  const f = $derived($fishing);
  const species = $derived(f.caught ? getFish(f.caught.fish) : undefined);
  const tint = $derived(species ? `#${species.color.toString(16).padStart(6, '0')}` : 'var(--ui-ink-faint)');

  /**
   * How far into the strike window the bite already is. Read when the bite arrives — the
   * derived value only changes when the line's state does, which is exactly once per bite.
   */
  const elapsed = $derived(f.phase === 'bite' ? Math.max(0, performance.now() - f.biteAt) : 0);
</script>

{#if f.phase === 'waiting'}
  <div class="fishing waiting" role="status">
    <span class="float" aria-hidden="true"></span>
    <span class="text">{$t('fish.waiting')}</span>
    <button type="button" class="quiet" onclick={() => cmd().fishStop()}>{$t('fish.reelIn')}</button>
  </div>
{:else if f.phase === 'bite'}
  <div class="fishing bite" role="status" aria-live="assertive">
    <span class="bite-label">{$t('fish.bite')}</span>
    <button type="button" class="strike" onclick={() => cmd().fishHook()}>
      <span>{$t('fish.strike')}</span>
      <kbd class="key-hint">E</kbd>
      {#key f.biteAt}
        <span
          class="window"
          title={$t('fish.strikeTime')}
          aria-hidden="true"
          style:animation-duration="{Math.max(1, f.window)}ms"
          style:animation-delay="-{elapsed}ms"
        ></span>
      {/key}
    </button>
  </div>
{:else if f.phase === 'caught' && f.caught}
  <div class="fishing catch" role="status" style:--fish={tint}>
    <svg class="fish-icon" viewBox="0 0 32 20" width="40" height="25" aria-hidden="true">
      <path d="M3 10C7 3.5 16.5 2.5 23 8L30 3.2 28.6 10 30 16.8 23 12C16.5 17.5 7 16.5 3 10Z" fill="currentColor" />
      <circle cx="8.6" cy="8.9" r="1.2" fill="var(--ui-surface-raised)" />
    </svg>
    <div class="catch-body">
      <p class="caught">{$t('fish.caught')}</p>
      <p class="species">
        <span class="name">{fishName(f.caught.fish, $lang)}</span>
        <span class="size">{$t('fish.size', { size: f.caught.size })}</span>
      </p>
      {#if species}
        <p class="rarity">
          {#if RARITY_DOTS[species.rarity] > 0}
            <span class="dots" aria-hidden="true">{'●'.repeat(RARITY_DOTS[species.rarity])}</span>
          {/if}
          <span>{$t(`rarity.${species.rarity}`)}</span>
        </p>
      {/if}
      {#if f.caught.newSpecies || f.caught.personalBest || f.caught.record}
        <ul class="tags">
          {#if f.caught.newSpecies}<li class="tag">{$t('fish.new')}</li>{/if}
          {#if f.caught.personalBest}<li class="tag">{$t('fish.pb')}</li>{/if}
          {#if f.caught.record}<li class="tag record">{$t('fish.record')}</li>{/if}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Above the bottom-centre stack in Hud.svelte: the 44 px emote button plus, at a fishing
     spot, the interact prompt above it (~30 px and a gap). */
  .fishing {
    position: fixed;
    left: 50%;
    translate: -50% 0;
    bottom: calc(max(var(--sp-lg), env(safe-area-inset-bottom)) + 92px);
    z-index: var(--z-hud);
    pointer-events: none;
    max-width: calc(100vw - 2 * var(--sp-md));
    box-sizing: border-box;
    animation: rise var(--mo-calm) both;
  }

  /* On a phone the minimap moves to the bottom-left corner and the emote button sits against
     it; the line goes above the map instead, where a thumb still reaches it. */
  @media (max-width: 640px) {
    .fishing {
      bottom: calc(max(var(--sp-lg), env(safe-area-inset-bottom)) + 196px);
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

  p {
    margin: 0;
  }

  .waiting {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: 6px 6px 6px var(--sp-md);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-lg);
    font-size: var(--fs-sm);
    color: var(--ui-ink-muted);
    white-space: nowrap;
  }

  /* A float, drawn: red cap over white. Still — the waiting is the calm part. */
  .float {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: linear-gradient(var(--ui-accent) 50%, var(--ui-surface-raised) 50%);
    box-shadow: 0 0 0 1px var(--ui-line);
    flex: none;
  }

  .quiet {
    pointer-events: auto;
    border: 1px solid var(--ui-line);
    background: transparent;
    border-radius: var(--r-md);
    padding: 4px var(--sp-sm);
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .quiet:hover {
    color: var(--ui-ink);
  }

  .bite {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-xs);
  }

  .bite-label {
    padding: 2px var(--sp-sm);
    border-radius: var(--r-sm);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  /* Big and plain: raised paper, a vermilion rule, ink text. Obvious without shouting. */
  .strike {
    pointer-events: auto;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-sm);
    min-width: 200px;
    min-height: 56px;
    padding: 0 var(--sp-xl);
    border: 2px solid var(--ui-accent);
    border-radius: var(--r-lg);
    background: var(--ui-surface-raised);
    box-shadow: var(--ui-shadow);
    font: inherit;
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--ui-ink);
    cursor: pointer;
    touch-action: manipulation;
  }

  .strike:active {
    background: var(--ui-surface-sunk);
  }

  .key-hint {
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: 400;
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

  /* The strike window, running out left to right along the bottom edge. */
  .window {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: var(--ui-accent-soft);
    transform-origin: left center;
    animation-name: drain;
    animation-timing-function: linear;
    animation-fill-mode: both;
  }

  @keyframes drain {
    from {
      transform: scaleX(1);
    }
    to {
      transform: scaleX(0);
    }
  }

  .catch {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-sm);
    width: min(300px, calc(100vw - 2 * var(--sp-md)));
    padding: var(--sp-sm) var(--sp-md);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-panel);
    border-left: 4px solid var(--fish);
  }

  .fish-icon {
    flex: none;
    margin-top: 4px;
    color: var(--fish);
  }

  .catch-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .caught {
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .species {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--sp-sm);
  }

  .name {
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--ui-ink);
  }

  .size {
    font-size: var(--fs-md);
    font-variant-numeric: tabular-nums;
    color: var(--ui-ink);
  }

  .rarity {
    display: flex;
    align-items: baseline;
    gap: var(--sp-xs);
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .dots {
    letter-spacing: 1px;
    font-size: 8px;
    color: var(--fish);
  }

  .tags {
    list-style: none;
    margin: 2px 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-xs);
  }

  .tag {
    font-size: var(--fs-xs);
    padding: 1px var(--sp-sm);
    border-radius: var(--r-sm);
    background: var(--ui-surface-sunk);
    color: var(--ui-ink);
  }

  .tag.record {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--ui-accent);
    color: var(--ui-accent);
  }

  button:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }
</style>
