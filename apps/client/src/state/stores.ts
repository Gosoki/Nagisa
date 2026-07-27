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
  zone: 'harbor',
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
export type PanelId = 'people' | 'activities' | 'settings' | 'host' | null;
export const openPanel: Writable<PanelId> = writable(null);

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
  /** Show the performance readout. Off by default; toggled with a keyboard shortcut. */
  showStats: boolean;
  /** Reduce motion: stills the camera drift and shortens transitions. */
  reducedMotion: boolean;
}

const SETTINGS_KEY = 'nagisa.settings';

/** Load persisted settings, falling back to sensible defaults. */
function loadSettings(): Settings {
  const defaults: Settings = {
    quality: 'high',
    muted: true,
    showNames: true,
    showStats: false,
    reducedMotion:
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
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
  switchRoom(id: string): void;
  setQuality(tier: QualityTier): void;
  setMuted(muted: boolean): void;
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
