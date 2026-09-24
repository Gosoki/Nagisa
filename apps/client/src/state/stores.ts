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
  FIREWORKS,
  Role,
  type ActivityId,
  type ActivityView,
  type AnnouncementView,
  type BadgeId,
  type DarumaView,
  type GuestbookEntry,
  type Hand,
  type PlayerId,
  type PlayerView,
  type ProfileView,
  type QuizView,
  type RoomView,
  type ServerFish,
  type ServerCheckinList,
  type ServerDig,
  type ServerFriends,
  type ServerOmikuji,
  type Weather,
  type ZoneId,
} from '@nagisa/shared';
import type { ConnectionState } from '../net/connection.js';
import { tr } from '../i18n/index.js';
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

/** The connection was closed because another tab took this player over (see `net/connection.ts`). */
export const replacedElsewhere: Writable<boolean> = writable(false);

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
 * Where someone else is right now, as the engine draws them — or null if the engine does not
 * have them. `players[i].pos` is only where they were when they arrived: moves go straight
 * to the figures, never through the store (ten writes a second per person would re-render
 * every list that shows people). So anything drawn on a map reads this instead, in its own
 * frame loop, for the same reason as `selfPose`. The app installs the lookup at boot.
 */
export const remotePose: { at(id: PlayerId): { x: number; z: number } | null } = { at: () => null };

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
  /**
   * Present on a whisper: who the other end is, and which way it went. Whispers are shown
   * in the log like any line, marked, and never raise a bubble.
   */
  readonly whisper?: { readonly peerId: string; readonly peerName: string; readonly outgoing: boolean };
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
    notify(tr(next.includes(id) ? 'mute.on' : 'mute.off', { name }));
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

/**
 * The interactable within reach, if any. Drives the single contextual prompt. `label` is
 * already in the player's language at the moment it was found; components that want it to
 * follow a language change mid-prompt can re-derive it from `effect` and `kind`.
 */
export const interactPrompt: Writable<{
  id: string;
  label: string;
  effect: import('@nagisa/shared').InteractableEffect;
  kind: 'use' | 'sit';
} | null> = writable(null);

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


/**
 * Which optional panel is open. Only ever one, and `null` most of the time.
 *
 * - `board` — the notice board: announcements and the guestbook.
 * - `collection` — your stamp card, fish book and badges.
 * - `island` — which island you are on, private islands, invites.
 */
export type PanelId =
  | 'people'
  | 'activities'
  | 'settings'
  | 'host'
  | 'notes'
  | 'board'
  | 'collection'
  | 'island'
  | null;
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
// Server clock
// ---------------------------------------------------------------------------

let serverClock: () => number = () => Date.now();

/**
 * The server's clock, best estimate. Countdowns (the quiz, a janken deadline) run on it so
 * that everyone's "3, 2, 1" ends at the same moment whatever their own clock says.
 */
export function serverNow(): number {
  return serverClock();
}

