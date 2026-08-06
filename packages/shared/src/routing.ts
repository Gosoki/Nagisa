/**
 * Getting from here to there on foot.
 * ===================================
 *
 * Everything that moves a character somewhere it did not choose — "travel to the shrine",
 * "join this activity", "follow that person" — used to steer at the destination in a
 * straight line and hope. On a flat map that is fine. On this one the middle of the island
 * is a mountain, and a straight line from the south harbour to the north one goes over it.
 *
 * Measured: **thirty of the seventy-two ordered pairs of named places never arrived.** The
 * character walked into the hillside and ground against it, indefinitely, with nothing on
 * screen to say why. South harbour to north harbour stopped 108 m short. That is the whole
 * of the "the player gets stuck" complaint, and no amount of smoothing the terrain would
 * have fixed it, because the terrain was not what was wrong.
 *
 * ### What this does instead
 *
 * The island already has a road network, and `npm run audit:terrain` asserts that every
 * lane centreline is walkable end to end. So: if the straight line is clear, take it — it
 * is shorter and it looks natural. If it is not, get on the nearest road, follow the roads,
 * and get off at the nearest point to the destination. That is also what a person would do.
 *
 * ### Why a sampled graph rather than the polylines themselves
 *
 * The lanes are authored as independent polylines with no declared junctions: they meet
 * because their coordinates happen to coincide, not because anything says so. Sampling them
 * into nodes every {@link NODE_SPACING} metres and joining nodes that are close enough to
 * step between discovers the junctions from the geometry, which means a lane re-routed in a
 * map pack re-connects itself without anybody maintaining a topology table.
 */

import { PATHS, canEnterFrom, isWalkable, pathAt, pathLength } from './terrain.js';
import { onMapChange } from './map/registry.js';

/** How finely the lanes are sampled into nodes, metres. */
const NODE_SPACING = 5;

/**
 * How far apart two nodes may be and still be joined, metres.
 *
 * Slightly over {@link NODE_SPACING} so consecutive nodes on one lane always connect, and
 * generous enough that two lanes crossing at a shallow angle find each other.
 */
const LINK_RADIUS = 7.5;

/** How far off the network a start or finish may be and still join it, metres. */
const ACCESS_RADIUS = 60;

/** Sampling interval for the straight-line test, metres. Finer than the character is wide. */
const LINE_STEP = 1;

interface Node {
  x: number;
  z: number;
  links: number[];
}

let graph: Node[] | null = null;

/**
 * Whether a character can walk straight from one point to another.
 *
 * Stepped through `canEnterFrom` rather than `isWalkable`, because that is the rule the
 * client and server actually move by: it is asymmetric, and a descent that is legal going
 * down would read as a wall if tested as a standing position.
 */
export function walkableLine(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  const span = Math.hypot(toX - fromX, toZ - fromZ);
  const steps = Math.ceil(span / LINE_STEP);
  if (steps === 0) return true;
  const ux = (toX - fromX) / steps;
  const uz = (toZ - fromZ) / steps;
  let px = fromX;
  let pz = fromZ;
  for (let i = 1; i <= steps; i++) {
    const nx = fromX + ux * i;
    const nz = fromZ + uz * i;
    if (!canEnterFrom(px, pz, nx, nz)) return false;
    px = nx;
    pz = nz;
  }
  return true;
}

function buildGraph(): Node[] {
  const nodes: Node[] = [];
  for (const path of PATHS) {
    const total = pathLength(path.id);
    const steps = Math.max(1, Math.round(total / NODE_SPACING));
    for (let i = 0; i <= steps; i++) {
      const { x, z } = pathAt(path.id, (i / steps) * total);
      // A lane the terrain audit calls snag-free can still have its very last station land
      // on something unwalkable at the map edge; a node nobody can stand on is a hole in
      // the network rather than a shortcut through it.
      if (isWalkable(x, z)) nodes.push({ x, z, links: [] });
    }
  }
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const na = nodes[a]!;
      const nb = nodes[b]!;
      if (Math.hypot(na.x - nb.x, na.z - nb.z) > LINK_RADIUS) continue;
      if (!walkableLine(na.x, na.z, nb.x, nb.z)) continue;
      na.links.push(b);
      nb.links.push(a);
    }
  }
  return nodes;
}

