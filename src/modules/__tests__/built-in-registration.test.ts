import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ModuleRegistry,
  builtInModulePath,
} from "../registry.js";
import {
  devSpaceManifest,
  lintTestManifest,
  sessionManifest,
  settingsManifest,
} from "../built-in/manifests.js";
import {
  __addBuiltInAllowedForTests,
  __resetBuiltInAllowlistForTests,
} from "../built-in-allowlist.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";

beforeEach(() => {
  // Synthetic fixture id used by the tool-prefix-waiver test below.
  __addBuiltInAllowedForTests("privileged-tools");
});

afterEach(() => {
  __resetBuiltInAllowlistForTests();
});

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
  it("each of the 4 existing built-ins registers without error", () => {
    // Phase 11: `metro-logs` moved out of built-ins into the
    // `@rn-dev-modules/metro-logs` 3p module. Phase H1: `session`
    // joins the in-process built-ins to host the daemon's lifecycle
    // hooks (`init` + `profile-changed`).
    const registry = new ModuleRegistry();
    registry.registerBuiltIn(devSpaceManifest);
    registry.registerBuiltIn(lintTestManifest);
    registry.registerBuiltIn(settingsManifest);
    registry.registerBuiltIn(sessionManifest);

    expect(
      registry.getAllManifests().map((m) => m.manifest.id).sort(),
    ).toEqual(["dev-space", "lint-test", "session", "settings"]);
  });

  it("settings contributes a config schema", () => {
    expect(settingsManifest.contributes?.config?.schema).toBeDefined();
  });

  it("session declares provides.hooks for init + profile-changed", () => {
    expect(sessionManifest.provides?.hooks).toEqual(["init", "profile-changed"]);
  });

  it("session contributes no TUI/MCP surface (host-only contribution-points)", () => {
    expect(sessionManifest.contributes).toBeUndefined();
  });

  it("every TUI-bearing built-in contributes a view keyed by the module id", () => {
    // session is exempt — it has no UI surface.
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