/** Registered by the app once the connection exists. */
export function setServerClock(fn: () => number): void {
  serverClock = fn;
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

/** Your stamps, fish book and badges, as the server last told you. */
export const profile: Writable<ProfileView | null> = writable(null);

/** The ○× quiz in progress in this room, if any. */
export const quiz: Writable<QuizView | null> = writable(null);

/** Whether the quiz card is on screen (QuizHud says), so another card can make room under it. */
export const quizCardShown: Writable<boolean> = writable(false);

/** だるまさんがころんだ in progress in this room, if any. */
export const daruma: Writable<DarumaView | null> = writable(null);

/** The notice board's signatures, newest first. */
export const guestbook: Writable<GuestbookEntry[]> = writable([]);

/** Whether you are standing at a notice board — signing requires it. */
export const atBoard: Writable<boolean> = writable(false);

/** Your line in the water. */
export interface FishingState {
  phase: ServerFish['phase'];
  /** The spot you cast from, while the line is out. */
  spot: string | null;
  /** On `bite`: local `performance.now()` when the bite arrived, and how long you have. */
  biteAt: number;
  window: number;
  /** On `caught`. */
  caught: { fish: string; size: number; newSpecies: boolean; record: boolean; personalBest: boolean } | null;
  /** On `escaped`. */
  reason: ServerFish['reason'] | null;
}

export const fishing: Writable<FishingState> = writable({
  phase: 'idle',
  spot: null,
  biteAt: 0,
  window: 0,
  caught: null,
  reason: null,
});

/** The omikuji slip you just drew, while it is being shown. */
export const omikujiSlip: Writable<Omit<ServerOmikuji, 't'> | null> = writable(null);

/** Your friends and the asks waiting for you. `enabled` is false without a visitor key. */
export const friends: Writable<Omit<ServerFriends, 't'>> = writable({ friends: [], requests: [], enabled: false });

/** Friends standing on this island right now, by their player id here. */
export const friendsHere: Readable<Set<PlayerId>> = derived(
  [friends, players],
  ([$friends, $players]) => {
    const here = new Set($players.map((p) => p.id));
    return new Set($friends.friends.flatMap((f) => (f.player && here.has(f.player) ? [f.player] : [])));
  },
);

/** Whether the first-steps card is up (see WelcomeCard.svelte). */
export const welcomeOpen: Writable<boolean> = writable(false);

/** The island's weather right now (see `weather.ts` in the shared package). Written by the app. */
export const weather: Writable<Weather> = writable('clear');

/** Whether it is night on the island (the fish and the fireflies' night). Written by the app. */
export const islandNight: Writable<boolean> = writable(false);

/** The treasure hunt that is running, if one is. */
export const treasureHunt: Readable<ActivityView | null> = derived(
  activities,
  ($activities) => $activities.find((a) => a.feature === 'treasure' && a.state === ActivityState.Live) ?? null,
);

/** What your last dig turned up, and when (`performance.now()`), for the treasure card. */
export const lastDig: Writable<{ result: ServerDig['result']; at: number } | null> = writable(null);

/** The last check-in register the server sent this host or admin, for the host console. */
export const checkinList: Writable<Omit<ServerCheckinList, 't'> | null> = writable(null);

/** A janken duel you are in. */
export interface JankenState {
  duel: string;
  opponent: PlayerId;
  opponentName: string;
  /**
   * `invited` — they challenged you; answer. `waiting` — you challenged them; wait.
   * `choose` — throw before `deadline`. `result` — a round was decided. `cancelled` — over
   * without a result (`reason`).
   */
  phase: 'invited' | 'waiting' | 'choose' | 'result' | 'cancelled';
  /** Server epoch ms. */
  deadline: number;
  round: number;
  /** What you threw this round, once you have. */
  mine: Hand | null;
  theirs: Hand | null;
  /** In `result`: the winner, or null for a tie. */
  winner: PlayerId | null;
  final: boolean;
  reason: 'declined' | 'timeout' | 'left' | 'busy' | 'far' | null;
  /** On `cancelled`: we were the one who ended it (declined the invitation). */
  byMe: boolean;
}

export const janken: Writable<JankenState | null> = writable(null);

/** The player whose card is open, if any. */
export const selectedPlayer: Writable<PlayerId | null> = writable(null);

/** The view being taken in at a lookout, while the camera is turned to it. */
export const vista: Writable<{ id: string } | null> = writable(null);

/** Whether the zone you are standing in is a shore fireworks may go up from. */
export const onFireworkShore: Readable<boolean> = derived(self, ($self) =>
  Boolean(FIREWORKS?.zones.includes($self.zone)),
);

/** Standing where a concert is on: the dance button is offered. */
export const onDanceFloor: Readable<boolean> = derived([self, activities], ([$self, $activities]) =>
  $activities.some((a) => a.feature === 'concert' && a.state === ActivityState.Live && a.zone === $self.zone),
);

/** Whether you are dancing (written by the app from the character, which stops when you walk off). */
export const dancing: Writable<boolean> = writable(false);

/** The badge you are wearing, straight from the profile. */
export const myTitle: Readable<BadgeId | null> = derived(profile, ($p) => $p?.title ?? null);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
//
// Lives in its own module so the language layer (`i18n/`) can read it without importing
// this file, which imports the language layer in turn.

export { settings, type Settings, type Lang } from './settings.js';

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

  // --- v2 ---------------------------------------------------------------------------------
  /** Whisper to one player. */
  whisper(id: PlayerId, text: string): void;
  /** Roll a die; everyone sees it. */
  roll(sides?: number): void;
  /** Strike when the float goes under. */
  fishHook(): void;
  /** Reel in. */
  fishStop(): void;
  /** Janken. */
  jankenChallenge(id: PlayerId): void;
  jankenRespond(duel: string, accept: boolean): void;
  jankenThrow(duel: string, hand: Hand): void;
  /** Send a firework up from the shore you are on. */
  firework(): void;
  /** Sign / unsign the notice board. */
  guestbookWrite(text: string): void;
  guestbookRemove(id: string): void;
  /** Wear a badge, or none. */
  setTitle(badge: BadgeId | null): void;
  /** Make a private island and go there. */
  createIsland(): void;
  /** Go to an island by room id or invite code. */
  joinIsland(idOrCode: string): void;
  /** Admin: put a template on the programme `inMin` minutes from now. */
  schedule(template: string, inMin: number): void;
  /** Admin: moderation. */
  admin(action: 'kick' | 'mute' | 'unmute' | 'grant_host' | 'revoke_host', target: PlayerId, activity?: ActivityId): void;
  /** Leave a lookout view early. */
  endVista(): void;
  /** Save a picture of the island as it is on screen, without the interface. */
  takePhoto(): void;
  /** After the connection closed for good: take the island back from another tab, or reload. */
  reconnect(): void;
  /** Dig where you stand, during a treasure hunt. */
  dig(): void;
  /** Dance on the spot at the concert, or stop. */
  dance(on: boolean): void;
  /** Ask a player here to be friends; accept, decline or end one by its id. */
  friend(action: 'request' | 'accept' | 'decline' | 'remove', target: string): void;
  /** Host or admin: ask for who has checked in to an activity. */
  checkinList(activity: ActivityId): void;
  /** Keeper: name the private island you are on; empty takes the name away. */
  nameIsland(title: string): void;
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
  whisper: noop,
  roll: noop,
  fishHook: noop,
  fishStop: noop,
  jankenChallenge: noop,
  jankenRespond: noop,
  jankenThrow: noop,
  firework: noop,
  guestbookWrite: noop,
  guestbookRemove: noop,
  setTitle: noop,
  createIsland: noop,
  joinIsland: noop,
  schedule: noop,
  admin: noop,
  endVista: noop,
  takePhoto: noop,
  reconnect: noop,
  dig: noop,
  friend: noop,
  dance: noop,
  checkinList: noop,
  nameIsland: noop,
});

/** Convenience for components: `cmd().joinActivity(...)`. */
export function cmd(): WorldCommands {
  return get(commands);
}
