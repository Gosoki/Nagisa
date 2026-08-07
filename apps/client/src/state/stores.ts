/**
 * Client state.
 * =============
 *
 * The single boundary between the 3D world and the interface. The engine writes here;
 * Svelte components read here. No component ever holds a reference to a `THREE.Scene`,
 * and no engine module ever imports a component.
 *
 * That boundary is worth the small amount of ceremony it costs:
 *
 * - the UI can be rebuilt, restyled or removed without touching the world;
 * - the world runs headless in tests, because nothing in it needs a DOM;
 * - every piece of state the interface can show is enumerated in one file, which is what
 *   keeps a "lightweight, restrained" interface from quietly accreting.
 *
 * These are plain Svelte stores rather than runes so that non-component modules (the
 * netcode, the scene director) can read and write them directly.
 */

import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import {
  ActivityState,
  Role,
  type ActivityId,
  type ActivityView,
  type AnnouncementView,
  type PlayerId,
  type PlayerView,
  type RoomView,
  type ZoneId,
} from '@nagisa/shared';
import type { ConnectionState } from '../net/connection.js';
import type { QualityTier } from '../engine/quality.js';

// ---------------------------------------------------------------------------
// Session & connection
// ---------------------------------------------------------------------------

/** Where the player is in the app's very short journey. */
export type AppPhase =
  /** Building the island. The loader is up. */
  | 'loading'
  /** Name and appearance. One screen, then you are in. */
  | 'entry'
  /** In the world. */
  | 'world';

export const appPhase: Writable<AppPhase> = writable('loading');

/** Loading progress, 0–1, and a short human label for what is happening. */
export const loadProgress: Writable<{ value: number; label: string }> = writable({
  value: 0,
  label: 'Approaching the island',
});

export const connectionState: Writable<ConnectionState> = writable('idle');

/** Round-trip latency, ms. Shown only when it is bad enough to matter. */
export const latency: Writable<number> = writable(0);

/**
 * True when the connection is troubled *and has been for long enough to mention*.
 * A one-second blip should not put a notice on screen; five seconds should.
 */
export const connectionTroubled: Readable<boolean> = derived(
  connectionState,
  ($state, set) => {
    if ($state === 'connected' || $state === 'idle') {
      set(false);
      return;
    }
    const timer = setTimeout(() => set(true), 5000);
    return () => clearTimeout(timer);
  },
  false,
);

// ---------------------------------------------------------------------------
// Self
// ---------------------------------------------------------------------------

/** Everything about the local player the interface needs. */
export interface SelfState {
  id: PlayerId | null;
  name: string;
  appearance: { outfit: number; skin: number; accessory: number };
  role: Role;
  /** Activity currently attached to, if any. */
  activity: ActivityId | null;
  mode: 'participant' | 'audience' | null;
  /** Whether we have checked in to the current activity. */
  checkedIn: boolean;
  zone: ZoneId;
  seated: boolean;
}

export const self: Writable<SelfState> = writable({
  id: null,
  name: '',
  appearance: { outfit: 0, skin: 0, accessory: 0 },
  role: Role.Guest,
  activity: null,
  mode: null,
  checkedIn: false,
  zone: 'south-harbor',
  seated: false,
});

/** True when the local player can run *any* activity — shows the host affordances. */
export const isHost: Readable<boolean> = derived(self, ($s) => $s.role >= Role.Host);
export const isAdmin: Readable<boolean> = derived(self, ($s) => $s.role >= Role.Admin);

// ---------------------------------------------------------------------------
// Room & presence
// ---------------------------------------------------------------------------

export const room: Writable<RoomView | null> = writable(null);
export const rooms: Writable<RoomView[]> = writable([]);

/** Everyone else in the room. Updated on join/leave, not per movement frame. */
export const players: Writable<PlayerView[]> = writable([]);

/** Total population including yourself. The one number the HUD always shows. */
export const population: Readable<number> = derived(players, ($p) => $p.length + 1);

