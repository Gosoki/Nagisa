/**
 * Where you were standing.
 * ========================
 *
 * One value, remembered across everything that can interrupt a session, so that coming
 * back puts you back rather than shipping you to the harbour.
 *
 * ### Why the resume token is not enough
 *
 * The resume token restores a player the *server* is still holding — it works beautifully
 * for the outage the token was designed for, a few seconds in a tunnel. Past
 * `PROTOCOL.SESSION_GRACE_MS` the server has removed that player, and if the process
 * restarted it never had them at all. In both cases the token names someone who no longer
 * exists, the connection is treated as a first arrival, and you are dropped on the quay,
 * possibly the whole island away from the conversation you were standing in.
 *
 * The one piece of information the server has irretrievably lost, and the client still
 * has, is the position. So the client keeps it, and offers it back on the next `hello`.
 * The server does not have to believe it (and re-derives it through the walkability
 * contract before it does).
 *
 * ### Why it goes to storage and not just a variable
 *
 * A live socket drop can be answered from memory. A page reload, a tab crash, a phone
 * killing a backgrounded tab, or a browser restart cannot — and those are exactly the
 * interruptions long enough to outlive the grace window, i.e. precisely the cases where
 * the position is the only thing left to reconnect with. So the pose is mirrored into
 * `localStorage` next to the resume token, throttled to keep it off the hot path.
 *
 * Stale poses are discarded on read: a position from a week ago is not where you are, and
 * a position saved under a different map does not even mean the same thing.
 */

import type { Vec3 } from '@nagisa/shared';

/** Storage key, deliberately adjacent to `nagisa.resume` in `connection.ts`. */
const POSE_KEY = 'nagisa.pose';

/**
 * How long a remembered pose stays meaningful.
 *
 * Long enough to cover the interruptions this exists for — a reload, a crash, a laptop
 * closed over lunch — and short enough that reopening the island days later reads as a
 * fresh visit and gives you the arrival at the harbour, which is the better experience
 * when you have long since lost the thread of where you were.
 */
const POSE_TTL_MS = 6 * 60 * 60 * 1000;

/** Minimum gap between writes. The pose changes every frame; storage is not free. */
const WRITE_INTERVAL_MS = 2_000;

export interface RememberedPose {
  pos: Vec3;
  yaw: number;
  /** Map the pose was recorded on. A position means nothing on a different pack. */
  mapId: string;
}

/** Kept in memory as well as in storage: this is the copy a live socket drop uses. */
let current: RememberedPose | null = null;
let lastWriteAt = -Infinity;

/**
 * Record where the character is now. Cheap to call every frame — writes to storage are
 * throttled to {@link WRITE_INTERVAL_MS}, and the in-memory copy is a single assignment.
 */
export function rememberPose(pos: Vec3, yaw: number, mapId: string, now = Date.now()): void {
  if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[2]) || !Number.isFinite(yaw)) return;
  current = { pos: [pos[0], pos[1], pos[2]], yaw, mapId };
  if (now - lastWriteAt < WRITE_INTERVAL_MS) return;
  lastWriteAt = now;
  try {
    localStorage.setItem(POSE_KEY, JSON.stringify({ ...current, at: now }));
  } catch {
    /* Private browsing, or storage full. The in-memory copy still covers socket drops. */
  }
}

/**
 * The pose to offer on the next `hello`, or `null` if there isn't a trustworthy one.
 *
 * Prefers the in-memory copy (this session, always current) over storage (a previous
 * session, up to {@link WRITE_INTERVAL_MS} behind and possibly stale).
 */
export function readPose(mapId: string | null, now = Date.now()): RememberedPose | null {
  if (current) return current.mapId === mapId || mapId === null ? current : null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(POSE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RememberedPose> & { at?: number };
    if (typeof parsed.at !== 'number' || now - parsed.at > POSE_TTL_MS) return null;
    if (!Array.isArray(parsed.pos) || parsed.pos.length !== 3 || typeof parsed.yaw !== 'number') return null;
    if (typeof parsed.mapId !== 'string') return null;
    if (mapId !== null && parsed.mapId !== mapId) return null;
    return { pos: parsed.pos as Vec3, yaw: parsed.yaw, mapId: parsed.mapId };
  } catch {
    return null;
  }
}

/**
 * Forget where we were. Paired with `Connection.clearResumeToken` — leaving the island
 * deliberately, or arriving under a new name, should land you at the harbour like anyone
 * else rather than at the last place your previous self stood.
 */
export function forgetPose(): void {
  current = null;
  lastWriteAt = -Infinity;
  try {
    localStorage.removeItem(POSE_KEY);
  } catch {
    /* Nothing stored to clear. */
  }
}
