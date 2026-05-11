#!/usr/bin/env bun
/**
 * Builds `@rn-dev/config` to `dist/index.js`. Project authors install the
 * package and import `defineConfig` from it; the daemon also imports it
 * to revalidate at boot.
 *
 * Run from repo root:   bun run packages/config/build.ts
 * Run via workspace:    bun run --filter @rn-dev/config build
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
  minify: true,
  sourcemap: "external",
  external: ["ajv", "@rn-dev/module-sdk"],
});

if (!result.success) {
  console.error("Config build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const out of result.outputs) {
  const kb = (out.size / 1024).toFixed(1);
  console.log(`✓ Built ${out.path} (${kb} KB)`);
}
