<script lang="ts">
  /**
   * Entry — shown while `$appPhase === 'entry'`.
   *
   * The world is already rendering behind this screen (the engine starts the render
   * loop before the player has a name), so this is a floating paper card over a dim
   * scrim — never an opaque wall. The scrim exists ('--ui-scrim', documented in
   * tokens.ts as being *for this screen specifically*) so the card reads clearly
   * against a busy scene without hiding the island the player is about to walk into.
   *
   * Design decisions worth flagging:
   *
   * - No validation blocks entry. An empty name silently becomes "Visitor ###" rather
   *   than showing an error, because a calm product does not put a red border between
   *   someone and the world on their first ten seconds in it.
   * - Appearance swatches are selected with an ink-coloured ring, not the accent colour.
   *   The accent is spent once per screen (rule 3), and "Go ashore" is the one thing on
   *   this screen that should carry it — three simultaneously-accented swatch rows would
   *   both break that rule and make the accent meaningless as a signal.
   * - Swatch colours are character-customisation content, not interface chrome, so they
   *   are drawn from a small bespoke palette rather than the UI tokens (which describe
   *   the *interface*, not what a visitor's haori can look like).
   */
  import { PROTOCOL } from '@nagisa/shared';
  import { cmd } from '../state/stores.js';

  let name = $state('');
  let appearance = $state({ outfit: 0, skin: 0, accessory: 0 });

  const OUTFITS = ['#8B3A3A', '#3A5A82', '#3F6B4A', '#B8925A', '#4A4642', '#EFE8DA'];
  const SKINS = ['#F2D8BC', '#E3B78F', '#C88E60', '#9C6B44', '#6E4A30'];
  /** 0 = none. The rest are just enough to feel like a choice, not a shop. */
  const ACCESSORIES = 4;

  function submit(): void {
    const trimmed = name.trim().slice(0, PROTOCOL.MAX_NAME_LENGTH);
    const finalName = trimmed.length > 0 ? trimmed : `Visitor ${Math.floor(100 + Math.random() * 900)}`;
    cmd().enterWorld(finalName, appearance);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') submit();
  }
</script>

<div class="entry">
  <div class="scrim"></div>

  <div class="card">
    <h1 class="title">Nagisa<span class="ja">渚</span></h1>
    <p class="tagline">It's a small island, but everyone has to be somewhere.</p>

    <label class="field">
      <span class="field-label">Name</span>
      <input
        type="text"
        maxlength={PROTOCOL.MAX_NAME_LENGTH}
        placeholder="What should we call you?"
        bind:value={name}
        onkeydown={onKeydown}
      />
    </label>

    <div class="picker">
      <span class="picker-label">Outfit</span>
      <div class="swatches" role="radiogroup" aria-label="Outfit colour">
        {#each OUTFITS as color, i (i)}
          <button
            type="button"
            class="swatch"
            class:selected={appearance.outfit === i}
            style:background={color}
            role="radio"
            aria-checked={appearance.outfit === i}
            aria-label="Outfit {i + 1}"
            onclick={() => (appearance.outfit = i)}
          ></button>
        {/each}
      </div>
    </div>

    <div class="picker">
      <span class="picker-label">Skin</span>
      <div class="swatches" role="radiogroup" aria-label="Skin tone">
        {#each SKINS as color, i (i)}
          <button
            type="button"
            class="swatch"
            class:selected={appearance.skin === i}
            style:background={color}
            role="radio"
            aria-checked={appearance.skin === i}
            aria-label="Skin tone {i + 1}"
            onclick={() => (appearance.skin = i)}
          ></button>
        {/each}
      </div>
    </div>

    <div class="picker">
      <span class="picker-label">Accessory</span>
      <div class="swatches" role="radiogroup" aria-label="Accessory">
        {#each Array(ACCESSORIES) as _, i (i)}
          <button
            type="button"
            class="swatch accessory"
            class:selected={appearance.accessory === i}
            role="radio"
            aria-checked={appearance.accessory === i}
            aria-label={i === 0 ? 'No accessory' : `Accessory ${i}`}
            onclick={() => (appearance.accessory = i)}
          >
            {#if i === 0}
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <circle cx="12" cy="12" r="7" fill="none" stroke="var(--ui-ink-faint)" stroke-width="1.4" />
              </svg>
            {:else if i === 1}
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M4 10 H20" stroke="var(--ui-ink)" stroke-width="3" stroke-linecap="round" />
              </svg>
            {:else if i === 2}
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  d="M12 5 V19 M5 12 H19 M7 7 L17 17 M17 7 L7 17"
                  stroke="var(--ui-ink)"
                  stroke-width="1.6"
                  stroke-linecap="round"
                />
              </svg>
            {:else}
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <rect x="4" y="9" width="16" height="6" rx="2" fill="var(--ui-ink)" />
              </svg>
            {/if}
          </button>
        {/each}
      </div>
    </div>

    <button type="button" class="go" onclick={submit}>Go ashore</button>
  </div>
</div>

<style>
  .entry {
    position: fixed;
    inset: 0;
    z-index: var(--z-entry);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-lg);
    padding-top: max(var(--sp-lg), env(safe-area-inset-top));
    padding-bottom: max(var(--sp-lg), env(safe-area-inset-bottom));
  }

  .scrim {
    position: absolute;
    inset: 0;
    background: var(--ui-scrim);
    pointer-events: auto;
  }

  .card {
    position: relative;
    pointer-events: auto;
    width: min(320px, 100%);
    max-height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-md);
    background: var(--ui-surface-raised);
    border-radius: var(--r-panel);
    box-shadow: var(--ui-shadow);
    padding: var(--sp-xl) var(--sp-lg);
  }

  .title {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .ja {
    margin-left: var(--sp-sm);
    font-size: var(--fs-md);
    font-weight: 400;
    color: var(--ui-ink-muted);
  }

  .tagline {
    margin: 0;
    font-size: var(--fs-sm);
    font-style: italic;
    color: var(--ui-ink-muted);
    line-height: 1.5;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--sp-xs);
  }

  .field-label {
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-ink-muted);
  }

  input {
    font: inherit;
    font-size: var(--fs-md);
    color: var(--ui-ink);
    background: var(--ui-surface);
    border: 1px solid var(--ui-line);
    border-radius: var(--r-sm);
    padding: var(--sp-sm) var(--sp-md);
    outline: none;
  }

  input:focus-visible {
    border-color: var(--ui-accent);
    box-shadow: 0 0 0 2px var(--ui-accent-soft);
  }

  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--sp-xs);
  }

  .picker-label {
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-ink-muted);
  }

  .swatches {
    display: flex;
    gap: var(--sp-sm);
  }

  .swatch {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 1.5px solid var(--ui-line);
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .swatch.accessory {
    background: var(--ui-surface-sunk);
  }

  .swatch.selected {
    border-color: var(--ui-ink);
    box-shadow: 0 0 0 2px var(--ui-surface-raised), 0 0 0 3px var(--ui-ink);
  }

  .swatch:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }

  .go {
    margin-top: var(--sp-sm);
    align-self: stretch;
    border: none;
    border-radius: var(--r-md);
    padding: var(--sp-sm) var(--sp-lg);
    background: var(--ui-accent);
    color: var(--ui-surface-raised);
    font-size: var(--fs-md);
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--mo-quick);
  }

  .go:hover {
    opacity: 0.92;
  }

  .go:focus-visible {
    outline: 2px solid var(--ui-ink);
    outline-offset: 2px;
  }
</style>
