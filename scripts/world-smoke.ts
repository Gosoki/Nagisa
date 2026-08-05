/**
 * World generation smoke test.
 * ============================
 *
 * Exercises everything that builds the island *except* the WebGL context, in Node.
 *
 * This is worth having because the failure modes of procedural geometry are silent: a
 * `NaN` in one vertex of the terrain does not throw, it produces a mesh that Three.js
 * uploads happily and the GPU renders as a black hole across the screen — or, worse, a
 * bounding sphere of `NaN` that makes the whole mesh vanish. None of that is visible to a
 * type checker, and none of it is visible to the server tests either.
 *
 * Three.js's geometry classes need no WebGL and no DOM, so all of this runs headless.
 *
 * Bundled by `scripts/world-smoke.mjs` and executed there.
 */

import * as THREE from 'three';
import {
  ISLAND_EXTENT,
  MAX_CLIENT_SPEED,
  MAX_SERVER_SPEED,
  MAX_WADE_DEPTH,
  MAX_WALKABLE_SLOPE,
  MOVE_SPEED,
  slopeAt,
  LANDMARKS,
  PADS,
  ZONES,
  crowdSlot,
  heightAt,
  isWalkable,
  normalAt,
  spawnPoint,
  zoneAt,
} from '@nagisa/shared';
import { buildTerrain } from '../apps/client/src/world/terrain.worker.js';
import { Scatter } from '../apps/client/src/world/scatter.js';
import { createLandmark, knownLandmarkKinds } from '../apps/client/src/world/props/index.js';
import { Character } from '../apps/client/src/character/character.js';
import { QUALITY_PRESETS } from '../apps/client/src/engine/quality.js';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (ok) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.log(`  ✘ ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 300)}`);
  }
}

