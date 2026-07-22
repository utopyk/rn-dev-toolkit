import path from 'path';

/**
 * Directory holding the Electron main-process assets (preload.cjs,
 * preload-module.js).
 *
 * Dev (tsx via launcher.cjs): this file lives at `<repo>/electron/`,
 * right next to both preload files.
 *
 * Packaged: the whole main graph is bundled to
 * `dist-electron/main.cjs` (see build.ts `gui` mode) and the build
 * copies both preloads beside the bundle, so the bundle's `__dirname`
 * still points at the directory that contains them.
 *
 * Every preload/renderer path in the main process MUST resolve through
 * these exports — a bare `__dirname` in any other file breaks under
 * bundling because inlined modules all share the bundle's directory.
 */
export const electronAssetsDir = __dirname;

/**
 * Packaged renderer entry — `<app>/dist-renderer/index.html`. The repo
 * mirrors the packaged layout in dev (renderer/vite.config.ts builds to
 * `../dist-renderer`), so the same relative hop works from both
 * `electron/` and `dist-electron/`.
 */
export const packagedRendererIndex = path.join(
  electronAssetsDir,
  '..',
  'dist-renderer',
  'index.html',
);
