/**
 * Tests for the games, the seats, the schedule and private islands.
 *
 * Every game is driven through a real `Room` with fake sockets and a pinned random source,
 * advanced by calling the games' own `tick(now)` with explicit times — no sleeping, no
 * wall-clock dependence. What is checked is what a player would notice: the messages they
 * get, the events everyone gets, and what ends up on their card.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import {
  ActivityState,
  FIREWORKS,
  PROGRAMME,
  QUIZ_ARENA,
  QUIZ_BANK,
  Role,
  STAMP_ZONES,
  DIG_COOLDOWN_MS,
  TREASURE_COUNT,
  digHeat,
  getQuizQuestion,
  isWalkable,
  getZone,
  heightAt,
  interactablePosition,
  interactablesWith,
  jstDay,
  nearestWalkable,
  type ServerMessage,
  type Vec3,
} from '@nagisa/shared';
import { Room } from './room.js';
import { RoomManager, IDLE_MS, islandRoomId } from './rooms.js';
import { Player } from './player.js';
import { Session } from './session.js';
import { createLogger } from './logger.js';
import { BITE_WINDOW_MS } from './games/fishing.js';
import { judge } from './games/janken.js';
import { FINISHED_MS, QUESTION_MS, REVEAL_MS } from './games/quiz.js';
import { BELL_REST_MS } from './games/interactions.js';
import { GUESTBOOK_COOLDOWN_MS, GUESTBOOK_LIMIT } from './games/guestbook.js';
import { PLAYER_COOLDOWN_MS, ROOM_BURST } from './games/fireworks.js';
import { ProfileStore, hashVisitorKey, newProfile } from './games/profiles.js';
import { materialiseProgramme } from './schedule.js';
import { bury } from './games/treasure.js';
import { migrate } from './persistence.js';

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

/** A room with no schedule and a random source that can be pinned per test. */
function makeRoom(random: () => number = () => 0.5): Room {
  return new Room('r1', 'Test', 50, log, { schedule: false, random });
}

let nextId = 0;
function join(room: Room, at: Vec3 = [0, 0, 0], name = `P${++nextId}`): { player: Player; socket: FakeSocket } {
  const socket = new FakeSocket();
  const session = new Session(socket as unknown as WebSocket, `c-${nextId}`, log);
  const player = new Player(`p-${++nextId}`, name, { outfit: 0, skin: 0, accessory: 0 }, Role.Guest, { pos: at, yaw: 0 });
  room.join(session, player);
  return { player, socket };
}

/** Stand a player at an interactable (on walkable ground, at terrain height). */
function standAt(player: Player, id: string): void {
  const it = interactablesWith('fish').concat(interactablesWith('stamp'), interactablesWith('ring_bell'), interactablesWith('omikuji'), interactablesWith('read_announcements'), interactablesWith('none')).find((i) => i.id === id);
  assert.ok(it, `interactable ${id}`);
  const p = interactablePosition(it);
  player.teleport([p.x, heightAt(p.x, p.z), p.z], 0);
}

function place(player: Player, x: number, z: number): void {
  const [wx, wz] = nearestWalkable(x, z, 6);
  player.teleport([wx, heightAt(wx, wz), wz], 0);
}

function of<T extends ServerMessage['t']>(socket: FakeSocket, t: T): Array<Extract<ServerMessage, { t: T }>> {
  return socket.sent.filter((m) => m.t === t) as Array<Extract<ServerMessage, { t: T }>>;
}

function lastOf<T extends ServerMessage['t']>(socket: FakeSocket, t: T): Extract<ServerMessage, { t: T }> | undefined {
  const all = of(socket, t);
  return all[all.length - 1];
}

/** Events broadcast in the next delta. */
function flushEvents(room: Room, socket: FakeSocket) {
  room.forceTick();
  const deltas = of(socket, 'delta');
  return deltas[deltas.length - 1]?.events ?? [];
}

// ---------------------------------------------------------------------------------------------
// Fishing
// ---------------------------------------------------------------------------------------------

