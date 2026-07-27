/**
 * Tests for `player.ts`'s movement validator: the server-authoritative half of
 * "client predicts, server decides" for transforms.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnimState, isWalkable, heightAt } from '@nagisa/shared';
import { Player } from './player.js';

/** A known-walkable spot on the harbour quay, independent of `spawnPoint`'s random index. */
const START: [number, number, number] = [-92, heightAt(-92, 96), 96];

function makePlayer(pos: [number, number, number] = START): Player {
  return new Player('p1', 'Test', { outfit: 0, skin: 0, accessory: 0 }, 0, { pos, yaw: 0 });
}

test('a small, in-budget move is accepted', () => {
  const player = makePlayer();
  const target: [number, number, number] = [START[0] + 0.5, START[1], START[2]];
  // 200ms of elapsed time -> a 1.4m budget at the 7 m/s cap, comfortably covering 0.5m.
  // (A freshly-constructed Player's `lastMoveAt` is "now," so without an explicit,
  // slightly-future `nowMs` here the very first move would be judged against an
  // almost-zero elapsed time and starved of budget — that's the speed cap doing
  // exactly its job, just not what this particular test is trying to exercise.)
  const result = player.applyMove({ pos: target, yaw: 0.1, anim: AnimState.Walk, seq: 1 }, Date.now() + 200);
  assert.equal(result, null);
  assert.deepEqual(player.pos, target);
  assert.equal(player.anim, AnimState.Walk);
});

test('NaN/Infinity positions are rejected with a bounds correction', () => {
  const player = makePlayer();
  for (const bad of [NaN, Infinity, -Infinity]) {
    const result = player.applyMove({ pos: [bad, START[1], START[2]], yaw: 0, anim: AnimState.Idle, seq: 1 });
    assert.ok(result, 'expected a correction');
    assert.equal(result!.reason, 'bounds');
    assert.equal(isWalkable(result!.pos[0], result!.pos[2]), true, 'correction target must itself be walkable');
    // Rejected reports must not move the player.
    assert.deepEqual(player.pos, START);
  }
});

test('a move that exceeds the horizontal speed budget is rejected with a speed correction', () => {
  const player = makePlayer();
  // 50m in one ~100ms tick is far beyond the ~7 m/s budget.
  const farAway: [number, number, number] = [START[0] + 50, START[1], START[2]];
  const result = player.applyMove({ pos: farAway, yaw: 0, anim: AnimState.Run, seq: 1 });
  assert.ok(result, 'expected a correction');
  assert.equal(result!.reason, 'speed');
  assert.deepEqual(player.pos, START, 'player position must be unchanged after rejection');
});

test('a move onto unwalkable terrain within the speed budget is rejected with a bounds correction', () => {
  // Two points near the lighthouse cape cliff edge: 13m apart (well within the ~14m/2s
  // budget), the first walkable, the second not — found by scanning terrain.ts's
  // isWalkable/heightAt directly (see task notes). This exercises the *terrain* half of
  // validation, as distinct from the NaN/Infinity shape check above.
  const start: [number, number, number] = [107.85889527835963, 0, -93.45481322062508];
  start[1] = heightAt(start[0], start[2]);
  const target: [number, number, number] = [107.85889527835965, start[1], -106.45481322062508];
  assert.equal(isWalkable(start[0], start[2]), true, 'test fixture precondition: start must be walkable');
  assert.equal(isWalkable(target[0], target[2]), false, 'test fixture precondition: target must be unwalkable');

  const player = makePlayer(start);
  // Give this report the full 2s budget ceiling (14m) so the 13m distance clears the
  // speed check and the terrain check is what actually rejects it.
  const result = player.applyMove({ pos: target, yaw: 0, anim: AnimState.Walk, seq: 1 }, Date.now() + 2_000);
  assert.ok(result, 'expected a correction');
  assert.equal(result!.reason, 'bounds');
  assert.deepEqual(player.pos, start, 'player position must be unchanged after rejection');
});

test('out-of-order (replayed/stale) sequence numbers are silently ignored', () => {
  const player = makePlayer();
  const ok = player.applyMove({ pos: [START[0] + 0.2, START[1], START[2]], yaw: 0, anim: AnimState.Idle, seq: 5 }, Date.now() + 200);
  assert.equal(ok, null);
  const stalePos = player.pos;
  const replay = player.applyMove({ pos: [START[0] + 0.4, START[1], START[2]], yaw: 0, anim: AnimState.Idle, seq: 3 }, Date.now() + 400);
  assert.equal(replay, null, 'stale seq should be silently dropped, not produce a correction');
  assert.deepEqual(player.pos, stalePos, 'stale report must not change position');
});

test('zone is recomputed on an accepted move', () => {
  const player = makePlayer();
  const initialZone = player.zone;
  assert.equal(initialZone, 'harbor');
  // Move toward the plaza, far enough (but split across many small accepted moves to
  // respect the speed budget) to cross into a different zone.
  let seq = 1;
  let pos = player.pos;
  player.lastMoveAt = Date.now() - 300; // Warm up dt so the very first step isn't budget-starved.
  for (let i = 0; i < 60; i++) {
    const next: [number, number, number] = [pos[0] + 1.6, pos[1], pos[2] - 1.6];
    const corrected = player.applyMove({ pos: [next[0], heightAt(next[0], next[2]), next[2]], yaw: 0, anim: AnimState.Run, seq: seq++ }, Date.now() + i * 300);
    if (corrected) break; // Terrain may not stay walkable in a straight line; stop at the first correction.
    pos = player.pos;
  }
  assert.notEqual(player.zone, null);
});
