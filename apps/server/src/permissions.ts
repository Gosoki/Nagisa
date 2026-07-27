/**
 * Permissions — pure authorization rules.
 * ========================================
 *
 * Every function here is pure: given a player and the thing they're trying to do,
 * answer yes/no (or throw, for `assertRole`). No I/O, no mutation, no awareness of
 * sessions or the network. That purity is deliberate — it is what lets
 * `permissions.test.ts` exhaustively cover the role matrix without touching a socket,
 * and it is what makes `handlers.ts` trustworthy: every privileged action routes
 * through exactly one of these checks rather than re-deriving "is this allowed" ad hoc
 * at each call site.
 *
 * The role ladder (`Role.Guest < Participant < Host < Admin`) is cumulative — see
 * {@link roleAtLeast} in the protocol — but announcement *scope* is not simply "higher
 * role reaches further"; a Host's reach is scoped to the one activity they run, not to
 * "every zone the Host role is allowed near." That scoping is what most of this file
 * is actually about.
 */

import { ErrorCode, Role, roleAtLeast, type AnnouncementView } from '@nagisa/shared';
import type { Activity } from './activity.js';
import type { Player } from './player.js';

/** Thrown by {@link assertRole} on a failed check. Handlers catch this and reply with `ServerError`. */
export class PermissionError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode = ErrorCode.Forbidden, message = 'Forbidden') {
    super(message);
    this.name = 'PermissionError';
    this.code = code;
  }
}

/**
 * Whether `player` may drive `activity`'s lifecycle (start/stop/cancel) and act as its
 * host for scoping purposes (announcements, in-activity moderation). True for:
 * - Admin, unconditionally (island-wide authority subsumes every activity), or
 * - the specific player granted {@link Role.Host} *of this activity* via `admin_action`.
 *
 * Deliberately not "anyone with role >= Host" — Host is per-activity, not a blanket
 * grant, or one host could start someone else's Lantern Walk.
 */
export function canHostActivity(player: Player, activity: Activity): boolean {
  if (roleAtLeast(player.role, Role.Admin)) return true;
  return player.role === Role.Host && player.hostOf === activity.id;
}

/**
 * Whether `player` may push an announcement with the given `scope`.
 *
 * - Guests can never announce — they hold no authority over anyone else's screen.
 * - Admins can announce anywhere (island, any zone, any activity).
 * - Hosts (role Host, not Admin) may announce only to the activity they run, or to that
 *   activity's own zone — never island-wide, and never to a *different* activity's zone.
 *   `hostedActivity` must be the caller's actual hosted activity (look it up from
 *   `player.hostOf` before calling); passing the wrong one would wrongly grant reach.
 * - Plain Participants (attending something, but not hosting it) cannot announce either;
 *   attendance is not authority.
 */
export function canAnnounce(
  player: Player,
  scope: AnnouncementView['scope'],
  hostedActivity: Activity | null,
): boolean {
  if (player.role === Role.Guest) return false;
  if (roleAtLeast(player.role, Role.Admin)) return true;
  if (player.role !== Role.Host || !hostedActivity) return false;

  switch (scope.kind) {
    case 'island':
      return false; // Island-wide reach is Admin-only.
    case 'activity':
      return scope.activity === hostedActivity.id;
    case 'zone':
      return scope.zone === hostedActivity.zone;
    default:
      return false;
  }
}

/** Whether `player` holds island-wide administrative authority. */
export function canAdmin(player: Player): boolean {
  return roleAtLeast(player.role, Role.Admin);
}

/**
 * Guard used at the top of a handler: throws {@link PermissionError} if `player` does
 * not meet `required`. `action` is a short machine-readable label (e.g. `'admin_action'`)
 * folded into the error message and, from there, into the audit log / client-visible
 * `ServerError.message` — keep it terse.
 */
export function assertRole(player: Player, required: Role, action: string): void {
  if (!roleAtLeast(player.role, required)) {
    throw new PermissionError(ErrorCode.Forbidden, `${action} requires role >= ${Role[required]}, has ${Role[player.role]}`);
  }
}