test('fishing: cast, too early, bite, strike, catch goes in the book and to everyone', () => {
  const room = makeRoom(() => 0);
  const { player, socket } = join(room);
  const watcher = join(room);
  const spot = interactablesWith('fish')[0];

  // Too far.
  place(player, 0, 0);
  room.fishing.cast(player, spot.id, 0);
  assert.equal(lastOf(socket, 'error')?.key, 'too_far');

  standAt(player, spot.id);
  room.fishing.cast(player, spot.id, 1000);
  assert.equal(lastOf(socket, 'fish')?.phase, 'waiting');

  // Striking before the bite loses it.
  room.fishing.hook(player, 1100);
  assert.deepEqual([lastOf(socket, 'fish')?.phase, lastOf(socket, 'fish')?.reason], ['escaped', 'early']);

  // Cast again; with random() = 0 the bite comes at the earliest moment.
  room.fishing.cast(player, spot.id, 2000);
  room.fishing.tick(2000 + 2400);
  assert.equal(lastOf(socket, 'fish')?.phase, 'waiting', 'no bite yet');
  room.fishing.tick(2000 + 2500);
  const bite = lastOf(socket, 'fish');
  assert.equal(bite?.phase, 'bite');
  assert.equal(bite?.window, BITE_WINDOW_MS);

  room.fishing.hook(player, 2000 + 2500 + 800);
  const caught = lastOf(socket, 'fish');
  assert.equal(caught?.phase, 'caught');
  assert.ok(caught?.fish);
  assert.equal(caught?.newSpecies, true);
  assert.equal(player.profile.catches, 1);
  assert.equal(player.profile.fish[caught!.fish!].count, 1);
  assert.equal(lastOf(socket, 'profile')?.profile.catches, 1);

  const events = flushEvents(room, watcher.socket);
  assert.ok(events.some((e) => e.k === 'catch' && e.by === player.id && e.fish === caught!.fish));
});

test('fishing: a missed bite escapes late, walking off reels in, leaving forgets the line', () => {
  const room = makeRoom(() => 0);
  const { player, socket } = join(room);
  const spot = interactablesWith('fish')[0];
  standAt(player, spot.id);

  room.fishing.cast(player, spot.id, 0);
  room.fishing.tick(2500);
  room.fishing.tick(2500 + BITE_WINDOW_MS + 400);
  assert.deepEqual([lastOf(socket, 'fish')?.phase, lastOf(socket, 'fish')?.reason], ['escaped', 'late']);

  room.fishing.cast(player, spot.id, 10_000);
  place(player, 0, 0);
  room.onMoved(player);
  assert.deepEqual([lastOf(socket, 'fish')?.phase, lastOf(socket, 'fish')?.reason], ['escaped', 'moved']);
  assert.equal(room.fishing.isFishing(player.id), false);

  standAt(player, spot.id);
  room.fishing.cast(player, spot.id, 20_000);
  room.removePlayer(player.id, 'test', { closeSession: false });
  assert.equal(room.fishing.isFishing(player.id), false);
});

test('fishing derby: participants score their biggest fish; the winner is crowned when it ends', () => {
  // random() = 0 lands the first species in the pool (never the boot) at its smallest size.
  const room = makeRoom(() => 0);
  const a = join(room, [0, 0, 0], 'Aki');
  const b = join(room, [0, 0, 0], 'Ben');
  const derby = room.activities.createFromTemplate('morning-catch', Date.now() - 1000);
  room.activities.sweep(Date.now());
  assert.equal(derby.state, ActivityState.Live);
  for (const p of [a, b]) {
    assert.deepEqual(derby.join(p.player.id, 'participant'), { ok: true });
    p.player.activity = derby.id;
    p.player.mode = 'participant';
  }
  const spot = interactablesWith('fish')[0];
  for (const p of [a, b]) {
    standAt(p.player, spot.id);
    room.fishing.cast(p.player, spot.id, 0);
  }
  room.fishing.tick(20_000);
  room.fishing.hook(a.player, 20_100);
  room.fishing.hook(b.player, 20_200);
  assert.ok(derby.board && derby.board.length === 2, 'both on the board');
  assert.ok(derby.board[0].score >= derby.board[1].score, 'biggest first');

  const winnerId = derby.board[0].id;
  room.activities.transition(derby, ActivityState.Ended);
  const winner = winnerId === a.player.id ? a.player : b.player;
  assert.ok(winner.profile.badges.includes('derby-champ'), 'the winner is Derby Champion');
  const loser = winner === a.player ? b.player : a.player;
  assert.ok(!loser.profile.badges.includes('derby-champ'));
});

// ---------------------------------------------------------------------------------------------
// Janken
// ---------------------------------------------------------------------------------------------

