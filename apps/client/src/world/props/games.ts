/**
 * Game furniture.
 * ===============
 *
 * The three small things the island's games are played *at*: a stamp stand in every place,
 * the shrine's fortune box, and a rod rack on the beach. They are ordinary landmarks — placed
 * from the map, culled with their zone, drawn in the same ink — so a game is something that
 * happens at a place on the island rather than a menu laid over it.
 *
 * Front is local −z, as everywhere in the kit: the side you walk up to.
 */

import * as THREE from 'three';
import { box, cyl, mergeByMaterial } from './geometry.js';
import { cappedPost } from './kit.js';
import { cloth, metal, roof as roofMaterial, shoji, stone, vermilion, wood } from '../materials.js';

type Opts = Record<string, unknown> | undefined;

function assemble(name: string, parts: THREE.Mesh[]): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  for (const mesh of mergeByMaterial(parts)) group.add(mesh);
  return group;
}

/**
 * A stamp stand (*スタンプ台*): a post carrying a little roofed box, its front open on the
 * stamp and the ink pad, and a paper sign on the post saying which place this is.
 */
export function stampStand(_opts?: Opts): THREE.Group {
  const timber = wood('dark');
  const light = wood('light');
  const parts: THREE.Mesh[] = [];

  /** Height of the box's floor. */
  const y0 = 1.02;

  // Stone footing, and a post whose cap is the bracket under the box's floor — `cappedPost`
  // stands its cap 0.45 of the post's thickness above the post. It was a metre tall, which ran
  // it up through the floor and left the cap standing inside the box between the stamp and
  // the ink pad, through the stamp's handle.
  parts.push(box(0.7, 0.16, 0.7, stone('dark'), 0, 0.08, 0));
  const postTop = y0 - 0.03 - 0.16 * 0.45;
  for (const mesh of cappedPost(postTop - 0.16, 0.16, timber)) {
    mesh.position.y += 0.16;
    parts.push(mesh);
  }
  // The box: back, sides and floor, open to the front.
  parts.push(box(0.9, 0.06, 0.6, light, 0, y0, 0));
  parts.push(box(0.9, 0.42, 0.05, light, 0, y0 + 0.24, 0.28));
  parts.push(box(0.05, 0.42, 0.6, light, -0.43, y0 + 0.24, 0));
  parts.push(box(0.05, 0.42, 0.6, light, 0.43, y0 + 0.24, 0));
  // Its little pitched roof.
  const cover = roofMaterial('board');
  parts.push(box(1.1, 0.05, 0.46, cover, 0, y0 + 0.56, -0.13, 0.42, 0, 0));
  parts.push(box(1.1, 0.05, 0.46, cover, 0, y0 + 0.56, 0.21, -0.42, 0, 0));
  // Stamp (a vermilion handle on a block) and ink pad.
  parts.push(box(0.2, 0.08, 0.14, metal('dark'), -0.16, y0 + 0.07, -0.02));
  parts.push(cyl(0.05, 0.05, 0.14, 6, vermilion(), 0.16, y0 + 0.13, -0.02));
  parts.push(box(0.16, 0.06, 0.16, wood('beam'), 0.16, y0 + 0.05, -0.02));
  // The sign, hung on the post's front.
  parts.push(box(0.34, 0.5, 0.03, shoji(), 0, 0.62, -0.1));

  return assemble('stamp-stand', parts);
}

/**
 * The omikuji box and the rack beside it where bad fortunes are tied and left behind.
 */
export function omikujiStand(_opts?: Opts): THREE.Group {
  const timber = wood('dark');
  const red = vermilion();
  const parts: THREE.Mesh[] = [];

  // A low table carrying the hexagonal draw box.
  parts.push(box(0.9, 0.08, 0.6, timber, -0.45, 0.82, 0));
  for (const [x, z] of [
    [-0.82, -0.24],
    [-0.08, -0.24],
    [-0.82, 0.24],
    [-0.08, 0.24],
  ] as const) {
    parts.push(box(0.07, 0.8, 0.07, timber, x, 0.4, z));
  }
  parts.push(cyl(0.16, 0.16, 0.42, 6, red, -0.45, 1.07, 0));
  parts.push(cyl(0.02, 0.02, 0.16, 4, wood('light'), -0.45, 1.34, 0));
  // The tying rack: two posts, two ropes' worth of rails, and slips knotted along them.
  for (const x of [0.2, 1.05]) parts.push(box(0.08, 1.5, 0.08, timber, x, 0.75, 0));
  parts.push(box(0.95, 0.06, 0.06, timber, 0.625, 1.42, 0));
  parts.push(box(0.95, 0.04, 0.04, timber, 0.625, 1.05, 0));
  const paper = cloth(0xf4efe4);
  for (let i = 0; i < 7; i++) {
    const x = 0.28 + i * 0.12;
    parts.push(box(0.04, 0.12, 0.02, paper, x, i % 2 ? 1.36 : 0.99, -0.03));
  }

  return assemble('omikuji-stand', parts);
}

/**
 * Two rods leaning on a rail over a bucket — the sign that this bit of shore is for fishing.
 */
export function rodRack(_opts?: Opts): THREE.Group {
  const timber = wood('weathered');
  const parts: THREE.Mesh[] = [];

  for (const x of [-0.7, 0.7]) parts.push(box(0.09, 0.9, 0.09, timber, x, 0.45, 0));
  parts.push(box(1.6, 0.07, 0.07, timber, 0, 0.84, 0));
  // Rods: long thin shafts, butts on the ground behind the rail and leaning on its top edge.
  // They used to lean at the same angle from a butt 0.7 m back, which crossed the rail 0.7 m
  // above it: two rods standing up on their own, resting on nothing.
  const rod = wood('beam');
  const lean = 0.42;
  const butt = 0.02 + 0.89 * Math.tan(lean);
  for (const x of [-0.35, 0.3]) {
    const shaft = cyl(0.012, 0.022, 2.6, 5, rod, x, 1.3 * Math.cos(lean), butt - 1.3 * Math.sin(lean), -lean, 0, 0);
    parts.push(shaft);
  }
  // A bucket at the foot.
  parts.push(cyl(0.17, 0.14, 0.26, 8, metal('dark'), 0.55, 0.13, -0.28));

  return assemble('rod-rack', parts);
}
