/**
 * Bundle a workspace TypeScript entry and run it under Node.
 * ==========================================================
 *
 * Four of this project's tools — the two audits, the world smoke test and the setback
 * solver — import workspace TypeScript directly, so Node cannot run them without a bundling
 * step first. esbuild is already present as a Vite dependency, which is why this does not
 * add a tool to the project just to run a test.
 *
 * They were four byte-identical copies of the same twenty lines, which is how all four came
 * to share one bug: each cleaned up its scratch directory in a `finally`, and each exited
 * with `process.exit()` *inside the try*. `process.exit` does not unwind the stack, so the
 * `finally` never ran, so every invocation left its directory behind. The repository had a
 * hundred and eleven of them.
 *
 * ### Where the scratch goes
 *
 * `.tmp/` at the project root, not the system temp directory, and not the root itself.
 *
 * Not the system temp directory because the bundles leave `three` external — it is a large
 * ESM package Node resolves perfectly well on its own and bundling it triples the build time
 * — and an external import only resolves if the bundle sits somewhere that can walk up to
 * the project's `node_modules`.
 *
 * Not the root itself because that is where they were, and a hundred `.audit-*` directories
 * in a listing is noise that hides whatever is actually there.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project root, derived from this file's own location. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Where every tool's scratch goes. One line in `.gitignore` covers all of it. */
export const SCRATCH = join(ROOT, '.tmp');

/**
 * How old an abandoned scratch directory must be before it is swept, ms.
 *
 * A safety net for the one case cleanup cannot cover: a tool killed with a signal it cannot
 * handle. Age-based rather than "delete everything on startup", because two tools may
 * legitimately be running at once and a blanket sweep would pull the floor out from under a
 * live one. An hour is far longer than any tool here takes and far shorter than the interval
 * at which anybody would notice the mess.
 */
const STALE_MS = 60 * 60 * 1000;

/** Make a private scratch directory under {@link SCRATCH}, sweeping any long-dead siblings. */
export function scratchDir(name) {
  mkdirSync(SCRATCH, { recursive: true });
  const cutoff = Date.now() - STALE_MS;
  for (const entry of readdirSync(SCRATCH)) {
    const path = join(SCRATCH, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      /* Raced with another tool's own cleanup. Nothing to do. */
    }
  }
  return mkdtempSync(join(SCRATCH, `${name}-`));
}

/**
 * Bundle `scripts/<name>.ts` and run it, then exit with its status.
 *
 * Never returns. The calling script is a runner and the tool's exit code is its exit code,
 * which is what makes `npm test` fail when a check fails — so the status is captured in a
 * variable, the scratch is removed in the `finally`, and the exit happens *after* both.
 * Exiting inside the `try` is the bug this module exists to stop repeating.
 *
 * Arguments are forwarded, which they were not before: `terrain-audit.ts` reads a `--map`
 * flag that its own runner had never passed on, so the documented
 * `npm run audit:terrain -- --map lantern-atoll` silently audited the default pack.
 */
export function bundleAndRun(name, { entry = `scripts/${name}.ts`, external = ['three'] } = {}) {
  const outDir = scratchDir(name);
  const outFile = join(outDir, `${name}.mjs`);
  let status = 1;
  try {
    const build = spawnSync(
      join(ROOT, 'node_modules/.bin/esbuild'),
      [
        join(ROOT, entry),
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--target=node20',
        `--outfile=${outFile}`,
        ...external.map((pkg) => `--external:${pkg}`),
        '--log-level=error',
      ],
      { cwd: ROOT, stdio: 'inherit' },
    );
    status =
      build.status === 0
        ? (spawnSync('node', [outFile, ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' }).status ?? 1)
        : (build.status ?? 1);
  } catch (err) {
    // A runner that dies silently and exits 1 is indistinguishable from a tool that failed
    // its checks, which is the difference between "the island is broken" and "esbuild is
    // missing". Say which.
    console.error(`[${name}] runner failed to start:`, err);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  process.exit(status);
}
