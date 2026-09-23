/**
 * Room — one island: the players on it, its activities, its games, its notice board, and the
 * fixed-rate tick that keeps everyone's view of it current.
 * =====================================================================================
 *
 * This is the busiest file in the server. Everything else exists to feed it (handlers
 * validate and translate client intent into calls on a `Room`) or to be fed by it (metrics,
 * persistence, audit). The tick loop is the one piece of real-time machinery in the whole
 * system; the rest of the server is comparatively simple request handling.
 *
 * A room is either a **public** shard (what matchmaking fills) or a **private** island (made
 * by somebody, reached by its code, kept by its maker — see `rooms.ts`). The two behave the
 * same in every way but who may find them and who is admin there.
 *
 * ## The tick loop, in one paragraph
 *
 * Every 1000/`PROTOCOL.TICK_HZ` ms: advance the activity lifecycle and keep the day's
 * programme on the board, advance the games (bites, duels, the quiz, the fireworks show),
 * expire stale announcements, gather whatever changed into one `ServerDelta`, append it to a
 * ring buffer of recent deltas (for replay-on-reconnect), and broadcast it. A delta that
 * carries nothing but player movement is droppable under backpressure (see `session.ts`),
 * because the next one 100 ms later repairs it; anything else — a join, an activity going
 * live, an announcement, a world event — is never dropped.
 *
 * ## The roster and why it is stable
 *
 * `PackedTransforms.ids` is only sent when room membership changes; every other tick reuses
 * the client's already-held roster. To make that safe, `Room` keeps its own
 * `rosterIds`/`rosterIndex` (not derived from `players.keys()` on the fly — Map iteration
 * order is a coincidence of implementation, not a contract we want to depend on for wire
 * compatibility). A join appends to the end; a leave splices the entry out and reindexes the
 * tail. Either operation sets `rosterDirty`, which guarantees the very next delta re-sends
 * the full roster before any index into it is trusted.
 *
 * ## Games
 *
 * The games live in `games/` and see the room only through the {@link GameRoom} interface,
 * which this class implements. The room owns one of each and tells them about the things
 * only it knows: a player moving, leaving or dropping, an activity starting or ending.
 */

import { randomUUID } from 'node:crypto';
import {
  type DailyKind,
  ActivityState,
  DARUMA_COURSE,
  ErrorCode,
  PROTOCOL,
  Role,
  ZONES,
  encode,
  getInteractable,
  interactablePosition,
  packTransform,
  type ActivityId,
  type ActivityView,
  type AnnouncementView,
  type BadgeId,
  type DarumaView,
  type Emote,
  type PackedTransforms,
  type PlayerId,
  type PlayerView,
  type QuizView,
  type RoomId,
  type RoomView,
  type ServerDelta,
  type ServerMessage,
  type ServerSnapshot,
  type Vec3,
  type WorldEvent,
  type ZoneId,
} from '@nagisa/shared';
import { Activity, ActivityManager } from './activity.js';
import type { Player } from './player.js';
import type { Session } from './session.js';
import type { Logger } from './logger.js';
import { metrics } from './metrics.js';
import type { PersistedActivity, PersistedRoom } from './persistence.js';
import { materialiseProgramme } from './schedule.js';
import type { GameRoom } from './games/context.js';
import { Fishing } from './games/fishing.js';
import { Janken } from './games/janken.js';
import { QuizRunner } from './games/quiz.js';
import { DarumaRunner } from './games/daruma.js';
import { Fireworks } from './games/fireworks.js';
import { TreasureHunt } from './games/treasure.js';
import { recordDaily } from './games/daily.js';
import { Interactions } from './games/interactions.js';
import { Guestbook } from './games/guestbook.js';
import { profileView } from './games/profiles.js';

/**
 * All ZoneIds, used to seed a full (all-zeros) zone population record.
 *
 * Read from `ZONES` on each call rather than captured once. `ZONES` is a live binding over
 * the active map pack, and the map is chosen at boot from `NAGISA_MAP` — snapshotting it at
 * module scope would bind whichever map happened to be active when this file was first
 * imported, which depends on module evaluation order rather than on configuration.
 */
function allZoneIds(): readonly ZoneId[] {
  return ZONES.map((z) => z.id);
}

/**
 * A delta is "quiet" — and therefore safe to drop under backpressure, see `session.ts` —
 * when it contains nothing but the tick number and player movement. Anything else is a
 * one-shot fact with no repairing successor frame.
 */
function isQuietDelta(d: ServerDelta): boolean {
  return (
    !d.join &&
    !d.leave &&
    !d.players &&
    !d.activities &&
    !d.activitiesRemoved &&
    !d.announcements &&
    !d.emotes &&
    !d.chats &&
    !d.zonePopulation &&
    !d.events &&
    !d.guestbook &&
    !d.guestbookRemoved &&
    d.quiz === undefined &&
    d.daruma === undefined
  );
}

function zonePopulationEqual(a: Record<ZoneId, number>, b: Record<ZoneId, number>): boolean {
  for (const id of allZoneIds()) if (a[id] !== b[id]) return false;
  return true;
}

/** How often the programme is re-checked for slots entering the horizon. */
const SCHEDULE_EVERY_MS = 1000;

/** How far a seated player may shift before the seat is theirs no longer, metres. */
const SEAT_SLIP_M = 1.5;

