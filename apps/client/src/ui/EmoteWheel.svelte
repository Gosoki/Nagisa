<script lang="ts">
  /**
   * EmoteWheel — a small arc of emote choices, shown when `$emoteOpen` is true.
   *
   * Fans out *upward* from the emote button's fixed position (bottom-centre, matching
   * Hud.svelte's `.emote-btn`) rather than a full circle — a full ring would put half the
   * choices below the viewport edge, which is exactly the kind of thing that "match a
   * phone at 360px" (rule 8) catches immediately. Positions are computed with simple
   * trigonometry over a ~200° arc so it reads as a deliberate fan, not a scattered menu.
   *
   * Plain Unicode glyphs stand in for each emote (rule allows this explicitly when it
   * looks clean) rather than custom SVG — EMOTES is a fixed, small, well-known set of
   * everyday gestures that render consistently as emoji across platforms.
   */
  import { EMOTES, type Emote } from '@nagisa/shared';
  import { emoteOpen, cmd } from '../state/stores.js';

  const GLYPH: Record<Emote, string> = {
    wave: '👋',
    clap: '👏',
    bow: '🙇',
    heart: '❤️',
    laugh: '😄',
    question: '❓',
    music: '🎵',
    sparkle: '✨',
  };

  const RADIUS = 92;
  /** Arc swept above the button, centred on straight up (-90°). */
  const ARC_DEGREES = 200;

  function positionFor(index: number, total: number): { x: number; y: number } {
    const start = -90 - ARC_DEGREES / 2;
    const step = total > 1 ? ARC_DEGREES / (total - 1) : 0;
    const deg = start + step * index;
    const rad = (deg * Math.PI) / 180;
    return { x: Math.cos(rad) * RADIUS, y: Math.sin(rad) * RADIUS };
  }

  function pick(emote: Emote): void {
    cmd().emote(emote);
    emoteOpen.set(false);
  }

  $effect(() => {
    if (!$emoteOpen) return;
    function onKeydown(e: KeyboardEvent): void {
      if (e.key === 'Escape') emoteOpen.set(false);
    }
    function onPointerdown(e: PointerEvent): void {
      if (e.target instanceof Element && e.target.closest('.wheel')) return;
      emoteOpen.set(false);
    }
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('pointerdown', onPointerdown);
    return () => {
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('pointerdown', onPointerdown);
    };
  });
</script>

{#if $emoteOpen}
  <div class="wheel" role="menu" aria-label="Emotes">
    {#each EMOTES as emote, i (emote)}
      {@const pos = positionFor(i, EMOTES.length)}
      <!-- Position (translate) and pop-in (scale) are split across two elements so the
           CSS animation only ever interpolates `scale`, never a compound transform. -->
      <div class="slot" style:transform="translate({pos.x}px, {pos.y}px)">
        <button
          type="button"
          class="emote"
          role="menuitem"
          aria-label={emote}
          style:animation-delay="{i * 16}ms"
          onclick={() => pick(emote)}
        >
          {GLYPH[emote]}
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .wheel {
    position: fixed;
    left: 50%;
    bottom: max(calc(var(--sp-lg) + 22px), calc(env(safe-area-inset-bottom) + 22px));
    z-index: var(--z-panel);
    pointer-events: none;
  }

  .slot {
    position: absolute;
    left: -18px;
    top: -18px;
    width: 36px;
    height: 36px;
  }

  .emote {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: none;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    cursor: pointer;
    pointer-events: auto;
    animation: pop var(--mo-quick) both;
  }

  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .emote:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 2px;
  }
</style>
