/**
 * Tests for だるまさんがころんだ (`games/daruma.ts`), and for the relocation fence it leans on
 * (`Player.relocate`).
 *
 * Like the quiz's tests, the race is driven through a real `Room` with fake sockets and a
 * pinned random source, advanced by calling the runner's own `tick(now)` on a clock the test
 * keeps — never the room's own tick, which reads the wall clock. Racers are moved the way an
 * accepted report moves them (`teleport`), and what is checked is what a player would notice:
 * being sent back (a `teleport` correction), the view, the board, their card.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import {
  ActivityState,
  AnimState,
  DARUMA_COURSE,
  PROTOCOL,
  DARUMA_STEP_SPEED,
  PROGRAMME,
  Role,
  clearOfLandmarks,
  darumaCourseAt,
  darumaCourseLength,
  darumaOni,
  darumaStartSpot,
  getTemplate,
  heightAt,
  interactablePosition,
  interactablesWith,
  isWalkable,
  spawnPoint,
  zoneAt,
  type DarumaView,
  type ServerMessage,
  type Vec3,
} from '@nagisa/shared';
import { Room } from './room.js';
import { Player } from './player.js';
import { Session } from './session.js';
import { createLogger } from './logger.js';
import type { Activity } from './activity.js';
import { AuditLog } from './audit.js';
import { HANDLERS, handleHello, type HandlerDeps } from './handlers.js';
import { RoomManager } from './rooms.js';
import { ProfileStore } from './games/profiles.js';
import { FINISHED_MS, LOBBY_MS, LOOK_GRACE_MS, OFF_COURSE_M, RACE_MS, STILL_TOLERANCE_M, type DarumaRunner } from './games/daruma.js';

class FakeSocket {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.readyState = 3;
  }
}

const log = createLogger({ level: 'error' });

/**
 * A room with no schedule. The random source is pinned high, so every chant runs its longest
 * (5 s) and every look likewise (3 s): a racer can cover a good stretch of the lane per chant.
 */
function makeRoom(random: () => number = () => 0.999): Room {
  return new Room('r1', 'Test', 50, log, { schedule: false, random });
}

let nextId = 0;
function join(room: Room, name = `P${++nextId}`): { player: Player; socket: FakeSocket; session: Session } {
  const socket = new FakeSocket();
  const session = new Session(socket as unknown as WebSocket, `c-${++nextId}`, log);
  const player = new Player(`p-${nextId}`, name, { outfit: 0, skin: 0, accessory: 0 }, Role.Guest, spawnPoint(nextId));
  room.join(session, player);
  return { player, socket, session };
}

/** Attach a player to an activity, the way `activity_join` does. */
function attend(room: Room, player: Player, activity: Activity, mode: 'participant' | 'audience'): void {
  assert.ok(activity.join(player.id, mode).ok);
  player.activity = activity.id;
  player.mode = mode;
}

/** A point on the course: `along` metres from the start line toward the goal, `across` from its middle. */
function onCourse(along: number, across = 0): Vec3 {
  const c = DARUMA_COURSE!;
  const length = darumaCourseLength();
  const ux = (c.goal.x - c.start.x) / length;
  const uz = (c.goal.z - c.start.z) / length;
  const x = c.start.x + ux * along + uz * across;
  const z = c.start.z + uz * along - ux * across;
  return [x, heightAt(x, z), z];
}

/** Where a player is on the course. */
function whereOn(player: Player): { along: number; across: number } {
  return darumaCourseAt(player.pos[0], player.pos[2])!;
}

/** Move a player the way an accepted report would. */
function step(player: Player, along: number, across = 0): void {
  player.teleport(onCourse(along, across), 0);
}

function of<T extends ServerMessage['t']>(socket: FakeSocket, t: T): Array<Extract<ServerMessage, { t: T }>> {
  return socket.sent.filter((m) => m.t === t) as Array<Extract<ServerMessage, { t: T }>>;
}

/** The race, on the test's own clock. */
class Race {
  t: number;
  constructor(
    readonly room: Room,
    readonly activity: Activity,
  ) {
    this.t = this.runner.view().endsAt;
  }

  get runner(): DarumaRunner {
    const runner = (this.room as unknown as { daruma: DarumaRunner | null }).daruma;
    assert.ok(runner, 'a race is running');
    return runner;
  }

