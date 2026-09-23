<script lang="ts">
  /**
   * IslandPanel — which island you are on, and how to be on the same one as your friends.
   *
   * The body only; `Panels.svelte` provides the frame, title and close button.
   *
   * The scenario it exists for is one sentence long: *you want to hang out with particular
   * people*. On a public island you might not even land on the same shard. So the panel leads
   * with where you are and, on a private island, with its code — big enough to read out loud —
   * and one button that copies the invite link. The clipboard can refuse (an insecure page, an
   * old browser, a permission prompt dismissed); then the link appears in a read-only field,
   * already selected, so copying it by hand is one gesture.
   *
   * Below that, the three ways to move: make a private island of your own, type a code
   * someone gave you (the Go button wakes up only once the text normalises to a real code —
   * spaces, dashes and lower case are forgiven, look-alike letters are not), or walk over to
   * another public shard. The list shows public shards only; a private island is never listed
   * to strangers, which is the point of it being private.
   */
  import { tick } from 'svelte';
  import { normaliseRoomCode, type RoomView } from '@nagisa/shared';
  import { cmd, population, room, rooms } from '../state/stores.js';
  import { inviteLink } from '../net/visitor.js';
  import { lang, roomName, t } from '../i18n/index.js';

  /** How long "Link copied" replaces the button's label. */
  const COPIED_MS = 2400;

  let codeInput = $state('');
  let copied = $state(false);
  let manual = $state(false);
  let linkEl = $state<HTMLInputElement>();

  const here = $derived($room);
  const code = $derived(here?.kind === 'private' ? (here.code ?? null) : null);
  const link = $derived(code ? inviteLink(code) : '');
  const typed = $derived(normaliseRoomCode(codeInput));
  const publicRooms = $derived($rooms.filter((r) => r.kind === 'public'));

  // The room list arrives with the welcome and is not pushed again, so its populations go
  // stale. Opening this panel is when they are read: ask the server for the current ones.
  $effect(() => {
    let cancelled = false;
    fetch('/api/rooms')
      .then((r) => (r.ok ? (r.json() as Promise<{ rooms: RoomView[] }>) : null))
      .then((body) => {
        if (cancelled || !body || !Array.isArray(body.rooms)) return;
        // The listing is public shards only; keep the private island we are on, if any.
        rooms.update((list) => [...body.rooms.filter((r) => r.kind === 'public'), ...list.filter((r) => r.kind === 'private')]);
      })
      .catch(() => {
        /* Offline or served elsewhere: the list from the welcome stands. */
      });
    return () => {
      cancelled = true;
    };
  });

  // A different island is a different link: forget the last copy.
  $effect(() => {
    void code;
    copied = false;
    manual = false;
  });

  $effect(() => {
    if (!copied) return;
    const timer = setTimeout(() => (copied = false), COPIED_MS);
    return () => clearTimeout(timer);
  });

  async function copy(): Promise<void> {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      manual = false;
    } catch {
      // No clipboard (or no permission): hand over the text, selected, instead.
      manual = true;
      await tick();
      linkEl?.focus();
      linkEl?.select();
    }
  }

  function join(): void {
    if (!typed || typed === code) return;
    cmd().joinIsland(typed);
    codeInput = '';
  }

  function onCodeKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      join();
    }
  }
</script>