test('janken: judge', () => {
  assert.equal(judge('rock', 'scissors'), 'a');
  assert.equal(judge('scissors', 'paper'), 'a');
  assert.equal(judge('paper', 'rock'), 'a');
  assert.equal(judge('rock', 'paper'), 'b');
  assert.equal(judge('paper', 'paper'), null);
});

test('janken: challenge, accept, throw, result and a win on the card', () => {
  const room = makeRoom();
  const a = join(room, [0, 0, 0]);
  const b = join(room, [0, 0, 0]);
  place(a.player, 64, 37);
  place(b.player, 66, 37);

  room.janken.challenge(a.player, a.player.id, 0);
  assert.equal(lastOf(a.socket, 'error')?.key, 'invalid', 'not yourself');

  room.janken.challenge(a.player, b.player.id, 0);
  const invite = lastOf(b.socket, 'janken');
  assert.equal(invite?.kind, 'invited');
  assert.equal(lastOf(a.socket, 'janken')?.kind, 'waiting');

  // A third party cannot answer for B, and A cannot start another.
  room.janken.challenge(a.player, b.player.id, 10);
  assert.equal(lastOf(a.socket, 'error')?.key, 'busy');

  room.janken.respond(b.player, invite!.duel, true, 100);
  assert.equal(lastOf(a.socket, 'janken')?.kind, 'start');
  room.janken.throwHand(a.player, invite!.duel, 'rock', 200);
  room.janken.throwHand(a.player, invite!.duel, 'paper', 210); // a hand cannot be changed
  room.janken.throwHand(b.player, invite!.duel, 'scissors', 300);

  const result = lastOf(a.socket, 'janken');
  assert.equal(result?.kind, 'result');
  assert.equal(result?.winner, a.player.id);
  assert.equal(result?.mine, 'rock');
  assert.equal(result?.final, true);
  assert.equal(lastOf(b.socket, 'janken')?.mine, 'scissors');
  assert.equal(a.player.profile.jankenWins, 1);
  assert.equal(room.janken.inDuel(a.player.id), false);
  const events = flushEvents(room, a.socket);
  assert.ok(events.some((e) => e.k === 'janken' && e.winner === a.player.id));
});

test('janken: ties replay after a pause; a missing throw forfeits; leaving cancels; too far is refused', () => {
  const room = makeRoom();
  const a = join(room);
  const b = join(room);
  place(a.player, 64, 37);
  place(b.player, 66, 37);
  room.janken.challenge(a.player, b.player.id, 0);
  const duel = lastOf(b.socket, 'janken')!.duel;
  room.janken.respond(b.player, duel, true, 0);
  room.janken.throwHand(a.player, duel, 'rock', 10);
  room.janken.throwHand(b.player, duel, 'rock', 20);
  const tie = lastOf(a.socket, 'janken');
  assert.deepEqual([tie?.kind, tie?.winner, tie?.final], ['result', null, false]);
  room.janken.tick(1000);
  assert.equal(lastOf(a.socket, 'janken')?.kind, 'result', 'still showing the tie');
  room.janken.tick(2100);
  const again = lastOf(a.socket, 'janken');
  assert.deepEqual([again?.kind, again?.round], ['start', 2]);

  // B never throws: A wins by forfeit when the clock runs out.
  room.janken.throwHand(a.player, duel, 'paper', 2200);
  room.janken.tick(2100 + 8001);
  const forfeit = lastOf(a.socket, 'janken');
  assert.deepEqual([forfeit?.kind, forfeit?.winner, forfeit?.final], ['result', a.player.id, true]);

  room.janken.challenge(a.player, b.player.id, 20_000);
  room.removePlayer(b.player.id, 'test', { closeSession: false });
  assert.deepEqual([lastOf(a.socket, 'janken')?.kind, lastOf(a.socket, 'janken')?.reason], ['cancelled', 'left']);

  const c = join(room);
  place(c.player, 64, -37);
  room.janken.challenge(a.player, c.player.id, 30_000);
  assert.equal(lastOf(a.socket, 'error')?.key, 'too_far');
});

// ---------------------------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------------------------

