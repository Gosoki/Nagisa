#!/usr/bin/env node
/**
 * Runner for the world-generation smoke test.
 *
 * `world-smoke.ts` imports client TypeScript directly, so it needs bundling before Node
 * can run it. esbuild is already present as a Vite dependency, which is why this does not
 * add a tool to the project just to run one test.
 *
 * `three` is left external: it is a large ESM package that Node resolves perfectly well
 * on its own, and bundling it would triple the build time for no benefit.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = join(root, 'node_modules/.bin/esbuild');

// The bundle must sit inside the project so Node resolves the external `three` import
// against the project's node_modules rather than the system temp directory.
const outDir = mkdtempSync(join(root, '.smoke-'));
const outFile = join(outDir, 'world-smoke.mjs');

try {
  const build = spawnSync(
    esbuild,
    [
      join(root, 'scripts/world-smoke.ts'),
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
