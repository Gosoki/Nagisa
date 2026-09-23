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
   */
  import {
    ACTIVITY_TEMPLATES,
    ActivityState,
    canTransition,
    PROTOCOL,
    type ActivityView,
    type AnnouncementView,
  } from '@nagisa/shared';
  import { activities, hostedActivities, isAdmin, isHost, cmd, notify } from '../state/stores.js';
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
{/if}

<style>
  .empty {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
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
</style>
