import { describe, expect, it } from "vitest";
import {
  ModuleRegistry,
  builtInModulePath,
} from "../registry.js";
import {
  devSpaceManifest,
  lintTestManifest,
  settingsManifest,
} from "../built-in/manifests.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";

describe("registerBuiltIn — stamps kind + sentinel path + isBuiltIn", () => {
  it("stamps kind='built-in-privileged', isBuiltIn=true, state='active'", () => {
    const registry = new ModuleRegistry();
    const registered = registry.registerBuiltIn(devSpaceManifest);

    expect(registered.kind).toBe("built-in-privileged");
    expect(registered.isBuiltIn).toBe(true);
    expect(registered.state).toBe("active");
  });

  it("sets modulePath to the <built-in:<id>> sentinel", () => {
    const registry = new ModuleRegistry();
    const registered = registry.registerBuiltIn(settingsManifest);

    expect(registered.modulePath).toBe(builtInModulePath("settings"));
    // Arch #4 — consumers now branch on `kind`, not on the modulePath string.
    // The sentinel remains for display; the predicate has been removed.
    expect(registered.kind).toBe("built-in-privileged");
  });

  it("registers under the 'global' scopeUnit for global-scope manifests", () => {
    const registry = new ModuleRegistry();
    registry.registerBuiltIn(devSpaceManifest);

    const reg = registry.getManifest("dev-space", "global");
    expect(reg).toBeDefined();
    expect(reg!.scopeUnit).toBe("global");
  });

  it("rejects invalid manifests with ModuleError", () => {
    const registry = new ModuleRegistry();
    // Missing required `id` field.
    const invalid = { version: "0.1.0" } as unknown as ModuleManifest;
    expect(() => registry.registerBuiltIn(invalid)).toThrow(
      /schema validation|E_INVALID_MANIFEST/,
    );
  });

  it("throws 'already registered' on duplicate built-in ids", () => {
    const registry = new ModuleRegistry();
    registry.registerBuiltIn(devSpaceManifest);
    expect(() => registry.registerBuiltIn(devSpaceManifest)).toThrow(
      /already registered/,
    );
  });

  it("waives the 3p tool-prefix policy (built-ins can contribute unprefixed tools)", () => {
    const registry = new ModuleRegistry();
    const unprefixed: ModuleManifest = {
      id: "privileged-tools",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "global",
      contributes: {
        mcp: {
          tools: [
            {
              name: "list-devices",
              description: "Flat-namespace tool name allowed on built-ins.",
              inputSchema: { type: "object" },
              readOnlyHint: true,
            },
          ],
        },
      },
    };
    expect(() => registry.registerBuiltIn(unprefixed)).not.toThrow();
  });
});

describe("built-in manifests — shape + contributes blocks", () => {
  it("each of the 3 existing built-ins registers without error", () => {
    // Phase 11: `metro-logs` moved out of built-ins into the
    // `@rn-dev-modules/metro-logs` 3p module — the three remaining
    // built-ins below are the ones kept in-process for Phase 11+.
    const registry = new ModuleRegistry();
    registry.registerBuiltIn(devSpaceManifest);
    registry.registerBuiltIn(lintTestManifest);
    registry.registerBuiltIn(settingsManifest);

    expect(
      registry.getAllManifests().map((m) => m.manifest.id).sort(),
    ).toEqual(["dev-space", "lint-test", "settings"]);
  });

  it("settings contributes a config schema", () => {
    expect(settingsManifest.contributes?.config?.schema).toBeDefined();
  });

  it("every built-in contributes a TUI view keyed by the module id", () => {
    const manifests = [
      devSpaceManifest,
      lintTestManifest,
      settingsManifest,
    ];
    for (const m of manifests) {
      const views = m.contributes?.tui?.views ?? [];
      expect(views.length).toBeGreaterThan(0);
      expect(views[0].id).toBe(m.id);
    }
  });
});
