<script lang="ts">
  /**
   * PlayerCard — one person, and the handful of things you can do with them.
   *
   * Opens when `$selectedPlayer` names someone in the room, and closes itself if they leave:
   * a card about somebody who is no longer here is a card whose buttons all fail.
   *
   * What it shows is what you would want to know before walking over — their name, the badge
   * they chose to wear, where they are and what they are at — and what it offers is the four
   * social verbs the world cannot express by itself:
   *
   * - **Follow** walks you to them and keeps you near (see `followTarget`).
   * - **Janken** challenges them; the duel card takes over from there, so this one closes.
   * - **Whisper** opens a one-line field right here. Enter sends and clears it and keeps it
   *   open, because a whisper is rarely one line; Escape inside it closes just the field.
   * - **Mute** is the unilateral one (see `stores.mutedIds`) and tells them nothing.
   *
   * Island keepers (`$isAdmin`) get a second, quieter row: mute or unmute on the server, kick
   * behind a confirmation, and hand an activity's hosting to this person or take it back.
   *
   * It sits on the left, clear of the minimap above it on a desktop and of the joystick and
   * chat on a phone, and closes on Escape, the ×, or a press anywhere outside it — the same
   * three ways out as the panels have.
   */
  import { ActivityState, PROTOCOL } from '@nagisa/shared';
  import {
    activities,
    cmd,
    followTarget,
    friends,
    friendsHere,
    isAdmin,
    janken,
    mutedSet,
    notify,
    players,
    room,
    selectedPlayer,
    toggleMute,
  } from '../state/stores.js';
  import { activityTitle, badgeIcon, badgeName, lang, t, tr, zoneName } from '../i18n/index.js';

  let cardEl = $state<HTMLElement>();
  let whisperEl = $state<HTMLInputElement>();
  let whisperOpen = $state(false);
  let whisperText = $state('');
  let confirmKick = $state(false);
  let hostChoice = $state('');
  /** Asked to be friends from this card; the button rests until the card changes. */
  let asked = $state(false);

  const player = $derived($selectedPlayer ? ($players.find((p) => p.id === $selectedPlayer) ?? null) : null);

  // They left (or were never in the room): nothing to show.
  $effect(() => {
    if ($selectedPlayer && !player) selectedPlayer.set(null);
  });

  // A different person is a fresh card.
  $effect(() => {
    void $selectedPlayer;
    whisperOpen = false;
    whisperText = '';
    confirmKick = false;
    asked = false;
  });

  /** Their standing ask to you, if they have made one. */
  const askedMe = $derived(player ? ($friends.requests.find((r) => r.player === player.id) ?? null) : null);

  function askFriend(): void {
    if (!player) return;
    cmd().friend('request', player.id);
    asked = true;
    notify(tr('friend.sent', { name: player.name }), 'neutral');
  }

  $effect(() => {
    if (whisperOpen) whisperEl?.focus();
  });

  const doing = $derived(player?.activity ? ($activities.find((a) => a.id === player.activity) ?? null) : null);
  const following = $derived(!!player && $followTarget?.id === player.id);
  const muted = $derived(!!player && $mutedSet.has(player.id));

  /** Activities that can still be handed to someone. */
  const hostable = $derived(
    $activities.filter((a) => a.state !== ActivityState.Ended && a.state !== ActivityState.Cancelled),
  );
  const hostActivity = $derived(hostable.find((a) => a.id === hostChoice) ?? hostable[0] ?? null);

  function close(): void {
    selectedPlayer.set(null);
  }

  // Escape, or a press outside the card, closes it.
  $effect(() => {
    const openedFor = $selectedPlayer;
    if (!openedFor) return;
    // The press that opened the card may still be on its way up to `window`; it must not
    // also be the press that closes it.
    const openedAt = performance.now();
    function dismiss(): void {
      // If something else picked a different person in the same moment, let that stand.
      selectedPlayer.update((cur) => (cur === openedFor ? null : cur));
    }
    function onKeydown(e: KeyboardEvent): void {
      if (e.key === 'Escape') dismiss();
    }
    function onPointerdown(e: PointerEvent): void {
      if (e.timeStamp <= openedAt) return;
      if (cardEl && e.target instanceof Node && cardEl.contains(e.target)) return;
      dismiss();
    }
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('pointerdown', onPointerdown);
    return () => {
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('pointerdown', onPointerdown);
    };
  });

  function challenge(): void {
    if (!player) return;
    cmd().jankenChallenge(player.id);
    close();
  }

  function sendWhisper(): void {
    const text = whisperText.trim();
    if (!player || !text) return;
    cmd().whisper(player.id, text);
    whisperText = '';
  }

  function onWhisperKey(e: KeyboardEvent): void {
    // Enter and Escape belong to this field: not to the chat's window handler, and not to
    // the card's own Escape, which would close everything at once.
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      sendWhisper();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      whisperOpen = false;
      whisperText = '';
    }
  }

  function kick(): void {
    if (!player) return;
    cmd().admin('kick', player.id);
    close();
  }
