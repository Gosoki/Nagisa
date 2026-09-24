<script lang="ts">
  /**
   * DarumaHud — だるまさんがころんだ, as one paper card in the quiz's slot under Next Up.
   *
   * The game is played with your eyes on the oni, not on this card, so the card says one thing
   * large — the chant while the oni's back is turned, and **止まれ！** the moment it turns — and
   * everything else small: how far you have to go, whether you were just sent back, and at the
   * end who got home.
   *
   * **The turn is shown on the server's clock.** A `walk` view says when it ends; the chant is
   * paced across it syllable by syllable, and the card switches to "freeze" at that moment by
   * `serverNow`, not when the next view arrives. That is what makes the grace the server gives
   * at the start of a look the same for everyone: nobody's screen tells them to stop later
   * because their connection is slower. The switch back to "go" waits for the server's own
   * `walk`, so nobody is told to move before the oni has turned its back.
   *
   * **Who sees it.** Racers (and anyone who was one earlier in the same race, so dropping out
   * or getting home turns the card into a spectator's view rather than removing it), anyone
   * standing where the course is, and anyone attached to the activity.
   *
   * Nothing on the card is interactive, so it keeps `pointer-events: none` and never steals a
   * tap from the beach underneath.
   */
  import { DARUMA_COURSE, darumaCourseAt, darumaCourseLength } from '@nagisa/shared';
  import { activities, daruma, quiz, self, selfPose, serverNow } from '../state/stores.js';
  import { lang, t, zoneName } from '../i18n/index.js';

  /** How often the chant, the clocks and your distance are re-read, ms. */
  const POLL_MS = 100;

  /** Medals for the places, in order. */
  const MEDALS = ['🥇', '🥈', '🥉'];

  let now = $state(serverNow());
  let toGo = $state<number | null>(null);

  /** The race (by activity id) you have been racing in, so dropping out or getting home keeps the card. */
  let racerIn = $state<string | null>(null);

  const v = $derived($daruma);
  const me = $derived($self.id);

  $effect(() => {
    const cur = $daruma;
    const id = $self.id;
    if (cur && id && (cur.racing.includes(id) || cur.places.some((p) => p.id === id))) racerIn = cur.activity;
  });

  const racing = $derived(!!v && !!me && v.racing.includes(me));
  const place = $derived(v && me ? v.places.findIndex((p) => p.id === me) : -1);
  const wasRacer = $derived(!!v && racerIn === v.activity);

  const visible = $derived(
    !!v && (wasRacer || (!!DARUMA_COURSE && $self.zone === DARUMA_COURSE.zone) || $self.activity === v.activity),
  );

  const counting = $derived(visible && v?.phase !== 'finished');

  $effect(() => {
    if (!counting) return;
    const poll = (): void => {
      now = serverNow();
      const at = darumaCourseAt(selfPose.x, selfPose.z);
      toGo = at ? Math.max(0, darumaCourseLength() - at.along) : null;
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  });

  /** The oni has turned: its look has begun, or the chant has run out and the look is on its way. */
  const frozen = $derived(!!v && (v.phase === 'look' || (v.phase === 'walk' && now >= v.endsAt)));

  /** The chant, as far as it has got. Syllables are separated by `|` in the dictionary. */
  const chant = $derived.by(() => {
    const parts = $t('daruma.chant').split('|');
    if (!v || v.phase !== 'walk') return parts.join('');
    const span = Math.max(1, v.endsAt - v.startedAt);
    const said = Math.min(parts.length, Math.max(1, Math.floor(((now - v.startedAt) / span) * parts.length) + 1));
    return parts.slice(0, said).join('');
  });

  /** Seconds left: of the lobby, or of the race. */
  const secondsLeft = $derived.by(() => {
    if (!v) return 0;
    const end = v.phase === 'lobby' ? v.endsAt : (v.raceEndsAt ?? v.endsAt);
    return Math.max(0, Math.ceil((end - now) / 1000));
  });
  const clock = $derived(
    v?.phase === 'lobby' ? $t('game.seconds', { n: secondsLeft }) : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`,
  );

  const activity = $derived(v ? $activities.find((a) => a.id === v.activity) : undefined);
  const venue = $derived(zoneName(DARUMA_COURSE?.zone ?? activity?.zone, $lang));
  const caughtNow = $derived(!!v && !!me && (v.caught?.includes(me) ?? false));

  /** A name, with yours marked. */
  function who(entry: { id: string; name: string }): string {
    return entry.id === me ? $t('daruma.me', { name: entry.name }) : entry.name;
  }
</script>

{#if visible && v}
  <!-- A quiz on at the same time (an admin can put both on) has the slot; this goes under it. -->
  <section
    class="daruma"
    class:below={$quiz !== null}
    role="status"
    aria-live="polite"
    aria-atomic="false"
    aria-label={$t('daruma.title')}
  >
    <header class="head">
      <span class="label">{$t('daruma.title')}</span>
      {#if v.phase !== 'finished'}
        <span class="clock" role="timer" aria-live="off" aria-label={$t('game.secondsLeft', { n: secondsLeft })}>{clock}</span>
      {/if}
    </header>

    <div class="body">
      {#if v.phase === 'lobby'}
        <p class="lead">
          {(activity?.participantCount ?? 0) > 0 ? $t('daruma.lobby', { place: venue }) : $t('daruma.waiting')}
        </p>
        <p class="how">{$t('daruma.how')}</p>
        {#if $self.activity === v.activity && $self.mode === 'participant'}
          <p class="where inside">{$t('daruma.youreIn')}</p>
        {/if}
      {:else if v.phase === 'walk' || v.phase === 'look'}
        {#if frozen}
          <p class="call freeze">{$t('daruma.freeze')}</p>
          <p class="how">{$t('daruma.looking')}</p>
        {:else}
          <p class="call" aria-hidden="true">{chant}</p>
          <p class="how">{$t('daruma.go')}</p>
        {/if}
        <div class="foot">
          {#if caughtNow}
            <span class="where caught">{$t('daruma.caught')}</span>
          {:else if racing}
            <!-- Ten times a second while walking: not something to read out each time. -->
            <span class="where inside" aria-live="off">{$t('daruma.toGo', { m: (toGo ?? 0).toFixed(1) })}</span>
          {:else if place >= 0}
            <span class="where inside">{$t('daruma.placed', { n: place + 1 })}</span>
          {:else}
            <span class="where">{wasRacer ? $t('daruma.out') : $t('daruma.watching')}</span>
          {/if}
          <span class="count">
            {v.phase === 'look' && (v.caught?.length ?? 0) > 0 ? $t('daruma.sentBack', { n: v.caught?.length ?? 0 }) : $t('daruma.racing', { n: v.racing.length })}
          </span>
        </div>
      {:else}
        <p class="lead">{$t('daruma.over')}</p>
        {#if v.places.length === 0}
          <p class="how">{$t('daruma.noWinner')}</p>
        {/if}
      {/if}

      {#if v.places.length > 0}
        <ol class="places" aria-label={$t('daruma.places')}>
          {#each v.places as entry, i (entry.id)}
            <li class:me={entry.id === me}>
              <span class="medal" aria-hidden="true">{MEDALS[i] ?? ''}</span>
              <span class="name">{who(entry)}</span>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </section>
{/if}

<style>
  /* The quiz card's slot, directly under NextUp's strip; the offsets track NextUp's own
     breakpoints (see QuizHud). */
  .daruma {
    position: fixed;
    top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 64px);
    left: 50%;
    translate: -50% 0;
    z-index: var(--z-hud);
    pointer-events: none;
    width: min(320px, calc(100vw - 2 * var(--sp-md)));
    box-sizing: border-box;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-panel);
    padding: var(--sp-sm) var(--sp-md);
  }

  @media (max-width: 640px) {
    .daruma {
      top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 92px);
    }
  }

  @media (max-width: 420px) {
    .daruma {
      top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 120px);
    }
  }

  /* Clear of the quiz card, which is at most about this tall. */
  .daruma.below {
    margin-top: 250px;
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

  .clock {
    margin-left: auto;
    font-size: var(--fs-md);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ui-ink);
  }

  .body {
    padding-top: var(--sp-xs);
  }

  p {
    margin: 0;
  }

  .lead {
    font-size: var(--fs-sm);
    color: var(--ui-ink);
  }

  .how {
    margin-top: 2px;
    font-size: var(--fs-xs);
    line-height: 1.45;
    color: var(--ui-ink-muted);
  }

  /* The one thing to read at a glance: the chant in ink, and the turn in the island's accent. */
  .call {
    font-size: var(--fs-lg);
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: 0.04em;
    color: var(--ui-ink);
    min-height: 1.3em;
  }

  .call.freeze {
    font-size: var(--fs-display);
    line-height: 1.1;
    color: var(--ui-accent);
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

  .where.caught {
    color: var(--ui-accent);
    font-weight: 600;
  }

  .count {
    color: var(--ui-ink-faint);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .places {
    list-style: none;
    margin: var(--sp-xs) 0 0;
    padding: 0;
    font-size: var(--fs-sm);
    color: var(--ui-ink-muted);
  }

  .places li {
    display: flex;
    gap: var(--sp-xs);
  }

  .places li.me {
    color: var(--ui-ink);
    font-weight: 600;
  }

  .places .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
