<script lang="ts">
  /**
   * PeoplePanel — who is on the island, shown inside Panels.svelte when `$openPanel === 'people'`.
   *
   * A quiet scrollable list, not a roster table: just a name and the zone it's standing
   * in, in the order the server reports them. `$self` is included at the top labelled
   * "You" — `$players` deliberately excludes the local player (see stores.ts), and a
   * "who's here" list that silently omits you would read as a bug, not restraint.
   *
   * Each row carries the two social affordances the world cannot express by itself.
   *
   * **Follow.** Knowing someone is at the shrine does not help if you do not know where the
   * shrine is from here, and asking a stranger to wait while you read a map is not a
   * feature. Following walks you there — see `App.updateFollow` for why it is a walk and
   * not a teleport.
   *
   * **Mute.** The one control that works with nobody watching: no host has to be present and
   * no report has to be read. It belongs here rather than on a right-click in the world
   * because the person you want to stop reading is often the person you are walking *away*
   * from, and aiming at them is the last thing you should have to do. See `stores.mutedIds`
   * for why it is unilateral, local, and does not hide them.
   *
   * A name is also a button: it opens that person's card (PlayerCard.svelte), which is where
   * whispering, janken and the rest live — the list stays a list. The badge someone wears is
   * shown as its small icon beside their name, the same mark their name tag carries.
   */
  import { commands, followTarget, myTitle, mutedSet, players, selectedPlayer, self, toggleMute } from '../state/stores.js';
  import { badgeIcon, badgeName, lang, t, zoneName } from '../i18n/index.js';
</script>

{#snippet badge(id: string | null | undefined)}
  {#if id && badgeIcon(id)}
    <span
      class="badge"
      role="img"
      aria-label={$t('people.wearing', { badge: badgeName(id, $lang) })}
      title={badgeName(id, $lang)}
    >{badgeIcon(id)}</span>
  {/if}
{/snippet}

<ul class="list">
  <li class="row you">
    <span class="who">
      <span class="name">{$self.name || $t('people.you')}</span>
      {@render badge($myTitle)}
    </span>
    <span class="zone">{zoneName($self.zone, $lang)}</span>
  </li>
  {#each $players as p (p.id)}
    <li class="row" class:followed={$followTarget?.id === p.id} class:muted={$mutedSet.has(p.id)}>
      <span class="who">
        <button
          type="button"
          class="name"
          aria-haspopup="dialog"
          title={$t('people.openCard', { name: p.name })}
          onclick={() => selectedPlayer.set(p.id)}
        >{p.name}</button>
        {@render badge(p.title)}
      </span>
      <span class="zone">{p.zone ? zoneName(p.zone, $lang) : ''}</span>
      <button
        type="button"
        class="act mute"
        class:on={$mutedSet.has(p.id)}
        aria-pressed={$mutedSet.has(p.id)}
        title={$mutedSet.has(p.id) ? $t('people.unmuteName', { name: p.name }) : $t('people.muteName', { name: p.name })}
        onclick={() => toggleMute(p.id, p.name)}
      >
        {$mutedSet.has(p.id) ? $t('people.unmute') : $t('people.mute')}
      </button>
      {#if $followTarget?.id === p.id}
        <button type="button" class="act follow on" onclick={() => $commands.follow(null)}>{$t('people.stop')}</button>
      {:else}
        <button type="button" class="act follow" onclick={() => $commands.follow(p.id)}>{$t('people.follow')}</button>
      {/if}
    </li>
  {/each}
</ul>

{#if $players.length === 0}
  <p class="empty">{$t('people.alone')}</p>
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

  .who {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .name {
    font-size: var(--fs-sm);
    color: var(--ui-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  button.name {
    all: unset;
    font-size: var(--fs-sm);
    color: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    border-radius: var(--r-sm);
  }

  button.name:hover {
    text-decoration: underline;
    text-decoration-color: var(--ui-line);
    text-underline-offset: 3px;
  }

  button.name:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 1px;
  }

  .badge {
    flex: none;
    font-size: var(--fs-xs);
    line-height: 1;
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

  /* A muted row stays legible — you still need to see them to walk away from them — but
     reads as switched off, which is the honest picture of what the mute did. */
  .row.muted .name,
  .row.muted .zone {
    opacity: 0.45;
    text-decoration: line-through;
    text-decoration-thickness: 1px;
  }

  .act {
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

  .row:hover .act,
  .act.on,
  .act:focus-visible {
    opacity: 1;
  }

  .follow.on {
    border-color: var(--ui-accent);
    color: var(--ui-accent);
  }

  .mute.on {
    border-color: var(--ui-ink-faint);
    color: var(--ui-ink-faint);
  }
</style>
