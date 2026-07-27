
    import { svelte } from '/root/nagisa/node_modules/@sveltejs/vite-plugin-svelte/src/index.js';
    export default {
      plugins: [svelte({ compilerOptions: { hmr: false } })],
      resolve: { conditions: ['browser'] },
      build: {
        ssr: '/root/nagisa/.uismoke-F39uwK/entry.js',
        outDir: '/root/nagisa/.uismoke-F39uwK',
        emptyOutDir: false,
        minify: false,
        target: 'node20',
        rollupOptions: { output: { entryFileNames: 'overlay.mjs', format: 'es' } },
      },
    };
    