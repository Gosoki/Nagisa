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
   */
  import { ActivityState, canTransition, PROTOCOL, type ActivityView, type AnnouncementView } from '@nagisa/shared';
  import { hostedActivities, isAdmin, isHost, cmd } from '../state/stores.js';

  type Scope = 'activity' | 'zone' | 'island';

  const composer = $state<Record<string, { text: string; scope: Scope }>>({});

  function draftFor(id: string) {
    if (!composer[id]) composer[id] = { text: '', scope: 'activity' };
    return composer[id];
  }

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
    <p class="empty">Nothing of yours is running right now.</p>
  {:else}
    {#each $hostedActivities as a (a.id)}
      {@const draft = draftFor(a.id)}
      <div class="slip">
        <p class="title">{a.title}</p>

        <div class="lifecycle">
          <button
            type="button"
            class="action"
            disabled={!canTransition(a.state, ActivityState.Open)}
            onclick={() => cmd().setActivityState(a.id, ActivityState.Open)}
          >
            Open
          </button>
          <button
            type="button"
            class="action"
            disabled={!canTransition(a.state, ActivityState.Live)}
            onclick={() => cmd().setActivityState(a.id, ActivityState.Live)}
          >
            Start
          </button>
          <button
            type="button"
            class="action"
            disabled={!canTransition(a.state, ActivityState.Ended)}
            onclick={() => cmd().setActivityState(a.id, ActivityState.Ended)}
          >
            End
          </button>
        </div>

        <div class="composer">
          <input
            type="text"
            placeholder="Announce something…"
            maxlength={PROTOCOL.MAX_ANNOUNCEMENT_LENGTH}
            bind:value={draft.text}
            onkeydown={(e) => e.key === 'Enter' && send(a)}
          />
          <div class="composer-row">
            <select bind:value={draft.scope} aria-label="Announcement scope">
              <option value="activity">This activity</option>
              <option value="zone">This zone</option>
              {#if $isAdmin}
                <option value="island">Island</option>
              {/if}
            </select>
            <button type="button" class="send" onclick={() => send(a)}>Send</button>
          </div>
        </div>
      </div>
    {/each}
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
</style>
