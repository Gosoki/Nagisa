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
   * - The language picker is three words, each in its own language, in the corner of the
   *   card. Someone who arrives in a language they cannot read can still find their own
   *   name for their own language; nothing else about it needs to be explained. It writes
   *   the same setting as the one in Settings, so the choice carries into the world.
   * - Arriving by an invite link says so, quietly, under the tagline — with the code, so
   *   a visitor can tell it is the island their friend meant before they go ashore.
   */
  import { PROTOCOL } from '@nagisa/shared';
  import { cmd, settings } from '../state/stores.js';
  import { LANGS, LANG_NAMES, lang, t, tr, type Lang } from '../i18n/index.js';
  import { inviteCodeFromUrl } from '../net/visitor.js';

  let name = $state('');
  let appearance = $state({ outfit: 0, skin: 0, accessory: 0 });

  const OUTFITS = ['#8B3A3A', '#3A5A82', '#3F6B4A', '#B8925A', '#4A4642', '#EFE8DA'];
  const SKINS = ['#F2D8BC', '#E3B78F', '#C88E60', '#9C6B44', '#6E4A30'];
  /** 0 = none. The rest are just enough to feel like a choice, not a shop. */
  const ACCESSORIES = 4;

  /** Read once: the address is not going to change under the entry card. */
  const inviteCode = inviteCodeFromUrl();

  function submit(): void {
    const trimmed = name.trim().slice(0, PROTOCOL.MAX_NAME_LENGTH);
    const finalName = trimmed.length > 0 ? trimmed : tr('entry.defaultName', { n: Math.floor(100 + Math.random() * 900) });
    cmd().enterWorld(finalName, appearance);
  }

  function setLang(next: Lang): void {
    settings.update((s) => ({ ...s, lang: next }));
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') submit();
  }
</script>

<div class="entry">
  <div class="scrim"></div>

  <div class="card">
    <div class="head">
      <h1 class="title">Nagisa<span class="ja" lang="ja">渚</span></h1>
      <div class="langs" role="radiogroup" aria-label={$t('lang.label')}>
        {#each LANGS as l (l)}
          <button
            type="button"
            class="lang"
            class:selected={$lang === l}
            role="radio"
            aria-checked={$lang === l}
            lang={l === 'zh' ? 'zh-CN' : l}
            onclick={() => setLang(l)}
          >
            {LANG_NAMES[l]}
          </button>
        {/each}
      </div>
    </div>
    <p class="tagline">{$t('entry.tagline')}</p>
    {#if inviteCode}
      <p class="invite">{$t('entry.invite', { code: inviteCode })}</p>
    {/if}

    <label class="field">
      <span class="field-label">{$t('entry.name')}</span>
      <input
        type="text"
        maxlength={PROTOCOL.MAX_NAME_LENGTH}
        placeholder={$t('entry.namePlaceholder')}
        bind:value={name}
        onkeydown={onKeydown}
      />
    </label>

    <div class="picker">
      <span class="picker-label">{$t('entry.outfit')}</span>
      <div class="swatches" role="radiogroup" aria-label={$t('entry.outfitGroup')}>
        {#each OUTFITS as color, i (i)}
          <button
            type="button"
            class="swatch"
            class:selected={appearance.outfit === i}
            style:background={color}
            role="radio"
            aria-checked={appearance.outfit === i}
            aria-label={$t('entry.outfitN', { n: i + 1 })}
            onclick={() => (appearance.outfit = i)}
          ></button>
        {/each}
      </div>
    </div>

    <div class="picker">
      <span class="picker-label">{$t('entry.skin')}</span>
      <div class="swatches" role="radiogroup" aria-label={$t('entry.skinGroup')}>
        {#each SKINS as color, i (i)}
          <button
            type="button"
            class="swatch"
            class:selected={appearance.skin === i}
            style:background={color}
            role="radio"
            aria-checked={appearance.skin === i}
            aria-label={$t('entry.skinN', { n: i + 1 })}
            onclick={() => (appearance.skin = i)}
          ></button>
        {/each}
      </div>
    </div>

    <div class="picker">
      <span class="picker-label">{$t('entry.accessory')}</span>
      <div class="swatches" role="radiogroup" aria-label={$t('entry.accessory')}>
        {#each Array(ACCESSORIES) as _, i (i)}
          <button
            type="button"
            class="swatch accessory"
            class:selected={appearance.accessory === i}
            role="radio"
            aria-checked={appearance.accessory === i}
            aria-label={i === 0 ? $t('entry.accessoryNone') : $t('entry.accessoryN', { n: i })}
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

    <button type="button" class="go" onclick={submit}>{$t('entry.go')}</button>
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

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-sm);
    flex-wrap: wrap;
  }

  .title {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .langs {
    display: flex;
    gap: 2px;
  }

  .lang {
    border: none;
    background: transparent;
    border-radius: var(--r-sm);
    padding: 2px 5px;
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
    cursor: pointer;
    transition: color var(--mo-quick);
  }

  .lang:hover {
    color: var(--ui-ink-muted);
  }

  .lang.selected {
    color: var(--ui-ink);
    text-decoration: underline;
    text-decoration-color: var(--ui-line);
    text-underline-offset: 3px;
  }

  .lang:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 1px;
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

  .invite {
    margin: calc(-1 * var(--sp-xs)) 0 0;
    font-size: var(--fs-xs);
    letter-spacing: 0.04em;
    color: var(--ui-sea);
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
