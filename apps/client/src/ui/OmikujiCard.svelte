<script lang="ts">
  /**
   * OmikujiCard — the shrine's paper fortune, unfolded in front of you.
   *
   * A narrow vertical slip rather than a dialog box, because that is what an omikuji is: a
   * strip of washi with a vermilion band across the top and the fortune written large down
   * the middle. The fortune itself (大吉, 小吉…) is set vertically, the one place in the
   * interface that does, since it is the one thing here that is a piece of Japanese writing
   * rather than a label.
   *
   * It is **not** modal. The world keeps running and stays clickable around it; the slip
   * takes pointer events only on its own paper. It goes away on its own after 14 seconds —
   * long enough to read the advice twice — or on Escape, or the button. `again` (you already
   * drew today, and this is that slip) adds one quiet line; world-sync has already said so in
   * a notice, so the slip does not make a point of it.
   *
   * In English the kanji alone would be a picture, so its reading and its English name are
   * added underneath; in Chinese and Japanese the kanji is the name.
   */
  import { FORTUNES } from '@nagisa/shared';
  import { omikujiSlip } from '../state/stores.js';
  import { fortuneText, lang, t } from '../i18n/index.js';

  /** How long the slip stays up before it folds itself away. */
  const SHOW_MS = 14_000;

  const slip = $derived($omikujiSlip);
  const words = $derived(slip ? fortuneText(slip.fortune, slip.item, slip.direction, $lang) : null);
  /** Same fallback as `fortuneText`, so the reading always matches the kanji shown. */
  const reading = $derived(slip ? (FORTUNES[slip.fortune] ?? FORTUNES[FORTUNES.length - 1]).reading : '');

  function close(): void {
    omikujiSlip.set(null);
  }

  // Each new slip restarts the clock; a slip dismissed early takes its timer with it.
  $effect(() => {
    if (!$omikujiSlip) return;
    const timer = setTimeout(close, SHOW_MS);
    function onKeydown(e: KeyboardEvent): void {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKeydown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKeydown);
    };
  });
</script>

{#if slip && words}
  <div class="stage">
    <aside class="slip" role="status" aria-live="polite" aria-label={$t('omikuji.label')}>
      <header class="band">{$t('omikuji.title')}</header>
      <div class="paper">
        <p class="kanji" lang="ja">{words.kanji}</p>
        {#if $lang === 'en'}
          <p class="reading" lang="ja">{reading}</p>
          <p class="en-name">{words.name}</p>
        {/if}
        <p class="line">{words.line}</p>
        <dl class="luck">
          <div class="luck-row">
            <dt>{$t('omikuji.item')}</dt>
            <dd>{words.item}</dd>
          </div>
          <div class="luck-row">
            <dt>{$t('omikuji.direction')}</dt>
            <dd>{words.direction}</dd>
          </div>
        </dl>
        {#if slip.again}
          <p class="again">{$t('omikuji.todays')}</p>
        {/if}
        <button type="button" class="dismiss" onclick={close}>{$t('omikuji.close')}</button>
      </div>
    </aside>
  </div>
{/if}

<style>
  /* A centring frame that takes no input itself: only the paper does. */
  .stage {
    position: fixed;
    inset: 0;
    z-index: var(--z-panel);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(max(var(--sp-md), env(safe-area-inset-top)) + 56px) var(--sp-md)
      calc(max(var(--sp-md), env(safe-area-inset-bottom)) + 72px);
    pointer-events: none;
  }

  .slip {
    pointer-events: auto;
    width: 196px;
    max-height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    border-radius: 3px;
    box-shadow: var(--ui-shadow);
    /* Washi: warm raised paper with a faint scatter of fibre. */
    background-color: var(--ui-surface-raised);
    background-image:
      radial-gradient(rgba(38, 34, 30, 0.035) 0.8px, transparent 1.2px),
      radial-gradient(rgba(38, 34, 30, 0.025) 0.8px, transparent 1.4px);
    background-size: 7px 9px, 11px 13px;
    background-position: 0 0, 3px 5px;
    animation: unfold var(--mo-slow) both;
  }

  @keyframes unfold {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .band {
    background: var(--ui-accent);
    color: var(--ui-surface-raised);
    text-align: center;
    font-size: var(--fs-sm);
    letter-spacing: 0.3em;
    padding: 6px 0 6px 0.3em;
  }

  .paper {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-sm);
    padding: var(--sp-md) var(--sp-md) var(--sp-sm);
    margin: 0 6px 6px;
    border: 1px solid var(--ui-accent-soft);
    border-top: none;
    text-align: center;
  }

  p {
    margin: 0;
  }

  .kanji {
    writing-mode: vertical-rl;
    text-orientation: upright;
    font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'YuMincho', 'Noto Serif JP', 'Songti SC', serif;
    font-size: 44px;
    line-height: 1;
    letter-spacing: 0.08em;
    color: var(--ui-ink);
    padding: var(--sp-xs) 0;
  }

  .reading {
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .en-name {
    margin-top: -4px;
    font-size: var(--fs-sm);
    font-weight: 600;
  }

  .line {
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--ui-ink);
    padding-top: var(--sp-sm);
    border-top: 1px solid var(--ui-line);
    width: 100%;
  }

  .luck {
    margin: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .luck-row {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-sm);
    font-size: var(--fs-xs);
  }

  dt {
    color: var(--ui-ink-muted);
    white-space: nowrap;
  }

  dd {
    margin: 0;
    color: var(--ui-ink);
    text-align: right;
  }

  .again {
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .dismiss {
    margin-top: var(--sp-xs);
    border: 1px solid var(--ui-line);
    background: transparent;
    border-radius: var(--r-sm);
    padding: 4px var(--sp-md);
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .dismiss:hover {
    color: var(--ui-ink);
  }

  .dismiss:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }
</style>
