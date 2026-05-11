// Phase H2d — KNOWN_CAPABILITIES + warnIfUnknownCapability typo
// detector, mirroring the existing KNOWN_PERMISSIONS scaffold. Wired
// into `CapabilityRegistry.register()` so a typo in a register call
// surfaces a console warning instead of silently shadowing the
// capability behind an unmatchable id.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityRegistry,
  KNOWN_CAPABILITIES,
  KNOWN_PERMISSIONS,
  RESERVED_CAPABILITY_IDS,
  resetUnknownCapabilityWarningsForTests,
  resetUnknownPermissionWarningsForTests,
  warnIfUnknownCapability,
} from "../capabilities.js";

describe("KNOWN_CAPABILITIES (Phase H2d)", () => {
  it("includes every capability id the host registers at session boot", () => {
    expect(KNOWN_CAPABILITIES).toEqual(
      expect.arrayContaining([
        "appInfo",
        "log",
        "artifacts",
        "devtools",
        "metro",
        "metro-logs",
        "modules",
        "build:hooks",
      ]),
    );
  });

  it("contains the reserved capability ids so register({allowReserved}) of them does not warn", () => {
    for (const reserved of RESERVED_CAPABILITY_IDS) {
      expect(KNOWN_CAPABILITIES).toContain(reserved);
    }
  });

  it("KNOWN_PERMISSIONS includes the new host:hooks:dispatch gate", () => {
    expect(KNOWN_PERMISSIONS).toContain("host:hooks:dispatch");
  });
});

describe("warnIfUnknownCapability (Phase H2d)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetUnknownCapabilityWarningsForTests();
    resetUnknownPermissionWarningsForTests();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("does not warn for a canonical id", () => {
    warnIfUnknownCapability("build:hooks");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once for an unknown id, then dedups subsequent calls", () => {
    warnIfUnknownCapability("buld:hookz"); // misspelled
    warnIfUnknownCapability("buld:hookz");
    warnIfUnknownCapability("buld:hookz");
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0] ?? [])[0]).toMatch(
      /capability "buld:hookz" is not on the host's canonical/,
    );
  });

  it("warns separately for two different unknown ids", () => {
    warnIfUnknownCapability("typoA");
    warnIfUnknownCapability("typoB");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("CapabilityRegistry.register() surfaces the warning at register-time", () => {
    const registry = new CapabilityRegistry();
    registry.register("totally-not-canonical", {});
    const calls = (warn.mock.calls as Array<Array<unknown>>).map(
      (c) => c[0] as string,
    );
    expect(
      calls.some((s) => s.includes("totally-not-canonical")),
    ).toBe(true);
  });

  it("CapabilityRegistry.register() does NOT warn for a canonical id", () => {
    const registry = new CapabilityRegistry();
    registry.register("build:hooks", {}, {
      requiredPermission: "host:hooks:dispatch",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not enumerate the canonical id list in the warning text (Security P2-B)", () => {
    warnIfUnknownCapability("nope");
    const text = (warn.mock.calls[0] ?? [])[0] as string;
    for (const id of KNOWN_CAPABILITIES) {
      expect(text).not.toContain(id);
    }
  });
});
