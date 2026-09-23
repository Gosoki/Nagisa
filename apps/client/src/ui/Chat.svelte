<script lang="ts">
  /**
   * Chat — the log and the composer.
   *
   * Two states, and the difference between them is the whole design:
   *
   * - **Collapsed** (default). The last few lines sit in the bottom-left, unboxed, fading
   *   out after a while. No panel, no border, no scrollbar. You can see that the room is
   *   talking without the room's talking taking up the room.
   * - **Pinned** (click the log, or the badge). A real panel with scrollback. Stays until
   *   you dismiss it.
   *
   * A chat client that is *always* a panel turns a world into a text window with scenery.
   * The reference product's whole register is that the interface gets out of the way until
   * you reach for it, so the log does too.
   *
   * ### Enter opens the composer
   *
   * The convention everywhere from Minecraft to VRChat, and worth the one collision it
   * causes: `Enter` used to be a second binding for interact, alongside `E`. `E` remains.
   *
   * While the composer has focus the input layer must not read movement keys, or typing
   * "sw" walks you into the sea. That is handled in `input.ts`, which ignores key events
   * whose target is a text field — so the composer being a real `<input>` is load-bearing,
   * not incidental.
   *
   * ### Whispers and slash commands
   *
   * A whisper is a line like any other, in the sea colour, with an arrow for which way it
   * went — `→ Rin` for yours, `Rin →` for theirs. That name is a button: it puts
   * `/w Rin ` in the composer, bound to that person's id so two people with one name cannot
   * be confused.
   *
   * The composer reads a leading slash as a command: `/w name text` (or `/whisper`), `/r
   * text` for the last whisper, `/roll [sides]`, and `/help`. A name matches exactly (any
   * case, spaces allowed, longest first), else by a prefix that fits one person only;
   * anything unclear is answered with a local line saying why, and the draft is left as it
   * was so it can be corrected rather than retyped. Those local lines never count as unread:
   * you were looking at the composer when they appeared.
   */
  import { tick } from 'svelte';
  import { get } from 'svelte/store';
  import { PROTOCOL, type PlayerId, type PlayerView } from '@nagisa/shared';
  import {
    chatComposing,
    chatLog,
    chatPinned,
    chatUnread,
    commands,
    players,
    pushSystemChat,
    type ChatLine,
  } from '../state/stores.js';
  import { t, tr } from '../i18n/index.js';

  /** How long a line stays visible in the collapsed log. */
  const FADE_AFTER_MS = 14_000;

  /** Lines shown when collapsed. Enough to follow a exchange, not enough to be a wall. */
  const COLLAPSED_LINES = 5;

  /** The die the server rolls when none is named, and the range it accepts. */
  const ROLL_MIN = 2;
  const ROLL_MAX = 1000;

  let composerEl: HTMLInputElement | undefined = $state();
  let scrollEl: HTMLElement | undefined = $state();
  let draft = $state('');
  let open = $state(false);

  /**
   * The person a clicked whisper name refers to, while the draft still addresses them.
   * Resolving by id rather than by the name in the draft is what keeps a reply going to the
   * right one of two people who chose the same name.
   */
  let replyTarget: { id: PlayerId; name: string } | null = null;

  /** Re-evaluated on a timer so collapsed lines actually fade rather than waiting on a store write. */
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const visible = $derived(
    $chatPinned ? $chatLog : $chatLog.slice(-COLLAPSED_LINES).filter((l) => now - l.at < FADE_AFTER_MS),
  );

  async function openComposer(): Promise<void> {
    open = true;
    chatComposing.set(true);
    await tick();
    composerEl?.focus();
  }

  function closeComposer(): void {
    open = false;
    draft = '';
    replyTarget = null;
    chatComposing.set(false);
    composerEl?.blur();
  }

  function send(): void {
    const text = draft.trim();
    if (/^\/\S/.test(text)) {
      if (runCommand(text) === 'keep') return;
    } else if (text) {
      $commands.say(text);
    }
    // Stay open after sending. A conversation is more than one line, and re-pressing Enter
    // to say the next thing is friction that shows up immediately in a busy room.
    draft = '';
    replyTarget = null;
  }

  // ---------------------------------------------------------------------------
  // Slash commands
  // ---------------------------------------------------------------------------

  /** Say something to yourself in the log. Not counted as unread — see the header. */
  function local(...lines: string[]): void {
    const unread = get(chatUnread);
    for (const line of lines) pushSystemChat(line);
    chatUnread.set(unread);
  }

  /**
   * Run a `/command`. Returns `'keep'` when the draft should stay for correcting, `'clear'`
   * when it has been dealt with. Only a slash followed directly by a word is a command; a
   * slash and a space is ordinary chat and never reaches here.
   */
  function runCommand(text: string): 'keep' | 'clear' {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return 'clear';
    const rest = (match[2] ?? '').trim();
    switch (match[1].toLowerCase()) {
      case 'roll': {
        if (!rest) {
          $commands.roll();
          return 'clear';
        }
        const sides = /^\d+$/.test(rest) ? Number(rest) : NaN;
        if (!(sides >= ROLL_MIN && sides <= ROLL_MAX)) {
          local(tr('chat.cmd.rollRange'));
          return 'keep';
        }
        $commands.roll(sides);
        return 'clear';
      }
      case 'w':
      case 'whisper': {
        const found = resolveWhisper(rest);
        if ('error' in found) {
          local(found.error);
          return 'keep';
        }
        $commands.whisper(found.peer.id, found.text);
        return 'clear';
      }
      case 'r':
      case 'reply': {
        const peer = lastWhisperPeer();
        if (!peer) {
          local(tr('chat.cmd.noPeer'));
          return 'keep';
        }
        if (!rest) {
          local(tr('chat.cmd.rUsage'));
          return 'keep';
        }
        if (!$players.some((p) => p.id === peer.peerId)) {
          local(tr('chat.cmd.gone', { name: peer.peerName }));
          return 'keep';
        }
        $commands.whisper(peer.peerId, rest);
        return 'clear';
      }
      case 'help':
      case '?':
        local(tr('chat.cmd.help'), tr('chat.cmd.w'), tr('chat.cmd.r'), tr('chat.cmd.roll'), tr('chat.cmd.helpLine'));
        return 'clear';
      default:
        local(tr('chat.cmd.unknown'));
        return 'keep';
    }
  }

  /** Who `/w …` means, and what is left to say to them. */
  function resolveWhisper(rest: string): { peer: Pick<PlayerView, 'id' | 'name'>; text: string } | { error: string } {
    if (!rest) return { error: tr('chat.cmd.wUsage') };
    const lower = rest.toLowerCase();
    const addresses = (name: string): boolean => {
      const n = name.toLowerCase();
      return lower === n || lower.startsWith(n + ' ');
    };

    // A reply begun by clicking a whisper name, still addressed to that name.
    if (replyTarget && addresses(replyTarget.name)) {
      const target = replyTarget;
      const text = rest.slice(target.name.length).trim();
      if (!text) return { error: tr('chat.cmd.wUsage') };
      if (!$players.some((p) => p.id === target.id)) return { error: tr('chat.cmd.gone', { name: target.name }) };
      return { peer: target, text };
    }

    // Whole names first, longest first: "Ann Lee hi" means Ann Lee even when Ann is here.
    const exact = $players.filter((p) => addresses(p.name));
    if (exact.length > 0) {
      const longest = Math.max(...exact.map((p) => p.name.length));
      const best = exact.filter((p) => p.name.length === longest);
      const text = rest.slice(longest).trim();
      if (best.length > 1) return { error: ambiguous(best[0].name, best) };
      if (!text) return { error: tr('chat.cmd.wUsage') };
      return { peer: best[0], text };
    }

    // Otherwise the first word as the start of a name, if it fits exactly one person.
    const word = rest.split(/\s+/)[0];
    const text = rest.slice(word.length).trim();
    const matches = $players.filter((p) => p.name.toLowerCase().startsWith(word.toLowerCase()));
    if (matches.length === 0) return { error: tr('chat.cmd.unknownName', { name: word }) };
    if (matches.length > 1) return { error: ambiguous(word, matches) };
    if (!text) return { error: tr('chat.cmd.wUsage') };
    return { peer: matches[0], text };
  }

  function ambiguous(typed: string, among: PlayerView[]): string {
    const names = among.slice(0, 4).map((p) => p.name);
    if (among.length > 4) names.push('…');
    return tr('chat.cmd.ambiguous', { name: typed, names: names.join(tr('list.sep')) });
  }

  /** The other end of the most recent whisper, either way. */
  function lastWhisperPeer(): NonNullable<ChatLine['whisper']> | null {
    for (let i = $chatLog.length - 1; i >= 0; i--) {
      const whisper = $chatLog[i].whisper;
      if (whisper) return whisper;
    }
    return null;
  }

  /** A whisper's name was clicked: start a whisper back to that person. */
  function replyTo(whisper: NonNullable<ChatLine['whisper']>, e: MouseEvent): void {
    // The collapsed log pins itself on click; answering someone should not also do that.
    e.stopPropagation();
    replyTarget = { id: whisper.peerId, name: whisper.peerName };
    draft = `/w ${whisper.peerName} `;
    void openComposer();
  }

  // ---------------------------------------------------------------------------

  function pin(): void {
    chatPinned.set(true);
    chatUnread.set(0);
    void scrollToEnd();
  }

  async function scrollToEnd(): Promise<void> {
    await tick();
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  $effect(() => {
    if ($chatPinned && $chatLog.length) void scrollToEnd();
  });

  /**
   * Controls that answer Enter themselves. Enter on a focused button presses the button;
   * opening the composer instead (and swallowing the key) would make every button in the
   * interface unusable from a keyboard.
   */
  const OWNS_ENTER =
    'input, textarea, select, button, a[href], summary, [contenteditable="true"], [role="button"], [role="tab"], [role="radio"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';

  function onWindowKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const onControl = target instanceof HTMLElement && (target.isContentEditable || target.closest(OWNS_ENTER) !== null);

    if (e.key === 'Enter' && !onControl) {
      e.preventDefault();
      void openComposer();
      return;
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        closeComposer();
      } else if ($chatPinned) {
        e.preventDefault();
        chatPinned.set(false);
      }
    }
  }

  function onComposerKey(e: KeyboardEvent): void {
    // Stop every key here from reaching the window handler above — otherwise Enter would
    // both send the line and re-open the composer, and Escape would be handled twice.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeComposer();
    }
  }

  function clock(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="chat" class:pinned={$chatPinned}>
  {#if $chatPinned}
    <header>
      <span class="title">{$t('chat.title')}</span>
      <button type="button" class="close" onclick={() => chatPinned.set(false)} aria-label={$t('chat.collapse')}>×</button>
    </header>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="log"
    class:scrollable={$chatPinned}
    bind:this={scrollEl}
    onclick={() => !$chatPinned && pin()}
  >
    {#each visible as line (line.seq)}
      <p class="line" class:system={line.system} class:mine={line.self} class:whisper={!!line.whisper}>
        {#if $chatPinned}<span class="time">{clock(line.at)}</span>{/if}
        {#if line.whisper}
          {@const w = line.whisper}
          <button
            type="button"
            class="who peer"
            aria-label={w.outgoing
              ? $t('chat.whisperToLabel', { name: w.peerName })
              : $t('chat.whisperFromLabel', { name: w.peerName })}
            onclick={(e) => replyTo(w, e)}
          >
            {w.outgoing ? $t('chat.whisperTo', { name: w.peerName }) : $t('chat.whisperFrom', { name: w.peerName })}
          </button>
        {:else if !line.system}<span class="who">{line.name}</span>{/if}
        <span class="text">{line.text}</span>
      </p>
    {/each}
  </div>

  {#if open}
    <div class="composer">
      <input
        bind:this={composerEl}
        bind:value={draft}
        onkeydown={onComposerKey}
        onblur={() => chatComposing.set(false)}
        onfocus={() => chatComposing.set(true)}
        maxlength={PROTOCOL.MAX_CHAT_LENGTH}
        placeholder={$t('chat.placeholder')}
        aria-label={$t('chat.inputLabel')}
      />
      <button type="button" class="send" onclick={send} disabled={!draft.trim()}>{$t('chat.send')}</button>
    </div>
  {:else}
    <button type="button" class="prompt" onclick={openComposer}>
      <span class="key">Enter</span>
      <span>{$t('chat.prompt')}</span>
      {#if $chatUnread > 0 && !$chatPinned}
        <span class="badge">{$chatUnread > 99 ? '99+' : $chatUnread}</span>
      {/if}
    </button>
  {/if}
</div>

<style>
  .chat {
    position: absolute;
    left: var(--sp-md);
    bottom: var(--sp-md);
    width: min(30rem, 42vw);
    display: flex;
    flex-direction: column;
    gap: var(--sp-xs);
    pointer-events: none;
    z-index: var(--z-hud);
  }

  .chat.pinned {
    background: var(--ui-surface);
    border-radius: var(--r-lg);
    box-shadow: var(--ui-shadow);
    padding: var(--sp-sm);
    backdrop-filter: blur(6px);
    pointer-events: auto;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-xs) var(--sp-xs);
  }

  .title {
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-ink-muted);
  }

  .close {
    all: unset;
    cursor: pointer;
    padding: 0 0.4rem;
    font-size: 1.1rem;
    line-height: 1;
    color: var(--ui-ink-muted);
  }
  .close:hover {
    color: var(--ui-ink);
  }

  .log {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    pointer-events: auto;
    cursor: default;
  }

  .log.scrollable {
    max-height: 32vh;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .chat:not(.pinned) .log {
    cursor: pointer;
  }

  .line {
    margin: 0;
    font-size: 0.86rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  /* Collapsed lines sit directly on the scene, so they need their own legibility rather
     than a panel's. A soft dark shadow reads over both the pale sand and the dark sea. */
  .chat:not(.pinned) .line {
    color: #f7f3eb;
    text-shadow:
      0 1px 3px rgba(20, 18, 16, 0.85),
      0 0 10px rgba(20, 18, 16, 0.5);
    animation: rise var(--mo-calm) ease-out;
  }

  .chat.pinned .line {
    color: var(--ui-ink);
  }

  /* Whispers: the sea colour, on paper and — paled so it still reads — over the scene. */
  .chat.pinned .line.whisper {
    color: var(--ui-sea);
  }

  .chat:not(.pinned) .line.whisper {
    color: #d3e6eb;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(0.35rem);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  .time {
    color: var(--ui-ink-muted);
    font-variant-numeric: tabular-nums;
    font-size: 0.76rem;
    margin-right: 0.35rem;
  }

  .who {
    font-weight: 600;
    margin-right: 0.35rem;
  }
  .who::after {
    content: ':';
    font-weight: 400;
    opacity: 0.55;
  }

  .line.mine .who {
    color: var(--ui-accent);
  }

  .who.peer {
    all: unset;
    font-weight: 600;
    margin-right: 0.35rem;
    color: inherit;
    cursor: pointer;
    border-radius: var(--r-sm);
  }
  .who.peer::after {
    content: none;
  }
  .line.whisper .who.peer {
    color: inherit;
  }
  .who.peer:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .who.peer:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 1px;
  }

  .line.system {
    font-style: italic;
    opacity: 0.72;
  }

  .composer {
    display: flex;
    gap: var(--sp-xs);
    pointer-events: auto;
  }

  .composer input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 0.9rem;
    padding: 0.5rem 0.7rem;
    border-radius: var(--r-sm);
    border: 1px solid var(--ui-line);
    background: var(--ui-surface);
    color: var(--ui-ink);
  }
  .composer input:focus {
    outline: 2px solid var(--ui-accent);
    outline-offset: 1px;
  }

  .send {
    all: unset;
    cursor: pointer;
    padding: 0.5rem 0.8rem;
    border-radius: var(--r-sm);
    background: var(--ui-accent);
    color: #fff;
    font-size: 0.86rem;
  }
  .send:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .prompt {
    all: unset;
    pointer-events: auto;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    align-self: flex-start;
    font-size: 0.8rem;
    color: #f7f3eb;
    text-shadow: 0 1px 3px rgba(20, 18, 16, 0.85);
    opacity: 0.75;
    transition: opacity var(--mo-quick) ease;
  }
  .prompt:hover {
    opacity: 1;
  }

  .chat.pinned .prompt {
    color: var(--ui-ink-muted);
    text-shadow: none;
  }

  .key {
    border: 1px solid currentColor;
    border-radius: 0.25rem;
    padding: 0.05rem 0.3rem;
    font-size: 0.72rem;
    opacity: 0.8;
  }

  .badge {
    background: var(--ui-accent);
    color: #fff;
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    font-size: 0.72rem;
    text-shadow: none;
  }

  @media (max-width: 640px) {
    .chat {
      width: calc(100vw - var(--sp-md) * 2);
      /* Clear of the virtual stick, which owns the bottom-left on touch. */
      bottom: 9.5rem;
    }
  }
</style>