<div class="island">
  <section class="section here" aria-labelledby="island-here">
    <h3 class="section-title" id="island-here">{$t('island.youAreOn')}</h3>
    {#if !here}
      <p class="faint">{$t('island.none')}</p>
    {:else if code}
      <p class="kind">{$t('island.privateTitle')}</p>
      <p class="code">
        <span aria-hidden="true">{code}</span>
        <!-- Spelled out, so a screen reader reads a code and not a word. -->
        <span class="sr">{$t('island.code')}: {code.split('').join(' ')}</span>
      </p>
      {#if here.ownerName}
        <p class="meta">{$t('island.owner', { name: here.ownerName })}</p>
      {/if}
      <p class="meta">{$t('island.people', { n: $population, cap: here.capacity })}</p>
      <button type="button" class="primary" onclick={copy}>
        {copied ? $t('island.copied') : $t('island.copy')}
      </button>
      <span class="sr" role="status">{copied ? $t('island.copied') : ''}</span>
      {#if manual}
        <label class="manual">
          <span class="meta">{$t('island.copyManual')}</span>
          <input
            bind:this={linkEl}
            type="text"
            readonly
            value={link}
            onfocus={(e) => e.currentTarget.select()}
          />
        </label>
      {/if}
      <p class="hint">{$t('island.inviteHow')}</p>
    {:else}
      <p class="name">{roomName(here, $lang)}</p>
      <p class="meta">{$t('island.public')} · {$t('island.people', { n: $population, cap: here.capacity })}</p>
    {/if}
  </section>

  <section class="section">
    <button type="button" class="secondary" onclick={() => cmd().createIsland()}>{$t('island.create')}</button>
    <p class="hint">{$t('island.createHow')}</p>
  </section>

  <section class="section">
    <label class="section-title" for="island-code">{$t('island.joinCode')}</label>
    <div class="row">
      <input
        id="island-code"
        class="code-input"
        type="text"
        bind:value={codeInput}
        maxlength="12"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        placeholder={$t('island.codePlaceholder')}
        onkeydown={onCodeKey}
      />
      <button type="button" class="go" disabled={!typed || typed === code} onclick={join}>{$t('island.go')}</button>
    </div>
  </section>

  {#if publicRooms.length > 0}
    <section class="section" aria-labelledby="island-public">
      <h3 class="section-title" id="island-public">{$t('island.publicList')}</h3>
      <ul class="rooms">
        {#each publicRooms as r (r.id)}
          {@const current = here?.id === r.id}
          {@const full = r.capacity > 0 && r.population >= r.capacity}
          <li class="room" class:current>
            <span class="room-name">{roomName(r, $lang)}</span>
            <!-- Where we are, count the room we can see; the list's numbers are a fetch old. -->
            <span class="room-pop">{$t('island.people', { n: current ? $population : r.population, cap: r.capacity })}</span>
            {#if current}
              <span class="here-tag">{$t('island.current')}</span>
            {:else if full}
              <span class="here-tag">{$t('island.full')}</span>
            {:else}
              <button type="button" class="go small" onclick={() => cmd().joinIsland(r.id)}>{$t('island.go')}</button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .island {
    max-height: min(64vh, 540px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    scrollbar-width: thin;
  }

  .section {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-xs);
    padding: var(--sp-sm) 0;
    border-bottom: 1px solid var(--ui-line);
  }

  .section:first-child {
    padding-top: 0;
  }

  .section:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .section-title {
    margin: 0;
    font-size: var(--fs-xs);
    font-weight: 400;
    letter-spacing: 0.08em;
    color: var(--ui-ink-muted);
  }

  p {
    margin: 0;
  }

  .kind {
    font-size: var(--fs-sm);
    color: var(--ui-ink);
  }

  .code {
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: 0.24em;
    font-variant-numeric: tabular-nums;
    color: var(--ui-ink);
  }

  .name {
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--ui-ink);
  }

  .meta {
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .faint {
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .hint {
    font-size: var(--fs-xs);
    line-height: 1.45;
    color: var(--ui-ink-faint);
  }

  .primary,
  .secondary,
  .go {
    border-radius: var(--r-sm);
    padding: 6px var(--sp-md);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
  }

  .primary {
    margin-top: var(--sp-xs);
    border: 1px solid var(--ui-accent);
    background: var(--ui-accent);
    color: var(--ui-surface-raised);
    font-weight: 600;
  }

  .secondary {
    border: 1px solid var(--ui-line);
    background: var(--ui-surface-raised);
    color: var(--ui-ink);
  }

  .secondary:hover {
    background: var(--ui-surface-sunk);
  }

  .manual {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  input {
    min-width: 0;
    font: inherit;
    font-size: var(--fs-sm);
    padding: 5px var(--sp-sm);
    border-radius: var(--r-sm);
    border: 1px solid var(--ui-line);
    background: var(--ui-surface-raised);
    color: var(--ui-ink);
  }

  input:focus {
    outline: 2px solid var(--ui-accent);
    outline-offset: 1px;
  }

  .row {
    display: flex;
    gap: var(--sp-xs);
  }

  .code-input {
    flex: 1;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .code-input::placeholder {
    text-transform: none;
    letter-spacing: normal;
  }

  .go {
    flex: none;
    border: 1px solid var(--ui-line);
    background: transparent;
    color: var(--ui-ink);
  }

  .go:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .go.small {
    padding: 2px var(--sp-sm);
    font-size: var(--fs-xs);
  }

  .rooms {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .room {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: 4px 0;
    font-size: var(--fs-sm);
    color: var(--ui-ink-muted);
  }

  .room.current {
    color: var(--ui-ink);
    font-weight: 600;
  }

  .room-name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .room-pop {
    flex: none;
    font-size: var(--fs-xs);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    color: var(--ui-ink-faint);
  }

  .here-tag {
    flex: none;
    font-size: var(--fs-xs);
    font-weight: 400;
    color: var(--ui-ink-muted);
  }

  button:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
