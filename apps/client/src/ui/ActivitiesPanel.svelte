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
   */
  import { getZone, ActivityState, type ActivityView } from '@nagisa/shared';
  import { activities, self, cmd } from '../state/stores.js';

  const STATE_LABEL: Record<ActivityState, string> = {
    [ActivityState.Scheduled]: 'Scheduled',
    [ActivityState.Open]: 'Open',
    [ActivityState.Live]: 'Live',
    [ActivityState.Ended]: 'Ended',
    [ActivityState.Cancelled]: 'Cancelled',
  };

  function joinable(a: ActivityView): boolean {
    return a.state === ActivityState.Open || a.state === ActivityState.Live;
  }

  function countLabel(a: ActivityView): string {
    const parts = [`${a.participantCount} going`];
    if (a.audienceCount > 0) parts.push(`${a.audienceCount} watching`);
    return parts.join(' · ');
  }
</script>

{#if $activities.length === 0}
  <p class="empty">Nothing on the board right now.</p>
{:else}
  <ul class="list">
    {#each $activities as a (a.id)}
      <li class="row">
        <div class="text">
          <p class="title">{a.title}</p>
          <p class="meta">
            {getZone(a.zone)?.name ?? a.zone} · <span class="chip state-{a.state}">{STATE_LABEL[a.state]}</span> · {countLabel(a)}
          </p>
        </div>
        {#if joinable(a)}
          {#if $self.activity === a.id}
            <button type="button" class="action" onclick={() => cmd().leaveActivity()}>Leave</button>
          {:else}
            <button type="button" class="action primary" onclick={() => cmd().joinActivity(a.id, 'participant')}>
              Join
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
