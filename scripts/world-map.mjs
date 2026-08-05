#!/usr/bin/env node
/**
 * Island map renderer — a development tool, not part of the product.
 * =================================================================
 *
 * Renders the analytic terrain field to a PNG: a shaded relief map of the island with the
 * paths, terraces, zone anchors and landmarks drawn on top.
 *
 * This exists because the failure modes of a procedural world are spatial, and reading
 * numbers does not catch them. A terrace that has drifted onto a cliff, a lane that dives
 * into the sea, a harbour bay that closed up when the coast noise was retuned — all of it
 * is obvious in one glance at a map and invisible in a test log. `world-smoke` asserts the
 * invariants; this shows you the island.
 *
 *     node scripts/world-map.mjs [output.png] [--size 1400]
 *
 * PNG is written by hand (a single IDAT of zlib-deflated scanlines) rather than by pulling
 * in an image library for a tool that is not shipped.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shared = require('../packages/shared/dist/index.js');
const {
  heightAt,
  slopeAt,
  isWalkable,
  nearestPath,
  PADS,
  PATHS,
  ZONES,
  LANDMARKS,
  SPAWN_POINTS,
  ISLAND_EXTENT,
  SUMMIT,
} = shared;

const args = process.argv.slice(2);
const outPath = args.find((a) => !a.startsWith('--')) ?? 'island-map.png';
const sizeArg = args.indexOf('--size');
const SIZE = sizeArg >= 0 ? Number(args[sizeArg + 1]) : 1200;
/** World half-extent covered by the image. A little past the shore, to show open sea. */
const VIEW = ISLAND_EXTENT * 0.95;

// --- Palette (matches the scene tokens closely enough to be recognisable) -------------
const SEA_DEEP = [46, 104, 116];
const SEA_SHALLOW = [122, 190, 184];
const SAND = [226, 214, 186];
const GRASS = [126, 150, 106];
const UPLAND = [150, 152, 110];
const ROCK = [150, 142, 126];
const SNOWLESS_PEAK = [176, 166, 150];
const PATH_COLOR = [232, 222, 198];
const UNWALKABLE = [188, 92, 78];
const INK = [40, 46, 50];

function mixc(a, b, t) {
  const u = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** Ground colour by altitude, then overridden by steepness. */
function groundColor(h, slope) {
  let c;
  if (h < 2) c = mixc(SAND, GRASS, (h - 0.4) / 2.4);
  else if (h < 26) c = mixc(GRASS, GRASS, 0);
  else if (h < 62) c = mixc(GRASS, UPLAND, (h - 26) / 36);
  else c = mixc(UPLAND, SNOWLESS_PEAK, (h - 62) / 30);
  const rocky = Math.max(0, Math.min(1, (slope - 0.42) / 0.3));
  return mixc(c, ROCK, rocky);
}

// --- Render ---------------------------------------------------------------------------

const px = new Uint8Array(SIZE * SIZE * 3);
const toWorld = (i) => -VIEW + (i / (SIZE - 1)) * 2 * VIEW;

// Sun for the hillshade: from the north-west, the cartographic convention, because the
// human eye reads relief lit from that direction as raised and from the south as sunken.
const SUN = [-0.55, 0.72, -0.42];

for (let j = 0; j < SIZE; j++) {
  const z = toWorld(j);
  for (let i = 0; i < SIZE; i++) {
    const x = toWorld(i);
    const h = heightAt(x, z);
    let rgb;

    if (h <= 0) {
      // Sea: depth-shaded, with a bright line right at the waterline.
      const depth = Math.max(0, Math.min(1, -h / 34));
      rgb = mixc(SEA_SHALLOW, SEA_DEEP, depth);
      if (h > -0.8) rgb = mixc(rgb, [244, 250, 246], 0.55);
    } else {
      const slope = slopeAt(x, z);
      rgb = groundColor(h, slope);

      // Hillshade from the analytic normal.
      const e = 1.2;
      const nx = heightAt(x - e, z) - heightAt(x + e, z);
      const nz = heightAt(x, z - e) - heightAt(x, z + e);
      const ny = 2 * e;
      const len = Math.hypot(nx, ny, nz) || 1;
      const lambert = (nx / len) * SUN[0] + (ny / len) * SUN[1] + (nz / len) * SUN[2];
      const shade = 0.62 + 0.55 * Math.max(0, lambert);
      rgb = [rgb[0] * shade, rgb[1] * shade, rgb[2] * shade];

      // Contour lines every 10 m: cheap, and they make the massif's shape legible.
      if (Math.abs(((h + 500) % 10) - 5) > 4.75) rgb = mixc(rgb, INK, 0.16);

      // Paths, drawn as their walkable width.
      const hit = nearestPath(x, z);
      if (hit.path && hit.dist < hit.path.halfWidth) rgb = mixc(rgb, PATH_COLOR, 0.85);

      // Anything a player cannot stand on, flagged.
      if (!isWalkable(x, z)) rgb = mixc(rgb, UNWALKABLE, 0.42);
    }

    const o = (j * SIZE + i) * 3;
    px[o] = Math.max(0, Math.min(255, rgb[0]));
    px[o + 1] = Math.max(0, Math.min(255, rgb[1]));
    px[o + 2] = Math.max(0, Math.min(255, rgb[2]));
  }
}

// --- Annotations ----------------------------------------------------------------------

const toPixel = (v) => Math.round(((v + VIEW) / (2 * VIEW)) * (SIZE - 1));

function dot(x, z, r, color) {
  const cx = toPixel(x);
  const cy = toPixel(z);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const ix = cx + dx;
      const iy = cy + dy;
      if (ix < 0 || iy < 0 || ix >= SIZE || iy >= SIZE) continue;
      const o = (iy * SIZE + ix) * 3;
      px[o] = color[0];
      px[o + 1] = color[1];
      px[o + 2] = color[2];
    }
  }
}

function ring(x, z, radiusMetres, color) {
  const steps = Math.max(48, Math.round(radiusMetres * 4));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    dot(x + Math.cos(a) * radiusMetres, z + Math.sin(a) * radiusMetres, 1, color);
  }
}

for (const pad of PADS) ring(pad.x, pad.z, pad.inner, [255, 255, 255]);
for (const landmark of LANDMARKS) dot(landmark.x, landmark.z, 2, [60, 60, 70]);
for (const zone of ZONES) if (zone.radius < 900) dot(zone.x, zone.z, 6, [196, 80, 58]);
for (const [x, z] of SPAWN_POINTS) dot(x, z, 3, [250, 250, 120]);
dot(SUMMIT.x, SUMMIT.z, 5, [255, 255, 255]);

// --- PNG encode -----------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

// Each scanline is prefixed with a filter byte; 0 = none, which deflate handles fine for
// an image this smooth and keeps the encoder to a dozen lines.
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let j = 0; j < SIZE; j++) {
  raw[j * (SIZE * 3 + 1)] = 0;
  Buffer.from(px.buffer, j * SIZE * 3, SIZE * 3).copy(raw, j * (SIZE * 3 + 1) + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour
writeFileSync(
  outPath,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);

console.log(`wrote ${outPath} (${SIZE}×${SIZE}, ${(VIEW * 2).toFixed(0)} m across)`);
