<script lang="ts">
  /**
   * QuizHud — the ○× quiz, as one small paper card under the Next Up strip.
   *
   * The quiz is played with your feet: the statement is on this card, the answer is where you
   * stand. So the card's whole job is to say three things at a glance — what is being asked,
   * how long is left, and which circle the island thinks you are in — and then get out of the
   * way of the plaza, where the actual game is.
   *
   * **Who sees it.** Contestants (your id in `alive`, `fell` or `winners` — and anyone who was
   * one earlier in the same quiz, so falling out turns the card into a spectator's view
   * rather than removing it), anyone standing in the arena's zone, and anyone attached to the
   * quiz activity. Everyone else on the island gets nothing: a quiz on the plaza is not news
   * at the lighthouse.
   *
   * **The countdown ticks.** Everywhere else in the interface time is shown coarsely and
   * refreshed rarely, because a digit that changes every second demands attention. Here the
   * seconds *are* the game — you are deciding when to commit to a circle — so this is the one
   * clock allowed to count down in whole seconds. It is still read on the server's clock
   * (`serverNow`), so everyone's zero is the same zero.
   *
   * **Your position is polled, not pushed.** `selfPose` is a plain object the app writes every
   * frame; a store written at 60 Hz would re-render the card sixty times a second. Reading it
   * every 150 ms while a question is open is responsive enough to feel live and costs nothing
   * the rest of the time. It is only a hint — the server decides from your last validated
   * position when the clock runs out.
   *
   * Nothing on the card is interactive, so it keeps `pointer-events: none` and never steals a
   * tap from the plaza underneath.
   */
  import { QUIZ_ARENA, quizSide } from '@nagisa/shared';
  import { activities, players, quiz, quizCardShown, self, selfPose, serverNow } from '../state/stores.js';
  import { lang, quizText, t, zoneName } from '../i18n/index.js';

  /** How often the countdown and your circle are re-read while a question is open. */
  const POLL_MS = 150;

  /** Winners named outright; the rest are counted. */
  const MAX_NAMES = 3;

  let now = $state(serverNow());
  let side = $state<'o' | 'x' | null>(null);

  /** The quiz (by activity id) you have been a contestant in, so falling out keeps the card. */
  let contestantIn = $state<string | null>(null);

  const q = $derived($quiz);
  const me = $derived($self.id);

  $effect(() => {
    const cur = $quiz;
    const id = $self.id;
    // The lobby's list is still forming; being in it is not yet being in the quiz.
    if (!cur || !id || cur.phase === 'lobby') return;
    if (cur.alive.includes(id) || cur.fell?.includes(id) || cur.winners?.includes(id)) contestantIn = cur.activity;
  });

  const isAlive = $derived(!!q && !!me && q.alive.includes(me));
  const wasContestant = $derived(!!q && contestantIn === q.activity);

  const visible = $derived(
    !!q &&
      (wasContestant ||
        isAlive ||
        (!!me && (q.fell?.includes(me) || q.winners?.includes(me))) ||
        (!!QUIZ_ARENA && $self.zone === QUIZ_ARENA.zone) ||
        $self.activity === q.activity),
  );

  const counting = $derived(visible && (q?.phase === 'lobby' || q?.phase === 'question'));

  $effect(() => {
    quizCardShown.set(visible);
    return () => quizCardShown.set(false);
  });

  $effect(() => {
    if (!counting) return;
    const poll = (): void => {
      now = serverNow();
      side = quizSide(selfPose.x, selfPose.z);
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  });

  const secondsLeft = $derived(q ? Math.max(0, Math.ceil((q.endsAt - now) / 1000)) : 0);

  /** Where to gather: the arena's zone, or the activity's own venue on a map without one. */
  const venue = $derived(
    zoneName(QUIZ_ARENA?.zone ?? $activities.find((a) => a.id === q?.activity)?.zone, $lang),
  );

  const words = $derived(quizText(q?.questionId, $lang));

  /** Winners as names — yours first — with how many were left unnamed. */
  const winners = $derived.by(() => {
    const ids = q?.winners ?? [];
    const names: string[] = [];
    if (me && ids.includes(me)) names.push($t('quiz.me', { name: $self.name }));
    for (const id of ids) {
      if (id === me || names.length >= MAX_NAMES) continue;
      const name = $players.find((p) => p.id === id)?.name;
      if (name) names.push(name);
    }
    return { names, rest: ids.length - names.length, total: ids.length };
  });

  const fellCount = $derived(q?.fell?.length ?? 0);
</script>

{#if visible && q}
  <section class="quiz" role="status" aria-live="polite" aria-atomic="false" aria-label={$t('quiz.title')}>
    <header class="head">
      <span class="label">{$t('quiz.title')}</span>
      {#if q.phase === 'question'}
        <span class="round">{$t('quiz.round', { n: q.round, total: q.totalRounds })}</span>
      {/if}
      {#if q.phase === 'lobby' || q.phase === 'question'}
        <span class="clock" role="timer" aria-live="off" aria-label={$t('game.secondsLeft', { n: secondsLeft })}>
          {$t('game.seconds', { n: secondsLeft })}
        </span>
      {/if}
    </header>

    {#key `${q.phase}:${q.round}`}
      <div class="body">
        {#if q.phase === 'lobby'}
          <p class="lead">{$t('quiz.lobby', { place: venue })}</p>
        {:else if q.phase === 'question'}
          <p class="statement">{words.text}</p>
          <p class="how">{$t('quiz.how')}</p>
          <div class="foot">
            {#if isAlive}
              <span class="where" class:inside={side !== null}>
                {side === 'o' ? $t('quiz.inO') : side === 'x' ? $t('quiz.inX') : $t('quiz.inNone')}
              </span>
            {:else}
              <span class="where">{wasContestant ? $t('quiz.out') : $t('quiz.watching')}</span>
            {/if}
            <span class="count">{$t('quiz.alive', { n: q.alive.length })}</span>
          </div>
        {:else if q.phase === 'reveal'}
          {#if q.answer !== undefined}
            <p class="answer-label">{$t('quiz.answerIs')}</p>
            <p class="answer">
              <span class="mark" class:o={q.answer} class:x={!q.answer} aria-hidden="true">{q.answer ? '○' : '×'}</span>
              <span class="answer-word">{q.answer ? $t('quiz.true') : $t('quiz.false')}</span>
            </p>
          {/if}
          {#if words.explain}
            <p class="explain">{words.explain}</p>
          {/if}
          <div class="foot">
            {#if me && q.fell?.includes(me)}
              <span class="where">{$t('quiz.youFell')}</span>
            {:else if isAlive}
              <span class="where inside">{$t('quiz.stillIn')}</span>
            {:else}
              <span class="where">{wasContestant ? $t('quiz.out') : $t('quiz.watching')}</span>
            {/if}
            <span class="count">{fellCount > 0 ? $t('quiz.fell', { n: fellCount }) : q.replay ? $t('quiz.replay') : $t('quiz.noneFell')}</span>
          </div>
        {:else if q.phase === 'finished'}
          <p class="lead">{$t('quiz.over')}</p>
          {#if winners.total > 0}
            <p class="winners">
              <span class="trophy" aria-hidden="true">🏆</span>
              <span class="winners-label">{winners.total === 1 ? $t('quiz.winner') : $t('quiz.winners')}</span>
              <span class="names">
                {winners.names.join($t('game.listSep'))}{#if winners.rest > 0}{' '}{$t('quiz.andOthers', { n: winners.rest })}{/if}
              </span>
            </p>
          {:else}
            <p class="explain">{$t('quiz.noWinner')}</p>
          {/if}
        {/if}
      </div>
    {/key}
  </section>
{/if}

<style>
  /* Directly under NextUp's strip (≈56 px tall at the top centre). On a phone the strip drops
     below the icon row, and on a narrow one it stacks its buttons under its title and grows —
     hence the two offsets below, which track NextUp's own breakpoints. */
  .quiz {
    position: fixed;
    top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 64px);
    left: 50%;
    translate: -50% 0;
    z-index: var(--z-hud);
    pointer-events: none;
    width: min(340px, calc(100vw - 2 * var(--sp-md)));
    box-sizing: border-box;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-panel);
    padding: var(--sp-sm) var(--sp-md) var(--sp-sm);
    animation: settle var(--mo-calm) both;
  }

  @media (max-width: 640px) {
    .quiz {
      top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 92px);
    }
  }

  @media (max-width: 420px) {
    .quiz {
      top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 120px);
    }
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

  .round {
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .clock {
    margin-left: auto;
    font-size: var(--fs-md);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ui-ink);
  }

  .body {
    padding-top: var(--sp-xs);
    animation: fade var(--mo-calm) both;
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  p {
    margin: 0;
  }

  .lead {
    font-size: var(--fs-sm);
    color: var(--ui-ink);
  }

  .statement {
    font-size: var(--fs-md);
    font-weight: 600;
    line-height: 1.45;
    color: var(--ui-ink);
  }

  .how {
    margin-top: 2px;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .foot {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-sm);
    margin-top: var(--sp-xs);
    font-size: var(--fs-xs);
  }

  .where {
    color: var(--ui-ink-muted);
  }

  .where.inside {
    color: var(--ui-ink);
    font-weight: 600;
  }

  .count {
    color: var(--ui-ink-faint);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .answer-label {
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .answer {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
  }

  .mark {
    font-size: var(--fs-display);
    line-height: 1;
    font-weight: 600;
  }

  /* The reveal's ○ is the card's one touch of vermilion; × takes the sea. */
  .mark.o {
    color: var(--ui-accent);
  }

  .mark.x {
    color: var(--ui-sea);
  }

  .answer-word {
    font-size: var(--fs-lg);
    font-weight: 600;
  }

  .explain {
    margin-top: 2px;
    font-size: var(--fs-sm);
    line-height: 1.45;
    color: var(--ui-ink-muted);
  }

  .winners {
    margin-top: 2px;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px var(--sp-xs);
    font-size: var(--fs-sm);
  }

  .winners-label {
    color: var(--ui-ink-muted);
    font-size: var(--fs-xs);
  }

  .names {
    font-weight: 600;
    color: var(--ui-ink);
  }
</style>
