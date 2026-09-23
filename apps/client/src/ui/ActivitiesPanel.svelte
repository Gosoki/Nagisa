<script lang="ts">
  /**
   * ActivitiesPanel — everything currently on the board, shown inside Panels.svelte when
   * `$openPanel === 'activities'`.
   *
   * `NextUp.svelte` already surfaces the *one* activity worth interrupting your walk for;
   * this panel is the deliberately unhurried complement — every activity, as plain rows
   * (title / zone / state / counts / one action), not cards. Rows read as a list you
   * glance down, not a grid you browse, which matters for rule 4 ("nothing is a
   * dashboard") given this is the one place in the overlay showing more than one
   * activity at a time.
   *
   * An activity that keeps score (the dawn derby, the quiz) shows its top three under its
   * row while it is live — a name and a number each, in small type. The server sends the
   * top five; three is what fits in a glance, and the full standings are announced at the
   * end anyway.
   */
  import { ActivityState, type ActivityView } from '@nagisa/shared';
  import { activities, self, cmd } from '../state/stores.js';
  import { activityTitle, lang, t, zoneName } from '../i18n/index.js';

  function joinable(a: ActivityView): boolean {
    return a.state === ActivityState.Open || a.state === ActivityState.Live;
  }

  function countLabel(a: ActivityView): string {
    const parts = [$t('activities.going', { n: a.participantCount })];
    if (a.audienceCount > 0) parts.push($t('activities.watching', { n: a.audienceCount }));
    return parts.join(' · ');
  }

  /** The top of the board, while it is live. */
  function leaders(a: ActivityView): NonNullable<ActivityView['board']> {
    return a.state === ActivityState.Live && a.board ? a.board.slice(0, 3) : [];
  }

  /** A score in the activity's own unit: the derby measures fish, in centimetres. */
  function score(a: ActivityView, value: number): string {
    const n = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return a.feature === 'derby' ? `${n} cm` : n;
  }
</script>

{#if $activities.length === 0}
  <p class="empty">{$t('activities.empty')}</p>
{:else}
  <ul class="list">
    {#each $activities as a (a.id)}
      {@const top = leaders(a)}
      <li class="row">
        <div class="text">
          <p class="title">{activityTitle(a, $lang)}</p>
          <p class="meta">
            {zoneName(a.zone, $lang)} · <span class="chip state-{a.state}">{$t(`activities.state.${a.state}`)}</span> · {countLabel(a)}
          </p>
          {#if top.length > 0}
            <ol class="leaders" aria-label={$t('activities.leaders')}>
              {#each top as entry, i (entry.id)}
                <li>
                  <span class="rank">{i + 1}</span>
                  <span class="leader" class:me={entry.id === $self.id}>{entry.name}</span>
                  <span class="score">{score(a, entry.score)}</span>
                </li>
              {/each}
            </ol>
          {/if}
        </div>
        {#if joinable(a)}
          {#if $self.activity === a.id}
            <button type="button" class="action" onclick={() => cmd().leaveActivity()}>{$t('activities.leave')}</button>
          {:else}
            <button type="button" class="action primary" onclick={() => cmd().joinActivity(a.id, 'participant')}>
              {$t('activities.join')}
            </button>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-sm);
    padding: var(--sp-xs) 0;
    border-bottom: 1px solid var(--ui-line);
  }

  .row:last-child {
    border-bottom: none;
  }

  .text {
    min-width: 0;
  }

  .title {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--ui-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    margin: 1px 0 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .chip {
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .leaders {
    list-style: none;
    margin: 3px 0 0;
    padding: 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    font-variant-numeric: tabular-nums;
  }

  .leaders li {
    display: flex;
    gap: var(--sp-sm);
  }

  .rank {
    flex: none;
    width: 1em;
    color: var(--ui-ink-faint);
  }

  .leader {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .leader.me {
    color: var(--ui-ink);
    font-weight: 600;
  }

  .score {
    flex: none;
    color: var(--ui-ink-faint);
  }

  .chip.state-live {
    color: var(--ui-live);
  }

  .chip.state-scheduled {
    color: var(--ui-ink-faint);
  }

  .action {
    flex-shrink: 0;
    border: 1px solid var(--ui-line);
    background: transparent;
    border-radius: var(--r-sm);
    padding: 4px var(--sp-sm);
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .action.primary {
    background: var(--ui-accent);
    border-color: var(--ui-accent);
    color: var(--ui-surface-raised);
    font-weight: 600;
  }

  .action:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }

  .empty {
    margin: var(--sp-sm) 0 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }
</style>
