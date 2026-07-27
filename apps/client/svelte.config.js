import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Needed only so tooling (svelte-check, the IDE extension) can find the same
 * preprocessing Vite applies at build time. Vite itself reads plugins from
 * vite.config.ts directly and does not consult this file.
 */
export default {
  preprocess: vitePreprocess(),
};
