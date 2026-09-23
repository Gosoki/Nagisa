<script lang="ts">
  /**
   * SettingsPanel — shown inside Panels.svelte when `$openPanel === 'settings'`.
   *
   * Quality and mute route through `cmd()` because the engine has to act on them
   * (rebuild render settings, unlock the audio context on the first gesture). Show-names
   * and reduced-motion have no corresponding command — they're pure client-side display
   * preferences — so this panel writes `settings` directly, which stores.ts explicitly
   * allows ("plain Svelte stores... so components can read and write them directly") and
   * which is what already makes them persist to localStorage via that module's own
   * subscribe hook. The type of `quality` is read off `Settings['quality']` rather than
   * importing it from engine/quality.ts, which this file (like every UI component) must
   * not import from directly.
   *
   * The room switcher is deliberately just a flat list of small rows, not a table — this
   * is one settings panel among four, capped at ~300px, and a room list with columns
   * would blow that budget immediately.
   *
   * Language comes first. Someone who has landed in a language they cannot read is looking
   * for exactly one thing in this panel, and each option is written in its own language so
   * they can find it without reading anything else. It writes `settings.lang` directly; the
   * whole interface reads the translator through a store, so it changes at once.
   */
  import { settings, rooms, room, cmd, population, welcomeOpen, type Settings } from '../state/stores.js';
  import { LANGS, LANG_NAMES, lang, roomName, t, type Lang } from '../i18n/index.js';

  type QualityTier = Settings['quality'];
  const TIERS: QualityTier[] = ['low', 'medium', 'high'];

  function setLang(lang: Lang): void {
    settings.update((s) => ({ ...s, lang }));
  }
</script>

<div class="section row">
  <button type="button" class="again" onclick={() => welcomeOpen.set(true)}>{$t('settings.welcome')}</button>
</div>

<div class="section">
  <span class="label">{$t('lang.label')}</span>
  <div class="segmented" role="radiogroup" aria-label={$t('lang.label')}>
    {#each LANGS as l (l)}
      <button
        type="button"
        class="segment"
        class:selected={$settings.lang === l}
        role="radio"
        aria-checked={$settings.lang === l}
        lang={l === 'zh' ? 'zh-CN' : l}
        onclick={() => setLang(l)}
      >
        {LANG_NAMES[l]}
      </button>
    {/each}
  </div>
</div>

<div class="section">
  <span class="label">{$t('settings.quality')}</span>
  <div class="segmented" role="radiogroup" aria-label={$t('settings.qualityGroup')}>
    {#each TIERS as tier (tier)}
      <button
        type="button"
        class="segment"
        class:selected={$settings.quality === tier}
        role="radio"
        aria-checked={$settings.quality === tier}
        onclick={() => cmd().setQuality(tier)}
      >
        {$t(`settings.tier.${tier}`)}
      </button>
    {/each}
  </div>
</div>

<div class="section row">
  <span class="label">{$t('settings.mute')}</span>
  <button
    type="button"
    class="toggle"
    class:on={$settings.muted}
    role="switch"
    aria-checked={$settings.muted}
    aria-label={$t('settings.mute')}
    onclick={() => cmd().setMuted(!$settings.muted)}
  >
    <span class="knob"></span>
  </button>
</div>

<div class="section row">
  <span class="label">{$t('settings.names')}</span>
  <button
    type="button"
    class="toggle"
    class:on={$settings.showNames}
    role="switch"
    aria-checked={$settings.showNames}
    aria-label={$t('settings.names')}
    onclick={() => settings.update((s) => ({ ...s, showNames: !s.showNames }))}
  >
    <span class="knob"></span>
  </button>
</div>

<div class="section row">
  <span class="label">{$t('settings.paper')}</span>
  <button
    type="button"
    class="toggle"
    class:on={$settings.paperTexture}
    role="switch"
    aria-checked={$settings.paperTexture}
    aria-label={$t('settings.paper')}
    onclick={() => settings.update((s) => ({ ...s, paperTexture: !s.paperTexture }))}
  >
    <span class="knob"></span>
  </button>
</div>

<div class="section row">
  <span class="label">{$t('settings.motion')}</span>
  <button
    type="button"
    class="toggle"
    class:on={$settings.reducedMotion}
    role="switch"
    aria-checked={$settings.reducedMotion}
    aria-label={$t('settings.motion')}
    onclick={() => settings.update((s) => ({ ...s, reducedMotion: !s.reducedMotion }))}
  >
    <span class="knob"></span>
  </button>
</div>

{#if $rooms.length > 1}
  <div class="section">
    <span class="label">{$t('settings.room')}</span>
    <ul class="rooms">
      {#each $rooms as r (r.id)}
        <li>
          <button
            type="button"
            class="room"
            class:current={$room?.id === r.id}
            disabled={$room?.id === r.id}
            onclick={() => cmd().switchRoom(r.id)}
          >
            <span>{roomName(r, $lang)}</span>
            <span class="pop">{$room?.id === r.id ? $population : r.population}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-xs);
    padding: var(--sp-sm) 0;
    border-bottom: 1px solid var(--ui-line);
  }

  .section:last-child {
    border-bottom: none;
  }

  .section.row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }

  .label {
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-ink-muted);
  }

  .segmented {
    display: flex;
    background: var(--ui-surface-sunk);
    border-radius: var(--r-sm);
    padding: 2px;
  }

  .again {
    border: 1px solid var(--ui-line);
    border-radius: 999px;
    background: transparent;
    padding: 2px 10px;
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .segment {
    flex: 1;
    border: none;
    background: transparent;
    border-radius: var(--r-sm);
    padding: 4px 0;
    font-size: var(--fs-xs);
    text-transform: capitalize;
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .segment.selected {
    background: var(--ui-surface-raised);
    color: var(--ui-ink);
    box-shadow: var(--ui-shadow);
  }

  .segment:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 1px;
  }

  .toggle {
    width: 32px;
    height: 18px;
    border-radius: 9px;
    border: none;
    background: var(--ui-surface-sunk);
    padding: 2px;
    display: flex;
    cursor: pointer;
  }

  .toggle.on {
    background: var(--ui-ink-faint);
    justify-content: flex-end;
  }

  .knob {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--ui-surface-raised);
    box-shadow: var(--ui-shadow);
  }

  .toggle:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }

  .rooms {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .room {
    width: 100%;
    display: flex;
    justify-content: space-between;
    border: none;
    background: transparent;
    border-radius: var(--r-sm);
    padding: 4px var(--sp-xs);
    font-size: var(--fs-sm);
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .room.current {
    color: var(--ui-ink);
    font-weight: 600;
    cursor: default;
  }

  .room:not(:disabled):hover {
    background: var(--ui-surface-sunk);
  }

  .room:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: -1px;
  }

  .pop {
    color: var(--ui-ink-faint);
  }
</style>
