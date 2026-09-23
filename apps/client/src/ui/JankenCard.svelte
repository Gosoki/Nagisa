<script lang="ts">
  /**
   * JankenCard — a duel of rock, paper, scissors, from your side of it.
   *
   * A compact card on the right-hand side, vertically centred: well away from the fishing
   * line and the emote button at the bottom centre, and from the chat in the bottom left,
   * because a duel can arrive while you are doing either. On a phone there is no "away": the
   * card takes the fishing line's slot above the minimap, and steps up above it while a line
   * is out, so the two never cover each other.
   *
   * It follows `$janken` (world-sync fills it from the server) through five states:
   *
   * - **invited** — someone near you challenged you. Accept or decline, with the seconds
   *   left to answer; silence declines for you.
   * - **waiting** — you challenged them; they are deciding.
   * - **choose** — three big hands to press, or the 1 / 2 / 3 keys. Once you have thrown, the
   *   card shows your hand and waits for theirs. Seconds left, because a missing throw
   *   forfeits.
   * - **result** — both hands side by side and the verdict. A tie that is not `final` says
   *   "again" and the next round's `start` replaces it by itself.
   * - **cancelled** — the reason, in words.
   *
   * The finished card is cleared by world-sync after a few seconds; there is nothing here to
   * dismiss. The countdown is whole seconds on the server's clock, like the quiz's: the
   * deadline is the game.
   */
  import { HANDS, type Hand } from '@nagisa/shared';
  import { cmd, fishing, janken, self, serverNow } from '../state/stores.js';
  import { t } from '../i18n/index.js';

  const GLYPH: Record<Hand, string> = { rock: '✊', paper: '✋', scissors: '✌️' };

  let now = $state(serverNow());
  /** The duel you have already answered, so a second tap cannot send a second answer. */
  let answered = $state<string | null>(null);

  const j = $derived($janken);
  /** Whether FishingHud is showing something, which on a phone is where this card would sit. */
  const lineShowing = $derived(['waiting', 'bite', 'caught'].includes($fishing.phase));
  const counting = $derived(!!j && (j.phase === 'invited' || j.phase === 'choose'));

  $effect(() => {
    if (!counting) return;
    now = serverNow();
    const timer = setInterval(() => (now = serverNow()), 250);
    return () => clearInterval(timer);
  });

  const secondsLeft = $derived(j ? Math.max(0, Math.ceil((j.deadline - now) / 1000)) : 0);

  const outcome = $derived.by(() => {
    if (!j || j.phase !== 'result') return null;
    if (j.winner === null) return j.final ? 'drawn' : 'again';
    if (j.winner === $self.id) return 'win';
    return 'lose';
  });

  function respond(accept: boolean): void {
    if (!j || j.phase !== 'invited' || answered === j.duel) return;
    answered = j.duel;
    cmd().jankenRespond(j.duel, accept);
  }

  function throwHand(hand: Hand): void {
    if (!j || j.phase !== 'choose' || j.mine) return;
    cmd().jankenThrow(j.duel, hand);
  }

  // 1 / 2 / 3 throw, while there is something to throw. Never while typing.
  $effect(() => {
    const cur = $janken;
    if (!cur || cur.phase !== 'choose' || cur.mine) return;
    function onKeydown(e: KeyboardEvent): void {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }
      const index = ['1', '2', '3'].indexOf(e.key);
      if (index < 0) return;
      e.preventDefault();
      throwHand(HANDS[index]);
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });
</script>

