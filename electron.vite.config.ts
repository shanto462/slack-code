import { defineConfig } from 'electron-vite';

/**
 * electron-vite already defaults to the conventional layout, so no entry paths
 * are declared here:
 *
 *   src/main/index.ts      -> out/main/index.mjs
 *   src/preload/index.ts   -> out/preload/index.cjs
 *   src/renderer/index.html -> out/renderer/index.html
 *
 * Two things are set explicitly rather than inferred.
 *
 * FORMAT. Main is ESM and preload is CJS, and that is not a style choice. The
 * agent SDK is ESM-only, so a CJS main process could not import it. Electron in
 * turn requires an ESM preload to be .mjs AND requires a sandboxed preload to be
 * plain non-ESM JavaScript, and sandbox stays on. So: main ESM, preload CJS.
 * Emitting .cjs also stops "type": "module" reinterpreting the preload.
 *
 * FILE NAMES. package.json#main points at ./out/main/index.mjs and the window
 * loads out/preload/index.cjs by path, so both names are pinned here instead of
 * left to whatever the lib-mode default happens to be.
 *
 * Note what is NOT here: externalizeDepsPlugin. It still exists in v5 but is
 * deprecated, and dependencies are externalised by default
 * (build.externalizeDeps ?? true). That default matters: the agent SDK must not
 * be bundled, because it resolves its 317 MB CLI binary relative to its own
 * import.meta.url.
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name]-[hash].cjs' },
      },
    },
  },
  renderer: {},
});
