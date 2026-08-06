<script lang="ts">
  /**
   * Placement notes — a developer surface, shown only when dev mode is on.
   *
   * One button and one box, which is the whole idea: stand where the problem is, press
   * **Mark here**, say what is wrong, save. The button fills in everything a note needs to
   * be actionable a day later and in a different process — the position, the heading, the
   * place, the nearest hand-placed landmark by name, and the camera, so the exact view can
   * be reproduced as a probe viewpoint.
   *
   * Words alone are not enough for this job. "This hut is too close to the road" is
   * unusable later because *this* was something you were looking at and the record kept
   * only the sentence. Naming the landmark is what turns it into an edit.
   *
   * Notes go to the server (`POST /dev/notes`) and land in a JSON-lines file that
   * `npm run notes` prints. They have to outlive the browser: they are written while
   * playing and read while editing the map, which is a different day.
   */
  import { onMount } from 'svelte';
  import { LANDMARKS, activeMapId, zoneAt } from '@nagisa/shared';
  import { cmd, selfPose } from '../state/stores.js';

  interface Mark {
    pos: [number, number, number];
    yaw: number;
    zone: string;
    nearest: { id: string; kind: string; dist: number } | null;
    camera: { eye: [number, number, number]; target: [number, number, number] } | null;
  }

  let mark: Mark | null = $state(null);
  let text = $state('');
  let status = $state('');
  let saved: { at: string; text: string; zone: string; nearest: string | null }[] = $state([]);

  /**
   * The eight nearest hand-placed landmarks, nearest first.
   *
   * A list rather than just the nearest, because the nearest is often not the one you mean:
   * standing between two row houses to say something about the *third* is exactly the case
   * that makes a note useless later. Picking the name here is what turns "move this" into an
   * edit somebody can make without going back into the world.
   *
   * Scanned linearly over ~120 landmarks, once per press. An index would be faster and would
   * also be a thing to keep in sync, for no gain at this size.
   */
  function nearbyLandmarks(x: number, z: number): NonNullable<Mark['nearest']>[] {
    return LANDMARKS.map((l) => ({ id: l.id, kind: l.kind, dist: Math.hypot(l.x - x, l.z - z) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8);
  }

  let nearby: NonNullable<Mark['nearest']>[] = $state([]);
  let chosen = $state('');

  function markHere(): void {
    const { x, y, z, yaw } = selfPose;
    const camera = cmd().cameraView?.() ?? null;
    nearby = nearbyLandmarks(x, z);
    chosen = nearby[0]?.id ?? '';
    mark = { pos: [x, y, z], yaw, zone: zoneAt(x, z), nearest: nearby[0] ?? null, camera };
    status = '';
  }

  // Re-point the note at whichever landmark is chosen, without re-marking the spot.
  $effect(() => {
    if (!mark) return;
    const pick = nearby.find((n) => n.id === chosen);
    if (pick && mark.nearest?.id !== pick.id) mark = { ...mark, nearest: pick };
  });

  /** What goes in the read-only field: dense, and readable aloud. */
  function summarise(m: Mark): string {
    const [x, y, z] = m.pos;
    const heading = `${((m.yaw * 180) / Math.PI).toFixed(0)}°`;
    const near = m.nearest ? `  ·  nearest ${m.nearest.id} (${m.nearest.dist.toFixed(1)} m)` : '';
    return `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}  ·  facing ${heading}  ·  ${m.zone}${near}`;
  }

  async function save(): Promise<void> {
    if (!mark || !text.trim()) {
      status = 'mark a spot and write something first';
      return;
    }
    status = 'saving…';
    try {
      const res = await fetch(`${devBase()}/dev/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...mark, map: activeMapId() ?? 'nagisa-island', text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        status = body?.error ?? `server said ${res.status}`;
        return;
      }
      text = '';
      status = 'saved';
      await load();
    } catch {
      // The endpoint is absent unless DEV_NOTES_PATH is set, and a 404 with no CORS header
      // reaches the browser as a network failure rather than as a status — so this is what
      // "the server is running but notes are off" actually looks like from here.
      status = 'notes are off — start the stack with `npm run dev`';
    }
  }

  /**
   * Where the server is.
   *
   * In development the client is on Vite's port and the server on its own, so a relative
   * URL would post to Vite. The websocket URL already knows the right host; this reuses the
   * same convention rather than inventing a second one.
   */
  function devBase(): string {
    const ws = import.meta.env.VITE_SERVER_URL as string | undefined;
    if (ws) return ws.replace(/^ws/, 'http').replace(/\/ws$/, '');
    return location.port === '5173' ? `${location.protocol}//${location.hostname}:8787` : '';
  }

  async function load(): Promise<void> {
    try {
      const res = await fetch(`${devBase()}/dev/notes`);
      if (!res.ok) return;
      const body = (await res.json()) as { notes: { at: string; text: string; zone: string; nearest: { id: string } | null }[] };
      saved = body.notes.slice(-8).reverse().map((n) => ({ at: n.at, text: n.text, zone: n.zone, nearest: n.nearest?.id ?? null }));
    } catch {
      /* The endpoint is absent unless DEV_NOTES_PATH is set. Nothing to show. */
    }
  }

  onMount(load);
</script>

<div class="notes">
  <p class="hint">Stand where the problem is, mark it, say what is wrong.</p>

  <button type="button" class="mark" onclick={markHere}>Mark here</button>

  <input class="coords" readonly value={mark ? summarise(mark) : 'nothing marked yet'} aria-label="Marked position" />

  {#if nearby.length}
    <label class="pick">
      <span class="label">This is about</span>
      <select bind:value={chosen} aria-label="Which landmark this note is about">
        {#each nearby as n (n.id)}
          <option value={n.id}>{n.id} · {n.kind} · {n.dist.toFixed(1)} m</option>
        {/each}
      </select>
    </label>
  {/if}

  <textarea
    bind:value={text}
    rows="3"
    placeholder="e.g. this hut is too close to the road, and its door faces the hill"
    aria-label="Note"
  ></textarea>

  <div class="row">
    <button type="button" class="save" onclick={save} disabled={!mark || !text.trim()}>Save note</button>
    {#if status}<span class="status">{status}</span>{/if}
  </div>

  {#if saved.length}
    <ul class="log">
      {#each saved as note (note.at)}
        <li>
          <span class="where">{note.nearest ?? note.zone}</span>
          {note.text}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .notes {
    display: flex;
    flex-direction: column;
    gap: var(--sp-sm);
  }

  .hint {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  button {
    border: none;
    border-radius: var(--r-md);
    background: var(--ui-surface-raised);
    color: var(--ui-ink);
    font: inherit;
    font-size: var(--fs-sm);
    padding: 7px var(--sp-md);
    cursor: pointer;
  }

  button:disabled {
    color: var(--ui-ink-faint);
    cursor: default;
  }

  .save {
    background: var(--ui-accent);
    color: #fff;
  }

  .save:disabled {
    background: var(--ui-surface-raised);
  }

  .coords,
  textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--ui-line);
    border-radius: var(--r-md);
    background: var(--ui-surface);
    color: var(--ui-ink);
    font: inherit;
    font-size: var(--fs-xs);
    padding: 6px 8px;
  }

  .coords {
    font-family: ui-monospace, monospace;
    color: var(--ui-ink-muted);
  }

  textarea {
    resize: vertical;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
  }

  .pick {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .pick .label {
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  select {
    border: 1px solid var(--ui-line);
    border-radius: var(--r-md);
    background: var(--ui-surface);
    color: var(--ui-ink);
    font: inherit;
    font-size: var(--fs-xs);
    padding: 5px 6px;
  }

  .status {
    font-size: var(--fs-xs);
    color: var(--ui-ink-faint);
  }

  .log {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--fs-xs);
    color: var(--ui-ink-muted);
    border-top: 1px solid var(--ui-line);
    padding-top: var(--sp-sm);
  }

  .where {
    font-family: ui-monospace, monospace;
    color: var(--ui-ink-faint);
    margin-right: 4px;
  }
</style>