test('quiz: gathers the plaza, judges by where people stand, crowns the last one standing', () => {
  assert.ok(QUIZ_ARENA, 'the island has an arena');
  const room = makeRoom(() => 0);
  const a = join(room);
  const b = join(room);
  const far = join(room);
  place(a.player, QUIZ_ARENA!.o.x, QUIZ_ARENA!.o.z);
  place(b.player, QUIZ_ARENA!.x.x, QUIZ_ARENA!.x.z);
  place(far.player, 0, 74);

  const quiz = room.activities.createFromTemplate('island-quiz', Date.now() - 1000);
  room.activities.sweep(Date.now());
  assert.equal(quiz.state, ActivityState.Live);
  room.forceTick(); // flush the lobby view
  const lobby = of(a.socket, 'delta').map((d) => d.quiz).filter(Boolean).pop();
  assert.equal(lobby?.phase, 'lobby');

  // Drive the runner on its own clock through the (private) room tick by moving time forward.
  const t0 = lobby!.endsAt;
  const runner = (room as unknown as { quiz: { tick(n: number): void; view(): import('@nagisa/shared').QuizView } }).quiz;
  runner.tick(t0);
  let view = runner.view();
  assert.equal(view.phase, 'question');
  assert.deepEqual(new Set(view.alive), new Set([a.player.id, b.player.id]), 'the far player is not in it');
  const q = getQuizQuestion(view.questionId!)!;
  assert.ok(q);

  runner.tick(t0 + QUESTION_MS);
  view = runner.view();
  assert.equal(view.phase, 'reveal');
  const right = q.answer ? a.player.id : b.player.id;
  const wrong = q.answer ? b.player.id : a.player.id;
  assert.deepEqual(view.alive, [right]);
  assert.deepEqual(view.fell, [wrong]);

  runner.tick(t0 + QUESTION_MS + REVEAL_MS);
  view = runner.view();
  assert.equal(view.phase, 'finished');
  assert.deepEqual(view.winners, [right]);
  const winner = right === a.player.id ? a.player : b.player;
  assert.ok(winner.profile.badges.includes('quiz-champ'));
  assert.equal(winner.profile.quizWins, 1);

  runner.tick(t0 + QUESTION_MS + REVEAL_MS + FINISHED_MS);
  room.forceTick();
  assert.equal(quiz.state, ActivityState.Ended, 'the activity ends with the quiz');
  const cleared = of(a.socket, 'delta').filter((d) => d.quiz !== undefined).pop();
  assert.equal(cleared?.quiz, null);
});

test('quiz: when everyone is wrong nobody goes out', () => {
  const room = makeRoom(() => 0);
  const a = join(room);
  const b = join(room);
  place(a.player, QUIZ_ARENA!.o.x, QUIZ_ARENA!.o.z);
  place(b.player, QUIZ_ARENA!.o.x, QUIZ_ARENA!.o.z);
  const quiz = room.activities.createFromTemplate('island-quiz', Date.now() - 1000);
  room.activities.sweep(Date.now());
  assert.equal(quiz.state, ActivityState.Live);
  const runner = (room as unknown as { quiz: { tick(n: number): void; view(): import('@nagisa/shared').QuizView } }).quiz;
  const t0 = runner.view().endsAt;
  runner.tick(t0);
  const q = getQuizQuestion(runner.view().questionId!)!;
  // Both stand in the wrong circle.
  const wrongCircle = q.answer ? QUIZ_ARENA!.x : QUIZ_ARENA!.o;
  place(a.player, wrongCircle.x, wrongCircle.z);
  place(b.player, wrongCircle.x, wrongCircle.z);
  runner.tick(t0 + QUESTION_MS);
  const view = runner.view();
  assert.equal(view.phase, 'reveal');
  assert.deepEqual(view.fell, []);
  assert.equal(view.replay, true, 'the reveal says why nobody fell');
  assert.equal(view.alive.length, 2);

  // Next round: B drops. Even if A is wrong again, B — who cannot answer — is out.
  runner.tick(t0 + QUESTION_MS + REVEAL_MS);
  const q2 = getQuizQuestion(runner.view().questionId!)!;
  const wrong2 = q2.answer ? QUIZ_ARENA!.x : QUIZ_ARENA!.o;
  place(a.player, wrong2.x, wrong2.z);
  room.disconnect(b.player.id);
  runner.tick(t0 + QUESTION_MS * 2 + REVEAL_MS);
  const view2 = runner.view();
  assert.deepEqual(view2.fell, [b.player.id], 'the absent player falls');
  assert.deepEqual(view2.alive, [a.player.id], 'the present one is spared by the house rule');
  assert.ok(QUIZ_BANK.length >= 8, 'enough statements for a whole quiz');
});

