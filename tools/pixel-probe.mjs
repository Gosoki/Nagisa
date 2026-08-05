#!/usr/bin/env node
/**
 * Pixel probe — development only.
 *
 * Boots the render probe headlessly and reads back specific pixels plus the live uniform
 * values of a named material. Screenshots tell you *that* something looks wrong; this
 * tells you which stage of the pipeline it went wrong in.
 *
 *     node tools/pixel-probe.mjs quay 300,160 300,130 320,330
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [view = 'quay', ...points] = process.argv.slice(2);
const samples = (points.length ? points : ['300,160', '300,130', '320,330', '600,60']).map((p) => p.split(',').map(Number));

const vite = spawn('npm', ['run', 'dev', '-w', '@nagisa/client'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const port = await new Promise((res) => {
  let buffer = '';
  const scan = (chunk) => {
    buffer += chunk.toString().replace(ANSI, '');
    const match = buffer.match(/localhost:(\d+)/);
    if (match) res(Number(match[1]));
  };
  vite.stdout.on('data', scan);
  vite.stderr.on('data', scan);
});

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(`http://localhost:${port}/probe.html?view=${view}&tier=low`);
await page.waitForFunction(() => window.__probeReady === true, null, { timeout: 240_000 });

const result = await page.evaluate((pts) => {
  const canvas = document.querySelector('#probe canvas');
  const gl = canvas.getContext('webgl2');
  const buf = new Uint8Array(4);
  const read = ([x, y]) => {
    // WebGL's origin is bottom-left; CSS pixel coordinates are top-left.
    const sx = Math.round((x / canvas.clientWidth) * canvas.width);
    const sy = Math.round(((canvas.clientHeight - y) / canvas.clientHeight) * canvas.height);
    gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return `${x},${y} -> rgb(${buf[0]}, ${buf[1]}, ${buf[2]})`;
  };

  // Walk the scene for the materials in play and report what the GPU was actually given.
  const materials = new Map();
  const scene = window.__probeScene;
  scene?.traverse((o) => {
    if (!o.isMesh || !o.material?.uniforms) return;
    const m = o.material;
    if (materials.has(m.name)) return;
    const u = m.uniforms;
    const hex = (c) => (c && c.getHexString ? '#' + c.getHexString() : String(c));
    materials.set(m.name, {
      color: hex(u.uColor?.value),
      shadow: hex(u.uShadowColor?.value),
      matId: u.uMatId?.value,
      hatch: u.uHatch?.value,
      sunStrength: u.uSunStrength?.value,
      ambient: u.uAmbient?.value,
      sunDir: u.uSunDir?.value ? u.uSunDir.value.toArray().map((n) => +n.toFixed(2)) : null,
      skyColor: hex(u.uSkyColor?.value),
      lightsFlag: m.lights,
      defines: Object.keys(m.defines ?? {}),
    });
  });

  return {
    pixels: pts.map(read),
    materials: Object.fromEntries([...materials].slice(0, 24)),
  };
}, samples);

console.log(JSON.stringify(result, null, 1));
await browser.close();
vite.kill('SIGTERM');
process.exit(0);
