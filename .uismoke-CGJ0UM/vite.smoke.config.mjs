
    import { svelte } from '/root/nagisa/node_modules/@sveltejs/vite-plugin-svelte/src/index.js';
    export default {
      // generate: 'client' is essential — Vite's `build.ssr` would otherwise compile the
      // components in SSR mode, where Svelte 5's mount() refuses to run. We want a
      // Node-loadable bundle of *client* components, which is an unusual but valid combo.
      plugins: [svelte({ compilerOptions: { generate: 'client', hmr: false } })],
      resolve: { conditions: ['browser'] },
      ssr: { noExternal: true, resolve: { conditions: ['browser'] } },
      build: {
        ssr: '/root/nagisa/.uismoke-CGJ0UM/entry.js',
        outDir: '/root/nagisa/.uismoke-CGJ0UM',
        emptyOutDir: false,
        minify: false,
        target: 'node20',
        rollupOptions: { output: { entryFileNames: 'overlay.mjs', format: 'es' } },
      },
    };
    