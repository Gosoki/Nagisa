#!/usr/bin/env node
/**
 * Realtime-server development runner.
 * ==================================
 *
 * Compiles `apps/server` in watch mode and restarts the process whenever the compiled
 * output changes.
 *
 * ### Why not `node --experimental-strip-types src/index.ts`?
 *
 * That was the original `dev` script, and it crashed on every boot:
 *
 * ```
 * Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/config.js'
 *                               imported from .../src/index.ts
 * ```
 *
 * Node's type stripping removes the *types* from a `.ts` file but does not rewrite
 * module specifiers. Our sources use the NodeNext convention of importing the emitted
 * name (`./config.js`) — which is correct for the built output, is what `tsc` requires
 * under `"module": "NodeNext"`, and is what the production `dist/` build runs on — but
 * that file does not exist next to the `.ts` source, so the very first import fails.
 *
 * The two ways out are (a) rewrite every specifier to `./config.ts` and adopt
 * `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, which changes the
 * shape of every import in the server for the benefit of one script, or (b) run the same
 * compiler in dev that we run in CI. This is (b): one build path, no second toolchain,
 * and the dev server fails on a type error exactly where the production build would.
 *
 * ### Behaviour
 *
 * - `tsc --watch` is the source of truth; its diagnostics stream straight through.
 * - The server is (re)started once the first successful emit lands, and on every emit
 *   after that. A failed compile leaves the last good process running rather than
 *   killing the world because of a typo mid-keystroke.
 * - Restarts are debounced: `tsc` writes many files per emit, and we want one restart.
 * - SIGINT/SIGTERM tear down both children before exiting.
 */

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'server');
const distDir = join(serverDir, 'dist');
const entry = join(distDir, 'index.js');

/** Collapse the burst of file writes a single `tsc` emit produces into one restart. */
const RESTART_DEBOUNCE_MS = 150;

/** @type {import('node:child_process').ChildProcess | null} */
let server = null;
/** @type {NodeJS.Timeout | null} */
let restartTimer = null;
let shuttingDown = false;

// `fs.watch` on a directory that does not exist throws. On a clean checkout `dist/` only
// appears after the first successful compile, so create it up front and let the watcher
// see the first emit rather than racing it.
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

const tsc = spawn(
  process.execPath,
  [join(serverDir, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'],
  { cwd: serverDir, stdio: ['ignore', 'inherit', 'inherit'] },
);

tsc.on('exit', (code) => {
  if (shuttingDown) return;
  console.error(`[dev-server] tsc exited unexpectedly (code ${code})`);
  shutdown(code ?? 1);
});

function startServer() {
  if (!existsSync(entry)) return; // First compile has not landed yet.
  if (server) {
    // Detach the handler first: this exit is us, not a crash.
    server.removeAllListeners('exit');
    server.kill('SIGTERM');
  }
  server = spawn(process.execPath, [entry], {
    cwd: serverDir,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  server.on('exit', (code, signal) => {
    if (shuttingDown || signal) return;
    // A non-zero exit that we did not cause is a real crash — surface it loudly, but
    // keep watching so saving a fix brings the server back without a manual restart.
    console.error(`[dev-server] server exited with code ${code}; waiting for the next compile`);
    server = null;
  });
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startServer();
  }, RESTART_DEBOUNCE_MS);
}

watch(distDir, { recursive: true }, (_event, filename) => {
  if (filename && !filename.endsWith('.js')) return;
  scheduleRestart();
});

// Kick off in case `dist/` is already populated from a previous run — otherwise the
// first restart waits for a source edit that may never come.
scheduleRestart();

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  server?.kill('SIGTERM');
  tsc.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