function ensureGraph(): Node[] {
  graph ??= buildGraph();
  return graph;
}

/** Nodes that can be reached from a loose point, nearest first. */
function accessNodes(x: number, z: number, nodes: Node[]): number[] {
  return nodes
    .map((n, i) => ({ i, d: Math.hypot(n.x - x, n.z - z) }))
    .filter((n) => n.d <= ACCESS_RADIUS)
    .sort((a, b) => a.d - b.d)
    .slice(0, 12)
    .filter((n) => walkableLine(x, z, nodes[n.i]!.x, nodes[n.i]!.z))
    .map((n) => n.i);
}

/**
 * A walkable route from one point to another, as waypoints to steer through in order.
 *
 * The last entry is always the destination. An empty array means there is no route at all —
 * the caller should not start walking, because walking would mean grinding into a hillside.
 *
 * The straight line is tried first and returned as a single waypoint when it is clear, so
 * short hops and anything inside one terrace behave exactly as they did before this existed.
 */
export function routeTo(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): Array<[number, number]> {
  if (walkableLine(fromX, fromZ, toX, toZ)) return [[toX, toZ]];

  const nodes = ensureGraph();
  const starts = accessNodes(fromX, fromZ, nodes);
  const finishes = new Set(accessNodes(toX, toZ, nodes));
  if (!starts.length || !finishes.size) return [];

  // A*, with straight-line distance to the destination as the heuristic. The graph is a
  // couple of hundred nodes, so this is instant and the heuristic is a nicety rather than
  // a necessity — it is here because it also biases ties toward the sensible-looking route.
  const best = new Float64Array(nodes.length).fill(Infinity);
  const from = new Int32Array(nodes.length).fill(-1);
  const open: Array<{ i: number; f: number }> = [];
  for (const i of starts) {
    best[i] = Math.hypot(nodes[i]!.x - fromX, nodes[i]!.z - fromZ);
    open.push({ i, f: best[i]! });
  }

  let goal = -1;
  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const { i } = open.shift()!;
    if (finishes.has(i)) {
      goal = i;
      break;
    }
    const here = nodes[i]!;
    for (const j of here.links) {
      const there = nodes[j]!;
      const cost = best[i]! + Math.hypot(here.x - there.x, here.z - there.z);
      if (cost >= best[j]!) continue;
      best[j] = cost;
      from[j] = i;
      open.push({ i: j, f: cost + Math.hypot(there.x - toX, there.z - toZ) });
    }
  }
  if (goal < 0) return [];

  const back: Array<[number, number]> = [];
  for (let i = goal; i >= 0; i = from[i]!) back.push([nodes[i]!.x, nodes[i]!.z]);
  back.reverse();
  back.push([toX, toZ]);
  return simplify(back, fromX, fromZ);
}

/**
 * Drop waypoints the character can see past.
 *
 * Without this a route is a bead-string of five-metre stations and the character visibly
 * steers to each one, which on a curve reads as a series of small corrections rather than
 * as walking down a road.
 */
function simplify(route: Array<[number, number]>, fromX: number, fromZ: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let px = fromX;
  let pz = fromZ;
  let i = 0;
  while (i < route.length) {
    // Furthest waypoint still reachable in a straight line from where we would be standing.
    let furthest = i;
    for (let j = route.length - 1; j > i; j--) {
      if (walkableLine(px, pz, route[j]![0], route[j]![1])) {
        furthest = j;
        break;
      }
    }
    const step = route[furthest]!;
    out.push(step);
    px = step[0];
    pz = step[1];
    i = furthest + 1;
  }
  return out;
}

/**
 * Roughly how far the route is, metres. Used by callers that want to say "that is a long
 * way" rather than start a two-minute walk without asking.
 */
export function routeLength(fromX: number, fromZ: number, route: ReadonlyArray<readonly [number, number]>): number {
  let total = 0;
  let px = fromX;
  let pz = fromZ;
  for (const [x, z] of route) {
    total += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  return total;
}

// The graph is a property of the active map's roads, so it cannot outlive a map change.
// Last statement in the file, for the same reason as its twins in `terrain.ts` and
// `world.ts`: the subscriber runs the moment it is registered.
onMapChange(() => {
  graph = null;
});
