/**
 * Entry point.
 * ============
 *
 * Mounts the interface, boots the world, and installs the two safety nets a long-lived
 * WebGL page needs: a context-loss handler and a top-level error reporter.
 *
 * Kept deliberately thin. Anything that could live in `App` does.
 */

import { App } from './app.js';
import { mountOverlay } from './ui/index.js';
import { appPhase, loadProgress, notify } from './state/stores.js';

const container = document.getElementById('app');
if (!container) throw new Error('#app container missing from the document');

// The interface mounts first so the loading screen is on-screen before the island starts
// building — otherwise the first two seconds are a blank page.
const overlay = mountOverlay(container);

const app = new App(container);

/**
 * WebGL context loss.
 *
 * Happens routinely: a phone backgrounded for a while, a laptop switching GPUs, a driver
 * reset. The default browser behaviour is a black canvas with no explanation, so we say
 * what happened and offer the one thing that reliably fixes it.
 */
installContextLossHandler();

function installContextLossHandler(): void {
  const canvas = container?.querySelector('canvas');
  canvas?.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    notify('Graphics interrupted — reload to return', 'warn', 30_000);
    console.warn('[nagisa] WebGL context lost');
  });
  canvas?.addEventListener('webglcontextrestored', () => {
    // Three.js re-uploads its own resources, but our worker-built geometry and canvas
    // textures are gone. A reload is honest and immediate; a partial rebuild would be a
    // large amount of code for a rare event.
    location.reload();
  });
}

app.boot().catch((err: unknown) => {
  console.error('[nagisa] boot failed', err);
  loadProgress.set({ value: 1, label: 'The island could not be reached' });
  appPhase.set('loading');
  notify('Something went wrong loading the island', 'warn', 30_000);
});

// Clean teardown on navigation. Not strictly required — the tab is going away — but it
// releases the GL context promptly, which matters when the page is inside an iframe or a
// bfcache-eligible history entry.
window.addEventListener('pagehide', () => {
  app.dispose();
  overlay.destroy();
});

// Expose the app for the browser console in development. Guarded so a production bundle
// does not hand a debugging surface to every visitor.
if (import.meta.env.DEV) {
  (window as unknown as { nagisa: unknown }).nagisa = app.debug;
}
