<script lang="ts">
  /**
   * HostPanel — shown inside Panels.svelte when `$openPanel === 'host'`, and only ever
   * reachable when `$isHost` (Hud.svelte hides the button that opens it otherwise; this
   * component also guards itself so it renders nothing if somehow opened without the role).
   *
   * One small control slip per hosted activity: its title, three lifecycle buttons
   * (Open / Start / End — disabled when the transition isn't legal, per
   * `canTransition` from the shared protocol, so a host can't double-tap into an
   * impossible state), and a one-line announcement composer scoped to that activity.
   *
   * This deliberately stays activity-scoped rather than becoming one global console with
   * a dropdown of "which activity" — a host with two things running gets two small slips,
   * not a form. Scope options are limited by role: everyone with Host on an activity can
   * announce to it or to its zone; only `$isAdmin` gets the island-wide option, matching
   * what the server itself will accept (see ClientHostAnnounce in protocol.ts).
   *
   * Admins also get one small "put on the programme" row under the slips: a template, a
   * start delay, a button. Templates are what keep this from being a form — the server
   * knows each one's venue, length and shape — and a handful of fixed delays covers "a quiz
   * in five minutes" without a time picker. It is shown whether or not the admin is hosting
   * anything, since scheduling is how they would come to be.
   *
   * Last, the check-in register: who checked in to what, in order, for the activities this
   * player may read (their own; for admins, any that took check-ins). It is asked for when
   * opened — the server keeps it, the board only carries the count — kept fresh while open by
   * asking again once the count stops moving, and saved as a CSV for whoever keeps the
   * attendance sheet.
   */
  import {
    ACTIVITY_TEMPLATES,
    ActivityState,
    canTransition,
    PROTOCOL,
    type ActivityId,
    type ActivityView,
    type AnnouncementView,
  } from '@nagisa/shared';
  import { activities, checkinList, hostedActivities, isAdmin, isHost, self, cmd, notify } from '../state/stores.js';
  import { activityTitle, lang, t, templateTitle, tr } from '../i18n/index.js';

  type Scope = 'activity' | 'zone' | 'island';

  /** Start delays on offer, minutes. */
  const DELAYS = [0, 2, 5, 10, 30] as const;

  let template = $state(ACTIVITY_TEMPLATES[0]?.id ?? '');
  let delay = $state<number>(5);

  /** How long to wait for the scheduled activity to appear before saying nothing. */
  const CONFIRM_MS = 5000;

  /**
   * A request in flight. "Scheduled" is said when the activity shows up on the board, not
   * when the button is pressed: the server may refuse (too many extras, one already running),
   * and saying both "scheduled" and why it was not is worse than waiting a tick.
   */
  let pending = $state<{ template: string; known: Set<string>; timer: ReturnType<typeof setTimeout> } | null>(null);

  function schedule(): void {
    if (!template) return;
    if (pending) clearTimeout(pending.timer);
    const known = new Set($activities.map((a) => a.id));
    pending = { template, known, timer: setTimeout(() => (pending = null), CONFIRM_MS) };
    cmd().schedule(template, delay);
  }

  $effect(() => {
    const wanted = pending;
    if (!wanted) return;
    const made = $activities.find((a) => a.templateId === wanted.template && !wanted.known.has(a.id));
    if (!made) return;
    clearTimeout(wanted.timer);
    pending = null;
    notify(tr('host.scheduled', { title: templateTitle(wanted.template) }), 'neutral');
  });

  const composer = $state<Record<string, { text: string; scope: Scope }>>({});

  // One draft per hosted activity, made before the slips render: creating it from the
  // template instead is a state write during render, which Svelte refuses outright.
  $effect.pre(() => {
    for (const a of $hostedActivities) {
      if (!composer[a.id]) composer[a.id] = { text: '', scope: 'activity' };
    }
  });

  function send(activity: ActivityView): void {
    const draft = composer[activity.id];
    const text = draft?.text.trim();
    if (!text) return;
    const scope: AnnouncementView['scope'] =
      draft.scope === 'island'
        ? { kind: 'island' }
        : draft.scope === 'zone'
          ? { kind: 'zone', zone: activity.zone }
          : { kind: 'activity', activity: activity.id };
    cmd().announce(text.slice(0, PROTOCOL.MAX_ANNOUNCEMENT_LENGTH), scope);
    draft.text = '';
  }

  /** Registers this player may read: their own; for an admin, any activity that has taken check-ins. */
  const registers = $derived(
    $activities.filter(
      (a) =>
        a.checkinEnabled &&
        (a.hostId === $self.id ||
          ($isAdmin && (a.checkinCount > 0 || a.state === ActivityState.Live || a.state === ActivityState.Ended))),
    ),
  );

  /** The register that is open, if any. */
  let registerOf = $state<ActivityId | null>(null);
  const shown = $derived($checkinList && $checkinList.activity === registerOf ? $checkinList.list : null);
  /** Its count on the board: a number, so the board changing elsewhere does not count as a change. */
  const openCount = $derived(registers.find((a) => a.id === registerOf)?.checkinCount);

  /** Asked for and not yet answered. Plain, not state: it only stops asking twice. */
  let asked: ActivityId | null = null;

  /** Forget what is on screen and fetch it afresh: nothing stale is shown, or saved. */
  function fetchRegister(): void {
    asked = null;
    checkinList.set(null);
  }

  function toggleRegister(id: ActivityId): void {
    registerOf = registerOf === id ? null : id;
    fetchRegister();
  }

  // Gone from the board (swept, or the island changed): nothing to show.
  $effect(() => {
    if (registerOf && openCount === undefined) registerOf = null;
  });

  // Open with nothing to show — just opened, refreshed, or cleared by a reconnect: ask, once.
  $effect(() => {
    const id = registerOf;
    if (!id || openCount === undefined || shown) {
      if (shown) asked = null;
      return;
    }
    if (asked === id) return;
    asked = id;
    cmd().checkinList(id);
  });

  // More check-ins since it was fetched: ask again once they stop coming, not once for each.
  $effect(() => {
    const id = registerOf;
    const count = openCount;
    if (!id || !shown || count === undefined || count === shown.length) return;
    const timer = setTimeout(() => cmd().checkinList(id), 1500);
    return () => clearTimeout(timer);
  });

  const pad = (n: number): string => String(n).padStart(2, '0');
  const clock = (at: number): string => {
    const d = new Date(at);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const stamp = (at: number): string => {
    const d = new Date(at);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  /**
   * One CSV cell. Quoted when it has to be; and a name that starts like a formula gets a
   * leading apostrophe, so a spreadsheet shows it rather than running it.
   */
  function cell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  }

  function saveRegister(a: ActivityView, list: NonNullable<typeof shown>): void {
    const rows = [
      [tr('host.csvOrdinal'), tr('host.csvName'), tr('host.csvTime')],
      ...list.map((r) => [String(r.ordinal), r.name, stamp(r.at)]),
    ];
    // The BOM is what makes a spreadsheet read the names as UTF-8 rather than mojibake.
    const csv = '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const d = new Date(a.startsAt);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nagisa-checkin-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${a.templateId || a.id}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
</script>

{#if $isHost}
  {#if $hostedActivities.length === 0}
    <p class="empty">{$t('host.none')}</p>
  {:else}
    {#each $hostedActivities as a (a.id)}
      {@const draft = composer[a.id]}
      <div class="slip">
        <p class="title">{activityTitle(a, $lang)}</p>

        <div class="lifecycle">
          <button
            type="button"
            class="action"
            disabled={!canTransition(a.state, ActivityState.Open)}
            onclick={() => cmd().setActivityState(a.id, ActivityState.Open)}
          >
            {$t('host.open')}
          </button>
          <button
            type="button"
            class="action"
            disabled={!canTransition(a.state, ActivityState.Live)}
            onclick={() => cmd().setActivityState(a.id, ActivityState.Live)}
          >
            {$t('host.start')}
          </button>
          <button
            type="button"
            class="action"
            disabled={!canTransition(a.state, ActivityState.Ended)}
            onclick={() => cmd().setActivityState(a.id, ActivityState.Ended)}
          >
            {$t('host.end')}
          </button>
        </div>

        {#if draft}
          <div class="composer">
            <input
              type="text"
              placeholder={$t('host.announcePlaceholder')}
              aria-label={$t('host.announcePlaceholder')}
              maxlength={PROTOCOL.MAX_ANNOUNCEMENT_LENGTH}
              bind:value={draft.text}
              onkeydown={(e) => e.key === 'Enter' && send(a)}
            />
            <div class="composer-row">
              <select bind:value={draft.scope} aria-label={$t('host.scope')}>
                <option value="activity">{$t('host.scopeActivity')}</option>
                <option value="zone">{$t('host.scopeZone')}</option>
                {#if $isAdmin}
                  <option value="island">{$t('host.scopeIsland')}</option>
                {/if}
              </select>
              <button type="button" class="send" onclick={() => send(a)}>{$t('host.send')}</button>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  {/if}

  {#if $isAdmin && ACTIVITY_TEMPLATES.length > 0}
    <div class="schedule">
      <span class="label">{$t('host.schedule')}</span>
      <div class="composer-row">
        <select class="what" bind:value={template} aria-label={$t('host.template')}>
          {#each ACTIVITY_TEMPLATES as tpl (tpl.id)}
            <option value={tpl.id}>{templateTitle(tpl.id, $lang)}</option>
          {/each}
        </select>
        <select class="when" bind:value={delay} aria-label={$t('host.when')}>
          {#each DELAYS as min (min)}
            <option value={min}>{min === 0 ? $t('host.now') : $t('host.inMin', { n: min })}</option>
          {/each}
        </select>
        <button type="button" class="send" onclick={schedule}>{$t('host.scheduleButton')}</button>
      </div>
    </div>
  {/if}

  {#if registers.length > 0}
    <div class="registers">
      <span class="label">{$t('host.register')}</span>
      {#each registers as a (a.id)}
        <div class="register-row">
          <span class="register-title" title={activityTitle(a, $lang)}>{activityTitle(a, $lang)}</span>
          <span class="register-count">{$t('host.registerCount', { n: a.checkinCount })}</span>
          <button
            type="button"
            class="action register-toggle"
            aria-expanded={registerOf === a.id}
            aria-label={`${activityTitle(a, $lang)} · ${registerOf === a.id ? $t('host.registerHide') : $t('host.registerView')}`}
            onclick={() => toggleRegister(a.id)}
          >
            {registerOf === a.id ? $t('host.registerHide') : $t('host.registerView')}
          </button>
        </div>
        {#if registerOf === a.id}
          <div class="register">
            {#if !shown}
              <p class="empty">{$t('host.registerLoading')}</p>
            {:else if shown.length === 0}
              <p class="empty">{$t('host.registerEmpty')}</p>
            {:else}
              <ol class="names">
                {#each shown as r (r.ordinal)}
                  <li><span class="ordinal">{r.ordinal}</span><span class="who">{r.name}</span><span class="at">{clock(r.at)}</span></li>
                {/each}
              </ol>
            {/if}
            <div class="composer-row">
              <button type="button" class="action" onclick={fetchRegister}>{$t('host.registerRefresh')}</button>
              <button type="button" class="send" disabled={!shown?.length} onclick={() => shown && saveRegister(a, shown)}>
                {$t('host.registerDownload')}
              </button>
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
{/if}

<style>
  .empty {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
  }

  .slip {
    display: flex;
    flex-direction: column;
    gap: var(--sp-xs);
    padding: var(--sp-sm) 0;
    border-bottom: 1px solid var(--ui-line);
  }

  .slip:last-child {
    border-bottom: none;
  }

  .title {
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 600;
  }

  .lifecycle {
    display: flex;
    gap: var(--sp-xs);
  }

  .action {
    flex: 1;
    border: 1px solid var(--ui-line);
    background: transparent;
    border-radius: var(--r-sm);
    padding: 4px 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    cursor: pointer;
  }

  .action:not(:disabled):hover {
    color: var(--ui-ink);
    background: var(--ui-surface-sunk);
  }

  .action:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .action:focus-visible {
    outline: 2px solid var(--ui-accent);
    outline-offset: 1px;
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .composer input {
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink);
    background: var(--ui-surface-sunk);
    border: none;
    border-radius: var(--r-sm);
    padding: 5px var(--sp-sm);
    outline: none;
  }

  .composer input:focus-visible {
    outline: 2px solid var(--ui-accent);
  }

  .composer-row {
    display: flex;
    gap: 4px;
  }

  select {
    flex: 1;
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    background: var(--ui-surface-sunk);
    border: none;
    border-radius: var(--r-sm);
    padding: 3px 4px;
  }

  .send {
    border: none;
    background: var(--ui-accent);
    color: var(--ui-surface-raised);
    border-radius: var(--r-sm);
    padding: 3px var(--sp-sm);
    font-size: var(--fs-xs);
    font-weight: 600;
    cursor: pointer;
  }

  .send:focus-visible {
    outline: 2px solid var(--ui-ink);
    outline-offset: 1px;
  }

  /* Under a slip, the slip's own rule separates them; under the "nothing" line, this does. */
  .schedule {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: var(--sp-sm);
  }

  .empty + .schedule {
    margin-top: var(--sp-sm);
    border-top: 1px solid var(--ui-line);
  }

  .label {
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-ink-muted);
  }

  .what {
    flex: 2 1 0;
    min-width: 0;
  }

  .when {
    flex: 1 1 0;
    min-width: 0;
  }

  .registers {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: var(--sp-sm);
    padding-top: var(--sp-sm);
    border-top: 1px solid var(--ui-line);
  }

  .register-row {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    font-size: var(--fs-xs);
  }

  .register-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .register-count {
    color: var(--ui-ink-muted);
    font-variant-numeric: tabular-nums;
  }

  .register-toggle {
    flex: 0 0 auto;
    padding: 2px var(--sp-sm);
  }

  .register {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 0 var(--sp-xs);
  }

  .names {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 12rem;
    overflow-y: auto;
    font-size: var(--fs-xs);
  }

  .names li {
    display: flex;
    gap: var(--sp-sm);
    padding: 1px 0;
  }

  .ordinal,
  .at {
    color: var(--ui-ink-muted);
    font-variant-numeric: tabular-nums;
  }

  .ordinal {
    min-width: 1.6em;
    text-align: right;
  }

  .who {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .send:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
