/**
 * Starting and stopping the dev stack, for the browser smoke tools.
 * =================================================================
 *
 * Three tools drive two real servers and one or two real browsers. They all had their own
 * copy of this, and all three copies had the same two bugs — which is the usual fate of a
 * helper that gets pasted rather than imported.
 *
 * ### Why `detached` and a negative pid
 *
 * `npm run dev -w @nagisa/server` is a wrapper: npm spawns `node scripts/dev-server.mjs`,
 * which spawns `tsc --watch`. Killing the child kills npm and *orphans* the rest. They keep
 * the port and keep burning CPU, and the next run fails — with `server not ready in
 * 120000ms` if it is quick about it, or, far worse, with a genuine-looking assertion failure
 * when the leftovers have simply starved the machine enough that a click times out.
 *
 * That is not a hypothetical: it produced four false failures in one session, one of which
 * looked exactly like a real regression in code that turned out to be fine. A harness that
 * reports failures it invented is worse than no harness, because it costs you the thing you
 * built it for — the ability to believe a red result.
 *
 * So each child is spawned `detached`, which gives it its own process group, and shutdown
 * signals the *group* (`-pid`), TERM first and KILL after a grace period.
 *
 * ### Why we wait for the port
 *
 * Even a clean shutdown does not return a listening socket instantly. Starting the next run
 * the moment the previous one's process exits is a race the previous run usually wins.
 */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/** Ports the stack listens on. Checked free before a run and after it. */
export const STACK_PORTS = [8787, 5173];

const children = [];

/** Resolves true if something is listening on `port`. */
function inUse(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until nothing is listening on the stack's ports.
 *
 * Throws rather than proceeding: a run that starts against someone else's server proves
 * nothing about the code in this working tree, and Vite will happily fall forward to :5174
 * and let the whole suite pass against a stale bundle.
 */
export async function waitForPortsFree(ports = STACK_PORTS, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = [];
    for (const port of ports) if (await inUse(port)) busy.push(port);
    if (!busy.length) return;
    if (Date.now() > deadline) {
      throw new Error(
        `port${busy.length > 1 ? 's' : ''} ${busy.join(', ')} still in use after ${timeoutMs}ms — ` +
          'something else is running the stack. Stop it, or `npm run dev` in another terminal is holding it.',
      );
    }
    await delay(500);
  }
}

/**
 * Spawn one half of the stack and resolve when its output matches `ready`.
 * The match is returned, so a caller can read Vite's port out of it.
 */
export function start(name, npmArgs, ready, { cwd, timeoutMs = 120_000 } = {}) {
  const child = spawn('npm', npmArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} not ready in ${timeoutMs}ms`)), timeoutMs);
    let buffer = '';
    const scan = (chunk) => {
      buffer += chunk.toString().replace(ANSI, '');
      const match = buffer.match(ready);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Stop everything this process started, and do not return until the ports are free.
 *
 * Signals the process *group* — see the note at the top of the file. `try`/`catch` around
 * each signal because a group whose leader has already exited throws ESRCH, which is the
 * outcome we wanted anyway.
 */
export async function shutdown(graceMs = 2500) {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    let anyBusy = false;
    for (const port of STACK_PORTS) if (await inUse(port)) anyBusy = true;
    if (!anyBusy) break;
    await delay(200);
  }

  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  children.length = 0;

  // Best effort: if the sockets are somehow still held, say so rather than leaving the next
  // run to discover it as a mystery.
  const stuck = [];
  for (const port of STACK_PORTS) if (await inUse(port)) stuck.push(port);
  if (stuck.length) console.log(`  note port${stuck.length > 1 ? 's' : ''} ${stuck.join(', ')} still held after shutdown`);
}
