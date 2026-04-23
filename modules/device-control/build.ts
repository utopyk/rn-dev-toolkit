#!/usr/bin/env bun
/**
 * Builds `@rn-dev-modules/device-control` to `dist/index.js`. The module
 * ships as a plain Node subprocess — the host spawns `node dist/index.js`
 * from the extracted tarball tree. Consumers don't transpile the TS at
 * install time, so this step runs as part of `bun pm pack` prep.
 *
 * Run from repo root:   bun run modules/device-control/build.ts
 * Run via workspace:    bun run --filter @rn-dev-modules/device-control build
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(pkgRoot, "dist"), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(pkgRoot, "src/index.ts")],
  outdir: join(pkgRoot, "dist"),
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  external: ["@rn-dev/module-sdk", "vscode-jsonrpc"],
});

if (!result.success) {
  console.error("device-control build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const out of result.outputs) {
  const kb = (out.size / 1024).toFixed(1);
  console.log(`✓ Built ${out.path} (${kb} KB)`);
}