// ---------------------------------------------------------------------------------------------
// Bells, omikuji, stamps, dice
// ---------------------------------------------------------------------------------------------

/** A small seeded generator, for tests that need varied but repeatable randomness. */
function seeded(seed = 1): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

test('treasure: buried apart on open ground, the sand says how close, finds score and the last one ends it', () => {
  const room = makeRoom(seeded(7));
  const a = join(room);
  const b = join(room);

  room.treasure.dig(a.player, 0);
  assert.equal(lastOf(a.socket, 'error')?.key, 'no_hunt', 'nothing to dig for yet');

  const hunt = room.activities.createFromTemplate('treasure-hunt', Date.now() - 1000);
  room.activities.sweep(Date.now());
  assert.equal(hunt.state, ActivityState.Live);
  const spots = (room.treasure as unknown as { spots: Array<{ x: number; z: number }> }).spots.map((s) => ({ ...s }));
  assert.equal(spots.length, TREASURE_COUNT);
  for (const s of spots) assert.ok(isWalkable(s.x, s.z), 'buried on ground you can stand on');
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) assert.ok(Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z) >= 30);
  }
  assert.equal(hunt.toView().left, TREASURE_COUNT);

  // Near one but not on it: the heat is the distance's.
  place(a.player, spots[0].x + 6, spots[0].z);
  const near = Math.min(...spots.map((s) => Math.hypot(s.x - a.player.pos[0], s.z - a.player.pos[2])));
  room.treasure.dig(a.player, 10_000);
  const told = lastOf(a.socket, 'dig');
  assert.equal(told?.result, near <= 2.5 ? 'found' : digHeat(near));
  if (told?.result !== 'found') {
    const events = flushEvents(room, b.socket);
    assert.ok(events.some((e) => e.k === 'dig' && e.by === a.player.id), 'everyone sees the spade go in');
  }

  // Too soon.
  room.treasure.dig(a.player, 10_000 + DIG_COOLDOWN_MS - 1);
  assert.equal(lastOf(a.socket, 'error')?.key, 'cooldown');

  // On it: found, scored, on the card, and news for everyone.
  a.player.profile.treasures = 2; // Two from earlier hunts: this one makes a Treasure Hunter.
  const remaining = () => (room.treasure as unknown as { spots: Array<{ x: number; z: number }> }).spots;
  const target = remaining()[0];
  place(a.player, target.x, target.z);
  room.treasure.dig(a.player, 20_000);
  assert.deepEqual(lastOf(a.socket, 'dig'), { t: 'dig', result: 'found', left: TREASURE_COUNT - 1 });
  const events = flushEvents(room, b.socket);
  assert.ok(events.some((e) => e.k === 'treasure' && e.by === a.player.id && e.left === TREASURE_COUNT - 1));
  assert.equal(a.player.profile.treasures, 3);
  assert.ok(a.player.profile.badges.includes('treasure'));
  assert.deepEqual(hunt.board, [{ id: a.player.id, name: a.player.name, score: 1 }]);

  // Somebody else digs up the rest; the last one ends the hunt and the island hears who won.
  let t = 30_000;
  while (remaining().length) {
    const next = remaining()[0];
    place(b.player, next.x, next.z);
    room.treasure.dig(b.player, (t += DIG_COOLDOWN_MS));
  }
  assert.equal(hunt.state, ActivityState.Ended);
  assert.equal(b.player.profile.treasures, TREASURE_COUNT - 1);
  assert.equal(hunt.board?.[0]?.id, b.player.id, 'most finds leads the board');
  room.forceTick();
  const podium = of(a.socket, 'delta').flatMap((d) => d.announcements ?? []).find((an) => an.text.startsWith('💎'));
  assert.ok(podium && podium.text.includes(b.player.name), JSON.stringify(podium));

  room.treasure.dig(a.player, (t += DIG_COOLDOWN_MS));
  assert.equal(lastOf(a.socket, 'error')?.key, 'no_hunt', 'nothing left once it is over');
});

