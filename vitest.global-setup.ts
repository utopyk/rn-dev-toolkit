/**
 * Vitest global setup — runs once before the test suite starts.
 *
 * Phase 3d: builds `@rn-dev/module-sdk` to its `dist/` before integration
 * tests spawn the echo fixture. The fixture imports the SDK via its npm
 * name, so `packages/module-sdk/package.json#main` (./dist/index.js) must
 * exist for `node` to resolve it. Vitest tests within `src/` go through
 * Vite, which transpiles TS directly — they don't depend on the build.
 *
 * The build is idempotent and finishes in <100ms, so we always run it
 * instead of checking mtimes. Developers modifying the SDK see their
 * changes on the next `vitest run` without remembering to rebuild.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export default async function globalSetup(): Promise<void> {
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const sdkBuild = join(repoRoot, "packages/module-sdk/build.ts");
  const result = spawnSync("bun", ["run", sdkBuild], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (result.status !== 0) {
    throw new Error(
      `[vitest.global-setup] SDK build exited with code ${result.status}`,
    );
  }
}
