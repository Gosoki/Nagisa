/**
 * Tests for `permissions.ts`'s authorization matrix. Every rule here maps directly to
 * a line in the top-level spec: "Guests may not announce. Hosts may announce only to
 * their own activity or its zone. Only Admin may announce island-wide or
 * kick/ban/grant-host."
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Role } from '@nagisa/shared';
import { Player } from './player.js';
import { Activity } from './activity.js';
import { assertRole, canAdmin, canAnnounce, canHostActivity, PermissionError } from './permissions.js';

function makePlayer(role: Role, hostOf: string | null = null): Player {
  const p = new Player('p1', 'Tester', { outfit: 0, skin: 0, accessory: 0 }, role, { pos: [0, 8, 0], yaw: 0 });
  p.hostOf = hostOf;
  return p;
}

function makeActivity(id = 'a1', zone: 'plaza' | 'beach' = 'plaza'): Activity {
  return new Activity({
    id,
    templateId: 't',
    title: 'Test',
    blurb: '',
    zone,
    startsAt: Date.now(),
    endsAt: null,
    capacity: 0,
    checkinEnabled: false,
  });
}

test('guests may never announce, at any scope', () => {
  const guest = makePlayer(Role.Guest);
  assert.equal(canAnnounce(guest, { kind: 'island' }, null), false);
  assert.equal(canAnnounce(guest, { kind: 'zone', zone: 'plaza' }, null), false);
  assert.equal(canAnnounce(guest, { kind: 'activity', activity: 'a1' }, null), false);
});

test('mere participants (attending, not hosting) may not announce', () => {
  const participant = makePlayer(Role.Participant);
  const activity = makeActivity();
  assert.equal(canAnnounce(participant, { kind: 'zone', zone: 'plaza' }, activity), false);
  assert.equal(canAnnounce(participant, { kind: 'activity', activity: activity.id }, activity), false);
});

test('a host may announce to their own activity and its zone, but never island-wide', () => {
  const activity = makeActivity('a1', 'plaza');
  const host = makePlayer(Role.Host, activity.id);

  assert.equal(canAnnounce(host, { kind: 'activity', activity: activity.id }, activity), true);
  assert.equal(canAnnounce(host, { kind: 'zone', zone: 'plaza' }, activity), true);

  // The explicit rule under test: island-wide reach is Admin-only, even for a host.
  assert.equal(canAnnounce(host, { kind: 'island' }, activity), false);
});

test('a host may not announce to a different activity or a different activity\'s zone', () => {
  const mine = makeActivity('mine', 'plaza');
  const someoneElses = makeActivity('theirs', 'beach');
  const host = makePlayer(Role.Host, mine.id);

  assert.equal(canAnnounce(host, { kind: 'activity', activity: someoneElses.id }, mine), false);
  assert.equal(canAnnounce(host, { kind: 'zone', zone: 'beach' }, mine), false);
});

test('a host with no resolvable hosted activity cannot announce at all', () => {
  // role says Host, but the caller passed null (e.g. player.hostOf pointed at an
  // activity that no longer exists) — must fail closed, not open.
  const host = makePlayer(Role.Host, null);
  assert.equal(canAnnounce(host, { kind: 'zone', zone: 'plaza' }, null), false);
});

test('admin may announce anywhere: island, any zone, any activity', () => {
  const admin = makePlayer(Role.Admin);
  const activity = makeActivity();
  assert.equal(canAnnounce(admin, { kind: 'island' }, null), true);
  assert.equal(canAnnounce(admin, { kind: 'zone', zone: 'beach' }, null), true);
  assert.equal(canAnnounce(admin, { kind: 'activity', activity: activity.id }, null), true);
});

test('canHostActivity: admin can host anything; a host can host only the activity granted to them', () => {
  const activity = makeActivity('a1');
  const otherActivity = makeActivity('a2');

  const admin = makePlayer(Role.Admin);
  assert.equal(canHostActivity(admin, activity), true);
  assert.equal(canHostActivity(admin, otherActivity), true);

  const host = makePlayer(Role.Host, activity.id);
  assert.equal(canHostActivity(host, activity), true);
  assert.equal(canHostActivity(host, otherActivity), false, 'host authority is per-activity, not blanket');

  const guest = makePlayer(Role.Guest);
  assert.equal(canHostActivity(guest, activity), false);
});

test('canAdmin is true only for Role.Admin', () => {
  assert.equal(canAdmin(makePlayer(Role.Guest)), false);
  assert.equal(canAdmin(makePlayer(Role.Participant)), false);
  assert.equal(canAdmin(makePlayer(Role.Host)), false);
  assert.equal(canAdmin(makePlayer(Role.Admin)), true);
});

test('assertRole throws PermissionError below the required role, and passes silently at or above it', () => {
  const guest = makePlayer(Role.Guest);
  assert.throws(() => assertRole(guest, Role.Admin, 'admin_action'), PermissionError);
  assert.doesNotThrow(() => assertRole(guest, Role.Guest, 'noop'));

  const admin = makePlayer(Role.Admin);
  assert.doesNotThrow(() => assertRole(admin, Role.Admin, 'admin_action'));
  assert.doesNotThrow(() => assertRole(admin, Role.Host, 'host_action'));
});