  get view(): DarumaView {
    return this.runner.view();
  }

  /** Advance the clock and tick the runner. */
  tick(ms = 100): void {
    this.t += ms;
    this.runner.tick(this.t);
  }

  /** Tick until the view reaches `phase` (the lobby's end is where the clock starts). */
  until(phase: DarumaView['phase'], limit = 400): void {
    for (let i = 0; i < limit && this.view.phase !== phase; i++) this.tick();
    assert.equal(this.view.phase, phase);
  }

  /**
   * To the last moment of a chant. A racer moved here has had the whole chant to get there —
   * moved at its start, the same distance would be a sprint (see the careful step).
   */
  nearTurn(): void {
    assert.equal(this.view.phase, 'walk');
    while (this.t + 100 < this.view.endsAt) this.tick();
  }

  /** From the start of a look, to the moment the oni has taken where everybody stands. */
  pastGrace(): void {
    assert.equal(this.view.phase, 'look');
    while (this.t < this.view.startedAt + LOOK_GRACE_MS) this.tick();
    this.tick();
  }
}

/** A race that has gone live, with its runner in the lobby. */
function startRace(room: Room, startsAgoMs = 1000): { race: Race; activity: Activity } {
  const activity = room.activities.createFromTemplate('daruma', Date.now() - startsAgoMs);
  room.activities.sweep(Date.now());
  assert.equal(activity.state, ActivityState.Live);
  const race = new Race(room, activity);
  assert.equal(race.view.phase, 'lobby');
  return { race, activity };
}

// ---------------------------------------------------------------------------------------------
// The course
// ---------------------------------------------------------------------------------------------

test('daruma: the course is a level, open, walkable lane in a venue, on the programme', () => {
  const course = DARUMA_COURSE;
  assert.ok(course, 'the island has a course');
  const template = getTemplate('daruma');
  assert.equal(template?.feature, 'daruma');
  assert.equal(template?.zone, course.zone, 'held where the course is');
  assert.ok(PROGRAMME.some((p) => p.template === 'daruma'), 'on the island’s day');
  assert.ok(darumaCourseLength() >= 18, 'long enough for a few chants');

  // Every half metre of the lane, and of the gathering room behind the start: ground a racer
  // can stand on, clear of every prop, and level enough to read as one place.
  let lo = Infinity;
  let hi = -Infinity;
  for (let along = -3.5; along <= darumaCourseLength() + 1; along += 0.5) {
    for (let across = -course.halfWidth; across <= course.halfWidth; across += 0.5) {
      const [x, y, z] = onCourse(along, across);
      assert.ok(isWalkable(x, z) && clearOfLandmarks(x, z, 0.3), `lane clear at ${along}, ${across}`);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  assert.ok(hi - lo < 1, `the lane is level (${(hi - lo).toFixed(2)} m)`);

  const oni = darumaOni()!;
  assert.ok(isWalkable(oni.x, oni.z) && clearOfLandmarks(oni.x, oni.z, 1.2), 'the oni stands on open ground');
  assert.equal(zoneAt(oni.x, oni.z), course.zone);

  // Start places: behind the line, across the lane, a metre apart for the first 27.
  const spots = Array.from({ length: 27 }, (_, i) => darumaStartSpot(i)!);
  for (const s of spots) {
    const at = darumaCourseAt(s.x, s.z)!;
    assert.ok(isWalkable(s.x, s.z), 'a start place is somewhere to stand');
    assert.ok(at.along < 0 && at.along > -4 && Math.abs(at.across) <= course.halfWidth);
  }
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) assert.ok(Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z) >= 0.9);
  }
  assert.ok(Math.abs(darumaCourseAt(spots[0].x, spots[0].z)!.across) < 0.01, 'the first racer takes the middle');
});

// ---------------------------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------------------------

