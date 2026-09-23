/**
 * Friends.
 * ========
 *
 * The island's answer to "is anyone I know on?" — a short list of people you have met here,
 * whether they are on right now, which island they are on, and a way to go there.
 *
 * ### What a friendship is
 *
 * A pair of visitor keys, recorded on both profiles (see `ProfileRecord.friends`). It takes
 * both: one asks, from the player card, while the two are on the same island; the other
 * accepts, whenever they like while the ask stands. Asking someone who has already asked you
 * is accepting. Either may end it, and it ends for both. A visitor with no key has no profile
 * to keep one on, so can do neither — the interface says so rather than failing quietly.
 *
 * Because a friend sees where you are, *including the code of a private island*, a friendship
 * is exactly as much consent as an invite link: someone you accepted may come and find you.
 * That is the point of it.
 *
 * ### Presence
 *
 * Rooms report every player arriving and leaving ({@link Friends.presenceChanged}); this
 * keeps an index of who is on, by key, and re-sends the list to anyone whose friend came,
 * went or moved. Moving island is a leave and a join in one breath, so the re-sends are
 * gathered and go out once the current task is done — a friend changing islands is seen
 * as moving, never as leaving and coming back.
 *
 * Requests live in memory only, for ten minutes: an ask nobody answers is not worth keeping
 * across a restart.
 */

import { createHash } from 'node:crypto';
import {
  FRIEND_LIMIT,
  type FriendRequestView,
  type FriendView,
  type PlayerId,
  type ServerFriends,
} from '@nagisa/shared';
import type { Player } from './player.js';
import type { Room } from './room.js';
import type { ProfileStore } from './games/profiles.js';
import type { ProfileRecord } from './persistence.js';

/** An unanswered ask is forgotten after this long, ms. */
export const FRIEND_REQUEST_TTL_MS = 10 * 60_000;
/** One ask per person this often, ms. */
export const FRIEND_REQUEST_COOLDOWN_MS = 3_000;
/** Asks one visitor may have waiting; past it the oldest goes. */
export const FRIEND_ASKS_LIMIT = 20;
/** How often every standing ask is checked for expiry, ms. */
const ASK_SWEEP_MS = 60_000;

/** What the friends list needs from the rest of the server. */
export interface FriendsHost {
  /** The room a player is in, if any. */
  roomOf(id: PlayerId): Room | undefined;
  /** Every visitor's record, for friends who are not on right now. */
  readonly profiles: ProfileStore;
  persist(): void;
}

/**
 * The id a friend is known by on the wire. Derived from their key's hash so it is stable,
 * and hashed again so the list never hands anyone a hash that identifies a visitor elsewhere.
 */
export function friendId(hash: string): string {
  return createHash('sha256').update(`nagisa-friend:${hash}`).digest('hex').slice(0, 16);
}

interface Ask {
  name: string;
  at: number;
}

export class Friends {
  /** Who is on, by visitor hash. Usually one player; more with the same key in two tabs. */
  private readonly online = new Map<string, Set<Player>>();
  /** Standing asks, by the hash asked, then by the hash asking. */
  private readonly asks = new Map<string, Map<string, Ask>>();
  private readonly lastAsk = new Map<PlayerId, number>();
  /**
   * Asks turned down, by the hash asked, then by the hash asking, for as long as an ask
   * would have stood: asking again straight after a no is not a question, it is pestering.
   */
  private readonly declined = new Map<string, Map<string, number>>();
  private lastSweep = 0;
  /** Hashes whose lists must be re-sent when the current task is done. */
  private readonly dirty = new Set<string>();
  private flushQueued = false;

  constructor(private readonly host: FriendsHost) {}

  /** A room gained or lost a player. */
  presenceChanged(player: Player, present: boolean): void {
    const hash = player.visitorHash;
    if (!hash) return;
    let here = this.online.get(hash);
    if (present) {
      if (!here) this.online.set(hash, (here = new Set()));
      here.add(player);
      // Their friends' lists keep the name they are going by now.
      for (const f of player.profile.friends) {
        const entry = this.record(f.hash)?.friends.find((x) => x.hash === hash);
        if (entry) entry.name = player.name;
      }
    } else if (here) {
      here.delete(player);
      if (here.size === 0) this.online.delete(hash);
      this.lastAsk.delete(player.id);
    }
    // Arriving, leaving and moving island are the changes every friend's list shows.
    this.touch(hash, true);
  }

