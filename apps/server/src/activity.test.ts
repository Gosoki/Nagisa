/**
 * Tests for `activity.ts`: lifecycle transition legality, capacity enforcement,
 * check-in rules, and the scheduler's automatic transitions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityState } from '@nagisa/shared';
import { Activity, ActivityManager, CLEAR_AFTER_MS, HOST_START_GRACE_MS } from './activity.js';

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

test('ActivityManager.sweep: opens 5 minutes early, starts itself at startsAt when nobody hosts it, ends at endsAt', () => {
  const manager = new ActivityManager();
  const transitions: string[] = [];
  manager.on('transition', (_a, from, to) => transitions.push(`${from}->${to}`));

  const now = Date.now();
  const startsAt = now + 10 * 60_000; // starts in 10 minutes
  const activity = manager.createFromTemplate('morning-assembly', startsAt);
  assert.equal(activity.state, ActivityState.Scheduled);

  // Well before the 5-minute-prior threshold: no change.
  manager.sweep(now);
  assert.equal(activity.state, ActivityState.Scheduled);

  // At exactly startsAt - 5min, it opens.
  manager.sweep(startsAt - 5 * 60_000);
  assert.equal(activity.state, ActivityState.Open);

  // Not yet time.
  manager.sweep(startsAt - 1);
  assert.equal(activity.state, ActivityState.Open);

  // Nobody hosts it: the island starts it on time rather than leaving it open forever.
  manager.sweep(startsAt);
  assert.equal(activity.state, ActivityState.Live);

  manager.sweep(activity.endsAt! - 1);
  assert.equal(activity.state, ActivityState.Live, 'must still be live one ms before endsAt');
  manager.sweep(activity.endsAt!);
  assert.equal(activity.state, ActivityState.Ended);
  assert.deepEqual(transitions, ['scheduled->open', 'open->live', 'live->ended']);
});

test('ActivityManager.sweep: a present host gets a grace period to start it; an absent one does not', () => {
  const manager = new ActivityManager();
  const startsAt = Date.now() + 60_000;
  const hosted = manager.createFromTemplate('morning-assembly', startsAt);
  hosted.setHost('host-1', 'Hana');
  const absent = manager.createFromTemplate('morning-assembly', startsAt);
  absent.setHost('host-2', 'Kai');
  const present = (id: string): boolean => id === 'host-1';

  manager.sweep(startsAt, present);
  assert.equal(hosted.state, ActivityState.Open, 'a host who is here decides when it starts');
  assert.equal(absent.state, ActivityState.Live, 'a host who is not here does not hold everyone up');

  manager.sweep(startsAt + HOST_START_GRACE_MS - 1, present);
  assert.equal(hosted.state, ActivityState.Open);
  manager.sweep(startsAt + HOST_START_GRACE_MS, present);
  assert.equal(hosted.state, ActivityState.Live, 'after the grace period the island starts it anyway');
});

test('ActivityManager.sweep: anything still not started at its end time is cancelled, and cleared off later', () => {
  const manager = new ActivityManager();
  const removed: string[] = [];
  manager.on('removed', (id) => removed.push(id));
  const startsAt = Date.now() - 60 * 60_000; // an hour ago — the server was down through it
  const missed = manager.createFromTemplate('morning-assembly', startsAt);
  manager.sweep(Date.now());
  assert.equal(missed.state, ActivityState.Cancelled);
  assert.ok(missed.closedAt !== null);

  manager.sweep(missed.closedAt! + CLEAR_AFTER_MS - 1);
  assert.equal(removed.length, 0, 'kept on the board for a while');
  manager.sweep(missed.closedAt! + CLEAR_AFTER_MS);
  assert.deepEqual(removed, [missed.id]);
  assert.equal(manager.get(missed.id), undefined);
});

test('ActivityManager.sweep: an activity that ended early is kept until its scheduled end, so its slot is not refilled', () => {
  const manager = new ActivityManager();
  const now = Date.now();
  const a = manager.createFromTemplate('harbor-market', now, 'harbor-market@1'); // 25 minutes long
  manager.transition(a, ActivityState.Open, now);
  manager.transition(a, ActivityState.Cancelled, now);
  manager.sweep(now + CLEAR_AFTER_MS);
  assert.ok(manager.get(a.id), 'still there: its slot runs another ten minutes');
  assert.equal(manager.hasSlot('harbor-market@1'), true);
  manager.sweep(a.endsAt!);
  assert.equal(manager.get(a.id), undefined);
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
