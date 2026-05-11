import { describe, it, expect } from "vitest";
import { ModuleError, ModuleErrorCode, type ModuleManifest } from "@rn-dev/module-sdk";
import {
  BUILT_IN_MODULE_ALLOWLIST,
  assertBuiltInAllowed,
  isBuiltInAllowed,
} from "../built-in-allowlist.js";
import { ModuleRegistry } from "../registry.js";

const SESSION_MANIFEST: ModuleManifest = {
  id: "session",
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global",
};

const ROGUE_MANIFEST: ModuleManifest = {
  ...SESSION_MANIFEST,
  id: "rogue-3p",
};

describe("BUILT_IN_MODULE_ALLOWLIST", () => {
  it("ships with `session` (H1) and `build` (H2)", () => {
    expect(BUILT_IN_MODULE_ALLOWLIST.has("session")).toBe(true);
    expect(BUILT_IN_MODULE_ALLOWLIST.has("build")).toBe(true);
  });

  it("does NOT include H3 ids that haven't shipped yet", () => {
    expect(BUILT_IN_MODULE_ALLOWLIST.has("clean")).toBe(false);
    expect(BUILT_IN_MODULE_ALLOWLIST.has("metro")).toBe(false);
    expect(BUILT_IN_MODULE_ALLOWLIST.has("devtools-core")).toBe(false);
    expect(BUILT_IN_MODULE_ALLOWLIST.has("preflight")).toBe(false);
  });
});

describe("assertBuiltInAllowed", () => {
  it("returns silently for an allowed id", () => {
    expect(() => assertBuiltInAllowed("session")).not.toThrow();
  });

  it("throws E_INVALID_MANIFEST for an unknown id", () => {
    let caught: unknown;
    try {
      assertBuiltInAllowed("rogue-3p");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModuleError);
    expect((caught as ModuleError).code).toBe(ModuleErrorCode.E_INVALID_MANIFEST);
    expect((caught as ModuleError).message).toMatch(/built-in-privileged allowlist/);
  });
});

describe("isBuiltInAllowed", () => {
  it("returns true for allowed ids and false otherwise", () => {
    expect(isBuiltInAllowed("session")).toBe(true);
    expect(isBuiltInAllowed("build")).toBe(true);
    expect(isBuiltInAllowed("clean")).toBe(false); // H3 — not yet
    expect(isBuiltInAllowed("")).toBe(false);
  });
});

describe("ModuleRegistry.registerBuiltIn — allowlist gate", () => {
  it("registers a manifest whose id is on the allowlist", () => {
    const registry = new ModuleRegistry();
    const registered = registry.registerBuiltIn(SESSION_MANIFEST);
    expect(registered.kind).toBe("built-in-privileged");
    expect(registered.manifest.id).toBe("session");
  });

  it("rejects a manifest whose id is NOT on the allowlist", () => {
    const registry = new ModuleRegistry();
    expect(() => registry.registerBuiltIn(ROGUE_MANIFEST)).toThrow(
      /built-in-privileged allowlist/,
    );
  });
});
