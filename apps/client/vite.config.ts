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
    // Source maps are worth their weight: shipping a 3D app without them makes every
    // field bug report unactionable.
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  // The island is generated, not loaded, so we depend on very few prebundled modules.
  optimizeDeps: {
    include: ['three'],
  },
});