  /** The list as `player` should see it. */
  viewFor(player: Player, now = Date.now()): ServerFriends {
    const hash = player.visitorHash;
    if (!hash) return { t: 'friends', friends: [], requests: [], enabled: false };
    const friends: FriendView[] = player.profile.friends.map((f) => {
      // Where someone is, only while they still count you as a friend. A record the store
      // evicted comes back empty, and its owner — who no longer has you, and cannot remove
      // you — must not be seen, private island code and all, by a list only you still keep.
      const on = this.onlinePlayer(f.hash);
      const mutual = !!on && on.profile.friends.some((x) => x.hash === hash);
      const room = on && mutual ? this.host.roomOf(on.id) : undefined;
      const view: FriendView = { id: friendId(f.hash), name: on?.name ?? f.name, online: !!room };
      if (on && room) {
        view.player = on.id;
        view.room = { id: room.id, name: room.name, kind: room.kind, ...(room.code ? { code: room.code } : {}), ...(room.title ? { title: room.title } : {}) };
      }
      return view;
    });
    friends.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    const requests: FriendRequestView[] = [];
    for (const [from, ask] of this.standingAsks(hash, now)) {
      const on = this.onlinePlayer(from);
      requests.push({ id: friendId(from), name: on?.name ?? ask.name, ...(on ? { player: on.id } : {}) });
    }
    return { t: 'friends', friends, requests, enabled: true };
  }

  /** Send a player their list now (a welcome, say). */
  sendTo(player: Player): void {
    this.host.roomOf(player.id)?.sendTo(player.id, this.viewFor(player));
  }

  /** A `friend` message. Refusals are the room's usual `error` with a key. */
  handle(player: Player, action: unknown, target: unknown, now = Date.now()): void {
    const room = this.host.roomOf(player.id);
    if (!room) return;
    const me = player.visitorHash;
    if (!me) {
      room.refuse(player.id, 'friend_needs_key');
      return;
    }
    if (typeof target !== 'string') {
      room.refuse(player.id, 'invalid');
      return;
    }

    this.sweep(now);
    switch (action) {
      case 'request': {
        if (player.muted) {
          room.refuse(player.id, 'muted');
          return;
        }
        const other = room.getPlayer(target);
        // Someone standing here — not yourself, and not yourself in another tab.
        if (!other || other.visitorHash === me) {
          room.refuse(player.id, 'not_found');
          return;
        }
        if (!other.visitorHash) {
          room.refuse(player.id, 'friend_unavailable', { name: other.name });
          return;
        }
        const them = other.visitorHash;
        if (player.profile.friends.some((f) => f.hash === them)) {
          room.refuse(player.id, 'already_friends', { name: other.name });
          return;
        }
        const last = this.lastAsk.get(player.id) ?? -Infinity;
        if (now - last < FRIEND_REQUEST_COOLDOWN_MS) {
          room.refuse(player.id, 'cooldown', { seconds: Math.ceil((FRIEND_REQUEST_COOLDOWN_MS - (now - last)) / 1000) });
          return;
        }
        this.lastAsk.set(player.id, now);
        // They asked first: asking back is saying yes.
        if (this.standingAsks(me, now).has(them)) {
          this.befriend(player, me, them, other.name, now);
          return;
        }
        // Turned down a moment ago: dropped without a word, so the no stands.
        const no = this.declined.get(them)?.get(me);
        if (no !== undefined && now - no < FRIEND_REQUEST_TTL_MS) return;
        const asked = this.standingAsks(them, now);
        if (asked.size === 0) this.asks.set(them, asked);
        asked.delete(me);
        asked.set(me, { name: player.name, at: now });
        // A Map keeps insertion order, so the first key is the oldest ask.
        while (asked.size > FRIEND_ASKS_LIMIT) asked.delete(asked.keys().next().value!);
        this.touch(them);
        return;
      }
      case 'accept':
      case 'decline': {
        const standing = this.standingAsks(me, now);
        const from = [...standing.keys()].find((h) => friendId(h) === target);
        if (!from) {
          room.refuse(player.id, 'not_found');
          // Most likely it expired while still shown: send the list that no longer has it.
          this.touch(me);
          return;
        }
        if (action === 'decline') {
          standing.delete(from);
          let noes = this.declined.get(me);
          if (!noes) this.declined.set(me, (noes = new Map()));
          noes.set(from, now);
          this.touch(me);
          return;
        }
        this.befriend(player, me, from, standing.get(from)!.name, now);
        return;
      }
      case 'remove': {
        const entry = player.profile.friends.find((f) => friendId(f.hash) === target);
        if (!entry) {
          room.refuse(player.id, 'not_found');
          return;
        }
        this.unfriend(me, entry.hash);
        return;
      }
      default:
        room.refuse(player.id, 'invalid');
    }
  }