test('treasure: one hunt at a time, and a restart ends one that was running', async () => {
  const room = makeRoom(seeded(3));
  const first = room.activities.createFromTemplate('treasure-hunt', Date.now() - 2000);
  const second = room.activities.createFromTemplate('treasure-hunt', Date.now() - 1000);
  room.activities.sweep(Date.now());
  await Promise.resolve();
  assert.equal(first.state, ActivityState.Live);
  assert.equal(second.state, ActivityState.Ended, 'the second is called off rather than left doing nothing');
  assert.equal(room.treasure.running, first.id);

  const after = makeRoom(seeded(3));
  after.restoreState(room.exportState());
  assert.equal(after.activities.get(first.id)?.state, ActivityState.Ended, 'the spots were never written down');

  // Buried spots are reachable from the harbour for any seed.
  for (let seed = 1; seed <= 20; seed++) assert.equal(bury(TREASURE_COUNT, seeded(seed)).length, TREASURE_COUNT, `seed ${seed}`);
});

test('bells ring for everyone, and rest between rings', () => {
  const room = makeRoom();
  const { player, socket } = join(room);
  const bell = interactablesWith('ring_bell')[0];
  room.interactions.ringBell(player, bell, 0);
  room.interactions.ringBell(player, bell, BELL_REST_MS - 1);
  assert.equal(lastOf(socket, 'error')?.key, 'cooldown');
  room.interactions.ringBell(player, bell, BELL_REST_MS);
  const events = flushEvents(room, socket);
  assert.equal(events.filter((e) => e.k === 'bell').length, 2);
});

test('omikuji: one slip a day, the same one again, and 大吉 earns Lucky Star', () => {
  const room = makeRoom(() => 0); // index 0: 大吉
  const { player, socket } = join(room);
  const now = Date.now();
  room.interactions.drawOmikuji(player, now);
  const first = lastOf(socket, 'omikuji');
  assert.deepEqual([first?.fortune, first?.again], [0, false]);
  assert.equal(player.profile.omikuji?.day, jstDay(now));
  assert.ok(player.profile.badges.includes('lucky'));
  assert.equal(player.profile.title, 'lucky', 'the first badge is worn');

  room.interactions.drawOmikuji(player, now + 1000);
  const again = lastOf(socket, 'omikuji');
  assert.deepEqual([again?.fortune, again?.again], [0, true]);
  const events = flushEvents(room, socket);
  assert.equal(events.filter((e) => e.k === 'omikuji').length, 1, 'announced once');
});

test('stamps: one per place, refused twice, the full card earns Island Walker', () => {
  const room = makeRoom();
  const { player, socket } = join(room);
  const stands = interactablesWith('stamp');
  assert.equal(stands.length, STAMP_ZONES.length);
  room.interactions.stamp(player, stands[0]);
  room.interactions.stamp(player, stands[0]);
  assert.equal(lastOf(socket, 'error')?.key, 'already_stamped');
  for (const s of stands.slice(1)) room.interactions.stamp(player, s);
  assert.equal(player.profile.stamps.length, STAMP_ZONES.length);
  assert.ok(player.profile.badges.includes('walker'));
  const events = flushEvents(room, socket);
  assert.equal(events.filter((e) => e.k === 'stamp' && e.complete).length, 1);
});

test('dice: sides validated, value in range, cooldown', () => {
  const room = makeRoom(() => 0.999999);
  const { player, socket } = join(room);
  room.interactions.roll(player, 1, 0);
  assert.equal(lastOf(socket, 'error')?.key, 'invalid');
  room.interactions.roll(player, 6, 0);
  room.interactions.roll(player, 6, 1000);
  assert.equal(lastOf(socket, 'error')?.key, 'cooldown');
  const events = flushEvents(room, socket);
  const dice = events.find((e) => e.k === 'dice');
  assert.ok(dice && dice.k === 'dice' && dice.value === 6 && dice.sides === 6);
});

// ---------------------------------------------------------------------------------------------
// Guestbook
// ---------------------------------------------------------------------------------------------