/** Who keeps a private island. */
export interface RoomOwner {
  /** Hash of the keeper's visitor key, if they had one. */
  hash: string | null;
  name: string | null;
  /** The keeper's player id this session — a keeper without a key keeps it only while here. */
  playerId: PlayerId | null;
}

export interface RoomOptions {
  kind?: 'public' | 'private';
  /** The invite code, for private islands. */
  code?: string;
  owner?: RoomOwner;
  /** The name its keeper gave a private island, if any. */
  title?: string | null;
  /** Ask for a save soon. Defaults to a no-op (tests). */
  persist?: () => void;
  /** Randomness for the games. Defaults to `Math.random`. */
  random?: () => number;
  /** Keep the day's programme on the board. Tests switch it off to control the schedule. */
  schedule?: boolean;
  /**
   * Told whenever the population changes. The room does not publish its own population
   * metric: a private island's id carries its invite code, and a metric label is public.
   */
  onPopulation?: () => void;
  /**
   * Told when a keyed player's profile changed, so every player sharing that visitor key —
   * in any room — is sent it. Without one, only the player themself is.
   */
  onProfile?: (player: Player) => void;
  /** Told when a player arrives in (`true`) or is removed from (`false`) this room. */
  onPresence?: (player: Player, present: boolean) => void;
}

export class Room implements GameRoom {
  readonly id: RoomId;
  readonly name: string;
  readonly capacity: number;
  readonly kind: 'public' | 'private';
  readonly code: string | null;
  owner: RoomOwner | null;
  /** The name its keeper gave a private island. Kept in the island registry, not here. */
  title: string | null;
  readonly activities = new ActivityManager();

  // --- games -------------------------------------------------------------------------------
  readonly fishing: Fishing;
  readonly janken: Janken;
  readonly fireworks: Fireworks;
  readonly treasure: TreasureHunt;
  readonly interactions: Interactions;
  readonly guestbook: Guestbook;
  private quiz: QuizRunner | null = null;
  private daruma: DarumaRunner | null = null;

  private readonly players = new Map<PlayerId, Player>();
  private readonly sessions = new Map<PlayerId, Session>();
  private readonly graceTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();

  /** Who holds each seat (a `sit` interactable), by interactable id. */
  private readonly seats = new Map<string, PlayerId>();

  private tick = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastScheduleAt = -Infinity;

  /** Epoch ms since which the room has been empty, or null while anyone is in it. */
  emptySince: number | null = Date.now();

  /** Ring buffer of recent deltas, newest last, capped at `PROTOCOL.DELTA_HISTORY_TICKS`. */
  private readonly history: ServerDelta[] = [];

  private rosterIds: PlayerId[] = [];
  private rosterIndex = new Map<PlayerId, number>();
  /** True when `rosterIds` changed since the last delta — forces the next delta to resend it. */
  private rosterDirty = false;

  private announcements: AnnouncementView[] = [];
  private lastZonePopulation: Record<ZoneId, number> | null = null;
  private quizView: QuizView | null = null;
  private darumaView: DarumaView | null = null;

  // --- per-tick accumulators, cleared after every broadcast --------------------------
  private pendingJoins: PlayerView[] = [];
  private pendingLeaves: PlayerId[] = [];
  private pendingPlayerChanges = new Map<PlayerId, Partial<PlayerView> & { id: PlayerId }>();
  private pendingActivityChanges = new Map<ActivityId, ActivityView>();
  private pendingActivitiesRemoved: ActivityId[] = [];
  private pendingAnnouncements: AnnouncementView[] = [];
  private pendingEmotes: Array<{ id: PlayerId; emote: Emote }> = [];
  private pendingChats: Array<{ id: PlayerId; text: string }> = [];
  private pendingEvents: WorldEvent[] = [];
  /** Set when the quiz view changed this tick; `value` may be null (the quiz is over). */
  private pendingQuiz: { value: QuizView | null } | null = null;
  /** The same, for だるまさんがころんだ. */
  private pendingDaruma: { value: DarumaView | null } | null = null;

  private readonly persistFn: () => void;
  private readonly onPopulation: () => void;
  private readonly onProfile: (player: Player) => void;
  private readonly onPresence: (player: Player, present: boolean) => void;
  private readonly randomFn: () => number;
  private readonly scheduleEnabled: boolean;

  constructor(
    id: RoomId,
    name: string,
    capacity: number,
    private readonly log: Logger,
    opts: RoomOptions = {},
  ) {
    this.id = id;
    this.name = name;
    this.capacity = capacity;
    this.kind = opts.kind ?? 'public';
    this.code = opts.code ?? null;
    this.owner = opts.owner ?? null;
    this.title = opts.title ?? null;
    this.persistFn = opts.persist ?? (() => {});
    this.onPopulation = opts.onPopulation ?? (() => {});
    this.onProfile = opts.onProfile ?? ((player) => this.sendProfile(player));
    this.onPresence = opts.onPresence ?? (() => {});
    this.randomFn = opts.random ?? Math.random;
    this.scheduleEnabled = opts.schedule ?? true;

    this.fishing = new Fishing(this);
    this.janken = new Janken(this);
    this.fireworks = new Fireworks(this);
    this.treasure = new TreasureHunt(this);
    this.interactions = new Interactions(this);
    this.guestbook = new Guestbook(this);

    // Any activity mutation (create, transition, join/leave, checkin, host change) funnels
    // through this one event, so callers of ActivityManager never need to remember to also
    // tell the room — the event is the single source of truth for "something about this
    // activity needs to reach clients."
    this.activities.on('changed', (activity) => {
      this.pendingActivityChanges.set(activity.id, activity.toView());
    });
    this.activities.on('transition', (activity, _from, to) => this.onTransition(activity, to));
    this.activities.on('removed', (id) => this.onActivityRemoved(id));
  }

