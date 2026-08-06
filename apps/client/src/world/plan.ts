/**
 * The plan view — a real photograph of the island, taken from directly above.
 * ==========================================================================
 *
 * The minimap used to be a *drawing* of the island: a few thousand `heightAt` samples turned
 * into a shaded relief. It was accurate about the ground and silent about everything else,
 * because the ground is the only thing the terrain field knows. No buildings, no piers, no
 * torii — none of the landmarks a person actually navigates by.
 *
 * So instead of describing the island a second time, photograph it: put an orthographic
 * camera above the world, render the scene once, and read the pixels back. Everything that
 * is in the world is in the picture, in the colours the world uses, with no second source of
 * truth to keep in sync.
 *
 * ### Once, not per frame
 *
 * One render of the whole island at 512² costs roughly a frame. That is affordable once, at
 * load, and unaffordable sixty times a second — so the result is captured to a canvas and
 * the minimap blits it. The island does not change shape while you are standing on it.
 *
 * ### Orientation is the part that goes wrong
 *
 * `Minimap.project()` maps world `+x` to canvas `+x` and world `+z` to canvas `+y`, so canvas
 * up is north. Two conventions have to be bent to match that:
 *
 * - A camera looking straight down has no natural "up", so it is given one: `-z`, which puts
 *   north at the top of the frame.
 * - `readRenderTargetPixels` hands back rows in WebGL order, bottom row first, which is
 *   upside down relative to `putImageData`. The rows are flipped on the way into the canvas.
 *
 * Get either wrong and the map is a mirror of the island — which reads as *plausible*, since
 * the coastline is roughly round, and sends everyone the wrong way. The check that catches it
 * is the expanded minimap: it draws the zone markers through `project()` on top of this
 * image, so if the labels do not land on their own buildings, the orientation is wrong.
 */

import * as THREE from 'three';

/** Resolution of the capture. 512² is finer than the minimap is ever displayed at. */
const PLAN_RESOLUTION = 512;

/**
 * Photograph the island from above.
 *
 * `extent` is the half-width of the area captured, in metres, and must match whatever the
 * caller uses to project world coordinates onto the result.
 */
export function bakePlan(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  extent: number,
  resolution = PLAN_RESOLUTION,
): HTMLCanvasElement {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    // Two attachments because every ink material declares two outputs. Rendering them into a
    // single-attachment target is undefined territory in WebGL2 and produces a black frame on
    // some drivers; giving them the second buffer they expect costs one throwaway texture.
    count: 2,
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 1, 4000);
  // High enough to clear the summit and everything on it by a wide margin; the near plane is
  // what would clip the mountain, not the far one.
  camera.position.set(0, 1200, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const previousTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);

  const raw = new Uint16Array(resolution * resolution * 4);
  renderer.readRenderTargetPixels(target, 0, 0, resolution, resolution, raw);
  renderer.setRenderTarget(previousTarget);

  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(resolution, resolution);

  for (let y = 0; y < resolution; y++) {
    // WebGL's row 0 is the bottom of the frame; ImageData's row 0 is the top.
    const src = (resolution - 1 - y) * resolution * 4;
    const dst = y * resolution * 4;
    for (let x = 0; x < resolution; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      image.data[d] = toByte(raw[s]!);
      image.data[d + 1] = toByte(raw[s + 1]!);
      image.data[d + 2] = toByte(raw[s + 2]!);
      // The colour attachment's alpha carries the material id, not opacity — see
      // `ink-material.ts`. Anything the camera saw is opaque; anything it did not is sky.
      image.data[d + 3] = 255;
    }
  }
  boostForLegibility(image.data);
  ctx.putImageData(image, 0, 0);

  target.dispose();
  return canvas;
}

/**
 * Half-float → 8-bit sRGB-ish byte.
 *
 * The geometry pass writes linear colour into a half-float buffer, and nothing downstream of
 * this does the conversion the ink composite would normally do, so it happens here: decode
 * the half, then apply the sRGB transfer curve. Skipping it leaves the plan noticeably darker
 * and more contrasty than the world it is a picture of.
 */
function toByte(half: number): number {
  const linear = decodeHalf(half);
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(Math.max(0, linear), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

/**
 * Lift the capture into something legible at 168 px across.
 *
 * A faithful photograph is not automatically a good map. Seen from 1200 m the island is one
 * pale wash — the ground is high-key by design and the buildings are small — and shrunk to a
 * badge in the corner of the screen it turns to mush. A *drawn* map is legible because it
 * exaggerates: more contrast between land and water, more saturation than the eye would
 * actually see, so that shape survives being small.
 *
 * So: pull the midpoint down a little, stretch around it, and push saturation up. Applied to
 * the whole image rather than per-material, because what needs to survive is the silhouette
 * and the difference between one kind of ground and another, not any particular colour.
 */
function boostForLegibility(data: Uint8ClampedArray): void {
  const CONTRAST = 1.28;
  const SATURATION = 1.35;
  const PIVOT = 148;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const target = PIVOT + (luma - PIVOT) * CONTRAST;
    data[i] = clamp255(target + (r - luma) * SATURATION);
    data[i + 1] = clamp255(target + (g - luma) * SATURATION);
    data[i + 2] = clamp255(target + (b - luma) * SATURATION);
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** IEEE 754 half-precision → number. */
function decodeHalf(h: number): number {
  const sign = (h & 0x8000) === 0 ? 1 : -1;
  const exponent = (h & 0x7c00) >> 10;
  const fraction = h & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}
