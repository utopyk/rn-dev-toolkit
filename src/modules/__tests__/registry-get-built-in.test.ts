// Phase H2c — `ModuleRegistry.getBuiltIn<T>(id)` resolves a built-in
// module's in-process capability instance. Throws cleanly on every
// misuse so call sites can tell apart "you typo'd the id", "you forgot
// to pass instance at registration time", and "this id is registered
// but as a non-built-in".

import { describe, it, expect, beforeEach } from "vitest";
import type { ModuleManifest } from "@rn-dev/module-sdk";
import { ModuleRegistry } from "../registry.js";
import {
  __addBuiltInAllowedForTests,
  __resetBuiltInAllowlistForTests,
} from "../built-in-allowlist.js";

const TEST_BUILTIN_ID = "h2c-test-builtin";

const manifest: ModuleManifest = {
  id: TEST_BUILTIN_ID,
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global",
  activationEvents: ["onStartup"],
};

interface FakeBuilderCapability {
  build(): "ok";
}

beforeEach(() => {
  __resetBuiltInAllowlistForTests();
  __addBuiltInAllowedForTests(TEST_BUILTIN_ID);
});

describe("ModuleRegistry.getBuiltIn", () => {
  it("returns the registered instance, narrowed to T", () => {
    const registry = new ModuleRegistry();
    const cap: FakeBuilderCapability = { build: () => "ok" };
    registry.registerBuiltIn(manifest, { instance: cap });

    const resolved = registry.getBuiltIn<FakeBuilderCapability>(TEST_BUILTIN_ID);
    expect(resolved).toBe(cap);
    expect(resolved.build()).toBe("ok");
  });

  it("throws when no built-in with that id has been registered", () => {
    const registry = new ModuleRegistry();
    expect(() => registry.getBuiltIn("does-not-exist")).toThrow(
      /no built-in with that id has been registered/,
    );
  });

  it("throws a different message when the manifest is registered without an instance", () => {
    const registry = new ModuleRegistry();
    registry.registerBuiltIn(manifest); // no instance

    expect(() => registry.getBuiltIn(TEST_BUILTIN_ID)).toThrow(
      /no capability instance was provided/,
    );
  });

  it("hasBuiltInInstance reports true only when an instance was provided", () => {
    const registry = new ModuleRegistry();
    expect(registry.hasBuiltInInstance(TEST_BUILTIN_ID)).toBe(false);

    registry.registerBuiltIn(manifest);
    expect(registry.hasBuiltInInstance(TEST_BUILTIN_ID)).toBe(false);

    const registry2 = new ModuleRegistry();
    registry2.registerBuiltIn(manifest, { instance: { build: () => "ok" } });
    expect(registry2.hasBuiltInInstance(TEST_BUILTIN_ID)).toBe(true);
  });

  it("treats {instance: null} as a real instance (not 'no instance')", () => {
    // null is a valid in-process capability for callers that intentionally
    // store a sentinel — only the literal `undefined` skips storage.
    const registry = new ModuleRegistry();
    registry.registerBuiltIn(manifest, { instance: null });
    expect(registry.hasBuiltInInstance(TEST_BUILTIN_ID)).toBe(true);
    expect(registry.getBuiltIn<null>(TEST_BUILTIN_ID)).toBeNull();
  });
});