  // ---------------------------------------------------------------------------------
  // Population / capacity / role
  // ---------------------------------------------------------------------------------

  /** Current occupancy, including players in their reconnect grace window (their spot is still theirs). */
  get population(): number {
    return this.players.size;
  }

  get hasCapacity(): boolean {
    return this.players.size < this.capacity;
  }

  toView(): RoomView {
    const view: RoomView = {
      id: this.id,
      name: this.name,
      population: this.population,
      capacity: this.capacity,
      kind: this.kind,
    };
    if (this.code) view.code = this.code;
    if (this.kind === 'private') view.ownerName = this.owner?.name ?? null;
    if (this.title) view.title = this.title;
    return view;
  }

  /** Rename the island and tell everyone on it. The registry is the caller's to update. */
  setTitle(title: string | null): void {
    this.title = title;
    const msg: ServerMessage = { t: 'room_info', room: this.toView() };
    for (const session of this.sessions.values()) session.send(msg);
  }

  /** Whether `player` keeps this island. */
  isKeeper(player: Player): boolean {
    if (this.kind !== 'private' || !this.owner) return false;
    if (this.owner.hash !== null && player.visitorHash === this.owner.hash) return true;
    return this.owner.playerId !== null && this.owner.playerId === player.id;
  }

  /**
   * The role `player` has in this room, from first principles: the server's admin token
   * anywhere; the keeper of a private island there; a host of one of this room's activities;
   * otherwise a guest. Recomputed whenever any of those inputs changes, so a role can never
   * leak from one room into another.
   */
  roleFor(player: Player): Role {
    if (player.globalAdmin || this.isKeeper(player)) return Role.Admin;
    if (player.hostOf && this.activities.get(player.hostOf)) return Role.Host;
    return Role.Guest;
  }

  getPlayer(id: PlayerId): Player | undefined {
    return this.players.get(id);
  }

  getSession(id: PlayerId): Session | undefined {
    return this.sessions.get(id);
  }

  allPlayers(): IterableIterator<Player> {
    return this.players.values();
  }

  // ---------------------------------------------------------------------------------
  // Join / leave / resume
  // ---------------------------------------------------------------------------------

  /** Add a brand-new (or re-homed) player and their live session to the room. */
  join(session: Session, player: Player): void {
    // Left and came back within one tick (a quick A→B→A): the leave must not go out, or every
    // client applies join-then-leave and deletes someone who is standing right here.
    this.pendingLeaves = this.pendingLeaves.filter((id) => id !== player.id);
    player.role = this.roleFor(player);
    this.players.set(player.id, player);
    this.sessions.set(player.id, session);
    this.rosterIds.push(player.id);
    this.rosterIndex.set(player.id, this.rosterIds.length - 1);
    this.rosterDirty = true;
    this.emptySince = null;
    // The keeper's name follows the keeper: a private island shows who made it.
    if (this.isKeeper(player) && this.owner) this.owner.name = player.name;
    this.pendingJoins.push(player.toView());
    this.onPopulation();
    this.onPresence(player, true);
    this.log.info('player_joined', { room: this.id, playerId: player.id, name: player.name });
  }

  /**
   * Reattach a live session to a player who is currently in their grace window
   * (`away === true`, no live session). Cancels the pending removal timer and clears
   * the away flag, broadcast as a `players` delta patch so everyone else's roster
   * un-greys them.
   */
  resume(session: Session, player: Player): void {
    this.sessions.set(player.id, session);
    this.cancelGraceTimer(player.id);
    // Move sequence numbers are per connection, and this is a new one: its first report is
    // seq 1. Keeping the old connection's high-water mark would silently drop every move the
    // new page sends until it had counted past it — a player frozen for as long as they had
    // been playing.
    player.lastMoveSeq = -1;
    player.lastMoveAt = Date.now();
    if (player.away) {
      player.away = false;
      this.markPlayerChanged(player.id, { away: false });
    }
    this.log.info('player_resumed', { room: this.id, playerId: player.id });
  }

  /**
   * Mark a player as disconnected without removing them yet. They keep their room slot,
   * their activity attachment, and their position for `PROTOCOL.SESSION_GRACE_MS` — long
   * enough to survive a subway tunnel or a screen lock without losing your place at an
   * activity. What cannot wait for them does not: their line is reeled in, a duel is called
   * off, their seat is freed. If no session reattaches within the grace window,
   * `removePlayer` runs.
   */
  disconnect(playerId: PlayerId, session?: Session): void {
    // A socket that was already replaced (a resume took over before the old one closed) is
    // not the player's connection any more; its late close changes nothing.
    if (session && this.sessions.get(playerId) !== session) return;
    this.sessions.delete(playerId);
    const player = this.players.get(playerId);
    if (!player) return;
    player.away = true;
    this.markPlayerChanged(playerId, { away: true });
    this.fishing.onLeave(playerId);
    this.janken.onLeave(playerId);
    this.releaseSeat(player);
    const timer = setTimeout(() => {
      this.removePlayer(playerId, 'grace_expired');
    }, PROTOCOL.SESSION_GRACE_MS);
    timer.unref?.();
    this.graceTimers.set(playerId, timer);
    this.log.info('player_disconnected', { room: this.id, playerId, graceMs: PROTOCOL.SESSION_GRACE_MS });
  }

