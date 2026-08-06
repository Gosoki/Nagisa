<script lang="ts">
  /**
   * PeoplePanel — who is on the island, shown inside Panels.svelte when `$openPanel === 'people'`.
   *
   * A quiet scrollable list, not a roster table: just a name and the zone it's standing
   * in, in the order the server reports them. `$self` is included at the top labelled
   * "You" — `$players` deliberately excludes the local player (see stores.ts), and a
   * "who's here" list that silently omits you would read as a bug, not restraint.
   *
   * Each row carries the one social affordance the world cannot express by itself:
   * **follow**. Knowing someone is at the shrine does not help if you do not know where the
   * shrine is from here, and asking a stranger to wait while you read a map is not a
   * feature. Following walks you there — see `App.updateFollow` for why it is a walk and
   * not a teleport.
   */
  import { getZone } from '@nagisa/shared';
  import { commands, followTarget, players, self } from '../state/stores.js';
</script>

<ul class="list">
  <li class="row you">
    <span class="name">{$self.name || 'You'}</span>
    <span class="zone">{getZone($self.zone)?.name ?? $self.zone}</span>
  </li>
  {#each $players as p (p.id)}
    <li class="row" class:followed={$followTarget?.id === p.id}>
      <span class="name">{p.name}</span>
      <span class="zone">{p.zone ? (getZone(p.zone)?.name ?? p.zone) : ''}</span>
      {#if $followTarget?.id === p.id}
        <button class="follow on" on:click={() => $commands.follow(null)}>Stop</button>
      {:else}
        <button class="follow" on:click={() => $commands.follow(p.id)}>Follow</button>
      {/if}
    </li>
  {/each}
</ul>

{#if $players.length === 0}
  <p class="empty">Just you, for now.</p>
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
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-sm);
    padding: 6px 0;
    border-bottom: 1px solid var(--ui-line);
  }

  .row:last-child {
    border-bottom: none;
  }

  .row.you .name {
    font-weight: 600;
  }

  .name {
    font-size: var(--fs-sm);
    color: var(--ui-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .zone {
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .empty {
    margin: var(--sp-sm) 0 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .row.followed {
    color: var(--ui-accent);
  }

  .follow {
    all: unset;
    cursor: pointer;
    font-size: var(--fs-xs);
    padding: 0.1rem 0.5rem;
    margin-left: var(--sp-xs);
    border-radius: 999px;
    border: 1px solid var(--ui-line);
    color: var(--ui-ink-muted);
    flex: none;
    /* Revealed on hover so a list of twenty people is a list, not a wall of buttons. */
    opacity: 0;
    transition: opacity var(--mo-quick) ease;
  }

  .row:hover .follow,
  .follow.on,
  .follow:focus-visible {
    opacity: 1;
  }

  .follow.on {
    border-color: var(--ui-accent);
    color: var(--ui-accent);
  }
</style>
