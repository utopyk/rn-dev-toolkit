import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  disabledFlagPath,
  isDisabled,
  setDisabled,
} from "../disabled-flag.js";
import { ModuleRegistry } from "../registry.js";

// ---------------------------------------------------------------------------
// isDisabled / setDisabled — pure file ops
// ---------------------------------------------------------------------------

describe("disabled-flag — isDisabled/setDisabled", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rn-dev-disabled-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("isDisabled returns false when flag file does not exist", () => {
    expect(isDisabled("fake-mod", root)).toBe(false);
  });

  it("setDisabled(true) creates the flag file", () => {
    setDisabled("fake-mod", true, root);
    expect(existsSync(disabledFlagPath("fake-mod", root))).toBe(true);
    expect(isDisabled("fake-mod", root)).toBe(true);
  });

  it("setDisabled(false) removes the flag file", () => {
    setDisabled("fake-mod", true, root);
    setDisabled("fake-mod", false, root);
    expect(isDisabled("fake-mod", root)).toBe(false);
  });

  it("setDisabled(false) on a module with no flag file is a no-op", () => {
    expect(() => setDisabled("never-disabled", false, root)).not.toThrow();
    expect(isDisabled("never-disabled", root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry integration — loadUserGlobalModules honors the flag
// ---------------------------------------------------------------------------

describe("loadUserGlobalModules — honors disabled flag", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rn-dev-disabled-registry-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(id: string): void {
    const moduleRoot = join(root, id);
    mkdirSync(moduleRoot, { recursive: true });
    writeFileSync(
      join(moduleRoot, "rn-dev-module.json"),
      JSON.stringify({
        id,
        version: "0.1.0",
        hostRange: ">=0.1.0",
        scope: "per-worktree",
      }),
    );
  }

  it("skips modules whose disabled.flag is present", () => {
    writeManifest("first");
    writeManifest("second");
    setDisabled("second", true, root);

    const registry = new ModuleRegistry();
    const result = registry.loadUserGlobalModules({
      hostVersion: "0.1.0",
      modulesDir: root,
    });

    expect(result.modules.map((m) => m.manifest.id).sort()).toEqual([
      "first",
    ]);
    expect(result.rejected).toEqual([]);
  });

  it("re-enabling + re-loading picks the module back up", () => {
    writeManifest("toggle");
    setDisabled("toggle", true, root);

    const first = new ModuleRegistry().loadUserGlobalModules({
      hostVersion: "0.1.0",
      modulesDir: root,
    });
    expect(first.modules).toHaveLength(0);

    setDisabled("toggle", false, root);
    const second = new ModuleRegistry().loadUserGlobalModules({
      hostVersion: "0.1.0",
      modulesDir: root,
    });
    expect(second.modules).toHaveLength(1);
  });
});