/** Per-zone occupancy, for the zone labels. */
export const zonePopulation: Writable<Record<string, number>> = writable({});

/** The zone the local player is standing in, and whether to show its title card. */
export const currentZone: Writable<{ id: ZoneId; name: string; nameJa: string; caption: string } | null> =
  writable(null);

/** Set briefly when entering a new zone, to fade the title card in and out. */
export const zoneAnnounce: Writable<boolean> = writable(false);

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export const activities: Writable<ActivityView[]> = writable([]);

/**
 * The "Next Up" item — the single activity the interface surfaces by default.
 *
 * Priority: something live you are attached to → anything live → the soonest thing that
 * is open → the soonest scheduled. Showing one is the whole point; a list of six
 * upcoming events is a dashboard, and this product is not that.
 */
export const nextUp: Readable<ActivityView | null> = derived([activities, self], ([$activities, $self]) => {
  if ($activities.length === 0) return null;
  const live = $activities.filter((a) => a.state === ActivityState.Live);
  const mine = live.find((a) => a.id === $self.activity);
  if (mine) return mine;
  if (live.length > 0) return live.sort((a, b) => a.startsAt - b.startsAt)[0];
  const open = $activities.filter((a) => a.state === ActivityState.Open);
  if (open.length > 0) return open.sort((a, b) => a.startsAt - b.startsAt)[0];
  const scheduled = $activities
    .filter((a) => a.state === ActivityState.Scheduled)
    .sort((a, b) => a.startsAt - b.startsAt);
  return scheduled[0] ?? null;
});

/** The activity the local player is attached to, resolved to its full record. */
export const myActivity: Readable<ActivityView | null> = derived([activities, self], ([$activities, $self]) =>
  $self.activity ? ($activities.find((a) => a.id === $self.activity) ?? null) : null,
);

/** Activities the local player hosts. Drives the host console's contents. */
export const hostedActivities: Readable<ActivityView[]> = derived([activities, self], ([$activities, $self]) =>
  $self.id ? $activities.filter((a) => a.hostId === $self.id) : [],
);

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/** Everything still within its TTL, newest first. The notice board reads this. */
export const announcements: Writable<AnnouncementView[]> = writable([]);

/** The one announcement currently being presented as a toast. `null` when quiet. */
export const currentToast: Writable<AnnouncementView | null> = writable(null);

/** Transient, purely local notices ("Checked in", "Reconnected"). Never networked. */
export interface LocalNotice {
  id: number;
  text: string;
  tone: 'neutral' | 'good' | 'warn';
}
export const notices: Writable<LocalNotice[]> = writable([]);

let noticeSeq = 0;

/** Show a short local notice. Auto-dismisses; callers do not manage its lifetime. */
export function notify(text: string, tone: LocalNotice['tone'] = 'neutral', ttlMs = 3200): void {
  const id = ++noticeSeq;
  notices.update((list) => [...list, { id, text, tone }]);
  setTimeout(() => {
    notices.update((list) => list.filter((n) => n.id !== id));
  }, ttlMs);
}

/**
 * The local player's transform, as a plain mutable object.
 *
 * Deliberately **not** a store. The minimap needs the player's position and heading every
 * frame, and a Svelte store written at 60 Hz re-runs every subscriber and every reactive
 * statement that touches it — for a value whose only consumer already has its own
 * `requestAnimationFrame` loop and can simply read the current value when it draws.
 *
 * The same reasoning as `stickState` in reverse: that one crosses the boundary as a store
 * because the interface must *react* to it; this one does not, because the interface polls.
 *
 * Written by `App` each frame. Read, never mutated, by everything else.
 */
export const selfPose = { x: 0, y: 0, z: 0, yaw: 0 };

