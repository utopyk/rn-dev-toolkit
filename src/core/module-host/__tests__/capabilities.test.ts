import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "../capabilities.js";

interface TestLogger {
  log: (msg: string) => void;
}

describe("CapabilityRegistry — register + resolve (no permission)", () => {
  it("resolves an unpermissioned capability by id", () => {
    const registry = new CapabilityRegistry();
    const logger: TestLogger = { log: () => {} };
    registry.register<TestLogger>("log", logger, { allowReserved: true });
    expect(registry.resolve<TestLogger>("log", [])).toBe(logger);
  });

  it("returns null for an unknown capability id", () => {
    const registry = new CapabilityRegistry();
    expect(registry.resolve("unknown", [])).toBeNull();
  });

  it("throws on duplicate registration (id collision)", () => {
    const registry = new CapabilityRegistry();
    registry.register("log", { log: () => {} }, { allowReserved: true });
    expect(() =>
      registry.register("log", { log: () => {} }, { allowReserved: true }),
    ).toThrow(/already registered/i);
  });

  it("lists registered ids via `ids()`", () => {
    const registry = new CapabilityRegistry();
    registry.register("log", {}, { allowReserved: true });
    registry.register("appInfo", {}, { allowReserved: true });
    expect(registry.ids().sort()).toEqual(["appInfo", "log"]);
  });
});

describe("CapabilityRegistry — reserved id guard (F6)", () => {
  it("rejects plain register() of the reserved `log` id", () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.register("log", {})).toThrow(/reserved/);
  });

  it("rejects plain register() of the reserved `appInfo` id", () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.register("appInfo", {})).toThrow(/reserved/);
  });

  it("allows register() of reserved ids when allowReserved: true is set", () => {
    const registry = new CapabilityRegistry();
    expect(() =>
      registry.register("log", { info: () => {} }, { allowReserved: true }),
    ).not.toThrow();
    expect(() =>
      registry.register(
        "appInfo",
        { hostVersion: "x" },
        { allowReserved: true },
      ),
    ).not.toThrow();
  });
});

describe("CapabilityRegistry — permission gating", () => {
  it("returns the impl when the granted permissions include the required one", () => {
    const registry = new CapabilityRegistry();
    const artifacts = { load: () => null };
    registry.register("artifacts", artifacts, {
      requiredPermission: "fs:artifacts",
    });
    expect(registry.resolve("artifacts", ["fs:artifacts"])).toBe(artifacts);
  });

  it("returns null when the granted permissions do NOT include the required one", () => {
    const registry = new CapabilityRegistry();
    registry.register(
      "artifacts",
      { load: () => null },
      { requiredPermission: "fs:artifacts" },
    );
    expect(registry.resolve("artifacts", [])).toBeNull();
    expect(registry.resolve("artifacts", ["network:outbound"])).toBeNull();
  });

  it("unpermissioned capability is resolvable with any (or no) granted permissions", () => {
    const registry = new CapabilityRegistry();
    const logger = { log: () => {} };
    registry.register("log", logger, { allowReserved: true });
    expect(registry.resolve("log", [])).toBe(logger);
    expect(registry.resolve("log", ["network:outbound"])).toBe(logger);
  });

  it("grants on a pattern match when permissions are declared with wildcards", () => {
    // Not supported in v1 — exact match only. This test documents the
    // expectation. If glob patterns land in V2, relax this.
    const registry = new CapabilityRegistry();
    registry.register(
      "net",
      { connect: () => {} },
      { requiredPermission: "net:8081-8090" },
    );
    expect(registry.resolve("net", ["net:*"])).toBeNull();
    expect(registry.resolve("net", ["net:8081-8090"])).toEqual({
      connect: expect.any(Function),
    });
  });
});

describe("CapabilityRegistry — introspection", () => {
  it("`describe(id)` returns metadata without the impl for UI/consent flows", () => {
    const registry = new CapabilityRegistry();
    registry.register(
      "metro",
      { /* impl */ },
      { requiredPermission: "exec:react-native" },
    );
    expect(registry.describe("metro")).toEqual({
      id: "metro",
      requiredPermission: "exec:react-native",
    });
  });

  it("`describe(id)` returns null for unknown capabilities", () => {
    const registry = new CapabilityRegistry();
    expect(registry.describe("ghost")).toBeNull();
  });

  it("`describeAll()` returns metadata for every registered capability", () => {
    const registry = new CapabilityRegistry();
    registry.register("log", {}, { allowReserved: true });
    registry.register("artifacts", {}, { requiredPermission: "fs:artifacts" });
    const all = registry.describeAll();
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.id === "log")?.requiredPermission).toBeUndefined();
    expect(all.find((c) => c.id === "artifacts")?.requiredPermission).toBe(
      "fs:artifacts",
    );
  });
});

describe("CapabilityRegistry — unregister", () => {
  it("removes a capability and returns true", () => {
    const registry = new CapabilityRegistry();
    registry.register("log", { log: () => {} }, { allowReserved: true });
    expect(registry.unregister("log")).toBe(true);
    expect(registry.resolve("log", [])).toBeNull();
  });

  it("returns false for an unknown id", () => {
    const registry = new CapabilityRegistry();
    expect(registry.unregister("ghost")).toBe(false);
  });
});
