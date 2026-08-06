#!/usr/bin/env node
/**
 * Runner for the terrain walkability audit. Same bundling trick as `world-smoke.mjs`:
 * the audit imports workspace TypeScript, so esbuild flattens it first.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = join(root, 'node_modules/.bin/esbuild');

const outDir = mkdtempSync(join(root, '.audit-'));
const outFile = join(outDir, 'setback-solve.mjs');

try {
  const build = spawnSync(
    esbuild,
    [
      join(root, 'scripts/setback-solve.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node20',
      `--outfile=${outFile}`,
      '--external:three',
      '--log-level=error',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);

  const run = spawnSync('node', [outFile], { cwd: root, stdio: 'inherit' });
  process.exit(run.status ?? 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
