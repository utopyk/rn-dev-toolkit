import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBunBinary } from "../../test/helpers/bun-binary.js";

// The generator is also a freshness check: if errors.ts changes but
// hook-errors.md isn't regenerated, this test catches the drift.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const docPath = join(repoRoot, "docs/guides/hook-errors.md");
const generator = join(repoRoot, "scripts/gen-hook-errors-doc.ts");

describe("gen-hook-errors-doc", () => {
  it("on-disk hook-errors.md matches what the generator produces", () => {
    const onDisk = readFileSync(docPath, "utf8");
    // Render to a tmp path and diff. The generator writes to the canonical
    // path; we capture-restore to avoid mutating the worktree.
    const before = onDisk;
    const result = spawnSync(resolveBunBinary(), ["run", generator], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `gen-hook-errors-doc.ts exited ${result.status}: ${result.stderr}`,
      );
    }
    const after = readFileSync(docPath, "utf8");
    if (after !== before) {
      // Restore the on-disk doc, then fail the test so dev can rerun
      // the generator manually.
      const fs = require("node:fs") as typeof import("node:fs");
      fs.writeFileSync(docPath, before);
      throw new Error(
        "docs/guides/hook-errors.md is stale. Run: bun run scripts/gen-hook-errors-doc.ts",
      );
    }
    expect(after).toBe(before);
  }, 15_000);
});
