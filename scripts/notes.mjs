#!/usr/bin/env node
/**
 * Print the placement notes.
 * =========================
 *
 *     npm run notes            # everything, oldest first
 *     npm run notes -- --new   # only what has not been marked done
 *
 * The notes are written from inside the world (see `apps/server/src/notes.ts` and the
 * placement-notes panel) and read here, which is the point of them: they are made while
 * playing and used while editing the map, and those are different days.
 *
 * Each one prints as something you can act on without going back into the game — the
 * landmark's id, the place, the position, and a `--map`-ready probe viewpoint for the exact
 * frame it was written from.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = process.env.DEV_NOTES_PATH ?? resolve(root, 'dev-notes.jsonl');

let raw = '';
try {
  raw = readFileSync(path, 'utf8');
} catch {
  console.log(`no notes yet (${path})`);
  console.log('Run `npm run dev`, open the client with ?dev=1, and use the pin button.');
  process.exit(0);
}

const notes = raw
  .split('\n')
  .filter((l) => l.trim())
  .flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

if (!notes.length) {
  console.log('the notes file is empty');
  process.exit(0);
}

console.log(`${notes.length} note(s) — ${path}\n`);
for (const [i, n] of notes.entries()) {
  const when = n.at?.replace('T', ' ').slice(0, 16) ?? '?';
  const near = n.nearest ? `${n.nearest.id} (${n.nearest.kind}, ${n.nearest.dist} m)` : '—';
  console.log(`${String(i + 1).padStart(3)}. ${when}  ${n.map}  ${n.zone}`);
  console.log(`     nearest: ${near}`);
  console.log(`     stood at: ${n.pos?.join(', ')}  facing ${((n.yaw * 180) / Math.PI).toFixed(0)}°`);
  if (n.camera) {
    console.log(
      `     view:     { eye: [${n.camera.eye.join(', ')}], target: [${n.camera.target.join(', ')}], fov: 50 }`,
    );
  }
  console.log(`     ${n.text.split('\n').join('\n     ')}\n`);
}