test('guestbook: only at a board, one line per 30 s, capped, and only the author or an admin can remove', () => {
  const room = makeRoom();
  const { player, socket } = join(room);
  const other = join(room);
  room.guestbook.write(player, 'hello', 0);
  assert.equal(lastOf(socket, 'error')?.key, 'not_here');

  const board = interactablesWith('read_announcements')[0];
  standAt(player, board.id);
  standAt(other.player, board.id);
  room.guestbook.write(player, '   ', 0);
  assert.equal(lastOf(socket, 'error')?.key, 'empty');
  room.guestbook.write(player, 'x'.repeat(81), 0);
  assert.equal(lastOf(socket, 'error')?.key, 'too_long');
  room.guestbook.write(player, 'hello island', 0);
  room.guestbook.write(player, 'again', GUESTBOOK_COOLDOWN_MS - 1);
  assert.equal(lastOf(socket, 'error')?.key, 'cooldown');
  assert.equal(room.guestbook.view().length, 1);

  const id = room.guestbook.view()[0].id;
  room.guestbook.remove(other.player, id);
  assert.equal(lastOf(other.socket, 'error')?.key, 'forbidden');
  room.guestbook.remove(player, id);
  assert.equal(room.guestbook.view().length, 0);

  // The cap: older lines fall off, and the delta says so.
  for (let i = 0; i < GUESTBOOK_LIMIT + 3; i++) {
    const w = join(room);
    standAt(w.player, board.id);
    room.guestbook.write(w.player, `line ${i}`, 0);
  }
  assert.equal(room.guestbook.view().length, GUESTBOOK_LIMIT);
  room.forceTick();
  const d = lastOf(socket, 'delta');
  assert.equal(d?.guestbook?.length, GUESTBOOK_LIMIT, 'added lines that were immediately pushed off are not sent');
});

// ---------------------------------------------------------------------------------------------
// Fireworks
// ---------------------------------------------------------------------------------------------

test('fireworks: only from a shore, per-player cooldown, room cap, and the show runs while live', () => {
  assert.ok(FIREWORKS);
  const room = makeRoom();
  const { player, socket } = join(room);
  place(player, 64, 37); // the plaza is not a shore
  player.zone = 'plaza';
  room.fireworks.launch(player, 0);
  assert.equal(lastOf(socket, 'error')?.key, 'not_here');

  const beach = getZone('beach')!;
  place(player, beach.x, beach.z);
  player.zone = 'beach';
  room.fireworks.launch(player, 0);
  room.fireworks.launch(player, PLAYER_COOLDOWN_MS - 1);
  assert.equal(lastOf(socket, 'error')?.key, 'cooldown');

  // Room cap: many people at once.
  for (let i = 0; i < ROOM_BURST + 2; i++) {
    const p = join(room);
    place(p.player, beach.x, beach.z);
    p.player.zone = 'beach';
    room.fireworks.launch(p.player, 1000);
  }
  const events = flushEvents(room, socket);
  const fw = events.filter((e) => e.k === 'firework');
  assert.equal(fw.length, ROOM_BURST, 'no more than the cap in the window');
  for (const e of fw) if (e.k === 'firework') assert.ok(e.h >= 28 && e.h <= 42 && e.pattern >= 0 && e.pattern < 4);

  const show = room.activities.createFromTemplate('fireworks', Date.now() - 1000);
  room.activities.sweep(Date.now());
  assert.equal(show.state, ActivityState.Live);
  room.fireworks.tick(100_000);
  const showEvents = flushEvents(room, socket);
  assert.ok(showEvents.some((e) => e.k === 'firework' && e.by === null), 'the show sends its own');
});

// ---------------------------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------------------------

test('seats: one person per seat; freed by standing, walking off or leaving', () => {
  const room = makeRoom();
  const a = join(room);
  const b = join(room);
  const seat = 'plaza-bench';
  assert.equal(room.sit(a.player, seat), true);
  assert.equal(room.sit(b.player, seat), false);
  assert.equal(lastOf(b.socket, 'error')?.key, 'seat_taken');

  place(a.player, 0, 0);
  room.onMoved(a.player);
  assert.equal(room.seatHolder(seat), undefined, 'walking off frees it');
  assert.equal(room.sit(b.player, seat), true);
  room.removePlayer(b.player.id, 'test', { closeSession: false });
  assert.equal(room.seatHolder(seat), undefined, 'leaving frees it');
});

// ---------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------

test('schedule: the programme is put on the board once per slot, however often it runs', () => {
  const room = makeRoom();
  const now = Date.now();
  const first = materialiseProgramme(room.activities, now);
  assert.ok(first > 0, 'something is on');
  assert.equal(materialiseProgramme(room.activities, now), 0, 'idempotent');
  assert.equal(materialiseProgramme(room.activities, now + 1000), 0);
  // Every materialised activity is from the programme and not already over.
  for (const a of room.activities.list()) {
    assert.ok(PROGRAMME.some((p) => p.template === a.templateId));
    assert.ok((a.endsAt ?? 0) > now);
  }
  // Survives a restart: restoring the exported state and running again adds nothing.
  const state = room.exportState();
  const again = makeRoom();
  again.restoreState(state);
  assert.equal(materialiseProgramme(again.activities, now), 0);
});