/** Scan a typed array for non-finite values, returning the first offending index. */
function firstNonFinite(array: ArrayLike<number>): number {
  for (let i = 0; i < array.length; i++) {
    if (!Number.isFinite(array[i])) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
console.log('\nTerrain field');
// ---------------------------------------------------------------------------

{
  // Dense sweep of the whole meshed area, plus well beyond it.
  let nonFinite = 0;
  let min = Infinity;
  let max = -Infinity;
  const step = 4;
  for (let x = -ISLAND_EXTENT - 60; x <= ISLAND_EXTENT + 60; x += step) {
    for (let z = -ISLAND_EXTENT - 60; z <= ISLAND_EXTENT + 60; z += step) {
      const h = heightAt(x, z);
      if (!Number.isFinite(h)) nonFinite++;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  check('heightAt is finite everywhere', nonFinite === 0, { nonFinite });
  check('height range is plausible', min > -200 && max > 30 && max < 140, { min, max });

  let badNormals = 0;
  for (let i = 0; i < 400; i++) {
    const x = (Math.random() * 2 - 1) * ISLAND_EXTENT;
    const z = (Math.random() * 2 - 1) * ISLAND_EXTENT;
    const n = normalAt(x, z);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!Number.isFinite(len) || Math.abs(len - 1) > 1e-6 || n[1] <= 0) badNormals++;
  }
  check('normals are unit length and point upward', badNormals === 0, { badNormals });

  // Determinism: the same coordinate must give the same height, every time, forever.
  const sample = () => [heightAt(12.5, -33.25), heightAt(-98, 104), heightAt(112, -78)];
  const a = sample();
  const b = sample();
  check('heightAt is deterministic', JSON.stringify(a) === JSON.stringify(b), { a, b });
}

// ---------------------------------------------------------------------------
console.log('\nWorld layout');
// ---------------------------------------------------------------------------

{
  // `coast` is the catch-all fallback: its radius covers the world and its anchor is
  // nominal, so "does the anchor resolve to this zone" is not a meaningful question for it.
  const misplaced = ZONES.filter((z) => z.id !== 'coast' && zoneAt(z.x, z.z) !== z.id);
  check('every zone anchor resolves to its own zone', misplaced.length === 0, misplaced.map((z) => z.id));

  const unwalkable = ZONES.filter((z) => z.id !== 'coast' && !isWalkable(z.x, z.z));
  check('every zone anchor is walkable', unwalkable.length === 0, unwalkable.map((z) => z.id));

  const padMismatch = PADS.filter((p) => Math.abs(heightAt(p.x, p.z) - p.height) > 0.35);
  check('gathering pads are flattened to their target height', padMismatch.length === 0,
    padMismatch.map((p) => ({ id: p.id, want: p.height, got: heightAt(p.x, p.z) })));

  const spawns = [0, 1, 2, 3, 4, 5].map((i) => spawnPoint(i));
  check('all spawn points are on the south harbour quay', spawns.every((s) => zoneAt(s.pos[0], s.pos[2]) === 'south-harbor'),
    spawns.map((s) => zoneAt(s.pos[0], s.pos[2])));
  check('all spawn points are walkable', spawns.every((s) => isWalkable(s.pos[0], s.pos[2])));

  // Crowd slots must land on ground people can actually stand on.
  const venues = ZONES.filter((z) => z.kind === 'venue');
  let badSlots = 0;
  for (const venue of venues) {
    for (let i = 0; i < 24; i++) {
      const slot = crowdSlot(venue.id, i);
      if (!slot || !isWalkable(slot.x, slot.z)) badSlots++;
    }
  }
  check('crowd slots at every venue are walkable', badSlots === 0, { badSlots });
}

// ---------------------------------------------------------------------------
console.log('\nTerrain mesh');
// ---------------------------------------------------------------------------

{
  const result = buildTerrain({ resolution: 120 });
  const tris = result.indices.length / 3;

  check('positions are all finite', firstNonFinite(result.positions) === -1, {
    at: firstNonFinite(result.positions),
  });
  check('normals are all finite', firstNonFinite(result.normals) === -1);
  check('colors are all finite', firstNonFinite(result.colors) === -1);
  check('colors are within [0,1]', Array.from(result.colors).every((c) => c >= 0 && c <= 1));

  const maxIndex = result.positions.length / 3 - 1;
  let outOfRange = 0;
  for (let i = 0; i < result.indices.length; i++) {
    if (result.indices[i] > maxIndex) outOfRange++;
  }
  check('every index is in range', outOfRange === 0, { outOfRange, maxIndex });
  check('triangle count matches the grid', tris === (120 - 1) * (120 - 1) * 2, { tris });

  // The bounding sphere is what culling depends on; NaN here makes the island vanish.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
  geo.computeBoundingSphere();
  check('bounding sphere is finite',
    !!geo.boundingSphere && Number.isFinite(geo.boundingSphere.radius) && geo.boundingSphere.radius > 100,
    { radius: geo.boundingSphere?.radius });
}

// ---------------------------------------------------------------------------
console.log('\nLandmarks');
// ---------------------------------------------------------------------------

{
  const failed: string[] = [];
  let totalTris = 0;
  let floating = 0;

  for (const landmark of LANDMARKS) {
    try {
      const group = createLandmark(landmark.kind, landmark.opts as Record<string, unknown> | undefined);
      const box = new THREE.Box3().setFromObject(group);
      if (!Number.isFinite(box.min.y) || !Number.isFinite(box.max.y)) {
        failed.push(`${landmark.id}: non-finite bounds`);
        continue;
      }
      // The base-centre-origin contract: props are dropped onto terrain by setting y,
      // so anything whose geometry starts well above 0 would hover.
      if (box.min.y > 0.5) floating++;

      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const index = obj.geometry.getIndex();
          const count = index ? index.count : obj.geometry.getAttribute('position').count;
          totalTris += count / 3;
          if (firstNonFinite(obj.geometry.getAttribute('position').array as Float32Array) !== -1) {
            failed.push(`${landmark.id}: non-finite vertex`);
          }
        }
      });
    } catch (err) {
      failed.push(`${landmark.id}: ${String(err)}`);
    }
  }

  check(`all ${LANDMARKS.length} landmarks build`, failed.length === 0, failed.slice(0, 5));
  check('no landmark floats above its base', floating === 0, { floating });
  // Budget raised for world model v2: 123 landmarks with stepped tile courses, framed
  // walls and plank decks, against v1's 48 box-and-wedge props. ~570 triangles per
  // landmark is the target; the ceiling here is a little over double that so a single
  // detailed building does not trip it, and well under the point where the island stops
  // fitting in a mobile vertex budget.
  check('total landmark geometry is within budget', totalTris < 160_000, { totalTris: Math.round(totalTris) });
  console.log(`      ${LANDMARKS.length} landmarks, ${Math.round(totalTris)} triangles total`);

  // Buildings are placed at a single height sample, so ground that varies across a
  // footprint puts one corner in the air. `island.ts` fits a foundation as a backstop, but
  // a foundation deep enough to hide a real slope is a retaining wall — so the layout is
  // required to put buildings on level ground in the first place.
  // `node tools/flatness.mjs` reports the same numbers with names attached.
  const FOOTPRINT: Record<string, [number, number]> = {
    lighthouse: [7, 7], stage: [14, 10], 'bell-tower': [3.4, 3.4], gate: [5.5, 0.6],
    torii: [6, 0.6], well: [2.6, 2.6], 'notice-board': [3.6, 0.5], temizuya: [3.8, 3.2],
    komainu: [1.6, 1.4], 'market-stall': [3.4, 2.6], 'net-rack': [1.6, 5], banner: [1.2, 1.2],
    'post-lantern': [0.8, 0.8], 'stone-lantern': [1.4, 1.4], bench: [2.4, 0.8],
    'summit-marker': [1.6, 1.6], 'beach-hut': [8, 6], minka: [12, 10], machiya: [9, 12],
    warehouse: [13, 9], teahouse: [12, 9], bathhouse: [15, 12], 'keepers-house': [11, 8],
    'shrine-hall': [14, 11],
  };
  const EXEMPT_FROM_FLATNESS = new Set(['pier', 'boat', 'breakwater', 'boathouse', 'rock', 'sea-wall', 'steps', 'rail']);
  const uneven: { id: string; drop: number }[] = [];
  for (const landmark of LANDMARKS) {
    if (EXEMPT_FROM_FLATNESS.has(landmark.kind) || landmark.opts?.inWater) continue;
    const [dw, dd] = FOOTPRINT[landmark.kind] ?? [3, 3];
    const scale = landmark.scale ?? 1;
    const w = (Number(landmark.opts?.w ?? dw) * scale) / 2;
    const d = (Number(landmark.opts?.d ?? dd) * scale) / 2;
    const cos = Math.cos(landmark.rot);
    const sin = Math.sin(landmark.rot);
    let min = Infinity;
    let max = -Infinity;
    for (const [ox, oz] of [[-w, -d], [w, -d], [-w, d], [w, d], [0, 0]] as const) {
      const h = heightAt(landmark.x + ox * cos - oz * sin, landmark.z + ox * sin + oz * cos);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    if (max - min > 0.45) uneven.push({ id: landmark.id, drop: Math.round((max - min) * 100) / 100 });
  }
  check('every building stands on level ground', uneven.length === 0, uneven.slice(0, 8));

  const unknown = createLandmark('not-a-real-kind' as never);
  check('an unknown landmark kind degrades to an empty group', unknown.children.length === 0);

  // Data and geometry live in different packages and can be edited in either order; this
  // is what turns "someone added a landmark kind and forgot the builder" from an
  // invisible missing building into a failed build.
  const buildable = new Set(knownLandmarkKinds());
  const missing = [...new Set(LANDMARKS.map((l) => l.kind))].filter((k) => !buildable.has(k));
  check('every landmark kind used by the world has a builder', missing.length === 0, missing);
}

// ---------------------------------------------------------------------------
console.log('\nWalkability contract');
// ---------------------------------------------------------------------------
//
// The client predicts movement and the server validates it. Both sides have to enforce
// the *same* rule, and when they do not, the symptom is not a subtle physics difference —
// it is the player being teleported at random while running, with nothing in the logs to
// say why. These checks are what makes that failure loud instead of mysterious.

{
  // 1 — Simulate the client's integrator against the server's validator.
  //
  // Walk long straight lines out from every zone in every direction, at running speed,
  // moving only where the client's rule (`canOccupy` — reproduced here as `isWalkable`
  // plus the strictly-improving escape hatch) allows, and assert the server would have
  // accepted every single position the client committed to.
  const illegality = (x: number, z: number): number =>
    Math.max(0, -heightAt(x, z) - MAX_WADE_DEPTH) + Math.max(0, slopeAt(x, z) - MAX_WALKABLE_SLOPE) * 10;

  const canOccupy = (fromX: number, fromZ: number, x: number, z: number): boolean => {
    if (isWalkable(x, z)) return true;
    const here = illegality(fromX, fromZ);
    return here > 0 && illegality(x, z) < here;
  };

  let committedIllegal = 0;
  let steps = 0;
  const stepLength = MOVE_SPEED.run / 60; // one 60 Hz tick at a run

  for (const zone of ZONES) {
    if (zone.radius > 900) continue;
    for (let a = 0; a < 16; a++) {
      const angle = (a / 16) * Math.PI * 2;
      let x = zone.x;
      let z = zone.z;
      for (let i = 0; i < 900; i++) {
        const nx = x + Math.cos(angle) * stepLength;
        const nz = z + Math.sin(angle) * stepLength;
        if (!canOccupy(x, z, nx, nz)) break;
        x = nx;
        z = nz;
        steps++;
        // This is the assertion that matters: the client committed to this position, so
        // the server must accept it.
        if (!isWalkable(x, z)) committedIllegal++;
      }
    }
  }

  check('every position the client would commit to is one the server accepts', committedIllegal === 0, {
    committedIllegal,
    steps,
  });
  check('the walk simulation actually moved', steps > 5000, { steps });

  // 2 — The client's own speed ceiling must sit inside the server's budget, with room for
  // the impulses (slides, jump carry) that arrive on top of steady-state running.
  check('client speed ceiling is inside the server budget', MAX_CLIENT_SPEED < MAX_SERVER_SPEED, {
    client: MAX_CLIENT_SPEED,
    server: MAX_SERVER_SPEED,
  });
  check('run speed is the client ceiling', MOVE_SPEED.run === MAX_CLIENT_SPEED, {
    run: MOVE_SPEED.run,
    ceiling: MAX_CLIENT_SPEED,
  });

  // 3 — Spawns must be legal, since a player who spawns illegally is corrected instantly.
  const spawnsLegal = [0, 1, 2, 3, 4, 5].every((i) => {
    const s = spawnPoint(i);
    return isWalkable(s.pos[0], s.pos[2]);
  });
  check('every spawn point satisfies the contract', spawnsLegal);
}

// ---------------------------------------------------------------------------
console.log('\nScatter');
// ---------------------------------------------------------------------------

{
  const scatter = new Scatter(QUALITY_PRESETS.high);
  check('scatter places a substantial number of instances', scatter.instanceCount > 3000, {
    instances: scatter.instanceCount,
  });
  // One InstancedMesh per species is the whole point of the scatterer: tens of thousands
  // of objects for a handful of draw calls.
  const scatterDrawCalls = scatter.group.children.length;
  check('scatter stays within a sane draw-call budget', scatterDrawCalls > 0 && scatterDrawCalls < 16, {
    drawCalls: scatterDrawCalls,
  });
  console.log(`      ${scatter.instanceCount} instances across ${scatterDrawCalls} draw calls`);

  // Determinism is the whole reason scatter is never networked: every client must
  // independently produce an identical island.
  const second = new Scatter(QUALITY_PRESETS.high);
  check('scatter is deterministic across runs', second.instanceCount === scatter.instanceCount, {
    first: scatter.instanceCount,
    second: second.instanceCount,
  });

  // Instance transforms must be finite, or an InstancedMesh silently disappears.
  let badMatrix = 0;
  scatter.group.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) {
      if (firstNonFinite(obj.instanceMatrix.array as Float32Array) !== -1) badMatrix++;
    }
  });
  check('all instance matrices are finite', badMatrix === 0, { badMatrix });

  scatter.dispose();
  second.dispose();
}

// ---------------------------------------------------------------------------
console.log('\nCharacters');
// ---------------------------------------------------------------------------

{
  let built = 0;
  let bad = 0;
  for (let outfit = 0; outfit < 8; outfit++) {
    for (let accessory = 0; accessory < 5; accessory++) {
      const c = new Character({ outfit, skin: outfit % 6, accessory });
      const box = new THREE.Box3().setFromObject(c.root);
      const height = box.max.y - box.min.y;
      // A character is 1.7 m; allow generous slack for hats and hoods.
      if (!Number.isFinite(height) || height < 1.2 || height > 2.4) bad++;
      built++;
      c.dispose();
    }
  }
  check(`all ${built} appearance combinations build at a plausible height`, bad === 0, { bad });
}

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
