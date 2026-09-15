import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

// The `clear-metro-cache` step used to delete EVERY `metro-*` and
// `haste-map-*` entry in the shared TMPDIR. A clean on one project
// therefore wiped the Metro caches of every other project and every other
// rn-dev session on the machine — a cross-session footgun against the
// 4-concurrent-session target.
//
// Metro 0.84 names the file-map cache
// `metro-file-map-<md5(projectRoot)>-<configHash>`
// (metro-file-map/src/lib/rootRelativeCacheKeys.js), so this project's
// entries are precisely identifiable. Everything else in TMPDIR must
// survive: `metro-cache/` is a FileStore root shared by all projects, and
// another project's file-map cache is none of our business.
//
// `os.tmpdir()` is mocked rather than steered through `process.env.TMPDIR`
// on purpose. The env var is process-global, and `test/helpers/
// spawnTestDaemon.ts` builds its worktrees with
// `mkdtempSync(join(tmpdir(), ...))` — pointing that at a sandbox this
// file later `rmSync`s recursively is a cross-file booby trap. The mock is
// scoped to this file's module graph.

const hoisted = vi.hoisted(() => ({ fakeTmp: "" }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    // Falls through to the real tmpdir until a test installs a sandbox, so
    // the sandbox itself can be created with the real one.
    tmpdir: () => hoisted.fakeTmp || actual.tmpdir(),
  };
});

const { CleanManager } = await import("../clean.js");
const { tmpdir: realTmpdir } = await vi.importActual<typeof import("os")>("os");

describe("clear-metro-cache is scoped to the project", () => {
  const projectRoot = "/Users/someone/dev/my-rn-app";

  function cacheStepAction() {
    const steps = new CleanManager(projectRoot).getStepsForMode("clean", "both");
    const step = steps.find((s) => s.name === "clear-metro-cache");
    if (!step) throw new Error("clear-metro-cache step not found");
    return step.action;
  }

  beforeEach(() => {
    hoisted.fakeTmp = mkdtempSync(join(realTmpdir(), "rn-dev-cache-scope-"));
  });

  afterEach(() => {
    const dir = hoisted.fakeTmp;
    hoisted.fakeTmp = "";
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes only this project's file-map cache and nothing else", async () => {
    const ourHash = createHash("md5").update(projectRoot).digest("hex");
    const theirHash = createHash("md5")
      .update("/Users/someone/dev/a-different-app")
      .digest("hex");

    const tmp = hoisted.fakeTmp;
    const ours = join(tmp, `metro-file-map-${ourHash}-configA`);
    const oursOtherConfig = join(tmp, `metro-file-map-${ourHash}-configB`);
    const theirs = join(tmp, `metro-file-map-${theirHash}-configA`);
    const sharedTransformCache = join(tmp, "metro-cache");
    const legacyHasteMap = join(tmp, "haste-map-abc123");
    const unrelated = join(tmp, "something-else");

    for (const d of [sharedTransformCache, legacyHasteMap, unrelated]) {
      mkdirSync(d, { recursive: true });
    }
    for (const f of [ours, oursOtherConfig, theirs]) {
      writeFileSync(f, "cache");
    }
    // A bucket file inside the shared store, to prove we do not recurse
    // into it.
    writeFileSync(join(sharedTransformCache, "00"), "someone else's entry");

    const result = await cacheStepAction()();
    expect(result.success).toBe(true);

    // Ours, both config hashes.
    expect(existsSync(ours)).toBe(false);
    expect(existsSync(oursOtherConfig)).toBe(false);

    // Everything else survives.
    expect(existsSync(theirs), "another project's file-map cache").toBe(true);
    expect(
      existsSync(join(sharedTransformCache, "00")),
      "shared transform cache is left to Metro's own --reset-cache",
    ).toBe(true);
    expect(existsSync(legacyHasteMap), "unattributable legacy haste map").toBe(
      true,
    );
    expect(existsSync(unrelated)).toBe(true);
  });

  it("succeeds and says so when this project has no file-map cache", async () => {
    mkdirSync(join(hoisted.fakeTmp, "metro-cache"), { recursive: true });
    writeFileSync(
      join(
        hoisted.fakeTmp,
        `metro-file-map-${createHash("md5").update("/other").digest("hex")}-x`,
      ),
      "cache",
    );

    const result = await cacheStepAction()();
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/no file-map cache for this project/i);
  });
});
