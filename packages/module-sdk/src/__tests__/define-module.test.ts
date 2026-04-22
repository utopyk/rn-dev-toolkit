import { describe, expect, it } from "vitest";
import {
  defineModule,
  enforceToolPrefix,
  ModuleError,
  ModuleErrorCode,
  validateManifest,
  type ModuleManifest,
} from "../index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function minimalManifest(
  overrides: Partial<ModuleManifest> = {},
): ModuleManifest {
  return {
    id: "example",
    version: "0.1.0",
    hostRange: ">=0.1.0",
    scope: "per-worktree",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateManifest / defineModule — happy path
// ---------------------------------------------------------------------------

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const result = validateManifest(minimalManifest());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.id).toBe("example");
    }
  });

  it("accepts a manifest with the full v1 contribution surface", () => {
    const manifest: ModuleManifest = minimalManifest({
      contributes: {
        mcp: {
          tools: [
            {
              name: "example__ping",
              description: "Ping the module",
              inputSchema: { type: "object", properties: {} },
              readOnlyHint: true,
            },
          ],
        },
        electron: {
          panels: [
            {
              id: "main",
              title: "Example",
              icon: "✨",
              webviewEntry: "dist/panel.html",
              hostApi: ["log", "appInfo"],
            },
          ],
        },
        tui: {
          views: [{ id: "main", title: "Example" }],
        },
      },
      permissions: ["network:outbound", "fs:artifacts"],
      activationEvents: ["onStartup", "onMcpTool:example__ping"],
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });

  it("accepts V2-reserved fields (signature, sandbox, target) without erroring", () => {
    const manifest: ModuleManifest = minimalManifest({
      signature: {
        algo: "ed25519",
        publicKey: "pk",
        signature: "sig",
      },
      sandbox: { kind: "none" },
      target: { kind: "emulator" },
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });

  it("accepts contributes.api (Phase 10 reserved) and contributes.config (Phase 5 reserved)", () => {
    const manifest: ModuleManifest = minimalManifest({
      contributes: {
        api: {
          methods: {
            lookupArtifact: {
              description: "Look up an artifact by hash",
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
            },
          },
        },
        config: { schema: { type: "object" } },
      },
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Error paths (path-pointing JSON Schema errors)
  // -------------------------------------------------------------------------

  it("rejects a manifest missing a required top-level field with a path-pointing error", () => {
    const result = validateManifest({
      id: "example",
      version: "0.1.0",
      // missing hostRange, scope
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((e) => e.message).join(" | ");
      expect(fields).toMatch(/hostRange|scope/);
    }
  });

  it("rejects an id that is not lowercase kebab-case at path `/id`", () => {
    const result = validateManifest(minimalManifest({ id: "Bad_Id" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path === "/id")).toBe(true);
    }
  });

  it("rejects an unknown scope with a path-pointing error on `/scope`", () => {
    const result = validateManifest(
      minimalManifest({ scope: "rogue" as unknown as "global" }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path === "/scope")).toBe(true);
    }
  });

  it("rejects an MCP tool missing inputSchema with a path-pointing error", () => {
    const manifest = minimalManifest({
      contributes: {
        mcp: {
          tools: [
            // Cast: this shape is intentionally invalid for the test.
            {
              name: "example__ping",
              description: "Ping",
            } as unknown as NonNullable<
              ModuleManifest["contributes"]
            >["mcp"] extends { tools: infer T }
              ? T extends readonly (infer U)[]
                ? U
                : never
              : never,
          ],
        },
      },
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) =>
          e.path.startsWith("/contributes/mcp/tools/0"),
        ),
      ).toBe(true);
    }
  });

  it("rejects additional top-level properties (schema is strict, no typo-tolerance)", () => {
    const result = validateManifest({
      ...minimalManifest(),
      rogueField: "nope",
    });
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// defineModule (throwing variant)
// ---------------------------------------------------------------------------

describe("defineModule", () => {
  it("returns the manifest untouched when valid", () => {
    const m = minimalManifest();
    expect(defineModule(m)).toBe(m);
  });

  it("throws ModuleError with code E_INVALID_MANIFEST on schema violation", () => {
    try {
      defineModule({
        id: "example",
        version: "0.1.0",
        // missing hostRange + scope
      } as unknown as ModuleManifest);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModuleError);
      expect((err as ModuleError).code).toBe(
        ModuleErrorCode.E_INVALID_MANIFEST,
      );
      expect((err as ModuleError).message).toMatch(/Invalid rn-dev module/);
    }
  });
});

// ---------------------------------------------------------------------------
// enforceToolPrefix
// ---------------------------------------------------------------------------

describe("enforceToolPrefix", () => {
  it("is a no-op for built-ins even when tool names lack the prefix", () => {
    const manifest = minimalManifest({
      contributes: {
        mcp: {
          tools: [
            {
              name: "metro/reload",
              description: "Reload",
              inputSchema: {},
            },
          ],
        },
      },
    });
    expect(() =>
      enforceToolPrefix(manifest, { isBuiltIn: true }),
    ).not.toThrow();
  });

  it("accepts correctly-prefixed 3p tool names", () => {
    const manifest = minimalManifest({
      id: "device-control",
      contributes: {
        mcp: {
          tools: [
            {
              name: "device-control__list",
              description: "List",
              inputSchema: {},
            },
          ],
        },
      },
    });
    expect(() =>
      enforceToolPrefix(manifest, { isBuiltIn: false }),
    ).not.toThrow();
  });

  it("rejects unprefixed 3p tool with E_TOOL_NAME_UNPREFIXED", () => {
    const manifest = minimalManifest({
      id: "device-control",
      contributes: {
        mcp: {
          tools: [
            {
              name: "list",
              description: "List",
              inputSchema: {},
            },
          ],
        },
      },
    });
    try {
      enforceToolPrefix(manifest, { isBuiltIn: false });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModuleError);
      expect((err as ModuleError).code).toBe(
        ModuleErrorCode.E_TOOL_NAME_UNPREFIXED,
      );
    }
  });

  it("rejects a 3p tool whose prefix does not match the module id", () => {
    const manifest = minimalManifest({
      id: "device-control",
      contributes: {
        mcp: {
          tools: [
            {
              name: "other__list",
              description: "List",
              inputSchema: {},
            },
          ],
        },
      },
    });
    expect(() =>
      enforceToolPrefix(manifest, { isBuiltIn: false }),
    ).toThrow(/device-control__/);
  });

  it("uses the MetaMCP double-underscore delimiter (single underscore is rejected)", () => {
    const manifest = minimalManifest({
      id: "device-control",
      contributes: {
        mcp: {
          tools: [
            {
              name: "device-control_list",
              description: "List",
              inputSchema: {},
            },
          ],
        },
      },
    });
    expect(() =>
      enforceToolPrefix(manifest, { isBuiltIn: false }),
    ).toThrow();
  });
});
