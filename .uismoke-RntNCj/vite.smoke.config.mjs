
    import { svelte } from '/root/nagisa/node_modules/@sveltejs/vite-plugin-svelte/src/index.js';
    export default {
      // A *client* library build, not an SSR build. Vite's build.ssr mode would compile
      // the components server-side, where Svelte 5's mount() refuses to run; lib mode
      // compiles them for the browser while still emitting a single ES module that Node
      // can import directly.
      //
      // emitCss:false matters just as much: extracted CSS would leave an import of
      // overlay.css in the bundle that Node cannot load. With it off, each
      // component injects its own styles at runtime — which is also what lets this test
      // assert that the design tokens made it into the document.
      plugins: [svelte({ emitCss: false, compilerOptions: { hmr: false } })],
      resolve: { conditions: ['browser'] },
      build: {
        outDir: '/root/nagisa/.uismoke-RntNCj',
        emptyOutDir: false,
        minify: false,
        target: 'esnext',
        cssCodeSplit: false,
        lib: {
          entry: '/root/nagisa/.uismoke-RntNCj/entry.js',
          formats: ['es'],
          fileName: () => 'overlay.mjs',
        },
      },
    };
    