/**
 * The island photographed from above, for the minimap to blit.
 *
 * Captured once after the world is built (see `world/plan.ts`) rather than drawn a second
 * time from the terrain field, so the map shows the buildings, the piers and the torii —
 * the things anyone actually navigates by — and cannot drift out of step with the world.
 *
 * Keyed by map id, because a different pack is a different island.
 */
export const planImage: Writable<{ mapId: string; canvas: HTMLCanvasElement; extent: number } | null> =
  writable(null);

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** One line in the chat log. */
export interface ChatLine {
  /** Monotonic, local. Used as the keyed-each key; server messages carry no id. */
  readonly seq: number;
  readonly playerId: string;
  readonly name: string;
  readonly text: string;
  /** Local receipt time, for the timestamp and for bubble expiry. */
  readonly at: number;
  /** True for lines the local player sent — styled differently, never bubbled. */
  readonly self: boolean;
  /** System lines (arrivals, departures, errors) have no author. */
  readonly system?: boolean;
}

/**
 * The chat log.
 *
 * Capped at {@link CHAT_HISTORY} lines. A chat room that keeps everything eventually
 * spends more memory on text nobody will scroll back to than on the island itself, and an
 * unbounded keyed-each is a rendering cost that grows all session.
 */
export const chatLog: Writable<ChatLine[]> = writable([]);

/** How many lines of scrollback to keep. */
const CHAT_HISTORY = 200;

/** Whether the composer has focus. The world stops reading movement keys while it does. */
export const chatComposing: Writable<boolean> = writable(false);

/**
 * True when the panel is pinned open. When false the log still shows recent lines and
 * fades them out, so conversation is visible without committing screen space to it.
 */
export const chatPinned: Writable<boolean> = writable(false);

/** Lines the local player has not seen because the log was collapsed. */
export const chatUnread: Writable<number> = writable(0);

let chatSeq = 0;

/** Append a line. The only writer — components and the net layer both come through here. */
export function pushChat(line: Omit<ChatLine, 'seq' | 'at'> & { at?: number }): void {
  const full: ChatLine = { ...line, seq: ++chatSeq, at: line.at ?? Date.now() };
  chatLog.update((lines) => {
    const next = [...lines, full];
    return next.length > CHAT_HISTORY ? next.slice(next.length - CHAT_HISTORY) : next;
  });
  if (!line.self) {
    let pinned = false;
    chatPinned.subscribe((v) => (pinned = v))();
    if (!pinned) chatUnread.update((n) => n + 1);
  }
}

/** A system line: arrivals, departures, and anything the room says rather than a person. */
export function pushSystemChat(text: string): void {
  pushChat({ playerId: '', name: '', text, self: false, system: true });
}

// ---------------------------------------------------------------------------
// Muting
// ---------------------------------------------------------------------------

/** Where the mute list lives between reloads. */
const MUTE_KEY = 'nagisa.muted';

/**
 * How many mutes are kept, newest first.
 *
 * A cap rather than none, because the list is written to `localStorage` and read on every
 * arriving chat line, and nothing ever removes an id: the people it names have long since
 * left, and their ids will not be issued again. Without this it is a log that grows for as
 * long as the browser profile lives. Two hundred is far more than anyone will mute in a
 * session and small enough that the linear scan per message stays free.
 */
const MUTE_LIMIT = 200;

/**
 * People whose chat and speech bubbles this client drops, by player id.
 *
 * ### Why this is client-side and unilateral
 *
 * It is the only thing in the room that works when nobody is watching. A report needs a
 * moderator to read it and a kick needs a host to be present, and neither is true at three
 * in the morning with two strangers on a beach. Mute needs no permission, takes effect on
 * the next frame, and tells the other person nothing — which is the point, because a mute
 * that announces itself is an escalation rather than an exit.
 *
 * It deliberately does **not** hide the person. You still see where they are, which is what
 * lets you walk away from them; a mute that made someone invisible would take away the
 * information you need most. See `world-sync` for where the drop actually happens.
 *
 * ### Why by id, and what that costs
 *
 * The id is what every message carries and what the bubbles and name tags are keyed on. It
 * survives a reconnect, because the resume token restores the same identity — so a mute
 * outlives the outage that a name-based one would too, without being defeated by two people
 * choosing the same name. What it does not survive is the other person rejoining fresh, and
 * no client-side scheme can: an anonymous room cannot promise a durable block, and
 * pretending otherwise would be worse than the honest version.
 */
