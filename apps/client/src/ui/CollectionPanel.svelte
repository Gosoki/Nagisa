<script lang="ts">
  /**
   * CollectionPanel — your stamp card, fish book and badges, in three tabs.
   *
   * The body only; `Panels.svelte` provides the frame, title and close button.
   *
   * - **Stamps** is drawn as a card, because it is one: a circle for each place on
   *   `STAMP_ZONES`, empty and dashed until you visit its stand, then stamped in vermilion
   *   and set down a few degrees off true, the way a rubber stamp actually lands. The mark is
   *   the first character of the place's Japanese name, as on a real eki stamp.
   * - **Fish book** lists every species in the table's order with the junk at the end.
   *   Uncaught fish are a silhouette and "？？？" — but with their rarity dots showing, so the
   *   book says what is still out there without saying what it is.
   * - **Badges** shows every badge; earned ones can be worn under your name (one at a time,
   *   and wearing the one you have on takes it off), the rest say how to earn them.
   *
   * A footnote says honestly whether any of this outlives the tab (`profile.persistent`).
   * Before the profile arrives there is nothing to show, and the panel says so rather than
   * showing an empty card that looks like lost progress.
   *
   * The tabs are a proper tablist: arrow keys move between them.
   */
  import { BADGES, COLLECTIBLE_FISH, STAMP_ZONES, dailyTasks, getZone, jstDay, type FishRarity } from '@nagisa/shared';
  import { cmd, profile, serverNow } from '../state/stores.js';
  import { ALL_FISH, badgeHow, badgeName, fishName, lang, t, zoneName } from '../i18n/index.js';

  type Tab = 'stamps' | 'fish' | 'badges';
  const TABS: readonly Tab[] = ['stamps', 'fish', 'badges'];
  const TAB_LABEL: Record<Tab, string> = {
    stamps: 'collection.stamps',
    fish: 'collection.fish',
    badges: 'collection.badges',
  };

  /** Dots per rarity. Junk gets none. */
  const RARITY_DOTS: Record<FishRarity, number> = {
    common: 1,
    uncommon: 2,
    rare: 3,
    epic: 4,
    legendary: 5,
    junk: 0,
  };

  let tab = $state<Tab>('stamps');
  const tabEls: Record<Tab, HTMLButtonElement | undefined> = $state({ stamps: undefined, fish: undefined, badges: undefined });

  const p = $derived($profile);

  const stamped = $derived(new Set<string>(p?.stamps ?? []));
  const stampCount = $derived(STAMP_ZONES.filter((z) => stamped.has(z)).length);
  const stampTotal = $derived(p?.stampTotal || STAMP_ZONES.length);

  /** The table's order, junk last. `sort` is stable, so species keep their places. */
  const fishRows = $derived([...ALL_FISH].sort((a, b) => Number(a.rarity === 'junk') - Number(b.rarity === 'junk')));
  const speciesCaught = $derived(COLLECTIBLE_FISH.filter((f) => p?.fish[f.id]).length);

  const badgesEarned = $derived(BADGES.filter((b) => p?.badges.includes(b.id)).length);

  /**
   * Today's tasks. The card the server last sent may be yesterday's — it sends one when
   * something changes, and midnight in Japan is not a change — so past midnight the list is
   * today's, from the shared calendar, with nothing done yet.
   */
  const today = $derived.by(() => {
    const day = jstDay(serverNow());
    if (!p?.daily || p.daily.day === day) return p?.daily ?? null;
    return { day, tasks: dailyTasks(day).map((t) => ({ ...t, progress: 0 })), done: false };
  });

  /** A stamp lands a few degrees off true; the same few degrees every time for the same place. */
  function tilt(index: number): string {
    return `${((index * 47) % 17) - 8}deg`;
  }

  function mark(zone: string): string {
    return getZone(zone)?.nameJa?.charAt(0) ?? '';
  }

  function hex(color: number): string {
    return `#${color.toString(16).padStart(6, '0')}`;
  }

  function onTabKey(e: KeyboardEvent): void {
    const i = TABS.indexOf(tab);
    let next: Tab | null = null;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(i + TABS.length - 1) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    tab = next;
    tabEls[next]?.focus();
  }
</script>

