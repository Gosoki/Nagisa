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
   *
   * **Friends** are listed under the people here: asks waiting for an answer, then everyone
   * on the list — on or off, and on which island. A friend on another island is one button
   * away ("go to them" goes to their island, private or not: a friendship is as much of an
   * invitation as a link). Someone who is a friend is also marked in the list above.
   */
  import type { FriendView } from '@nagisa/shared';
  import { cmd, commands, followTarget, friends, friendsHere, myTitle, mutedSet, players, room, selectedPlayer, self, toggleMute } from '../state/stores.js';
  import { badgeIcon, badgeName, lang, roomName, t, zoneName } from '../i18n/index.js';

  /** The friend whose "remove" has been pressed once, waiting for the second press. */
  let removing = $state<string | null>(null);

  function place(f: FriendView): string {
    if (!f.room) return '';
    if (f.room.id === $room?.id) return $t('friend.here');
    return f.room.kind === 'private' ? $t('island.private', { code: f.room.code ?? '' }) : roomName(f.room, $lang);
  }

  function goTo(f: FriendView): void {
    if (!f.room) return;
    cmd().joinIsland(f.room.kind === 'private' && f.room.code ? f.room.code : f.room.id);
  }

  function remove(f: FriendView): void {
    if (removing !== f.id) {
      removing = f.id;
      return;
    }
    removing = null;
    cmd().friend('remove', f.id);
  }
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
        {#if $friendsHere.has(p.id)}<span class="friend-mark" title={$t('friend.isFriend')}>{$t('friend.isFriend')}</span>{/if}
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

<section class="friends" aria-labelledby="friends-title">
  <h3 class="section-title" id="friends-title">{$t('friend.title')}</h3>
  {#if !$friends.enabled}
    <p class="empty">{$t('friend.needsKey')}</p>
  {:else}
    {#each $friends.requests as r (r.id)}
      <div class="row ask">
        <span class="who"><span class="name">{$t('friend.asked', { name: r.name })}</span></span>
        <button type="button" class="act shown on" onclick={() => cmd().friend('accept', r.id)}>{$t('friend.accept')}</button>
        <button type="button" class="act shown" onclick={() => cmd().friend('decline', r.id)}>{$t('friend.decline')}</button>
      </div>
    {/each}
    {#if $friends.friends.length === 0}
      <p class="empty">{$t('friend.none')}</p>
    {:else}
      <ul class="list">
        {#each $friends.friends as f (f.id)}
          <li class="row" class:offline={!f.online}>
            <span class="who">
              <span class="dot" class:on={f.online} aria-hidden="true"></span>
              <span class="name">{f.name}</span>
            </span>
            <span class="zone">{f.online ? place(f) : $t('friend.offline')}</span>
            {#if f.online && f.room && f.room.id !== $room?.id}
              <button type="button" class="act shown on" onclick={() => goTo(f)}>{$t('friend.go')}</button>
            {:else if f.online && f.player && $followTarget?.id !== f.player}
              <button type="button" class="act follow" onclick={() => $commands.follow(f.player ?? null)}>{$t('people.follow')}</button>
            {/if}
            <button type="button" class="act" class:on={removing === f.id} onclick={() => remove(f)} onblur={() => (removing = removing === f.id ? null : removing)}>
              {removing === f.id ? $t('friend.removeConfirm') : $t('friend.remove')}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

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

  .friends {
    margin-top: var(--sp-md);
  }

  .section-title {
    margin: 0 0 var(--sp-xs);
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--ui-ink-muted);
  }

  /* Answers to an ask are not revealed on hover: they are the whole point of the row. */
  .act.shown {
    opacity: 1;
  }

  .friend-mark {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--ui-sea);
  }

  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    align-self: center;
    background: var(--ui-ink-faint);
  }

  .dot.on {
    background: var(--ui-live);
  }

  .row.offline .name {
    color: var(--ui-ink-muted);
  }
</style>
