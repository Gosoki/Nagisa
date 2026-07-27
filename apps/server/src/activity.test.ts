/**
 * Tests for `activity.ts`: lifecycle transition legality, capacity enforcement,
 * check-in rules, and the scheduler's automatic transitions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityState } from '@nagisa/shared';
import { Activity, ActivityManager } from './activity.js';

function makeActivity(overrides: Partial<{ capacity: number; checkinEnabled: boolean }> = {}): Activity {
  return new Activity({
    templateId: 'test-template',
    title: 'Test Activity',
    blurb: 'blurb',
    zone: 'plaza',
    startsAt: Date.now(),
    endsAt: Date.now() + 60_000,
    capacity: overrides.capacity ?? 0,
    checkinEnabled: overrides.checkinEnabled ?? true,
  });
}

test('illegal lifecycle transitions are rejected; the legal path succeeds', () => {
  const activity = makeActivity();
  assert.equal(activity.state, ActivityState.Scheduled);

  // Scheduled -> Live is not a legal direct transition.
  assert.equal(activity.transitionTo(ActivityState.Live), false);
  assert.equal(activity.state, ActivityState.Scheduled, 'a rejected transition must not change state');

  // Scheduled -> Ended is not legal either.
  assert.equal(activity.transitionTo(ActivityState.Ended), false);

  // The legal path: Scheduled -> Open -> Live -> Ended.
  assert.equal(activity.transitionTo(ActivityState.Open), true);
  assert.equal(activity.state, ActivityState.Open);

  // Open -> Ended is not legal (must go live first, or cancel).
  assert.equal(activity.transitionTo(ActivityState.Ended), false);
  assert.equal(activity.state, ActivityState.Open);

  assert.equal(activity.transitionTo(ActivityState.Live), true);
  assert.equal(activity.state, ActivityState.Live);

  // Live -> Open (going backwards) is not legal.
  assert.equal(activity.transitionTo(ActivityState.Open), false);

  assert.equal(activity.transitionTo(ActivityState.Ended), true);
  assert.equal(activity.state, ActivityState.Ended);

  // Ended is terminal: nothing transitions out of it.
  for (const target of Object.values(ActivityState)) {
    assert.equal(activity.transitionTo(target), false, `Ended -> ${target} must be rejected`);
  }
});

test('capacity is enforced against total attendance (participants + audience)', () => {
  const activity = makeActivity({ capacity: 2 });
  activity.transitionTo(ActivityState.Open);

  assert.deepEqual(activity.join('p1', 'participant'), { ok: true });
  assert.deepEqual(activity.join('p2', 'audience'), { ok: true });
  assert.equal(activity.attendanceCount, 2);

  const rejected = activity.join('p3', 'audience');
  assert.equal(rejected.ok, false);
  assert.equal((rejected as { reason: string }).reason, 'full');

  // Freeing a slot (leave) makes room again.
  activity.leave('p2');
  assert.deepEqual(activity.join('p3', 'audience'), { ok: true });
});

test('capacity 0 means uncapped', () => {
  const activity = makeActivity({ capacity: 0 });
  activity.transitionTo(ActivityState.Open);
  for (let i = 0; i < 500; i++) {
    assert.deepEqual(activity.join(`p${i}`, 'audience'), { ok: true });
  }
  assert.equal(activity.attendanceCount, 500);
});

test('joining is rejected outside Open/Live', () => {
  const activity = makeActivity();
  // Still Scheduled.
  const result = activity.join('p1', 'participant');
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'not_open');
});

test('check-in is accepted only while Live, only once per player, and only while attending', () => {
  const activity = makeActivity({ checkinEnabled: true });

  // Not live yet: the lifecycle gate is checked before attendance, so even a
  // never-joined player is rejected as `not_live`, not `not_attending`.
  assert.deepEqual(activity.checkin('ghost', Date.now()), { ok: false, reason: 'not_live' });

  activity.transitionTo(ActivityState.Open);
  activity.join('p1', 'participant');
  activity.join('p2', 'audience');

  // Open, but not Live: check-in must be rejected even though p1 is attending.
  assert.deepEqual(activity.checkin('p1', Date.now()), { ok: false, reason: 'not_live' });

  activity.transitionTo(ActivityState.Live);

  // Now that the activity is live, a player who never joined is rejected specifically
  // as not attending (as opposed to the lifecycle gate above).
  assert.deepEqual(activity.checkin('ghost', Date.now()), { ok: false, reason: 'not_attending' });

  const first = activity.checkin('p1', Date.now());
  assert.equal(first.ok, true);
  assert.equal((first as { ordinal: number }).ordinal, 1);

  // Checking in again must be rejected — one check-in per player.
  assert.deepEqual(activity.checkin('p1', Date.now()), { ok: false, reason: 'already' });

  // A second, distinct attendee gets the next ordinal in arrival order.
  const second = activity.checkin('p2', Date.now());
  assert.equal(second.ok, true);
  assert.equal((second as { ordinal: number }).ordinal, 2);

  assert.equal(activity.checkinRecords().length, 2);
  assert.deepEqual(
    activity.checkinRecords().map((r) => r.playerId),
    ['p1', 'p2'],
  );
});

test('check-in is rejected when the activity does not have check-in enabled', () => {
  const activity = makeActivity({ checkinEnabled: false });
  activity.transitionTo(ActivityState.Open);
  activity.join('p1', 'participant');
  activity.transitionTo(ActivityState.Live);
  assert.deepEqual(activity.checkin('p1', Date.now()), { ok: false, reason: 'not_live' });
});

test('ActivityManager.sweep advances scheduled->open 5 minutes before start, and live->ended at endsAt', () => {
  const manager = new ActivityManager();
  const changed: string[] = [];
  manager.on('changed', (a) => changed.push(a.state));

  const now = Date.now();
  const startsAt = now + 10 * 60_000; // starts in 10 minutes
  const activity = manager.createFromTemplate('morning-assembly', startsAt);
  assert.equal(activity.state, ActivityState.Scheduled);

  // Well before the 5-minute-prior threshold: no change.
  manager.sweep(now);
  assert.equal(activity.state, ActivityState.Scheduled);

  // At exactly startsAt - 5min, it should open.
  manager.sweep(startsAt - 5 * 60_000);
  assert.equal(activity.state, ActivityState.Open);

  // open -> live is a host decision, not automatic — sweep alone must never do it.
  manager.sweep(startsAt + 60_000);
  assert.equal(activity.state, ActivityState.Open);

  activity.transitionTo(ActivityState.Live);
  assert.ok(activity.endsAt);
  manager.sweep(activity.endsAt! - 1);
  assert.equal(activity.state, ActivityState.Live, 'must still be live one ms before endsAt');
  manager.sweep(activity.endsAt!);
  assert.equal(activity.state, ActivityState.Ended);
});

test('host assignment', () => {
  const activity = makeActivity();
  assert.equal(activity.hostId, null);
  activity.setHost('host-1', 'Hana');
  assert.equal(activity.hostId, 'host-1');
  assert.equal(activity.hostName, 'Hana');
  activity.setHost(null, null);
  assert.equal(activity.hostId, null);
  assert.equal(activity.hostName, null);
});