test('daruma: participants go to the start line; the audience and passers-by do not race', () => {
  const room = makeRoom();
  const { race, activity } = startRace(room);
  const a = join(room, 'Aki');
  const b = join(room, 'Ben');
  const watcher = join(room, 'Wren');
  const passer = join(room, 'Pip');
  attend(room, a.player, activity, 'participant');
  attend(room, b.player, activity, 'participant');
  attend(room, watcher.player, activity, 'audience');

  // Ben is sitting on the beach log, Aki fishing off the beach, when the lobby closes.
  const log = interactablesWith('none').find((i) => i.id === 'beach-log')!;
  const seat = interactablePosition(log);
  b.player.teleport([seat.x, seat.y, seat.z], 0);
  assert.ok(room.sit(b.player, log.id));
  const spot = interactablesWith('fish').find((i) => i.habitat === 'beach')!;
  const at = interactablePosition(spot);
  a.player.teleport([at.x, heightAt(at.x, at.z), at.z], 0);
  room.fishing.cast(a.player, spot.id, Date.now());
  assert.equal(of(a.socket, 'fish').pop()?.phase, 'waiting');

  room.forceTick();
  const lobby = of(a.socket, 'delta').map((d) => d.daruma).filter(Boolean).pop();
  assert.equal(lobby?.phase, 'lobby', 'the lobby goes out to everyone');

  race.until('walk');
  assert.deepEqual(new Set(race.view.racing), new Set([a.player.id, b.player.id]), 'participants only');
  for (const racer of [a, b]) {
    const moved = of(racer.socket, 'correction').pop();
    assert.equal(moved?.reason, 'teleport', 'told they were moved');
    assert.ok(whereOn(racer.player).along < 0 && whereOn(racer.player).along > -2, 'on the start line');
  }
  assert.equal(of(watcher.socket, 'correction').length + of(passer.socket, 'correction').length, 0, 'nobody else is moved');
  assert.equal(room.seatHolder(log.id), undefined, 'the seat is let go');
  assert.equal(of(a.socket, 'fish').pop()?.phase, 'escaped', 'the line is reeled in');
  assert.ok(race.view.raceEndsAt && race.view.raceEndsAt <= race.t + RACE_MS);

  // A report Aki's client sent before it heard it was moved — from a couple of metres short of
  // the line, where it was walking to — is not believed, so it cannot read as a rush.
  const stale = a.player.applyMove({ pos: onCourse(1, whereOn(a.player).across), yaw: 0, anim: AnimState.Walk, seq: 1 });
  assert.equal(stale?.reason, 'teleport', 'told again where it is');
  race.tick();
  assert.equal(race.view.caught, undefined, 'nobody is caught for setting off');
  assert.ok(whereOn(a.player).along < 0);
});

test('daruma: moving once the oni has looked sends you back; standing still, or moving in the grace, does not', () => {
  const room = makeRoom();
  const { race, activity } = startRace(room);
  const mover = join(room, 'Mover');
  const still = join(room, 'Still');
  const early = join(room, 'Early');
  const fidget = join(room, 'Fidget');
  const watcher = join(room, 'Watcher');
  for (const r of [mover, still, early, fidget]) attend(room, r.player, activity, 'participant');
  attend(room, watcher.player, activity, 'audience');
  race.until('walk');

  // Everyone creeps forward during the chant, well within a careful step.
  const chant = race.view.endsAt - race.view.startedAt;
  const stride = DARUMA_STEP_SPEED * (chant / 1000) * 0.8;
  race.nearTurn();
  for (const r of [mover, still, early, fidget]) step(r.player, stride, whereOn(r.player).across);
  step(watcher.player, 4);
  race.until('look');
  assert.deepEqual(race.view.caught ?? [], []);

  // Early is still taking a last step when the oni turns: that is what the grace is for.
  race.tick(LOOK_GRACE_MS / 2);
  step(early.player, stride + 1, whereOn(early.player).across);
  race.pastGrace();
  const before = of(mover.socket, 'correction').length;

  // After the grace: Mover walks on, Fidget shifts a little, Still does nothing but turn
  // round and dance, and the watcher strolls right across the lane.
  step(mover.player, stride + STILL_TOLERANCE_M + 0.5, whereOn(mover.player).across);
  step(fidget.player, stride + STILL_TOLERANCE_M * 0.5, whereOn(fidget.player).across);
  still.player.yaw = 2;
  still.player.anim = AnimState.Dance;
  step(watcher.player, 12, 3);
  race.tick();

  const view = race.view;
  assert.deepEqual(view.caught, [mover.player.id], 'only the one who moved is caught');
  const sentBack = of(mover.socket, 'correction');
  assert.equal(sentBack.length, before + 1);
  assert.equal(sentBack.at(-1)?.reason, 'teleport');
  assert.ok(whereOn(mover.player).along < 0, 'and is back behind the start line');
  assert.ok(view.racing.includes(mover.player.id), 'still racing, from the start');
  for (const r of [still, early, fidget, watcher]) assert.equal(of(r.socket, 'correction').length, r === watcher ? 0 : 1, `${r.player.name} was not sent back`);

  // Staying put after being sent back is fine; the next chant clears the list.
  race.tick(500);
  assert.deepEqual(race.view.caught, [mover.player.id]);
  race.until('walk');
  assert.equal(race.view.caught, undefined);
});