  private cancelGraceTimer(playerId: PlayerId): void {
    const timer = this.graceTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(playerId);
    }
  }

  /**
   * Permanently remove a player from the room: detaches them from any activity and every
   * game, frees their seat, drops them from the roster, and queues a `leave` for the next
   * delta. Used for explicit kicks, grace-window expiry, and (with `closeSession: false`)
   * room switching, where the same live socket is about to be re-attached to a different
   * room and must not be torn down. Returns the removed `Player` record so a room switch
   * can re-insert the same record elsewhere without losing identity.
   */
  removePlayer(playerId: PlayerId, reason: string, opts: { closeSession?: boolean } = {}): Player | undefined {
    this.cancelGraceTimer(playerId);
    const player = this.players.get(playerId);
    if (!player) return undefined;

    if (player.activity) {
      const activity = this.activities.get(player.activity);
      activity?.leave(playerId);
      if (activity) this.activities.notifyChanged(activity);
    }
    // A host who leaves stops hosting: the activity falls back to the island's own schedule.
    if (player.hostOf) {
      const hosted = this.activities.get(player.hostOf);
      if (hosted && hosted.hostId === playerId) {
        hosted.setHost(null, null);
        this.activities.notifyChanged(hosted);
      }
    }
    this.fishing.onLeave(playerId);
    this.janken.onLeave(playerId);
    this.fireworks.onLeave(playerId);
    this.treasure.onLeave(playerId);
    this.interactions.onLeave(playerId);
    this.guestbook.onLeave(playerId);
    this.quiz?.onLeave(playerId);
    this.daruma?.onLeave(playerId);
    this.releaseSeat(player);

    this.players.delete(playerId);
    const session = this.sessions.get(playerId);
    if (opts.closeSession !== false) session?.close(1000, reason);
    this.sessions.delete(playerId);

    const idx = this.rosterIds.indexOf(playerId);
    if (idx >= 0) {
      this.rosterIds.splice(idx, 1);
      this.rosterIndex.delete(playerId);
      // Re-index the tail. This is an O(n) reshuffle of the id→index map, but it only
      // happens on membership change, which forces a full roster resend anyway — the
      // indices produced here are exactly the ones that resend will carry.
      for (let i = idx; i < this.rosterIds.length; i++) this.rosterIndex.set(this.rosterIds[i], i);
      this.rosterDirty = true;
    }

    // A player queued as joining in this same tick never needs announcing at all.
    this.pendingJoins = this.pendingJoins.filter((v) => v.id !== playerId);
    this.pendingPlayerChanges.delete(playerId);
    this.pendingLeaves.push(playerId);
    if (this.players.size === 0) this.emptySince = Date.now();
    this.onPopulation();
    this.onPresence(player, false);
    this.log.info('player_removed', { room: this.id, playerId, reason });
    return player;
  }

  // ---------------------------------------------------------------------------------
  // Movement hooks
  // ---------------------------------------------------------------------------------

  /** A player's accepted position changed. The games that care about where you stand hear it. */
  onMoved(player: Player): void {
    this.fishing.onMove(player);
    if (player.seat) {
      const seat = getInteractable(player.seat);
      const at = seat ? interactablePosition(seat) : null;
      if (!at || Math.hypot(player.pos[0] - at.x, player.pos[2] - at.z) > (seat?.range ?? 0) + SEAT_SLIP_M) {
        this.releaseSeat(player);
      }
    }
  }

  // ---------------------------------------------------------------------------------
  // Seats
  // ---------------------------------------------------------------------------------

  /**
   * Take a seat. One person per seat: a seat held by somebody else who is here is refused;
   * one held by somebody gone is simply taken. Taking a seat releases any other you held.
   */
  sit(player: Player, seatId: string): boolean {
    const holder = this.seats.get(seatId);
    if (holder && holder !== player.id) {
      const other = this.players.get(holder);
      if (other && !other.away && other.seat === seatId) {
        this.refuse(player.id, 'seat_taken');
        return false;
      }
    }
    if (player.seat && player.seat !== seatId) this.releaseSeat(player);
    this.seats.set(seatId, player.id);
    player.seat = seatId;
    return true;
  }

  releaseSeat(player: Player): void {
    if (!player.seat) return;
    if (this.seats.get(player.seat) === player.id) this.seats.delete(player.seat);
    player.seat = null;
  }

  // ---------------------------------------------------------------------------------
  // Player field changes (zone crossing, activity attach, role grant, away flag, ...)
  // ---------------------------------------------------------------------------------

  /**
   * Queue a non-transform field change (zone, activity/mode, role, away, title, check-in)
   * to go out in the `players` array of the next delta. Movement (`pos`/`yaw`/`anim`) never
   * goes through here — that is `PackedTransforms`' job, gathered separately every tick
   * from `player.dirty`.
   */
  markPlayerChanged(id: PlayerId, patch: Partial<PlayerView>): void {
    const existing = this.pendingPlayerChanges.get(id) ?? { id };
    this.pendingPlayerChanges.set(id, { ...existing, ...patch });
  }

  // ---------------------------------------------------------------------------------
  // Messages to players
  // ---------------------------------------------------------------------------------

  sendTo(id: PlayerId, msg: ServerMessage): void {
    this.sessions.get(id)?.send(msg);
  }

  refuse(id: PlayerId, key: string, params?: Record<string, string | number>, code: ErrorCode = ErrorCode.Forbidden): void {
    this.sendTo(id, { t: 'error', code, message: key, key, params });
  }

  pushProfile(player: Player): void {
    if (player.visitorHash) {
      // Other tabs presenting the same visitor key share this record; they hear about it too.
      this.onProfile(player);
      return;
    }
    this.sendProfile(player);
  }

  /** Send one player their profile, and let the room see the badge they now wear. */
  sendProfile(player: Player): void {
    this.sendTo(player.id, { t: 'profile', profile: profileView(player.profile, player.profilePersistent) });
    this.markPlayerChanged(player.id, { title: player.title });
  }

  celebrate(player: Player, badges: readonly BadgeId[]): void {
    for (const badge of badges) this.emitEvent({ k: 'badge', by: player.id, badge });
    // The first badge is worn automatically (see `awardBadge`); `pushProfile` shows it.
    this.pushProfile(player);
  }

  // ---------------------------------------------------------------------------------
  // Emotes / chat / events
  // ---------------------------------------------------------------------------------

  emote(id: PlayerId, emote: Emote): void {
    this.pendingEmotes.push({ id, emote });
  }

  chat(id: PlayerId, text: string): void {
    this.pendingChats.push({ id, text });
  }

  emitEvent(event: WorldEvent): void {
    this.pendingEvents.push(event);
  }

  setQuiz(view: QuizView | null): void {
    this.quizView = view;
    this.pendingQuiz = { value: view };
  }

  setDaruma(view: DarumaView | null): void {
    this.darumaView = view;
    this.pendingDaruma = { value: view };
  }

  relocate(player: Player, pos: Vec3, yaw: number): void {
    const zone = player.zone;
    this.sendTo(player.id, player.relocate(pos, yaw, Date.now()));
    // As if they had walked there: a line left behind is reeled in, a seat left is let go.
    this.onMoved(player);
    if (player.zone !== zone) this.markPlayerChanged(player.id, { zone: player.zone });
  }

  persist(): void {
    this.persistFn();
  }

  daily(player: Player, kind: DailyKind, zone?: string): void {
    recordDaily(this, player, kind, Date.now(), zone);
  }

  random(): number {
    return this.randomFn();
  }

  // ---------------------------------------------------------------------------------
  // Announcements
  // ---------------------------------------------------------------------------------

  /**
   * Publish an announcement. Delivery is unfiltered — every session in the room receives
   * every announcement's *existence*, exactly as every snapshot includes every active one.
   * `scope` governs who was *allowed to create* it (see `permissions.ts`) and whom the
   * client *interrupts* with a toast (only those it is addressed to — see `world-sync`);
   * the notice board shows everything, so a player who walks into a zone just after an
   * announcement still finds it there.
   */
  announce(input: Omit<AnnouncementView, 'id' | 'at'>): AnnouncementView {
    const full: AnnouncementView = { ...input, id: randomUUID(), at: Date.now() };
    this.announcements.push(full);
    this.pendingAnnouncements.push(full);
    return full;
  }

  announceSystem(text: string, scope: AnnouncementView['scope'], priority: AnnouncementView['priority'] = 'normal'): void {
    this.announce({ text, fromName: '渚 Nagisa', scope, ttlMs: 90_000, priority });
  }

  /**
   * Restore an announcement from persisted state verbatim (same id, same original `at`)
   * without treating it as newly-created — its TTL is measured from its original issue
   * time, not from the moment the server happened to reboot.
   */
  restoreAnnouncement(view: AnnouncementView): void {
    this.announcements.push(view);
  }

  private expireAnnouncements(nowMs: number): void {
    this.announcements = this.announcements.filter((a) => nowMs - a.at < a.ttlMs);
  }

  private activeAnnouncements(): AnnouncementView[] {
    return [...this.announcements].sort((a, b) => a.at - b.at);
  }

  // ---------------------------------------------------------------------------------
  // Activities and their features
  // ---------------------------------------------------------------------------------

  /** Whether a player is here and connected — the scheduler's "is the host present". */
  private present(id: PlayerId): boolean {
    const p = this.players.get(id);
    return !!p && !p.away;
  }

  /** Start and stop what an activity does while it runs. */
  private onTransition(activity: Activity, to: ActivityState): void {
    if (to === ActivityState.Live && activity.feature === 'quiz') {
      if (!this.quiz) {
        this.quiz = new QuizRunner(this, activity.id, Date.now());
      } else if (this.quiz.activity !== activity.id) {
        // There is one arena and a quiz is already in it: this one is called off rather than
        // shown as live with nothing happening. (Deferred a tick: we are inside a transition.)
        queueMicrotask(() => {
          if (activity.state === ActivityState.Live) this.activities.transition(activity, ActivityState.Ended);
        });
      }
    }
    // One set of spots, so one hunt at a time; a second is called off the same way.
    if (to === ActivityState.Live && activity.feature === 'treasure' && !this.treasure.start(activity)) {
      queueMicrotask(() => {
        if (activity.state === ActivityState.Live) this.activities.transition(activity, ActivityState.Ended);
      });
    }
    // One course, so one race at a time — and none on a map without a course.
    if (to === ActivityState.Live && activity.feature === 'daruma') {
      if (!this.daruma && DARUMA_COURSE) {
        this.daruma = new DarumaRunner(this, activity.id, Date.now());
      } else if (this.daruma?.activity !== activity.id) {
        queueMicrotask(() => {
          if (activity.state === ActivityState.Live) this.activities.transition(activity, ActivityState.Ended);
        });
      }
    }
    if (to === ActivityState.Ended || to === ActivityState.Cancelled) {
      if (this.quiz && this.quiz.activity === activity.id) {
        this.quiz.abort();
        this.quiz = null;
      }
      if (this.daruma && this.daruma.activity === activity.id) {
        this.daruma.abort();
        this.daruma = null;
      }
      if (activity.feature === 'treasure') this.treasure.finish(activity, to === ActivityState.Ended);
      if (activity.feature === 'derby' && to === ActivityState.Ended) this.fishing.finishDerby(activity);
    }
    this.persist();
  }

  /** An activity was cleared off the board: nobody is attached to it any more. */
  private onActivityRemoved(id: ActivityId): void {
    this.pendingActivitiesRemoved.push(id);
    this.pendingActivityChanges.delete(id);
    for (const p of this.players.values()) {
      if (p.activity === id) {
        p.activity = null;
        p.mode = null;
        p.checkedIn = false;
        this.markPlayerChanged(p.id, { activity: null, mode: null, checkedIn: false });
      }
      if (p.hostOf === id) {
        p.hostOf = null;
        const role = this.roleFor(p);
        if (role !== p.role) {
          p.role = role;
          this.markPlayerChanged(p.id, { role });
          this.sendTo(p.id, { t: 'role_changed', role });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------
  // Zone population
  // ---------------------------------------------------------------------------------

  private computeZonePopulation(): Record<ZoneId, number> {
    const counts = Object.fromEntries(allZoneIds().map((z) => [z, 0])) as Record<ZoneId, number>;
    for (const player of this.players.values()) {
      // Away players are disconnected — they still occupy a room slot (see `disconnect`)
      // but should not inflate "how many people are physically in this zone right now."
      if (player.zone && !player.away && player.zone in counts) counts[player.zone]++;
    }
    return counts;
  }

  // ---------------------------------------------------------------------------------
  // Snapshot / delta / replay
  // ---------------------------------------------------------------------------------

  /** The complete observable state of the room. Idempotent — a client may apply this any number of times. */
  buildSnapshot(): ServerSnapshot {
    return {
      t: 'snapshot',
      room: this.id,
      tick: this.tick,
      serverTime: Date.now(),
      players: [...this.players.values()].map((p) => p.toView()),
      activities: this.activities.list().map((a) => a.toView()),
      announcements: this.activeAnnouncements(),
      zonePopulation: this.computeZonePopulation(),
      guestbook: this.guestbook.view(),
      quiz: this.quizView,
      daruma: this.darumaView,
    };
  }

  /**
   * Deltas the caller should replay to catch up from `haveTick` to the present, or `null`
   * if the gap is too large for the retained history — in which case the caller must fall
   * back to a fresh `buildSnapshot()`.
   */
  getDeltasSince(haveTick: number): ServerDelta[] | null {
    if (haveTick >= this.tick) return [];
    if (this.history.length === 0) return null;
    const oldestTick = this.history[0].tick;
    if (haveTick < oldestTick - 1) return null; // gap predates our retained history
    return this.history.filter((d) => d.tick > haveTick);
  }

  private pushHistory(delta: ServerDelta): void {
    this.history.push(delta);
    if (this.history.length > PROTOCOL.DELTA_HISTORY_TICKS) this.history.shift();
  }

  /** Gather every moving player into one `PackedTransforms` frame, or `undefined` if nothing to send. */
  private gatherMoves(): PackedTransforms | undefined {
    const data: number[] = [];
    for (const player of this.players.values()) {
      if (!player.dirty) continue;
      const idx = this.rosterIndex.get(player.id);
      if (idx === undefined) continue; // Shouldn't happen — every player has a roster slot.
      data.push(...packTransform(idx, player.pos, player.yaw, player.anim));
      player.dirty = false;
    }
    const includeIds = this.rosterDirty;
    if (includeIds) this.rosterDirty = false;
    if (data.length === 0 && !includeIds) return undefined;
    const frame: PackedTransforms = { data };
    if (includeIds) frame.ids = [...this.rosterIds];
    return frame;
  }

  private buildDelta(): ServerDelta {
    const delta: ServerDelta = { t: 'delta', tick: this.tick };
    if (this.pendingJoins.length) delta.join = this.pendingJoins;
    if (this.pendingLeaves.length) delta.leave = this.pendingLeaves;
    if (this.pendingPlayerChanges.size) delta.players = [...this.pendingPlayerChanges.values()];
    if (this.pendingActivityChanges.size) delta.activities = [...this.pendingActivityChanges.values()];
    if (this.pendingActivitiesRemoved.length) delta.activitiesRemoved = this.pendingActivitiesRemoved;
    if (this.pendingAnnouncements.length) delta.announcements = this.pendingAnnouncements;
    if (this.pendingEmotes.length) delta.emotes = this.pendingEmotes;
    if (this.pendingChats.length) delta.chats = this.pendingChats;
    if (this.pendingEvents.length) delta.events = this.pendingEvents;
    if (this.pendingQuiz) delta.quiz = this.pendingQuiz.value;
    if (this.pendingDaruma) delta.daruma = this.pendingDaruma.value;

    const board = this.guestbook.drain();
    if (board.added.length) delta.guestbook = board.added;
    if (board.removed.length) delta.guestbookRemoved = board.removed;

    const zonePopulation = this.computeZonePopulation();
    if (!this.lastZonePopulation || !zonePopulationEqual(zonePopulation, this.lastZonePopulation)) {
      delta.zonePopulation = zonePopulation;
      this.lastZonePopulation = zonePopulation;
    }

    const moves = this.gatherMoves();
    if (moves) delta.moves = moves;

    return delta;
  }

  private clearPending(): void {
    this.pendingJoins = [];
    this.pendingLeaves = [];
    this.pendingPlayerChanges.clear();
    this.pendingActivityChanges.clear();
    this.pendingActivitiesRemoved = [];
    this.pendingAnnouncements = [];
    this.pendingEmotes = [];
    this.pendingChats = [];
    this.pendingEvents = [];
    this.pendingQuiz = null;
    this.pendingDaruma = null;
  }

  private broadcast(delta: ServerDelta): void {
    if (this.sessions.size === 0) return;
    const droppable = isQuietDelta(delta);
    const frame = encode(delta);
    for (const session of this.sessions.values()) {
      session.sendEncoded('delta', frame, { droppable });
    }
  }

  /** Advance everything that moves by itself: the schedule, the lifecycle, the games. */
  private advance(now: number): void {
    if (this.scheduleEnabled && now - this.lastScheduleAt >= SCHEDULE_EVERY_MS) {
      this.lastScheduleAt = now;
      materialiseProgramme(this.activities, now);
    }
    this.activities.sweep(now, (id) => this.present(id));
    this.fishing.tick(now);
    this.janken.tick(now);
    this.fireworks.tick(now);
    if (this.quiz) {
      this.quiz.tick(now);
      if (this.quiz.finished) {
        const activity = this.activities.get(this.quiz.activity);
        this.quiz = null;
        // The quiz has run its course: the activity is over, whatever the clock says.
        if (activity && activity.state === ActivityState.Live) this.activities.transition(activity, ActivityState.Ended, now);
      }
    }
    if (this.daruma) {
      this.daruma.tick(now);
      if (this.daruma.finished) {
        const activity = this.activities.get(this.daruma.activity);
        this.daruma = null;
        // The same for a race that is over.
        if (activity && activity.state === ActivityState.Live) this.activities.transition(activity, ActivityState.Ended, now);
      }
    }
    this.expireAnnouncements(now);
  }

  /** Epoch ms of the last tick, for the liveness check. */
  private lastTickAt = Date.now();

  /**
   * Whether this room's loop has stopped ticking while it is supposed to be running — the
   * one failure a liveness probe exists to catch, since the process itself stays up.
   */
  isStalled(now = Date.now(), graceMs = 5000): boolean {
    return this.tickTimer !== null && now - this.lastTickAt > graceMs;
  }

  /** Run one tick: advance, gather changes, broadcast, record history. Never throws. */
  private runTick(): void {
    const startedAt = performance.now();
    this.lastTickAt = Date.now();
    this.tick++;
    try {
      // A bug in one game must not cost the tick what everyone else did in it — the joins,
      // the leaves, the chat. It is logged, and the tick goes out with what was gathered.
      try {
        this.advance(Date.now());
      } catch (err) {
        this.tickFailed(err);
      }
      let recorded = false;
      try {
        const delta = this.buildDelta();
        this.pushHistory(delta);
        recorded = true;
        this.broadcast(delta);
      } catch (err) {
        this.tickFailed(err);
        // The tick number is spent either way. A client that sees a gap asks to be replayed
        // from the history, which would not have this tick — and then drops every later delta
        // as out of order until the history rolls past it, a frozen room for twelve seconds.
        // An empty delta keeps the sequence whole.
        if (!recorded) {
          const empty: ServerDelta = { t: 'delta', tick: this.tick };
          this.pushHistory(empty);
          try {
            this.broadcast(empty);
            // What this tick would have said — someone arriving, someone leaving — is lost,
            // and with the sequence whole nobody would ask for it again: everyone is given
            // the room as it now stands instead. Snapshots are idempotent by construction.
            const snapshot = this.buildSnapshot();
            for (const session of this.sessions.values()) session.send(snapshot);
          } catch {
            /* Whoever missed it asks for a replay, which now has it. */
          }
        }
      }
    } finally {
      // The next tick gets a clean slate whatever happened in this one.
      this.clearPending();
      metrics.tickDurationMs.observe(performance.now() - startedAt);
    }
  }

  private tickFailed(err: unknown): void {
    this.log.error('room_tick_error', { room: this.id, err });
    metrics.errorsTotal.inc({ kind: 'room_tick' });
  }

  /**
   * Run exactly one tick synchronously, right now, bypassing the interval timer. Production
   * code never calls this — `start()` drives the real cadence. It exists so tests can advance
   * room state deterministically without sleeping for real wall-clock ticks.
   */
  forceTick(): void {
    this.runTick();
  }

  /**
   * Bring the board up to date right now — the day's programme on it, every due lifecycle
   * step taken — without broadcasting. Called when a room wakes, so the very first visitor's
   * snapshot already shows what is on rather than an empty board until the first tick.
   */
  prime(now = Date.now()): void {
    if (this.scheduleEnabled) {
      this.lastScheduleAt = now;
      materialiseProgramme(this.activities, now);
    }
    this.activities.sweep(now, (id) => this.present(id));
  }

  /** Start the fixed-rate tick loop. Idempotent. */
  start(): void {
    if (this.tickTimer) return;
    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => this.runTick(), 1000 / PROTOCOL.TICK_HZ);
    this.tickTimer.unref?.();
  }

  /** Stop the tick loop and cancel every pending grace timer. Used on room teardown / process shutdown. */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
  }

  /** Every live session in the room, for cross-cutting operations like shutdown broadcast. */
  allSessions(): IterableIterator<Session> {
    return this.sessions.values();
  }

  /** Every seat's holder, for tests and diagnostics. */
  seatHolder(seatId: string): PlayerId | undefined {
    return this.seats.get(seatId);
  }

  // ---------------------------------------------------------------------------------
  // Persistence interop (see persistence.ts) — pure data projection, no I/O here.
  // ---------------------------------------------------------------------------------

  /** Everything about this room worth keeping across a restart. */
  exportState(): PersistedRoom {
    return {
      activities: this.activities.list().map((a) => exportActivity(a)),
      announcements: this.activeAnnouncements(),
      guestbook: this.guestbook.export(),
      savedAt: Date.now(),
    };
  }

  /** Restore what `exportState` produced. Call before `start()`. */
  restoreState(state: PersistedRoom): void {
    for (const pa of state.activities) {
      // One damaged record (a file edited by hand, a field of the wrong shape) costs that
      // record, never the room: a throw here would leave an island that can never be opened.
      let activity: Activity | null = null;
      try {
        activity = restoreActivity(pa);
      } catch (err) {
        this.log.warn('activity_restore_skipped', { room: this.id, err });
      }
      if (!activity) continue;
      // A quiz is its runner, and the runner did not survive the restart: a quiz restored as
      // live would sit on the board doing nothing (and block a new one). It is over. So is a
      // treasure hunt, whose spots were never written down, and a race, which was its runner too.
      if ((activity.feature === 'quiz' || activity.feature === 'treasure' || activity.feature === 'daruma') && activity.state === ActivityState.Live) {
        activity.state = ActivityState.Ended;
        activity.closedAt = Date.now();
      }
      this.activities.add(activity);
    }
    for (const ann of state.announcements) {
      // Every tick sorts and expires these; one without a time or a text would throw there.
      if (!ann || typeof ann !== 'object' || typeof ann.text !== 'string' || !Number.isFinite(ann.at) || !Number.isFinite(ann.ttlMs)) continue;
      this.restoreAnnouncement(ann);
    }
    this.guestbook.restore(state.guestbook);
  }
}

/** Project an activity into the shape `Store` persists. */
function exportActivity(a: Activity): PersistedActivity {
  return {
    id: a.id,
    templateId: a.templateId,
    title: a.title,
    blurb: a.blurb,
    zone: a.zone,
    state: a.state,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    hostId: a.hostId,
    hostName: a.hostName,
    capacity: a.capacity,
    checkinEnabled: a.checkinEnabled,
    participants: [...a.participants],
    audience: [...a.audience],
    checkins: a.checkinRecords(),
    slot: a.slot,
    closedAt: a.closedAt,
  };
}

/**
 * Reconstruct an activity from persisted state, bypassing lifecycle checks (this is a
 * restore, not a live transition). Rosters are *not* restored: the players they name were in
 * a process that no longer exists, and a roster of ghosts would hold capacity nobody can use.
 * Check-in records are kept — they are history, not presence. A host is dropped for the same
 * reason; the island's own schedule takes over.
 */
function restoreActivity(pa: PersistedActivity): Activity | null {
  if (!pa || typeof pa.id !== 'string' || typeof pa.templateId !== 'string') return null;
  const activity = new Activity({
    id: pa.id,
    templateId: pa.templateId,
    title: pa.title,
    blurb: pa.blurb,
    zone: pa.zone,
    startsAt: pa.startsAt,
    endsAt: pa.endsAt,
    capacity: pa.capacity,
    checkinEnabled: pa.checkinEnabled,
    slot: pa.slot ?? null,
  });
  activity.state = pa.state;
  activity.closedAt = pa.closedAt ?? null;
  activity.restoreCheckins(pa.checkins ?? []);
  return activity;
}
