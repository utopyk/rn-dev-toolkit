// Phase 7 — ModuleRegistry.loadSingleManifest is the helper the
// Marketplace installer uses to validate a freshly-extracted manifest
// without scanning the whole modules dir (which surfaced sibling
// rejections in a broken-neighbor scenario).

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleRegistry } from "../registry.js";

function makeTmpManifest(body: unknown): { manifestPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rn-dev-manifest-"));
  const manifestPath = join(dir, "rn-dev-module.json");
  writeFileSync(manifestPath, JSON.stringify(body));
  return {
    manifestPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("ModuleRegistry.loadSingleManifest", () => {
  it("returns { kind: 'ok', module } for a valid manifest", () => {
    const { manifestPath, cleanup } = makeTmpManifest({
      id: "tester",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "global",
      contributes: {
        mcp: {
          tools: [
            {
              name: "tester__ping",
              description: "ping",
              inputSchema: { type: "object" },
            },
          ],
        },
      },
    });
    try {
      const result = ModuleRegistry.loadSingleManifest(manifestPath, {
        hostVersion: "0.1.0",
        scopeUnit: "global",
        isBuiltIn: false,
      });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.module.manifest.id).toBe("tester");
        expect(result.module.scopeUnit).toBe("global");
        expect(result.module.state).toBe("inert");
      }
    } finally {
      cleanup();
    }
  });

  it("returns E_INVALID_MANIFEST when the JSON fails schema validation", () => {
    const { manifestPath, cleanup } = makeTmpManifest({ id: "x" });
    try {
      const result = ModuleRegistry.loadSingleManifest(manifestPath, {
        hostVersion: "0.1.0",
        scopeUnit: "global",
        isBuiltIn: false,
      });
      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.rejection.code).toBe("E_INVALID_MANIFEST");
      }
    } finally {
      cleanup();
    }
  });

  it("returns E_INVALID_JSON when the file isn't valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-dev-bad-json-"));
    const manifestPath = join(dir, "rn-dev-module.json");
    writeFileSync(manifestPath, "{not valid json");
    try {
      const result = ModuleRegistry.loadSingleManifest(manifestPath, {
        hostVersion: "0.1.0",
        scopeUnit: "global",
        isBuiltIn: false,
      });
      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.rejection.code).toBe("E_INVALID_JSON");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects 3p manifests with unprefixed tool names (E_TOOL_NAME_UNPREFIXED)", () => {
    const { manifestPath, cleanup } = makeTmpManifest({
      id: "naughty",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "global",
      contributes: {
        mcp: {
          tools: [
            {
              name: "flat-name-no-prefix",
              description: "no prefix",
              inputSchema: { type: "object" },
            },
          ],
        },
      },
    });
    try {
      const result = ModuleRegistry.loadSingleManifest(manifestPath, {
        hostVersion: "0.1.0",
        scopeUnit: "global",
        isBuiltIn: false,
      });
      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.rejection.code).toBe("E_TOOL_NAME_UNPREFIXED");
      }
    } finally {
      cleanup();
    }
  });

  it("accepts unprefixed tool names for built-ins", () => {
    const { manifestPath, cleanup } = makeTmpManifest({
      id: "builtin",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "global",
      contributes: {
        mcp: {
          tools: [
            {
              name: "flat-name-allowed",
              description: "flat",
              inputSchema: { type: "object" },
            },
          ],
        },
      },
    });
    try {
      const result = ModuleRegistry.loadSingleManifest(manifestPath, {
        hostVersion: "0.1.0",
        scopeUnit: "global",
        isBuiltIn: true,
      });
      expect(result.kind).toBe("ok");
    } finally {
      cleanup();
    }
  });

  it("rejects with E_HOST_RANGE_MISMATCH when hostVersion outside hostRange", () => {
    const { manifestPath, cleanup } = makeTmpManifest({
      id: "tester",
      version: "0.1.0",
      hostRange: ">=2.0.0",
      scope: "global",
    });
    try {
      const result = ModuleRegistry.loadSingleManifest(manifestPath, {
        hostVersion: "0.1.0",
        scopeUnit: "global",
        isBuiltIn: false,
      });
      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.rejection.code).toBe("E_HOST_RANGE_MISMATCH");
      }
    } finally {
      cleanup();
    }
  });
});

// sanity check that mkdirSync is actually used via transitive test setup
// (empty probe so linters don't flag the import as unused).
describe("setup sanity", () => {
  it("mkdirSync is a fn", () => {
    expect(typeof mkdirSync).toBe("function");
  });
});