  // ---------------------------------------------------------------------------------------

  private befriend(player: Player, me: string, them: string, theirName: string, now: number): void {
    const mine = player.profile;
    const theirs = this.record(them) ?? this.host.profiles.forVisitor(them, now);
    if (mine.friends.length >= FRIEND_LIMIT || theirs.friends.length >= FRIEND_LIMIT) {
      this.host.roomOf(player.id)?.refuse(player.id, 'friends_full', { max: FRIEND_LIMIT });
      return;
    }
    if (!mine.friends.some((f) => f.hash === them)) mine.friends.push({ hash: them, name: theirName, since: now });
    if (!theirs.friends.some((f) => f.hash === me)) theirs.friends.push({ hash: me, name: player.name, since: now });
    this.asks.get(me)?.delete(them);
    this.asks.get(them)?.delete(me);
    this.host.persist();
    this.touch(me);
    this.touch(them);
  }

  private unfriend(a: string, b: string): void {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const rec = this.record(x);
      if (rec) rec.friends = rec.friends.filter((f) => f.hash !== y);
    }
    this.host.persist();
    // Each by name: neither is on the other's list any more, so neither would be reached
    // through it.
    this.touch(a);
    this.touch(b);
  }

  /** Forget expired asks and noes everywhere, at most once a minute. */
  private sweep(now: number): void {
    if (now - this.lastSweep < ASK_SWEEP_MS) return;
    this.lastSweep = now;
    for (const hash of [...this.asks.keys()]) this.standingAsks(hash, now);
    for (const [hash, noes] of this.declined) {
      for (const [from, at] of noes) if (now - at >= FRIEND_REQUEST_TTL_MS) noes.delete(from);
      if (noes.size === 0) this.declined.delete(hash);
    }
  }

  /** The asks standing for `hash`, expired ones dropped. */
  private standingAsks(hash: string, now: number): Map<string, Ask> {
    const asked = this.asks.get(hash) ?? new Map<string, Ask>();
    for (const [from, ask] of asked) if (now - ask.at > FRIEND_REQUEST_TTL_MS) asked.delete(from);
    if (asked.size === 0) this.asks.delete(hash);
    return asked;
  }

  /** A visitor's record: from whoever is on with it (the same object the store holds), else the store's. */
  private record(hash: string): ProfileRecord | undefined {
    return this.onlinePlayer(hash)?.profile ?? this.host.profiles.peek(hash);
  }

  private onlinePlayer(hash: string): Player | undefined {
    const here = this.online.get(hash);
    return here ? here.values().next().value : undefined;
  }

  /**
   * `hash`'s own list changed: send it again, shortly. `andFriends` when `hash` itself came,
   * went or moved, which changes every list it is on too. An ask or an answer changes only
   * the lists of those it is between — sending every friend's list for one would let a
   * stream of junk answers fan out fifty-fold.
   */
  private touch(hash: string, andFriends = false): void {
    this.dirty.add(hash);
    if (andFriends) for (const f of this.record(hash)?.friends ?? []) this.dirty.add(f.hash);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushQueued = false;
    const hashes = [...this.dirty];
    this.dirty.clear();
    for (const hash of hashes) {
      for (const player of this.online.get(hash) ?? []) this.sendTo(player);
    }
  }
}
