<script lang="ts">
  /**
   * TreasureHud — the treasure hunt, as one paper card where the quiz's would be.
   *
   * The hunt is played with your feet and a spade: walk somewhere, dig, read what the sand
   * says, walk on. So the card holds exactly that loop — how many are still buried, what your
   * last dig said, and the button (or F) that digs — plus who has found the most, because a
   * name on the board is what makes the next dig worth doing.
   *
   * It is shown to everyone on the island while a hunt is live: unlike the quiz there is no
   * arena, the whole island is the field. The quiz and the hunt are never on the programme at
   * the same time, so they share the slot under the Next Up strip — and if an admin puts both
   * on at once, this card steps down under the quiz's.
   *
   * The button rests a little longer than the server's own interval between digs, so a
   * second press does not earn a refusal. F is ignored while typing, like every other game key.
   */
  import { DIG_COOLDOWN_MS } from '@nagisa/shared';
  import { cmd, lastDig, quiz, self, treasureHunt } from '../state/stores.js';
  import { t } from '../i18n/index.js';

  /** How long what the sand said stays on the card, ms. */
  const RESULT_MS = 6000;

  /**
   * How long the button rests after a dig: the server's interval, plus a little. The server
   * measures between arrivals, and two digs sent exactly the interval apart can arrive a
   * little closer than that.
   */
  const REST_MS = DIG_COOLDOWN_MS + 250;

  let resting = $state(false);
  let now = $state(performance.now());

  const hunt = $derived($treasureHunt);
  const shown = $derived($lastDig && now - $lastDig.at < RESULT_MS ? $lastDig : null);
  const board = $derived((hunt?.board ?? []).slice(0, 3));

  // Re-read the clock while a result is up, so it leaves on time.
  $effect(() => {
    if (!$lastDig) return;
    now = performance.now();
    const timer = setTimeout(() => (now = performance.now()), RESULT_MS + 50);
    return () => clearTimeout(timer);
  });

  function dig(): void {
    if (resting || !hunt) return;
    cmd().dig();
    resting = true;
    setTimeout(() => (resting = false), REST_MS);
  }

  function typing(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.code !== 'KeyF' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || !hunt) return;
    e.preventDefault();
    dig();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if hunt}
  <!-- A quiz on at the same time (an admin can put both on) has the slot; this goes under it. -->
  <section class="treasure" class:below={$quiz !== null} aria-label={$t('treasure.title')}>
    <header class="head">
      <span class="label"><span aria-hidden="true">💎</span> {$t('treasure.title')}</span>
      <span class="left">{$t('treasure.left', { n: hunt.left ?? 0 })}</span>
    </header>

    {#if shown}
      <p class="said {shown.result}" role="status">
        {shown.result === 'found' ? $t('treasure.found') : $t(`treasure.heat.${shown.result}`)}
      </p>
    {:else}
      <p class="how">{$t('treasure.how')}</p>
    {/if}

    <button type="button" class="dig" disabled={resting} onclick={dig}>
      <span>{$t('treasure.dig')}</span>
      <kbd class="key-hint">{$t('treasure.key')}</kbd>
    </button>

    {#if board.length}
      <ol class="board" aria-label={$t('treasure.board')}>
        {#each board as entry (entry.id)}
          <li class:me={entry.id === $self.id}>
            <span class="name">{entry.name}</span>
            <span class="score">×{entry.score}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
{/if}

<style>
  /* The quiz card's slot, directly under NextUp's strip; the offsets track NextUp's own
     breakpoints (see QuizHud). */
  .treasure {
    position: fixed;
    top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 64px);
    left: 50%;
    translate: -50% 0;
    z-index: var(--z-hud);
    pointer-events: none;
    width: min(300px, calc(100vw - 2 * var(--sp-md)));
    box-sizing: border-box;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-panel);
    padding: var(--sp-sm) var(--sp-md);
  }

  @media (max-width: 640px) {
    .treasure {
      top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 92px);
    }
  }

  /* Clear of the quiz card, which is at most about this tall. */
  .treasure.below {
    margin-top: 250px;
  }

  @media (max-width: 420px) {
    .treasure {
      top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 120px);
    }
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-sm);
    padding-bottom: var(--sp-xs);
    border-bottom: 1px solid var(--ui-line);
  }

  .label {
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    color: var(--ui-ink-muted);
  }

  .left {
    margin-left: auto;
    font-size: var(--fs-xs);
    color: var(--ui-ink);
    font-variant-numeric: tabular-nums;
  }

  .how,
  .said {
    margin: var(--sp-xs) 0;
    font-size: var(--fs-sm);
    line-height: 1.45;
    color: var(--ui-ink-muted);
  }

  .said {
    font-weight: 600;
    color: var(--ui-ink);
  }

  /* Heat reads as colour as well as words, from the island's own palette: vermilion for
     hot, ochre for warm, the sea for cool and cold. */
  .said.hot,
  .said.found {
    color: var(--ui-accent);
  }

  .said.warm {
    color: var(--ui-warn);
  }

  .said.cool,
  .said.cold {
    color: var(--ui-sea);
  }

  .dig {
    pointer-events: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-sm);
    width: 100%;
    min-height: 44px;
    border: 2px solid var(--ui-accent);
    border-radius: var(--r-lg);
    background: var(--ui-surface-raised);
    color: var(--ui-ink);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    touch-action: manipulation;
  }

  .dig:active {
    background: var(--ui-surface-sunk);
  }

  .dig:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .dig:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
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

  .board {
    list-style: none;
    margin: var(--sp-sm) 0 0;
    padding: 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .board li {
    display: flex;
    gap: var(--sp-sm);
  }

  .board li.me {
    color: var(--ui-ink);
    font-weight: 600;
  }

  .board .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .board .score {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
</style>
