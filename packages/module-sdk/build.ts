#!/usr/bin/env bun
/**
 * Builds `@rn-dev/module-sdk` to `dist/index.js`. Third-party authors
 * install the package and import from that JS — they don't transpile TS
 * at consumer sites. Test fixtures spawned with plain `node` also need
 * this artifact since they can't execute `src/index.ts` directly.
 *
 * Run from repo root:   bun run packages/module-sdk/build.ts
 * Run via workspace:    bun run --filter @rn-dev/module-sdk build
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
  external: ["vscode-jsonrpc", "ajv"],
});

if (!result.success) {
  console.error("SDK build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const out of result.outputs) {
  const kb = (out.size / 1024).toFixed(1);
  console.log(`✓ Built ${out.path} (${kb} KB)`);
}
