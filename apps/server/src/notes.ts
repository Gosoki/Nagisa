/**
 * Placement notes — a development channel from the world to the map file.
 * =======================================================================
 *
 * The slow part of arranging a village is not moving a building; it is *saying which one*.
 * A note like "this hut is too close to the road" is unusable a day later because "this"
 * was a thing you were looking at, and the record kept only the words.
 *
 * So a note carries where you stood, which way you were facing, which place you were in
 * and what was nearest to you, and the client fills all of that in from one button press.
 * The words are then unambiguous, and — because the camera is in there too — the exact
 * view can be reproduced as a probe viewpoint without asking anybody to describe it.
 *
 * ### Why this lives on the server
 *
 * It has to survive the browser: notes are written while playing and read while editing,
 * which is a different process on a different day. One JSON-lines file, appended to, is
 * the whole storage design — it is a few dozen lines a week, it diffs, and `npm run notes`
 * prints it.
 *
 * ### Why it is not authenticated
 *
 * Because it is not enabled unless `DEV_NOTES_PATH` is set, and nothing sets it in a
 * deployment. The endpoint is absent in production rather than guarded in production; a
 * feature that cannot be reached cannot be abused, and a guard is a thing to get wrong.
 */

import { appendFile, readFile } from 'node:fs/promises';

/** One note, as stored. Everything except `text` is captured by the client automatically. */
export interface PlacementNote {
  /** ISO 8601, server clock. */
  readonly at: string;
  readonly map: string;
  /** Where the player stood. */
  readonly pos: readonly [number, number, number];
  /** Which way they faced, radians, the world's yaw convention. */
  readonly yaw: number;
  /** The zone they were in, by id. */
  readonly zone: string;
  /**
   * The nearest hand-placed landmark, and how far away it was. This is what turns "move
   * this one" into a name.
   */
  readonly nearest: { readonly id: string; readonly kind: string; readonly dist: number } | null;
  /** Eye and target, so the view can be replayed as a probe viewpoint. */
  readonly camera: { readonly eye: readonly [number, number, number]; readonly target: readonly [number, number, number] } | null;
  readonly text: string;
}

/** Longest note accepted. Generous for a sentence, short enough that the file stays readable. */
const MAX_TEXT = 2000;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function triple(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out = v.map(num);
  return out.every((n) => n !== null) ? (out as [number, number, number]) : null;
}

/**
 * Validate a posted note. Returns the note to store, or a reason it was refused.
 *
 * Strict about shape and lenient about content: the position and the map id are what make
 * a note *useful*, so a note without them is a note that will waste somebody's time later,
 * and is better refused at the door.
 */
export function parseNote(body: unknown, now: Date): PlacementNote | string {
  if (typeof body !== 'object' || body === null) return 'expected an object';
  const b = body as Record<string, unknown>;

  const pos = triple(b.pos);
  if (!pos) return 'pos must be three finite numbers';
  const yaw = num(b.yaw);
  if (yaw === null) return 'yaw must be a finite number';
  if (typeof b.map !== 'string' || !b.map) return 'map must be a non-empty string';
  if (typeof b.text !== 'string') return 'text must be a string';
  const text = b.text.slice(0, MAX_TEXT).trim();
  if (!text) return 'text must not be empty';

  let nearest: PlacementNote['nearest'] = null;
  if (typeof b.nearest === 'object' && b.nearest !== null) {
    const n = b.nearest as Record<string, unknown>;
    const dist = num(n.dist);
    if (typeof n.id === 'string' && typeof n.kind === 'string' && dist !== null) {
      nearest = { id: n.id, kind: n.kind, dist: Math.round(dist * 10) / 10 };
    }
  }

  let camera: PlacementNote['camera'] = null;
  if (typeof b.camera === 'object' && b.camera !== null) {
    const c = b.camera as Record<string, unknown>;
    const eye = triple(c.eye);
    const target = triple(c.target);
    if (eye && target) camera = { eye, target };
  }

  const round = (n: number): number => Math.round(n * 10) / 10;
  return {
    at: now.toISOString(),
    map: b.map,
    pos: [round(pos[0]), round(pos[1]), round(pos[2])],
    yaw: Math.round(yaw * 1000) / 1000,
    zone: typeof b.zone === 'string' ? b.zone : 'coast',
    nearest,
    camera: camera ? { eye: camera.eye.map(round) as [number, number, number], target: camera.target.map(round) as [number, number, number] } : null,
    text,
  };
}

/** Append one note. One line of JSON, so the file is both a log and a data structure. */
export async function appendNote(path: string, note: PlacementNote): Promise<void> {
  await appendFile(path, JSON.stringify(note) + '\n', 'utf8');
}

/** Read them back, newest last. A malformed line is skipped rather than fatal. */
export async function readNotes(path: string): Promise<PlacementNote[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: PlacementNote[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as PlacementNote);
    } catch {
      /* A half-written line from a killed process. Skip it. */
    }
  }
  return out;
}
