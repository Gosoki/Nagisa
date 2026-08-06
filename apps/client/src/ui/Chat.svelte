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
   */
  import { tick } from 'svelte';
  import { PROTOCOL } from '@nagisa/shared';
  import { chatComposing, chatLog, chatPinned, chatUnread, commands } from '../state/stores.js';

  /** How long a line stays visible in the collapsed log. */
  const FADE_AFTER_MS = 14_000;

  /** Lines shown when collapsed. Enough to follow a exchange, not enough to be a wall. */
  const COLLAPSED_LINES = 5;

  let composerEl: HTMLInputElement | undefined;
  let scrollEl: HTMLElement | undefined;
  let draft = '';
  let open = false;

  /** Re-evaluated on a timer so collapsed lines actually fade rather than waiting on a store write. */
  let now = Date.now();
  setInterval(() => (now = Date.now()), 1000);

  $: visible = $chatPinned ? $chatLog : $chatLog.slice(-COLLAPSED_LINES).filter((l) => now - l.at < FADE_AFTER_MS);

  async function openComposer(): Promise<void> {
    open = true;
    chatComposing.set(true);
    await tick();
    composerEl?.focus();
  }

  function closeComposer(): void {
    open = false;
    draft = '';
    chatComposing.set(false);
    composerEl?.blur();
  }

  function send(): void {
    const text = draft.trim();
    if (text) $commands.say(text);
    // Stay open after sending. A conversation is more than one line, and re-pressing Enter
    // to say the next thing is friction that shows up immediately in a busy room.
    draft = '';
  }

  function pin(): void {
    chatPinned.set(true);
    chatUnread.set(0);
    void scrollToEnd();
  }

  async function scrollToEnd(): Promise<void> {
    await tick();
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  $: if ($chatPinned && $chatLog.length) void scrollToEnd();

  function onWindowKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const typing = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    if (e.key === 'Enter' && !typing) {
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

<svelte:window on:keydown={onWindowKey} />

<div class="chat" class:pinned={$chatPinned}>
  {#if $chatPinned}
    <header>
      <span class="title">Chat</span>
      <button class="close" on:click={() => chatPinned.set(false)} aria-label="Collapse chat">×</button>
    </header>
  {/if}

  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div
    class="log"
    class:scrollable={$chatPinned}
    bind:this={scrollEl}
    on:click={() => !$chatPinned && pin()}
  >
    {#each visible as line (line.seq)}
      <p class="line" class:system={line.system} class:mine={line.self}>
        {#if $chatPinned}<span class="time">{clock(line.at)}</span>{/if}
        {#if !line.system}<span class="who">{line.name}</span>{/if}
        <span class="text">{line.text}</span>
      </p>
    {/each}
  </div>

  {#if open}
    <div class="composer">
      <input
        bind:this={composerEl}
        bind:value={draft}
        on:keydown={onComposerKey}
        on:blur={() => chatComposing.set(false)}
        on:focus={() => chatComposing.set(true)}
        maxlength={PROTOCOL.MAX_CHAT_LENGTH}
        placeholder="Say something…"
        aria-label="Chat message"
      />
      <button class="send" on:click={send} disabled={!draft.trim()}>Say</button>
    </div>
  {:else}
    <button class="prompt" on:click={openComposer}>
      <span class="key">Enter</span>
      <span>to say something</span>
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