// ---------------------------------------------------------------------------------------------
// Private islands
// ---------------------------------------------------------------------------------------------

function makeManager(persisted?: ConstructorParameters<typeof RoomManager>[0]['persisted']): RoomManager {
  return new RoomManager({ log, roomCapacity: 50, privateCapacity: 10, initialRoomCount: 1, persist: () => {}, persisted, autostart: false });
}

test('private islands: made with a code, kept by their maker, reopened from the code after sleeping', () => {
  const rooms = makeManager();
  const hash = hashVisitorKey('abcdefghijklmnopqrstuvwx')!;
  const island = rooms.createPrivate({ hash, name: 'Mio', playerId: 'p-mio' })!;
  assert.ok(island.code && /^[2-9A-HJKMNP-Z]{5}$/.test(island.code));
  assert.equal(island.kind, 'private');

  // The keeper is admin there, a guest elsewhere; a stranger is a guest there.
  const keeper = new Player('k', 'Mio', { outfit: 0, skin: 0, accessory: 0 }, Role.Guest, { pos: [0, 0, 0], yaw: 0 });
  keeper.visitorHash = hash;
  const stranger = new Player('s', 'Sam', { outfit: 0, skin: 0, accessory: 0 }, Role.Guest, { pos: [0, 0, 0], yaw: 0 });
  assert.equal(island.roleFor(keeper), Role.Admin);
  assert.equal(island.roleFor(stranger), Role.Guest);
  assert.equal(rooms.list()[0].roleFor(keeper), Role.Guest);

  // Not listed to strangers; listed to whoever is on it.
  assert.ok(!rooms.listViews().some((v) => v.kind === 'private'));
  assert.ok(rooms.listViews(island).some((v) => v.code === island.code));

  // Found by code (any case, with spaces); a code nobody made opens nothing.
  const found = rooms.resolve(island.code!.toLowerCase().split('').join(' '));
  assert.ok('room' in found && found.room === island);
  const unknown = rooms.resolve(island.code === 'ZZZZZ' ? 'YYYYY' : 'ZZZZZ');
  assert.deepEqual(unknown, { refusal: 'not_found' });

  // Sleeps when empty long enough; its state and keeper come back with the code.
  island.emptySince = Date.now() - IDLE_MS - 1;
  assert.equal(rooms.sweepIdle(), 1);
  assert.equal(rooms.get(islandRoomId(island.code!)), undefined);
  const exported = { rooms: rooms.exportRooms(), islands: rooms.exportIslands() };
  const after = makeManager(exported);
  const back = after.resolve(island.code!);
  assert.ok('room' in back);
  assert.equal(back.room.roleFor(keeper), Role.Admin, 'still theirs after a restart');
});

test('matchmaking never puts a stranger on a private island', () => {
  const rooms = makeManager();
  rooms.createPrivate({ hash: null, name: 'A', playerId: 'a' });
  for (let i = 0; i < 5; i++) assert.equal(rooms.pickRoom().room.kind, 'public');
});

// ---------------------------------------------------------------------------------------------
// Persistence and profiles
// ---------------------------------------------------------------------------------------------

test('persistence: a v1 file migrates onto the first shard', () => {
  const v1 = { firstBootAt: 5, activities: [{ id: 'a1' }], announcements: [{ id: 'n1' }], audit: [] };
  const state = migrate(v1);
  assert.equal(state.version, 2);
  assert.equal(state.firstBootAt, 5);
  assert.equal(state.rooms['shore-1'].activities.length, 1);
  assert.equal(state.rooms['shore-1'].announcements.length, 1);
  assert.deepEqual(state.islands, []);
});

test('profiles: keys hash, malformed keys are no key, the store is bounded', () => {
  assert.equal(hashVisitorKey('short'), null);
  assert.equal(hashVisitorKey('has spaces in it, sadly!'), null);
  const h = hashVisitorKey('abcdefghijklmnop');
  assert.ok(h && h.length === 64 && h !== 'abcdefghijklmnop');
  const store = new ProfileStore();
  for (let i = 0; i < 10; i++) store.forVisitor(`h${i}`, i);
  const kept = store.export(4);
  assert.deepEqual(Object.keys(kept).sort(), ['h6', 'h7', 'h8', 'h9']);
  assert.deepEqual(newProfile(0).badges, []);
});
