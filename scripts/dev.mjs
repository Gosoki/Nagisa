#!/usr/bin/env node
/**
 * Development runner.
 * ===================
 *
 * Starts the realtime server and the Vite dev server together, prefixes their output so
 * you can tell them apart, and shuts both down cleanly on Ctrl-C.
 *
 * Two small things it does that a bare `concurrently` would not:
 *
 * - **Builds `@nagisa/shared` first, and watches it.** Both apps import the shared
 *   package by its built output, so a change to the protocol has to be compiled before
 *   either side sees it. Forgetting this is the single most common way to lose twenty
 *   minutes to a "the server is ignoring my new message type" mystery.
 *
 * - **Kills the whole process group on exit.** Vite spawns workers; a plain `kill` on
 *   the parent leaves them holding the port.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** ANSI colours, one per process, so interleaved output stays readable. */
const COLORS = { shared: '\x1b[35m', server: '\x1b[36m', client: '\x1b[32m', reset: '\x1b[0m' };

const children = [];

/**
 * Spawn a workspace command with prefixed output.
 * @param {string} name  Label and colour key.
 * @param {string[]} args Arguments passed to npm.
 */
function run(name, args) {
  const child = spawn('npm', args, {
    cwd: root,
    // Not `shell: true`: it breaks signal propagation, which is exactly what we need to
    // work here.
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const prefix = `${COLORS[name] ?? ''}[${name}]${COLORS.reset} `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (signal) return; // We are shutting down on purpose.
    if (code !== 0) {
      process.stdout.write(`${prefix}exited with code ${code}\n`);
      shutdown(code ?? 1);
    }
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  // Give them a moment to close sockets, then leave regardless.
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Build shared once up front so neither app starts against stale or missing output.
const build = spawn('npm', ['run', 'build', '-w', '@nagisa/shared'], { cwd: root, stdio: 'inherit' });
build.on('exit', (code) => {
  if (code !== 0) {
    console.error('[dev] @nagisa/shared failed to build; not starting');
    process.exit(code ?? 1);
  }
  // Keep rebuilding it as the protocol and world layout change.
  run('shared', ['run', 'build', '-w', '@nagisa/shared', '--', '--watch', '--preserveWatchOutput']);
  run('server', ['run', 'dev', '-w', '@nagisa/server']);
  run('client', ['run', 'dev', '-w', '@nagisa/client']);

  console.log('\n  Nagisa is starting.');
  console.log('  client  http://localhost:5173');
  console.log('  server  http://localhost:8787/healthz\n');
});
