<script lang="ts">
  /**
   * PeoplePanel — who is on the island, shown inside Panels.svelte when `$openPanel === 'people'`.
   *
   * A quiet scrollable list, not a roster table: just a name and the zone it's standing
   * in, in the order the server reports them. `$self` is included at the top labelled
   * "You" — `$players` deliberately excludes the local player (see stores.ts), and a
   * "who's here" list that silently omits you would read as a bug, not restraint.
   */
  import { getZone } from '@nagisa/shared';
  import { players, self } from '../state/stores.js';
</script>

<ul class="list">
  <li class="row you">
    <span class="name">{$self.name || 'You'}</span>
    <span class="zone">{getZone($self.zone)?.name ?? $self.zone}</span>
  </li>
  {#each $players as p (p.id)}
    <li class="row">
      <span class="name">{p.name}</span>
      <span class="zone">{p.zone ? (getZone(p.zone)?.name ?? p.zone) : ''}</span>
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
</style>
