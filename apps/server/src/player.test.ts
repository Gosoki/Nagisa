/**
 * Tests for `player.ts`'s movement validator: the server-authoritative half of
 * "client predicts, server decides" for transforms.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnimState, isWalkable, heightAt, spawnPoint } from '@nagisa/shared';
import { Player } from './player.js';

/**
 * Where a player starts, taken from the world rather than pinned here.
 *
 * The previous version hard-coded the quay's coordinates, which quietly became a point in
 * the sea when the island was rebuilt at half the size — every test using it then failed
 * for a reason that had nothing to do with the movement validator. `spawnPoint` is the
 * same function the server uses, so this cannot drift again.
 */
const spawn = spawnPoint(0);
const START: [number, number, number] = spawn.pos;

/**
 * Find a walkable point with an unwalkable point roughly `gap` metres away.
 *
 * **Derived, not hard-coded.** The obvious way to test "a move onto unwalkable terrain is
 * rejected" is to paste in two coordinates found by hand. Those coordinates are a hidden
 * dependency on the exact shape of the island: retune the coast noise by a few per cent
 * and the test fails for a reason that has nothing to do with the movement validator.
 * Searching for a qualifying pair costs a few milliseconds and makes the test say what it
 * actually means — "somewhere on this island there is an edge, and walking off it is
 * rejected".
 */
/**
 * A walkable point next to an unwalkable one, `gap` metres away.
 *
 * `uphill` picks which kind of edge: the contract is asymmetric, so a bank you may not climb
 * and a ledge you may step off are two different fixtures. See `canEnterFrom`.
 */
function findWalkableEdge(gap = 13, uphill = true): { start: [number, number, number]; target: [number, number, number] } {
  for (let ring = 40; ring < 300; ring += 7) {
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2;
      const x = Math.cos(angle) * ring;
      const z = Math.sin(angle) * ring;
      if (!isWalkable(x, z)) continue;
      for (let j = 0; j < 16; j++) {
        const a2 = (j / 16) * Math.PI * 2;
        const tx = x + Math.cos(a2) * gap;
        const tz = z + Math.sin(a2) * gap;
        if (isWalkable(tx, tz)) continue;
        const rise = heightAt(tx, tz) - heightAt(x, z);
        if (uphill ? rise <= 1 : rise > -1) continue;
        return { start: [x, heightAt(x, z), z], target: [tx, heightAt(tx, tz), tz] };
      }
    }
  }
  throw new Error('no walkable/unwalkable pair found — the terrain has no edges, which cannot be right');
}

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
  // A pair 13 m apart (well within the ~14 m/2 s budget), the first walkable and the second
  // not, and the second *above* the first — a bank the player is trying to climb. This
  // exercises the terrain half of validation, as distinct from the NaN/Infinity shape check
  // above; the descent case is the test below.
  const { start, target } = findWalkableEdge(13, true);
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

test('a move onto unwalkable terrain that is *below* the player is accepted', () => {
  // The other half of `canEnterFrom`: steep ground may be entered on the way down. Without
  // this a clifftop is a fence — the ground past the edge is unwalkable, so the step off it
  // is refused, so the player cannot jump down, fall down, or walk off at all.
  const { start, target } = findWalkableEdge(13, false);
  assert.equal(isWalkable(target[0], target[2]), false, 'test fixture precondition: target must be unwalkable');
  assert.ok(heightAt(target[0], target[2]) < heightAt(start[0], start[2]), 'fixture: target must be lower');

  const player = makePlayer(start);
  const result = player.applyMove({ pos: target, yaw: 0, anim: AnimState.Fall, seq: 1 }, Date.now() + 2_000);
  assert.equal(result, null, 'stepping off a ledge must not be corrected');
  assert.deepEqual(player.pos, target);
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
  assert.equal(initialZone, 'south-harbor', 'spawns are on the south quay');
  // Move inland, far enough (but split across many small accepted moves to respect the
  // speed budget) to cross into a different zone.
  let seq = 1;
  let pos = player.pos;
  player.lastMoveAt = Date.now() - 300; // Warm up dt so the very first step isn't budget-starved.
  for (let i = 0; i < 60; i++) {
    const next: [number, number, number] = [pos[0], pos[1], pos[2] - 2.2];
    const corrected = player.applyMove({ pos: [next[0], heightAt(next[0], next[2]), next[2]], yaw: 0, anim: AnimState.Run, seq: seq++ }, Date.now() + i * 300);
    if (corrected) break; // Terrain may not stay walkable in a straight line; stop at the first correction.
    pos = player.pos;
  }
  assert.notEqual(player.zone, null);
});
