<script lang="ts">
  /**
   * ZoneCard — the centred-low title card shown when entering a new zone.
   *
   * This is called out in the design brief as "the one moment the UI is allowed a little
   * presence": everywhere else the interface tries to disappear, but announcing where you
   * just arrived is worth a beat of quiet attention. It still fades in and out on the
   * slow, dignified curve (`--mo-slow`) rather than the default `--mo-calm`, precisely
   * because it is the one exception — it should feel considered, not snappy.
   *
   * `$zoneAnnounce` is a plain boolean the engine flips true on zone entry. This
   * component owns the *duration* of the card's visibility (~3.5s) independently of
   * whatever the store does afterwards, by latching the zone snapshot and running its own
   * timer on the true→true or false→true edge. That keeps "how long the card stays up" a
   * presentation decision here rather than something the engine needs to know about.
   */
  import { zoneAnnounce, currentZone } from '../state/stores.js';

  const HOLD_MS = 3500;

  let visible = $state(false);
  let shownZone = $state<{ name: string; nameJa: string; caption: string } | null>(null);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if ($zoneAnnounce && $currentZone) {
      shownZone = $currentZone;
      visible = true;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        visible = false;
      }, HOLD_MS);
    }
    return () => clearTimeout(hideTimer);
  });
</script>

{#if shownZone}
  <div class="zone-card" class:visible aria-hidden={!visible}>
    <p class="name">{shownZone.name}</p>
    <p class="ja">{shownZone.nameJa}</p>
    <p class="caption">{shownZone.caption}</p>
  </div>
{/if}

<style>
  .zone-card {
    position: fixed;
    left: 50%;
    bottom: 30%;
    transform: translate(-50%, 8px);
    z-index: var(--z-hud);
    pointer-events: none;
    text-align: center;
    max-width: min(360px, 84vw);
    opacity: 0;
    transition: opacity var(--mo-slow), transform var(--mo-slow);
  }

  .zone-card.visible {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  .name {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .ja {
    margin: 2px 0 0;
    font-size: var(--fs-sm);
    color: var(--ui-ink-muted);
  }

  .caption {
    margin: var(--sp-xs) 0 0;
    font-size: var(--fs-sm);
    font-style: italic;
    color: var(--ui-ink-muted);
  }
</style>