{#if !p}
  <p class="empty">{$t('collection.none')}</p>
{:else}
  <!-- Today's tasks sit above the tabs: they change every day, the rest of the book does not. -->
  {#if today}
    <section class="today" aria-labelledby="today-title">
      <h3 class="today-title" id="today-title">
        {$t('daily.title')}{#if today.done}<span class="today-done" aria-hidden="true"> ✓</span>{/if}
      </h3>
      <ul class="tasks">
        {#each today.tasks as task (task.kind)}
          {@const full = task.progress >= task.goal}
          <li class="task" class:full>
            <span class="tick" aria-hidden="true">{full ? '✓' : '·'}</span>
            <span class="what">{$t(`daily.task.${task.kind}`, { n: task.goal })}</span>
            <span class="count">{Math.min(task.progress, task.goal)}/{task.goal}</span>
          </li>
        {/each}
      </ul>
      <p class="progress">{p.dailyStreak > 0 ? $t('daily.streak', { n: p.dailyStreak, total: p.dailyDays }) : $t('daily.same')}</p>
    </section>
  {/if}

  <div class="tabs" role="tablist" aria-label={$t('collection.sections')}>
    {#each TABS as id (id)}
      <button
        type="button"
        role="tab"
        class="tab"
        class:selected={tab === id}
        id="collection-tab-{id}"
        aria-selected={tab === id}
        aria-controls={tab === id ? 'collection-body' : undefined}
        tabindex={tab === id ? 0 : -1}
        bind:this={tabEls[id]}
        onclick={() => (tab = id)}
        onkeydown={onTabKey}
      >
        {$t(TAB_LABEL[id])}
      </button>
    {/each}
  </div>

  <div class="body" role="tabpanel" id="collection-body" aria-labelledby="collection-tab-{tab}">
    {#if tab === 'stamps'}
      <p class="progress">{$t('collection.stampProgress', { n: stampCount, total: stampTotal })}</p>
      <ol class="stamps">
        {#each STAMP_ZONES as zone, i (zone)}
          {@const got = stamped.has(zone)}
          <li class="stamp" class:got>
            <span class="seal" style:rotate={got ? tilt(i) : null} aria-hidden="true">
              {#if got}<span class="seal-mark" lang="ja">{mark(zone)}</span>{/if}
            </span>
            <span class="place">{zoneName(zone, $lang)}</span>
            <span class="sr">{got ? $t('collection.stamped') : $t('collection.notYet')}</span>
          </li>
        {/each}
      </ol>
      <p class="note" class:done={stampTotal > 0 && stampCount >= stampTotal}>
        {stampTotal > 0 && stampCount >= stampTotal ? $t('collection.walker') : $t('collection.stampHint')}
      </p>
    {:else if tab === 'fish'}
      <p class="progress">
        {$t('collection.fishProgress', { n: speciesCaught, total: COLLECTIBLE_FISH.length })}
        {#if p.catches > 0}<span class="faint"> · {$t('collection.catches', { n: p.catches })}</span>{/if}
      </p>
      <ul class="fishbook">
        {#each fishRows as fish (fish.id)}
          {@const record = p.fish[fish.id]}
          <li class="fish" class:caught={!!record}>
            <svg class="fish-icon" viewBox="0 0 32 20" width="28" height="18" aria-hidden="true" style:color={record ? hex(fish.color) : null}>
              <path d="M3 10C7 3.5 16.5 2.5 23 8L30 3.2 28.6 10 30 16.8 23 12C16.5 17.5 7 16.5 3 10Z" fill="currentColor" />
              {#if record}<circle cx="8.6" cy="8.9" r="1.2" fill="var(--ui-surface-raised)" />{/if}
            </svg>
            <div class="fish-text">
              <span class="fish-name">{record ? fishName(fish.id, $lang) : $t('collection.unknown')}</span>
              {#if record}
                <span class="fish-stat">
                  {$t('collection.count', { n: record.count })} · {$t('collection.best', { size: record.best })}
                </span>
              {/if}
            </div>
            {#if RARITY_DOTS[fish.rarity] > 0}
              <span class="dots" role="img" aria-label={$t(`rarity.${fish.rarity}`)}>
                {'●'.repeat(RARITY_DOTS[fish.rarity])}
              </span>
            {:else}
              <span class="junk">{$t('rarity.junk')}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="progress">{$t('collection.badgeProgress', { n: badgesEarned, total: BADGES.length })}</p>
      <ul class="badges">
        {#each BADGES as badge (badge.id)}
          {@const earned = p.badges.includes(badge.id)}
          {@const wearing = p.title === badge.id}
          <li class="badge" class:earned>
            <span class="badge-icon" aria-hidden="true">{badge.icon}</span>
            <div class="badge-text">
              <span class="badge-name">{badgeName(badge.id, $lang)}</span>
              {#if !earned}<span class="how">{badgeHow(badge.id, $lang)}</span>{/if}
            </div>
            {#if earned}
              <button
                type="button"
                class="wear"
                class:on={wearing}
                aria-pressed={wearing}
                onclick={() => cmd().setTitle(wearing ? null : badge.id)}
              >
                {wearing ? $t('collection.wearing') : $t('collection.wear')}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <p class="foot">{p.persistent ? $t('collection.kept') : $t('collection.notKept')}</p>
{/if}

<style>
  .empty {
    margin: var(--sp-xs) 0 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .tabs {
    display: flex;
    background: var(--ui-surface-sunk);
    border-radius: var(--r-sm);
    padding: 2px;
    margin-bottom: var(--sp-sm);
  }

  .tab {
    flex: 1;
    border: none;
    background: transparent;
    border-radius: var(--r-sm);
    padding: 4px 0;
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .tab.selected {
    background: var(--ui-surface-raised);
    color: var(--ui-ink);
    box-shadow: var(--ui-shadow);
  }

  .body {
    max-height: min(52vh, 400px);
    overflow-y: auto;
    scrollbar-width: thin;
  }

  p {
    margin: 0;
  }

  .progress {
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    margin-bottom: var(--sp-sm);
  }

  .today {
    margin-bottom: var(--sp-md);
    padding-bottom: var(--sp-sm);
    border-bottom: 1px solid var(--ui-line);
  }

  .today-title {
    margin: 0 0 var(--sp-xs);
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--ui-ink-muted);
  }

  .today-done {
    color: var(--ui-live);
  }

  .tasks {
    list-style: none;
    margin: 0 0 var(--sp-xs);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .task {
    display: flex;
    gap: var(--sp-sm);
    align-items: baseline;
    font-size: var(--fs-sm);
    color: var(--ui-ink);
  }

  .task.full {
    color: var(--ui-ink-muted);
  }

  .tick {
    flex: none;
    width: 1em;
    text-align: center;
    color: var(--ui-ink-faint);
  }

  .task.full .tick {
    color: var(--ui-live);
  }

  .what {
    flex: 1 1 auto;
    min-width: 0;
  }

  .count {
    flex: none;
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--ui-ink-muted);
  }

  .faint {
    color: var(--ui-ink-faint);
  }

  /* The stamp card. */
  .stamps {
    list-style: none;
    margin: 0;
    padding: var(--sp-sm);
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--sp-sm) var(--sp-xs);
    background: var(--ui-surface-raised);
    border: 1px solid var(--ui-line);
    border-radius: var(--r-md);
  }

  .stamp {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    min-width: 0;
  }

  .seal {
    width: 46px;
    height: 46px;
    box-sizing: border-box;
    border-radius: 50%;
    border: 1.5px dashed var(--ui-ink-faint);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.6;
  }

  /* Stamped: a double vermilion ring, slightly uneven, like ink on paper. */
  .stamp.got .seal {
    border: 2px solid var(--ui-accent);
    box-shadow: inset 0 0 0 2px var(--ui-surface-raised), inset 0 0 0 3px var(--ui-accent);
    opacity: 0.88;
  }

  .seal-mark {
    font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'YuMincho', 'Noto Serif JP', 'Songti SC', serif;
    font-size: 20px;
    font-weight: 600;
    color: var(--ui-accent);
    line-height: 1;
  }

  .place {
    max-width: 100%;
    font-size: var(--fs-xs);
    line-height: 1.2;
    text-align: center;
    color: var(--ui-ink-muted);
    overflow-wrap: anywhere;
  }

  .stamp.got .place {
    color: var(--ui-ink);
  }

  .note {
    margin-top: var(--sp-sm);
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .note.done {
    color: var(--ui-ink);
    font-weight: 600;
  }

  /* The fish book. */
  .fishbook,
  .badges {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .fish,
  .badge {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: 5px 0;
    border-bottom: 1px solid var(--ui-line);
  }

  .fish:last-child,
  .badge:last-child {
    border-bottom: none;
  }

  .fish-icon {
    flex: none;
    color: var(--ui-ink-faint);
    opacity: 0.55;
  }

  .fish.caught .fish-icon {
    opacity: 1;
  }

  .fish-text,
  .badge-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .fish-name {
    font-size: var(--fs-sm);
    color: var(--ui-ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .fish.caught .fish-name {
    color: var(--ui-ink);
  }

  .fish-stat {
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    font-variant-numeric: tabular-nums;
  }

  .dots {
    flex: none;
    font-size: 7px;
    letter-spacing: 1px;
    color: var(--ui-ink-faint);
  }

  .fish.caught .dots {
    color: var(--ui-ink-muted);
  }

  .junk {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  /* Badges. */
  .badge-icon {
    flex: none;
    width: 24px;
    text-align: center;
    font-size: 18px;
    filter: grayscale(1);
    opacity: 0.4;
  }

  .badge.earned .badge-icon {
    filter: none;
    opacity: 1;
  }

  .badge-name {
    font-size: var(--fs-sm);
    color: var(--ui-ink-faint);
  }

  .badge.earned .badge-name {
    color: var(--ui-ink);
  }

  .how {
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .wear {
    flex: none;
    border: 1px solid var(--ui-line);
    background: transparent;
    border-radius: 999px;
    padding: 2px var(--sp-sm);
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .wear.on {
    border-color: var(--ui-accent);
    color: var(--ui-accent);
  }

  .foot {
    margin-top: var(--sp-sm);
    padding-top: var(--sp-xs);
    border-top: 1px solid var(--ui-line);
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  button:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 1px;
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