</script>

{#if player}
  <div class="card" role="dialog" aria-modal="false" aria-label={$t('player.card', { name: player.name })} bind:this={cardEl}>
    <header class="head">
      <div class="who">
        <h2 class="name">{player.name}</h2>
        {#if player.title && badgeIcon(player.title)}
          <p class="title"><span aria-hidden="true">{badgeIcon(player.title)}</span> {badgeName(player.title, $lang)}</p>
        {/if}
      </div>
      <button type="button" class="close" aria-label={$t('player.close')} onclick={close}>×</button>
    </header>

    {#if player.zone}
      <p class="meta">{$t('player.at', { place: zoneName(player.zone, $lang) })}</p>
    {/if}
    {#if doing}
      <p class="meta">
        {$t(player.mode === 'audience' ? 'player.watching' : 'player.joined', { title: activityTitle(doing, $lang) })}
      </p>
    {/if}

    <div class="actions">
      {#if following}
        <button type="button" class="act on" aria-pressed="true" onclick={() => cmd().follow(null)}>{$t('player.unfollow')}</button>
      {:else}
        <button type="button" class="act" aria-pressed="false" onclick={() => cmd().follow(player.id)}>{$t('player.follow')}</button>
      {/if}
      <button type="button" class="act" disabled={$janken !== null} onclick={challenge}>{$t('player.janken')}</button>
      <button
        type="button"
        class="act"
        class:on={whisperOpen}
        aria-expanded={whisperOpen}
        onclick={() => (whisperOpen = !whisperOpen)}
      >
        {$t('player.whisper')}
      </button>
      <button type="button" class="act" class:on={muted} aria-pressed={muted} onclick={() => toggleMute(player.id, player.name)}>
        {muted ? $t('player.unmute') : $t('player.mute')}
      </button>
      {#if $friends.enabled}
        {#if $friendsHere.has(player.id)}
          <span class="friend-tag">{$t('friend.isFriend')}</span>
        {:else if askedMe}
          <button type="button" class="act on" onclick={() => askedMe && cmd().friend('accept', askedMe.id)}>{$t('friend.acceptFrom')}</button>
        {:else}
          <button type="button" class="act" disabled={asked} onclick={askFriend}>{$t('friend.add')}</button>
        {/if}
      {/if}
    </div>

    {#if whisperOpen}
      <div class="whisper">
        <input
          bind:this={whisperEl}
          bind:value={whisperText}
          type="text"
          maxlength="140"
          autocomplete="off"
          aria-label={$t('player.whisperTo', { name: player.name })}
          placeholder={$t('player.whisperTo', { name: player.name })}
          onkeydown={onWhisperKey}
        />
        <button type="button" class="send" disabled={!whisperText.trim()} onclick={sendWhisper}>{$t('player.send')}</button>
      </div>
    {/if}

    {#if $isAdmin}
      <div class="mod">
        <p class="mod-label">{$t('player.mod')}</p>
        {#if confirmKick}
          <p class="confirm">{$t('player.kickConfirm', { name: player.name })}</p>
          {#if $room?.kind === 'private'}
            <p class="note">{$t('player.kickBanNote', { n: PROTOCOL.ISLAND_BAN_MIN })}</p>
          {/if}
          <div class="row">
            <button type="button" class="act danger" onclick={kick}>{$t('player.kickYes')}</button>
            <button type="button" class="act" onclick={() => (confirmKick = false)}>{$t('player.cancel')}</button>
          </div>
        {:else}
          <div class="row">
            <button type="button" class="act" onclick={() => cmd().admin('mute', player.id)}>{$t('player.serverMute')}</button>
            <button type="button" class="act" onclick={() => cmd().admin('unmute', player.id)}>{$t('player.serverUnmute')}</button>
            <button type="button" class="act" onclick={() => (confirmKick = true)}>{$t('player.kick')}</button>
          </div>
        {/if}
        {#if hostActivity}
          <div class="host">
            <label class="host-label" for="player-card-host">{$t('player.hostOf')}</label>
            <select
              id="player-card-host"
              value={hostActivity.id}
              onchange={(e) => (hostChoice = e.currentTarget.value)}
            >
              {#each hostable as a (a.id)}
                <option value={a.id}>{activityTitle(a, $lang)}</option>
              {/each}
            </select>
            {#if hostActivity.hostId === player.id}
              <button type="button" class="act" onclick={() => cmd().admin('revoke_host', player.id, hostActivity.id)}>
                {$t('player.revokeHost')}
              </button>
            {:else}
              <button type="button" class="act" onclick={() => cmd().admin('grant_host', player.id, hostActivity.id)}>
                {$t('player.grantHost')}
              </button>
            {/if}
          </div>
        {:else}
          <p class="meta faint">{$t('player.noActivities')}</p>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Left-hand side, below the minimap on a desktop; mid-left on a phone, where the minimap,
     the joystick and the chat all live along the bottom. */
  .card {
    position: fixed;
    left: max(var(--sp-md), env(safe-area-inset-left));
    top: calc(max(var(--sp-md), env(safe-area-inset-top)) + 224px);
    z-index: var(--z-panel);
    pointer-events: auto;
    width: min(280px, calc(100vw - 2 * var(--sp-md)));
    max-height: calc(100vh - 240px - var(--sp-md));
    overflow-y: auto;
    box-sizing: border-box;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    border-radius: var(--r-panel);
    padding: var(--sp-sm) var(--sp-md) var(--sp-md);
    animation: settle var(--mo-calm) both;
  }

  @media (max-width: 640px), (max-height: 560px) {
    .card {
      top: 50%;
      translate: 0 -50%;
      max-height: calc(100vh - 2 * var(--sp-lg));
    }
  }

  @keyframes settle {
    from {
      opacity: 0;
      transform: translateX(-6px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-sm);
    padding-bottom: var(--sp-xs);
    margin-bottom: var(--sp-xs);
    border-bottom: 1px solid var(--ui-line);
  }

  .who {
    min-width: 0;
  }

  .name {
    margin: 0;
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--ui-ink);
    overflow-wrap: anywhere;
  }

  .title {
    margin: 1px 0 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .close {
    border: none;
    background: transparent;
    color: var(--ui-ink-faint);
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 0 2px;
    cursor: pointer;
  }

  .close:hover {
    color: var(--ui-ink);
  }

  .meta {
    margin: 2px 0 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .meta.faint {
    color: var(--ui-ink-faint);
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-xs);
    margin-top: var(--sp-sm);
  }

  .act {
    border: 1px solid var(--ui-line);
    background: transparent;
    border-radius: var(--r-sm);
    padding: 5px var(--sp-sm);
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    cursor: pointer;
    line-height: 1.3;
  }

  .friend-tag {
    align-self: center;
    padding: 0 var(--sp-xs);
    font-size: var(--fs-xs);
    color: var(--ui-sea);
  }

  .act:hover:not(:disabled) {
    color: var(--ui-ink);
    background: var(--ui-surface-sunk);
  }

  .act.on {
    border-color: var(--ui-accent);
    color: var(--ui-accent);
  }

  .act.danger {
    border-color: var(--ui-accent);
    background: var(--ui-accent);
    color: var(--ui-surface-raised);
  }

  .act:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .whisper {
    display: flex;
    gap: var(--sp-xs);
    margin-top: var(--sp-sm);
  }

  input,
  select {
    min-width: 0;
    font: inherit;
    font-size: var(--fs-sm);
    padding: 5px var(--sp-sm);
    border-radius: var(--r-sm);
    border: 1px solid var(--ui-line);
    background: var(--ui-surface-raised);
    color: var(--ui-ink);
  }

  input {
    flex: 1;
  }

  .send {
    border: none;
    border-radius: var(--r-sm);
    padding: 5px var(--sp-sm);
    background: var(--ui-accent);
    color: var(--ui-surface-raised);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }

  .send:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .mod {
    margin-top: var(--sp-sm);
    padding-top: var(--sp-sm);
    border-top: 1px solid var(--ui-line);
  }

  .mod-label,
  .host-label {
    margin: 0 0 var(--sp-xs);
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    color: var(--ui-ink-muted);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-xs);
  }

  .confirm {
    margin: 0 0 var(--sp-xs);
    font-size: var(--fs-sm);
    color: var(--ui-ink);
  }

  .note {
    margin: 0 0 var(--sp-xs);
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .host {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-xs);
    margin-top: var(--sp-sm);
  }

  .host-label {
    margin: 0;
  }

  button:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }

  input:focus {
    outline: 2px solid var(--ui-accent);
    outline-offset: 1px;
  }
</style>
