<script lang="ts">
  /**
   * BoardPanel — the notice board: what the island has been told, and who has been here.
   *
   * The body only; `Panels.svelte` provides the frame, title and close button.
   *
   * Two sections, newest first in both:
   *
   * - **Announcements** — everything the hosts and keepers have posted that is still on the
   *   board, with who posted it, how long ago, and a small tag for who it was addressed to
   *   (the whole island, one place, or one activity's crowd). Scope decides who gets the
   *   toast; the board is for everyone to read.
   * - **The guestbook** — one line each, kept across restarts. You can take down your own
   *   lines (keepers can take down any). Signing needs you to be standing at a notice board,
   *   so the write box only appears there; everywhere else it is replaced by a hint saying
   *   where to go, rather than by a field that refuses what you type.
   *
   * "How long ago" is refreshed every half minute — a board does not need a ticking clock.
   */
  import { PROTOCOL, type AnnouncementView, type GuestbookEntry } from '@nagisa/shared';
  import { activities, announcements, atBoard, cmd, guestbook, isAdmin, self, serverNow } from '../state/stores.js';
  import { activityTitle, lang, t, zoneName } from '../i18n/index.js';

  const MAX = PROTOCOL.MAX_GUESTBOOK_LENGTH;

  let now = $state(serverNow());
  let draft = $state('');

  $effect(() => {
    const timer = setInterval(() => (now = serverNow()), 30_000);
    return () => clearInterval(timer);
  });

  // Something new on the board is dated against the clock as it is now, not as it was at
  // the last half-minute.
  $effect(() => {
    void $announcements;
    void $guestbook;
    now = serverNow();
  });

  const canSign = $derived($atBoard && draft.trim().length > 0 && draft.length <= MAX);

  function ago(at: number): string {
    const seconds = Math.max(0, (now - at) / 1000);
    if (seconds < 60) return $t('ago.now');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return $t('ago.min', { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $t('ago.hour', { n: hours });
    return $t('ago.day', { n: Math.floor(hours / 24) });
  }

  function scopeTag(a: AnnouncementView): string {
    const scope = a.scope;
    if (scope.kind === 'zone') return zoneName(scope.zone, $lang);
    if (scope.kind === 'activity') {
      const activity = $activities.find((x) => x.id === scope.activity);
      return activity ? activityTitle(activity, $lang) : $t('board.scope.activity');
    }
    return $t('board.scope.island');
  }

  function canRemove(entry: GuestbookEntry): boolean {
    return $isAdmin || (entry.authorId !== null && entry.authorId === $self.id);
  }

  /**
   * The lines already on the board when ours was sent. The draft is cleared when a new line
   * of ours shows up, not when the button is pressed: a refused one (the half-minute rest
   * between signatures) would otherwise take what was typed with it.
   */
  let awaiting = $state<Set<string> | null>(null);

  function sign(): void {
    const text = draft.trim();
    if (!$atBoard || !text) return;
    awaiting = new Set($guestbook.map((g) => g.id));
    cmd().guestbookWrite(text);
  }

  $effect(() => {
    const before = awaiting;
    if (!before) return;
    if ($guestbook.some((g) => !before.has(g.id) && g.authorId !== null && g.authorId === $self.id)) {
      draft = '';
      awaiting = null;
    }
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      sign();
    }
  }
</script>

<div class="board">
  <section class="section" aria-labelledby="board-announcements">
    <h3 class="section-title" id="board-announcements">{$t('board.announcements')}</h3>
    {#if $announcements.length === 0}
      <p class="empty">{$t('board.noAnnouncements')}</p>
    {:else}
      <ul class="list">
        {#each $announcements as a (a.id)}
          <li class="item" class:high={a.priority === 'high'}>
            <div class="meta">
              <span class="from">{a.fromName}</span>
              <span class="tag">{scopeTag(a)}</span>
              <span class="when">{ago(a.at)}</span>
            </div>
            <p class="text">{a.text}</p>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="section" aria-labelledby="board-guestbook">
    <h3 class="section-title" id="board-guestbook">{$t('board.guestbook')}</h3>

    {#if $atBoard}
      <div class="write">
        <input
          type="text"
          bind:value={draft}
          maxlength={MAX}
          autocomplete="off"
          aria-label={$t('board.write')}
          aria-describedby="board-counter"
          placeholder={$t('board.placeholder')}
          onkeydown={onKeydown}
        />
        <button type="button" class="sign" disabled={!canSign} onclick={sign}>{$t('board.sign')}</button>
      </div>
      <p class="counter" id="board-counter">
        <span aria-hidden="true">{draft.length}/{MAX}</span>
        <span class="sr">{$t('board.counter', { n: draft.length, max: MAX })}</span>
      </p>
    {:else}
      <p class="hint">{$t('board.walkUp')}</p>
    {/if}

    {#if $guestbook.length === 0}
      <p class="empty">{$t('board.empty')}</p>
    {:else}
      <ul class="list">
        {#each $guestbook as entry (entry.id)}
          <li class="item signature">
            <div class="meta">
              <span class="from">{entry.name}</span>
              <span class="when">{ago(entry.at)}</span>
              {#if canRemove(entry)}
                <button
                  type="button"
                  class="remove"
                  aria-label={$t('board.removeLabel', { name: entry.name })}
                  title={$t('board.remove')}
                  onclick={() => cmd().guestbookRemove(entry.id)}
                >
                  {$t('board.remove')}
                </button>
              {/if}
            </div>
            <p class="text">{entry.text}</p>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .board {
    max-height: min(62vh, 520px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-sm);
    scrollbar-width: thin;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-xs);
  }

  .section + .section {
    padding-top: var(--sp-sm);
    border-top: 1px solid var(--ui-line);
  }

  .section-title {
    margin: 0;
    font-size: var(--fs-xs);
    font-weight: 400;
    letter-spacing: 0.08em;
    color: var(--ui-ink-muted);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .item {
    padding: 6px 0;
    border-bottom: 1px solid var(--ui-line);
  }

  .item:last-child {
    border-bottom: none;
  }

  .item.high .text {
    font-weight: 600;
  }

  .meta {
    display: flex;
    align-items: baseline;
    gap: var(--sp-xs);
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    min-width: 0;
  }

  .from {
    color: var(--ui-ink);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .tag {
    flex: none;
    max-width: 45%;
    padding: 0 5px;
    border-radius: var(--r-sm);
    background: var(--ui-surface-sunk);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .when {
    flex: none;
    margin-left: auto;
    color: var(--ui-ink-faint);
    white-space: nowrap;
  }

  .text {
    margin: 2px 0 0;
    font-size: var(--fs-sm);
    line-height: 1.45;
    color: var(--ui-ink);
    overflow-wrap: anywhere;
  }

  .remove {
    flex: none;
    border: none;
    background: transparent;
    padding: 0 2px;
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .remove:hover {
    color: var(--ui-ink);
  }

  .empty,
  .hint {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .write {
    display: flex;
    gap: var(--sp-xs);
  }

  input {
    flex: 1;
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

  .sign {
    border: none;
    border-radius: var(--r-sm);
    padding: 5px var(--sp-md);
    background: var(--ui-accent);
    color: var(--ui-surface-raised);
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: 600;
    cursor: pointer;
  }

  .sign:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .counter {
    margin: 0;
    text-align: right;
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--ui-ink-faint);
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
