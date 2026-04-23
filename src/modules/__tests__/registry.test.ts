import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import React from "react";
import { ModuleRegistry } from "../registry.js";
import { ModuleErrorCode } from "@rn-dev/module-sdk";
import type { ModuleManifest } from "@rn-dev/module-sdk";
import type { RnDevModule } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModule(overrides: Partial<RnDevModule> = {}): RnDevModule {
  return {
    id: "test-module",
    name: "Test Module",
    icon: "T",
    order: 10,
    component: (() => null) as unknown as React.FC,
    shortcuts: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ModuleRegistry
// ---------------------------------------------------------------------------

describe("ModuleRegistry", () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
  });

  // -------------------------------------------------------------------------
  // register / get
  // -------------------------------------------------------------------------

  it("registers and retrieves a module by id", () => {
    const mod = makeModule({ id: "alpha" });
    registry.register(mod);
    expect(registry.get("alpha")).toBe(mod);
  });

  it("returns undefined for an unregistered id", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    const mod = makeModule({ id: "dup" });
    registry.register(mod);
    expect(() => registry.register(mod)).toThrow(/already registered/i);
  });

  it("throws on duplicate registration even with different object", () => {
    registry.register(makeModule({ id: "dup" }));
    expect(() => registry.register(makeModule({ id: "dup" }))).toThrow();
  });

  // -------------------------------------------------------------------------
  // unregister
  // -------------------------------------------------------------------------

  it("unregister removes the module and returns true", () => {
    registry.register(makeModule({ id: "rem" }));
    expect(registry.unregister("rem")).toBe(true);
    expect(registry.get("rem")).toBeUndefined();
  });

  it("unregister returns false for an unknown id", () => {
    expect(registry.unregister("ghost")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // getAll (sorted by order)
  // -------------------------------------------------------------------------

  it("getAll returns all modules sorted by order ascending", () => {
    registry.register(makeModule({ id: "c", order: 30 }));
    registry.register(makeModule({ id: "a", order: 10 }));
    registry.register(makeModule({ id: "b", order: 20 }));

    const all = registry.getAll();
    expect(all.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("getAll returns empty array when no modules registered", () => {
    expect(registry.getAll()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // getShortcuts
  // -------------------------------------------------------------------------

  it("getShortcuts collects shortcuts from all modules", () => {
    const action = async () => {};
    registry.register(
      makeModule({
        id: "m1",
        shortcuts: [
          { key: "r", label: "Reload", action, showInPanel: true },
          { key: "d", label: "Dev Menu", action, showInPanel: false },
        ],
      })
    );
    registry.register(
      makeModule({
        id: "m2",
        shortcuts: [{ key: "s", label: "Save", action, showInPanel: true }],
      })
    );

    const shortcuts = registry.getShortcuts();
    expect(shortcuts).toHaveLength(3);
    expect(shortcuts.map((s) => s.key)).toEqual(["r", "d", "s"]);
    expect(shortcuts.every((s) => "moduleId" in s)).toBe(true);
  });

  it("getShortcuts returns empty array when no modules have shortcuts", () => {
    registry.register(makeModule({ id: "no-shortcuts", shortcuts: [] }));
    expect(registry.getShortcuts()).toEqual([]);
  });

  it("getShortcuts works when shortcuts field is undefined", () => {
    const mod: RnDevModule = {
      id: "no-shortcuts-field",
      name: "No Shortcuts",
      icon: "N",
      order: 5,
      component: (() => null) as unknown as React.FC,
    };
    registry.register(mod);
    expect(registry.getShortcuts()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // loadPlugins
  // -------------------------------------------------------------------------

  describe("loadPlugins", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "rn-dev-cli-registry-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("handles missing package.json gracefully", async () => {
      // No package.json in tmpDir — should not throw
      await expect(registry.loadPlugins(tmpDir)).resolves.toBeUndefined();
    });

    it("handles package.json with no rn-dev field gracefully", async () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "my-project" })
      );
      await expect(registry.loadPlugins(tmpDir)).resolves.toBeUndefined();
    });

    it("handles package.json with empty plugins array gracefully", async () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "my-project", "rn-dev": { plugins: [] } })
      );
      await expect(registry.loadPlugins(tmpDir)).resolves.toBeUndefined();
    });

    it("handles invalid plugin entries gracefully (does not throw)", async () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "my-project",
          "rn-dev": { plugins: ["nonexistent-plugin-xyz-12345"] },
        })
      );
      // Should not throw even if the plugin can't be imported
      await expect(registry.loadPlugins(tmpDir)).resolves.toBeUndefined();
    });

    it("handles malformed package.json gracefully", async () => {
      writeFileSync(join(tmpDir, "package.json"), "{ invalid json");
      await expect(registry.loadPlugins(tmpDir)).resolves.toBeUndefined();
    });

    it("accepts an Ink module without a component (loosened isRnDevModule)", () => {
      // Direct register — no component, proving the type accepts it.
      const mcpOnly: RnDevModule = {
        id: "mcp-only",
        name: "MCP Only",
        icon: "M",
        order: 1,
      };
      expect(() => registry.register(mcpOnly)).not.toThrow();
      expect(registry.get("mcp-only")).toBe(mcpOnly);
    });
  });

  // -------------------------------------------------------------------------
  // loadUserGlobalModules — manifest-based modules (Phase 1)
  // -------------------------------------------------------------------------

  describe("loadUserGlobalModules", () => {
    let modulesDir: string;

    beforeEach(() => {
      modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-modules-"));
    });

    afterEach(() => {
      rmSync(modulesDir, { recursive: true, force: true });
    });

    function writeManifest(name: string, manifest: ModuleManifest): string {
      const moduleRoot = join(modulesDir, name);
      mkdirSync(moduleRoot, { recursive: true });
      const path = join(moduleRoot, "rn-dev-module.json");
      writeFileSync(path, JSON.stringify(manifest, null, 2));
      return path;
    }

    function baseManifest(
      overrides: Partial<ModuleManifest> = {},
    ): ModuleManifest {
      return {
        id: "fixture",
        version: "0.1.0",
        hostRange: ">=0.1.0",
        scope: "per-worktree",
        ...overrides,
      };
    }

    it("returns empty result when the modules directory does not exist", () => {
      const result = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir: join(modulesDir, "nonexistent"),
      });
      expect(result.modules).toEqual([]);
      expect(result.rejected).toEqual([]);
    });

    it("loads a valid minimal manifest end-to-end in inert state", () => {
      writeManifest("fixture", baseManifest());

      const result = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir,
        scopeUnit: "wt-abc",
      });

      expect(result.rejected).toEqual([]);
      expect(result.modules).toHaveLength(1);
      const [mod] = result.modules;
      expect(mod.manifest.id).toBe("fixture");
      expect(mod.state).toBe("inert");
      expect(mod.isBuiltIn).toBe(false);
      expect(mod.scopeUnit).toBe("wt-abc");
      expect(registry.getManifest("fixture", "wt-abc")).toBe(mod);
    });

    it("pins global-scope modules to scopeUnit='global' regardless of the passed scopeUnit", () => {
      writeManifest("glob", baseManifest({ id: "glob", scope: "global" }));

      const result = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir,
        scopeUnit: "wt-abc",
      });

      expect(result.modules).toHaveLength(1);
      expect(result.modules[0]?.scopeUnit).toBe("global");
    });

    it("scope-aware key — same id in two scope units registers independently", () => {
      const manifest = baseManifest({ id: "per-wt" });

      // Load twice with two different scopeUnits
      writeManifest("per-wt", manifest);
      const first = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir,
        scopeUnit: "wt-1",
      });
      expect(first.modules).toHaveLength(1);

      const second = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir,
        scopeUnit: "wt-2",
      });
      expect(second.modules).toHaveLength(1);

      expect(registry.getAllManifests()).toHaveLength(2);
      expect(registry.getManifest("per-wt", "wt-1")).toBeDefined();
      expect(registry.getManifest("per-wt", "wt-2")).toBeDefined();
    });

    it("rejects a manifest whose hostRange does not satisfy the host version", () => {
      const path = writeManifest(
        "too-new",
        baseManifest({ id: "too-new", hostRange: ">=2.0.0" }),
      );

      const result = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir,
      });

      expect(result.modules).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.manifestPath).toBe(path);
      expect(result.rejected[0]?.code).toBe(
        ModuleErrorCode.E_HOST_RANGE_MISMATCH,
      );
      expect(result.rejected[0]?.message).toMatch(/0\.1\.0/);
    });

    it("rejects an invalid manifest with path-pointing JSON Schema errors", () => {
      const moduleRoot = join(modulesDir, "broken");
      mkdirSync(moduleRoot, { recursive: true });
      writeFileSync(
        join(moduleRoot, "rn-dev-module.json"),
        JSON.stringify({
          id: "broken",
          version: "0.1.0",
          // missing hostRange + scope
        }),
      );

      const result = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir,
      });

      expect(result.modules).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      const rejection = result.rejected[0];
      expect(rejection?.code).toBe(ModuleErrorCode.E_INVALID_MANIFEST);
      expect(rejection?.schemaErrors).toBeDefined();
      expect(rejection?.schemaErrors?.length).toBeGreaterThan(0);
      // Path-pointing — at least one error should carry a JSON Pointer.
      expect(
        rejection?.schemaErrors?.every((e) => typeof e.path === "string"),
      ).toBe(true);
    });

    it("rejects a manifest with a 3p tool name missing the <id>__ prefix", () => {
      writeManifest(
        "unprefixed",
        baseManifest({
          id: "unprefixed",
          contributes: {
            mcp: {
              tools: [
                {
                  name: "do-stuff",
                  description: "Does stuff",
                  inputSchema: {},
                },
              ],
            },
          },
        }),
      );

      const result = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir,
      });

      expect(result.modules).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.code).toBe(
        ModuleErrorCode.E_TOOL_NAME_UNPREFIXED,
      );
      expect(result.rejected[0]?.message).toMatch(/unprefixed__/);
    });

    it("skips malformed JSON with an E_INVALID_JSON rejection", () => {
      const moduleRoot = join(modulesDir, "not-json");
      mkdirSync(moduleRoot, { recursive: true });
      writeFileSync(
        join(moduleRoot, "rn-dev-module.json"),
        "{ this is not valid json",
      );

      const result = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir,
      });

      expect(result.modules).toHaveLength(0);
      expect(result.rejected[0]?.code).toBe("E_INVALID_JSON");
    });

    it("skips module directories that lack a rn-dev-module.json", () => {
      const moduleRoot = join(modulesDir, "no-manifest");
      mkdirSync(moduleRoot, { recursive: true });
      writeFileSync(join(moduleRoot, "package.json"), "{}");

      const result = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir,
      });

      expect(result.modules).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
    });

    it("loads the fixture at test/fixtures/minimal-module end-to-end", () => {
      const repoRoot = join(__dirname, "..", "..", "..");
      const fixtureParent = join(repoRoot, "test", "fixtures");

      const result = registry.loadUserGlobalModules({
        hostVersion: "0.1.0",
        modulesDir: fixtureParent,
      });

      expect(result.rejected).toEqual([]);
      expect(result.modules.map((m) => m.manifest.id)).toContain(
        "minimal-fixture",
      );
      const fixture = result.modules.find(
        (m) => m.manifest.id === "minimal-fixture",
      );
      expect(fixture?.manifest.contributes?.mcp?.tools?.[0]?.name).toBe(
        "minimal-fixture__ping",
      );
      expect(fixture?.manifest.permissions).toEqual(["network:outbound"]);
      expect(fixture?.manifest.activationEvents).toEqual(["onStartup"]);
    });

    // Phase 10 P1-5 — static-vs-instance split: applyScan is the instance
    // half of the scan/apply pipeline and can be called with any
    // LoadManifestsResult, not just the output of scanUserGlobalModules.
    describe("applyScan (Phase 10 split)", () => {
      it("accepts a pre-scanned manifest and registers it", () => {
        writeManifest("foo", baseManifest({ id: "foo" }));
        const scan = ModuleRegistry.scanUserGlobalModules({
          hostVersion: "0.1.0",
          modulesDir,
        });
        expect(scan.modules).toHaveLength(1);

        const applied = registry.applyScan(scan);
        expect(applied.modules).toHaveLength(1);
        expect(registry.getManifest("foo", "global")).toBeDefined();
      });

      it("preserves scan-time rejections in the applied result", () => {
        const moduleRoot = join(modulesDir, "broken");
        mkdirSync(moduleRoot, { recursive: true });
        writeFileSync(
          join(moduleRoot, "rn-dev-module.json"),
          "{ not json",
        );

        const scan = ModuleRegistry.scanUserGlobalModules({
          hostVersion: "0.1.0",
          modulesDir,
        });
        expect(scan.rejected).toHaveLength(1);

        const applied = registry.applyScan(scan);
        expect(applied.rejected).toHaveLength(1);
        expect(applied.modules).toHaveLength(0);
      });

      it("converts duplicate registration to an apply-time rejection (no throw)", () => {
        writeManifest("dupe", baseManifest({ id: "dupe" }));
        const scan = ModuleRegistry.scanUserGlobalModules({
          hostVersion: "0.1.0",
          modulesDir,
        });
        // Apply twice — second call hits the duplicate-id guard.
        registry.applyScan(scan);
        const second = registry.applyScan(scan);
        expect(second.modules).toHaveLength(0);
        expect(second.rejected).toHaveLength(1);
        expect(second.rejected[0]?.code).toBe("E_INVALID_MANIFEST");
      });
    });
  });

  // -------------------------------------------------------------------------
  // Manifest registration — direct API
  // -------------------------------------------------------------------------

  describe("registerManifest / getManifest", () => {
    const manifest: ModuleManifest = {
      id: "direct",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "per-worktree",
    };

    it("registers and retrieves a manifest by scope-aware key", () => {
      registry.registerManifest({
        manifest,
        modulePath: "/tmp/direct",
        scopeUnit: "wt-1",
        state: "inert",
        isBuiltIn: false,
      });
      expect(registry.getManifest("direct", "wt-1")?.manifest).toBe(manifest);
      expect(registry.getManifest("direct", "wt-2")).toBeUndefined();
    });

    it("throws on duplicate registration for the same (id, scopeUnit) pair", () => {
      const entry = {
        manifest,
        modulePath: "/tmp/direct",
        scopeUnit: "wt-1",
        state: "inert" as const,
        isBuiltIn: false,
      };
      registry.registerManifest(entry);
      expect(() => registry.registerManifest(entry)).toThrow(
        /already registered/i,
      );
    });

    it("unregisterManifest returns true on removal, false on unknown", () => {
      registry.registerManifest({
        manifest,
        modulePath: "/tmp/direct",
        scopeUnit: "wt-1",
        state: "inert",
        isBuiltIn: false,
      });
      expect(registry.unregisterManifest("direct", "wt-1")).toBe(true);
      expect(registry.unregisterManifest("direct", "wt-1")).toBe(false);
    });
  });
});