test('daruma: nobody outruns the careful step', () => {
  const room = makeRoom();
  const { race, activity } = startRace(room);
  const a = join(room, 'Dash');
  attend(room, a.player, activity, 'participant');
  race.until('walk');
  race.tick(1000);
  // A second into the chant, eight metres on: a sprint, not a creep.
  step(a.player, 8);
  race.tick();
  assert.deepEqual(race.view.caught, [a.player.id]);
  assert.ok(whereOn(a.player).along < 0, 'back to the start');
  // From there, the step is measured afresh.
  race.tick(1000);
  step(a.player, DARUMA_STEP_SPEED * 0.9);
  race.tick();
  assert.equal(of(a.socket, 'correction').length, 2, 'one move to the start line, one back to it — and no more');
});

test('daruma: first over the line wins, three places are kept, and the race ends with them', () => {
  const room = makeRoom();
  const { race, activity } = startRace(room);
  const racers = ['Ichi', 'Ni', 'San', 'Shi'].map((n) => join(room, n));
  for (const r of racers) attend(room, r.player, activity, 'participant');
  race.until('walk');

  // Each chant, everyone takes as much of the lane as a careful step allows — the first three
  // a little more boldly than the last, and in order.
  const length = darumaCourseLength();
  const pace = [1, 0.95, 0.9, 0.5];
  const until = (phase: DarumaView['phase']): void => {
    for (let i = 0; i < 100 && race.view.phase !== phase && race.view.phase !== 'finished'; i++) race.tick();
  };
  for (let chants = 0; race.view.phase === 'walk' && chants < 20; chants++) {
    race.nearTurn();
    const walked = (race.t - race.view.startedAt) / 1000;
    racers.forEach((r, i) => {
      if (!race.view.racing.includes(r.player.id)) return;
      const at = whereOn(r.player);
      step(r.player, Math.min(length + 0.5, at.along + DARUMA_STEP_SPEED * walked * pace[i]), at.across);
    });
    until('look');
    until('walk');
  }

  const view = race.view;
  assert.equal(view.phase, 'finished');
  assert.deepEqual(view.places.map((p) => p.name), ['Ichi', 'Ni', 'San']);
  assert.ok(view.racing.includes(racers[3].player.id), 'the fourth never got home');
  assert.deepEqual(activity.board?.map((b) => b.name), ['Ichi', 'Ni', 'San'], 'the board has the places');
  assert.ok(activity.board!.every((b, i, all) => b.score > 0 && (i === 0 || b.score >= all[i - 1].score)), 'with the seconds each took');
  assert.ok(racers[0].player.profile.badges.includes('daruma'), 'the winner is Daruma Champion');
  assert.ok(!racers[1].player.profile.badges.includes('daruma'));

  room.forceTick();
  const events = of(racers[1].socket, 'delta').flatMap((d) => d.events ?? []);
  assert.ok(events.some((e) => e.k === 'badge' && e.by === racers[0].player.id && e.badge === 'daruma'), 'and everyone hears so');
  const podium = of(racers[1].socket, 'delta').flatMap((d) => d.announcements ?? []).find((a) => a.text.startsWith('🏁'));
  assert.ok(podium?.text.includes('Ichi') && podium.text.includes('San') && podium.scope.kind === 'zone');

  // The finished card, then the view goes and the activity ends.
  race.tick(FINISHED_MS);
  room.forceTick();
  assert.equal(activity.state, ActivityState.Ended, 'the activity ends with the race');
  const cleared = of(racers[0].socket, 'delta').filter((d) => d.daruma !== undefined).pop();
  assert.equal(cleared?.daruma, null);
});

