import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/**
 * Vite configuration.
 *
 * Two deliberate choices:
 *
 * - **Manual chunks.** Three.js is ~600 KB and never changes between our deploys; the
 *   island and UI change constantly. Splitting them means a redeploy invalidates a
 *   150 KB chunk rather than a 750 KB one, which matters a great deal for returning
 *   visitors on mobile data.
 *
 * - **Dev proxy.** The client talks to the realtime server over `/ws` in every
 *   environment, so there is no environment-specific URL logic in the app. In dev, Vite
 *   proxies that to the local server; in production the same origin serves both.
 *
 * - **Two entry points.** `probe.html` is the render probe (see `docs/RENDERING.md` §9).
 *   It is listed here so `vite build` emits it alongside the app: a diagnostic page that
 *   only works under the dev server is one that quietly stops working and nobody notices
 *   until they need it. It costs a few KB and is not linked from anywhere.
 */
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        probe: resolve(import.meta.dirname, 'probe.html'),
      },
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
    // Source maps are worth their weight: shipping a 3D app without them makes every
    // field bug report unactionable.
    sourcemap: true,
  },
  // The island is generated, not loaded, so we depend on very few prebundled modules.
  optimizeDeps: {
    include: ['three'],
  },
});