export const mutedIds: Writable<string[]> = writable(loadMuted());

function loadMuted(): string[] {
  try {
    const raw = localStorage.getItem(MUTE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(-MUTE_LIMIT);
  } catch {
    // Private browsing, or a value written by an older build. An empty list is correct.
    return [];
  }
}

/** A set view, for the per-message check that runs on every arriving line. */
export const mutedSet: Readable<ReadonlySet<string>> = derived(mutedIds, ($ids) => new Set($ids));

/** Read the mute list outside a component. Used by the net layer, which has no `$`. */
export function isMuted(id: string): boolean {
  let ids: string[] = [];
  mutedIds.subscribe((v) => (ids = v))();
  return ids.includes(id);
}

/** Mute or unmute someone. Persisted immediately — this is not a preference to lose. */
export function toggleMute(id: string, name: string): void {
  mutedIds.update((ids) => {
    const next = ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id].slice(-MUTE_LIMIT);
    try {
      localStorage.setItem(MUTE_KEY, JSON.stringify(next));
    } catch {
      /* Non-fatal: the mute still holds for this session. */
    }
    notify(next.includes(id) ? `Muted ${name}` : `Unmuted ${name}`);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Following
// ---------------------------------------------------------------------------

/**
 * The player being followed, or null.
 *
 * Following walks you to someone and keeps you near them — the thing you actually want in
 * a social world when a friend says "come over here" and you have no idea where "here" is.
 * It is *not* a teleport: you travel the ground like anyone else, which keeps the island a
 * place with distances in it. Any manual movement input cancels it, so it never feels like
 * losing control of your own character.
 */
export const followTarget: Writable<{ id: string; name: string } | null> = writable(null);

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

/** The interactable within reach, if any. Drives the single contextual prompt. */
export const interactPrompt: Writable<{ id: string; label: string } | null> = writable(null);

/** Whether the emote wheel is open. */
export const emoteOpen: Writable<boolean> = writable(false);

/**
 * Screen-space state of the touch movement stick, or `null` when no drag is active.
 *
 * This is the one genuinely hot value that crosses the engine↔interface boundary: it is
 * written on every `pointermove` of a drag. It lives here anyway, rather than being
 * threaded through as a component prop, because the alternative is re-rendering the
 * overlay root on every pointer event — which is both more work and a far worse contract.
 *
 * The cost is small and bounded: a store write plus two CSS transforms on two elements,
 * only while a finger is down, and only on touch devices.
 */
export interface StickState {
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
}

export const stickState: Writable<StickState | null> = writable(null);


/** Which optional panel is open. Only ever one, and `null` most of the time. */
export type PanelId = 'people' | 'activities' | 'settings' | 'host' | 'notes' | null;
export const openPanel: Writable<PanelId> = writable(null);

/**
 * Developer mode: shows the placement-notes panel and its HUD button.
 *
 * `?dev=1` turns it on and remembers it; `?dev=0` turns it off again. A URL parameter
 * rather than a setting because it is not a preference — it is a different job, and a
 * toggle for it in the settings panel would be one more thing every player has to read
 * past and decide is not for them.
 */
export const devMode: boolean = (() => {
  try {
    const param = new URLSearchParams(location.search).get('dev');
    if (param === '1') localStorage.setItem('nagisa.dev', '1');
    if (param === '0') localStorage.removeItem('nagisa.dev');
    return localStorage.getItem('nagisa.dev') === '1';
  } catch {
    return false;
  }
})();

/** Open a panel, closing whatever else was open. */
export function togglePanel(id: Exclude<PanelId, null>): void {
  openPanel.update((cur) => (cur === id ? null : id));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  quality: QualityTier;
  /** Master audio mute. Audio starts muted until the first gesture — browsers require it. */
  muted: boolean;
  /** Show name tags above other players. */
  showNames: boolean;
  /** Show the minimap. On by default — it is the only way to find people. */
  minimap: boolean;
  /** Show the performance readout. Off by default; toggled with a keyboard shortcut. */
  showStats: boolean;
  /** Reduce motion: stills the camera drift and shortens transitions. */
  reducedMotion: boolean;
  /**
   * Draw the medium: pen hatching in the shade and paper tooth over everything.
   *
   * Both are screen-space, so they belong to the picture rather than to the surfaces —
   * which is the point of them and also why they slide as you walk. On by default;
   * off gives flat fills and lines only.
   */
  paperTexture: boolean;
}

const SETTINGS_KEY = 'nagisa.settings';

/** Load persisted settings, falling back to sensible defaults. */
function loadSettings(): Settings {
  const defaults: Settings = {
    quality: 'high',
    muted: true,
    showNames: true,
    minimap: true,
    showStats: false,
    reducedMotion:
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    paperTexture: true,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) } : defaults;
  } catch {
    return defaults;
  }
}

export const settings: Writable<Settings> = writable(loadSettings());

// Persist on every change. Cheap, and it means quality choices survive a reload.
settings.subscribe((value) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  } catch {
    /* Private mode: settings are session-only. */
  }
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface Stats {
  fps: number;
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
  /** Instances placed by the scatter pass. Static after load. */
  scatterInstances: number;
}

export const stats: Writable<Stats> = writable({
  fps: 60,
  drawCalls: 0,
  triangles: 0,
  pixelRatio: 1,
  scatterInstances: 0,
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Actions the interface can ask the world to perform.
 *
 * The UI never calls into the engine directly; it calls these. The app wires the real
 * implementations at boot, which keeps components trivially testable and means the whole
 * interface can be mounted with no WebGL context at all.
 */
export interface WorldCommands {
  enterWorld(name: string, appearance: SelfState['appearance']): void;
  joinActivity(id: ActivityId, mode: 'participant' | 'audience'): void;
  leaveActivity(): void;
  checkIn(): void;
  emote(emote: string): void;
  interact(): void;
  /** Send a chat line. Empty or whitespace-only input is dropped here, not on the wire. */
  say(text: string): void;
  /** Follow a player by id, or pass null to stop. */
  follow(id: string | null): void;
  switchRoom(id: string): void;
  setQuality(tier: QualityTier): void;
  setMuted(muted: boolean): void;
  /**
   * Where the camera is and what it is aimed at, world space. Used by the developer
   * notes panel so a marked spot carries the view it was marked from, which is what
   * lets the exact frame be reproduced later as a probe viewpoint.
   */
  cameraView?(): { eye: [number, number, number]; target: [number, number, number] } | null;
  travelTo(zone: ZoneId): void;
  /** Host controls. */
  setActivityState(id: ActivityId, state: ActivityState): void;
  announce(text: string, scope: AnnouncementView['scope']): void;
}

/** No-op implementations, replaced at boot. Keeps components safe before wiring. */
const noop = (): void => {
  /* not yet wired */
};

export const commands: Writable<WorldCommands> = writable({
  enterWorld: noop,
  joinActivity: noop,
  leaveActivity: noop,
  say: noop,
  follow: noop,
  checkIn: noop,
  emote: noop,
  interact: noop,
  switchRoom: noop,
  setQuality: noop,
  setMuted: noop,
  travelTo: noop,
  setActivityState: noop,
  announce: noop,
});

/** Convenience for components: `cmd().joinActivity(...)`. */
export function cmd(): WorldCommands {
  return get(commands);
}