{#if j}
  <section class="janken" class:above-line={lineShowing} role="status" aria-live="polite" aria-atomic="false" aria-label={$t('janken.title')}>
    <header class="head">
      <span class="label">{$t('janken.title')}</span>
      {#if j.round > 1 && (j.phase === 'choose' || j.phase === 'result')}
        <span class="round">{$t('janken.round', { n: j.round })}</span>
      {/if}
      {#if counting}
        <span class="clock" role="timer" aria-live="off" aria-label={$t('game.secondsLeft', { n: secondsLeft })}>
          {$t('game.seconds', { n: secondsLeft })}
        </span>
      {/if}
    </header>

    {#if j.phase === 'invited'}
      <p class="lead">{$t('janken.invited', { name: j.opponentName })}</p>
      <div class="row">
        <button type="button" class="btn primary" disabled={answered === j.duel} onclick={() => respond(true)}>
          {$t('janken.accept')}
        </button>
        <button type="button" class="btn" disabled={answered === j.duel} onclick={() => respond(false)}>
          {$t('janken.decline')}
        </button>
      </div>
    {:else if j.phase === 'waiting'}
      <p class="lead muted">{$t('janken.waiting', { name: j.opponentName })}</p>
    {:else if j.phase === 'choose'}
      {#if j.mine}
        <p class="thrown">
          <span class="glyph" aria-hidden="true">{GLYPH[j.mine]}</span>
          <span class="hand-name">{$t(`hand.${j.mine}`)}</span>
        </p>
        <p class="lead muted">{$t('janken.thrown', { name: j.opponentName })}</p>
      {:else}
        <p class="lead">
          {$t('janken.choose')}
          <span class="vs">{$t('janken.vs', { name: j.opponentName })}</span>
        </p>
        <div class="hands">
          {#each HANDS as hand, i (hand)}
            <button type="button" class="hand" aria-keyshortcuts={String(i + 1)} onclick={() => throwHand(hand)}>
              <span class="glyph" aria-hidden="true">{GLYPH[hand]}</span>
              <span class="hand-name">{$t(`hand.${hand}`)}</span>
            </button>
          {/each}
        </div>
        <p class="keys">{$t('janken.keys')}</p>
      {/if}
    {:else if j.phase === 'result'}
      <div class="versus">
        <div class="side">
          <span class="who">{$t('janken.you')}</span>
          <span class="glyph" aria-hidden="true">{j.mine ? GLYPH[j.mine] : '…'}</span>
          <span class="hand-name">{j.mine ? $t(`hand.${j.mine}`) : $t('janken.noThrow')}</span>
        </div>
        <span class="vs-mark" aria-hidden="true">vs</span>
        <div class="side">
          <span class="who">{j.opponentName}</span>
          <span class="glyph" aria-hidden="true">{j.theirs ? GLYPH[j.theirs] : '…'}</span>
          <span class="hand-name">{j.theirs ? $t(`hand.${j.theirs}`) : $t('janken.noThrow')}</span>
        </div>
      </div>
      <p class="outcome" class:win={outcome === 'win'}>
        {#if outcome === 'win'}
          {$t('janken.win')}
        {:else if outcome === 'lose'}
          {$t('janken.lose')}
        {:else if outcome === 'again'}
          {$t('janken.again')}
        {:else}
          {$t('janken.drawn')}
        {/if}
      </p>
    {:else if j.phase === 'cancelled'}
      <p class="lead muted">{$t(j.byMe && j.reason === 'declined' ? 'janken.cancel.youDeclined' : `janken.cancel.${j.reason ?? 'other'}`, { name: j.opponentName })}</p>
    {/if}
  </section>
{/if}

<style>
  .janken {
    position: fixed;
    right: max(var(--sp-md), env(safe-area-inset-right));
    top: 50%;
    translate: 0 -50%;
    z-index: var(--z-panel);
    pointer-events: auto;
    width: min(240px, calc(100vw - 2 * var(--sp-md)));
    box-sizing: border-box;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-panel);
    padding: var(--sp-sm) var(--sp-md) var(--sp-md);
    animation: settle var(--mo-calm) both;
  }

  /* On a phone the right-hand side is not wide enough to be "away" from anything: the card
     takes the fishing line's slot above the minimap (see FishingHud), and stands on top of
     the line while one is out — never over it. */
  @media (max-width: 640px) {
    .janken {
      top: auto;
      translate: none;
      bottom: calc(max(var(--sp-lg), env(safe-area-inset-bottom)) + 196px);
      max-height: calc(100vh - 260px);
      overflow-y: auto;
    }

    .janken.above-line {
      bottom: calc(max(var(--sp-lg), env(safe-area-inset-bottom)) + 332px);
      max-height: calc(100vh - 390px);
    }
  }

  @keyframes settle {
    from {
      opacity: 0;
      transform: translateX(6px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-sm);
    padding-bottom: var(--sp-xs);
    margin-bottom: var(--sp-sm);
    border-bottom: 1px solid var(--ui-line);
  }

  .label {
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    color: var(--ui-ink-muted);
  }

  .round {
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .clock {
    margin-left: auto;
    font-size: var(--fs-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  p {
    margin: 0;
  }

  .lead {
    font-size: var(--fs-sm);
    line-height: 1.45;
    color: var(--ui-ink);
  }

  .lead.muted {
    color: var(--ui-ink-muted);
  }

  .vs {
    display: block;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .row {
    display: flex;
    gap: var(--sp-xs);
    margin-top: var(--sp-sm);
  }

  .btn {
    flex: 1;
    border: 1px solid var(--ui-line);
    background: transparent;
    border-radius: var(--r-sm);
    padding: 6px var(--sp-sm);
    font: inherit;
    font-size: var(--fs-sm);
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .btn.primary {
    background: var(--ui-accent);
    border-color: var(--ui-accent);
    color: var(--ui-surface-raised);
    font-weight: 600;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .hands {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--sp-xs);
    margin-top: var(--sp-sm);
  }

  .hand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: 64px;
    padding: var(--sp-sm) 0 6px;
    border: 1px solid var(--ui-line);
    border-radius: var(--r-md);
    background: var(--ui-surface-raised);
    font: inherit;
    color: var(--ui-ink);
    cursor: pointer;
    touch-action: manipulation;
  }

  .hand:hover {
    background: var(--ui-surface-sunk);
  }

  .glyph {
    font-size: 26px;
    line-height: 1;
  }

  .hand-name {
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .keys {
    margin-top: var(--sp-xs);
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
    text-align: center;
  }

  @media (pointer: coarse) {
    .keys {
      display: none;
    }
  }

  .thrown {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    margin-bottom: var(--sp-xs);
  }

  .versus {
    display: flex;
    align-items: center;
    justify-content: space-around;
    gap: var(--sp-sm);
  }

  .side {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .who {
    max-width: 100%;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .side .glyph {
    font-size: 32px;
  }

  .vs-mark {
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .outcome {
    margin-top: var(--sp-sm);
    text-align: center;
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--ui-ink);
  }

  .outcome.win {
    color: var(--ui-live);
  }

  button:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }
</style>
