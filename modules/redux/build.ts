#!/usr/bin/env bun
/**
 * Builds `@rn-dev-modules/redux` to `dist/index.js`. Mirrors the
 * metro-logs / devtools-network builds — a plain Node subprocess the
 * rn-dev host spawns via `node dist/index.js`.
 *
 * Run from repo root:  bun run modules/redux/build.ts
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
  console.error("redux build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const out of result.outputs) {
  const kb = (out.size / 1024).toFixed(1);
  console.log(`✓ Built ${out.path} (${kb} KB)`);
}