test('daruma: racers who leave, stop taking part or wander off drop out; with nobody left the race is over', () => {
  const room = makeRoom();
  const { race, activity } = startRace(room);
  const quits = join(room, 'Quits');
  const watches = join(room, 'Watches');
  const wanders = join(room, 'Wanders');
  const drops = join(room, 'Drops');
  const leaves = join(room, 'Leaves');
  for (const r of [quits, watches, wanders, drops, leaves]) attend(room, r.player, activity, 'participant');
  race.until('walk');
  assert.equal(race.view.racing.length, 5);

  // Left the activity (as `activity_leave` does), and went over to watching.
  activity.leave(quits.player.id);
  quits.player.activity = null;
  quits.player.mode = null;
  attend(room, watches.player, activity, 'audience');
  // Walked off the lane, to the side.
  wanders.player.teleport(onCourse(1, DARUMA_COURSE!.halfWidth + OFF_COURSE_M + 1), 0);
  race.tick();
  assert.deepEqual(race.view.racing.sort(), [drops.player.id, leaves.player.id].sort());

  // Dropping connection keeps your place for the grace window: the oni does not judge a
  // player who cannot move, and they carry on when they are back.
  room.disconnect(drops.player.id);
  race.until('look');
  race.pastGrace();
  race.tick(500);
  assert.ok(race.view.racing.includes(drops.player.id), 'away, and still racing');
  const again = new Session(new FakeSocket() as unknown as WebSocket, 'c-again', log);
  room.resume(again, drops.player);
  race.tick();
  assert.ok(race.view.racing.includes(drops.player.id) && !(race.view.caught ?? []).includes(drops.player.id), 'back, and still racing');

  // Leaving the island — for another, or for good — is leaving the race.
  room.removePlayer(leaves.player.id, 'room_switch', { closeSession: false });
  assert.deepEqual(race.view.racing, [drops.player.id]);
  room.removePlayer(drops.player.id, 'grace_expired');
  race.tick();
  assert.equal(race.view.phase, 'finished', 'nobody left racing: over');
  assert.deepEqual(race.view.places, []);
  race.tick(FINISHED_MS);
  room.forceTick();
  assert.equal(activity.state, ActivityState.Ended);
});

test('daruma: a host ending it early stops the race, and a new one can run; one race at a time', async () => {
  const room = makeRoom();
  const { race, activity } = startRace(room);
  const a = join(room, 'A');
  attend(room, a.player, activity, 'participant');
  race.until('walk');

  // A second race going live meanwhile is called off: there is one course.
  const second = room.activities.createFromTemplate('daruma', Date.now() - 500);
  room.activities.sweep(Date.now());
  await Promise.resolve();
  assert.equal(second.state, ActivityState.Ended, 'called off rather than left doing nothing');
  assert.equal(race.runner.activity, activity.id, 'the first carries on');

  assert.ok(room.activities.transition(activity, ActivityState.Ended));
  assert.equal((room as unknown as { daruma: unknown }).daruma, null, 'the runner is gone');
  room.forceTick();
  assert.equal(of(a.socket, 'delta').filter((d) => d.daruma !== undefined).pop()?.daruma, null, 'and so is the card');

  const next = startRace(room);
  assert.equal(next.race.view.activity, next.activity.id);
});

test('daruma: with nobody taking part the lobby waits while a race still fits, then the game is over', () => {
  const room = makeRoom();
  // Its eight minutes started 3½ ago: when the first lobby closes there is still room for
  // another lobby and a whole race, and when that one closes there is not.
  const { race, activity } = startRace(room, 215_000);
  const bystander = join(room, 'Bystander');
  const firstLobbyEnd = race.view.endsAt;
  race.tick(1);
  assert.equal(race.view.phase, 'lobby', 'nobody yet: the lobby opens again');
  assert.ok(race.view.endsAt > firstLobbyEnd);
  assert.deepEqual(race.view.racing, []);

  race.tick(LOBBY_MS);
  assert.equal(race.view.phase, 'finished', 'and when a race no longer fits, it is over');
  assert.deepEqual(race.view.places, []);
  assert.equal(of(bystander.socket, 'correction').length, 0, 'nobody was moved');
  race.tick(FINISHED_MS);
  room.forceTick();
  assert.equal(activity.state, ActivityState.Ended);
  const announced = of(bystander.socket, 'delta').flatMap((d) => d.announcements ?? []);
  assert.ok(!announced.some((a) => a.text.startsWith('🏁')), 'no podium for nobody');
});

