#!/usr/bin/env bun
/**
 * Builds `@rn-dev-modules/metro-logs` to `dist/index.js`. Mirrors the
 * Phase 9 devtools-network build — the module ships as a plain Node
 * subprocess spawned by the rn-dev host via `node dist/index.js` from
 * the extracted tarball tree.
 *
 * Run from repo root:   bun run modules/metro-logs/build.ts
 * Run via workspace:    bun run --filter @rn-dev-modules/metro-logs build
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
  console.error("metro-logs build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const out of result.outputs) {
  const kb = (out.size / 1024).toFixed(1);
  console.log(`\u2713 Built ${out.path} (${kb} KB)`);
}