test('daruma: a race live across a restart is over, and does not block the next', () => {
  const before = makeRoom();
  const { activity } = startRace(before);
  const saved = before.exportState();
  before.stop();

  const after = makeRoom();
  after.restoreState(saved);
  assert.equal(after.activities.get(activity.id)?.state, ActivityState.Ended, 'nothing is running it any more');
  const next = startRace(after);
  assert.equal(next.activity.state, ActivityState.Live);
  after.stop();
});

// ---------------------------------------------------------------------------------------------
// Relocation
// ---------------------------------------------------------------------------------------------

test('relocate: reports from before the client heard are answered with the move again, until one comes from there', () => {
  const player = new Player('p-fence', 'Fence', { outfit: 0, skin: 0, accessory: 0 }, Role.Guest, { pos: onCourse(10), yaw: 0 });
  const t0 = 1_000_000;
  // Standing still for a while (a keep-alive's worth): enough budget that a stale report from
  // ten metres away would otherwise be believed.
  assert.equal(player.applyMove({ pos: onCourse(10), yaw: 0, anim: AnimState.Idle, seq: 1 }, t0), null);
  const spot = onCourse(-1);
  const told = player.relocate(spot, Math.PI / 2, t0 + 1900);
  assert.deepEqual(told, { t: 'correction', pos: spot, yaw: Math.PI / 2, reason: 'teleport' });

  // Still in flight when the move was made: from where they were.
  const stale = player.applyMove({ pos: onCourse(10.3), yaw: 0, anim: AnimState.Walk, seq: 2 }, t0 + 2000);
  assert.equal(stale?.reason, 'teleport', 'said again, not believed');
  assert.deepEqual(player.pos, spot);

  // Then from beside the spot: believed, and the fence is down.
  assert.equal(player.applyMove({ pos: onCourse(-0.8), yaw: 0, anim: AnimState.Walk, seq: 3 }, t0 + 2100), null);
  assert.ok(Math.abs(whereOn(player).along + 0.8) < 0.01);
  assert.equal(player.applyMove({ pos: onCourse(-0.3), yaw: 0, anim: AnimState.Walk, seq: 4 }, t0 + 2200), null);

  // A move somewhere else entirely (a room switch's harbour) takes the fence down with it.
  player.relocate(spot, 0, t0 + 3000);
  const harbour = spawnPoint(0).pos;
  player.teleport(harbour, 0);
  assert.equal(player.applyMove({ pos: harbour, yaw: 0, anim: AnimState.Idle, seq: 5 }, t0 + 3100), null);
});

// ---------------------------------------------------------------------------------------------
// From the host panel
// ---------------------------------------------------------------------------------------------

test('daruma: an admin can put a race on, but not a second while one is running', () => {
  const deps: HandlerDeps = {
    rooms: new RoomManager({ log, roomCapacity: 40, privateCapacity: 20, initialRoomCount: 1, persist: () => {}, autostart: false }),
    audit: new AuditLog(log),
    log,
    config: { RESUME_SECRET: 'test-secret' } as HandlerDeps['config'],
    profiles: new ProfileStore(),
    persist: () => {},
  };
  const socket = new FakeSocket();
  const session = new Session(socket as unknown as WebSocket, 'c-admin', log);
  const conn = handleHello(session, { t: 'hello', protocol: PROTOCOL.VERSION, name: 'Keeper', appearance: { outfit: 0, skin: 0, accessory: 0 } }, { adminGranted: true }, deps);
  assert.ok(conn);
  const schedule = (): void => HANDLERS.host_schedule(conn, { t: 'host_schedule', template: 'daruma', inMin: 0 }, deps);

  schedule();
  const made = conn.room.activities.list().filter((a) => a.feature === 'daruma' && a.slot?.startsWith('adhoc:'));
  assert.equal(made.length, 1, 'on the board');
  // Live now — or called off at once, if the island's own race happens to be on: either way
  // one race is running, and another is refused.
  conn.room.activities.sweep(Date.now());
  assert.ok(conn.room.activities.list().some((a) => a.feature === 'daruma' && a.state === ActivityState.Live));
  schedule();
  assert.equal(of(socket, 'error').pop()?.key, 'already_running');
  conn.room.stop();
});
