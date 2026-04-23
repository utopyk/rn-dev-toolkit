import { describe, it, expect } from "vitest";
import { parseFlags } from "../server.js";

describe("parseFlags — defaults", () => {
  it("defaults every flag to false / empty", () => {
    const flags = parseFlags([]);
    expect(flags.enabledModules.size).toBe(0);
    expect(flags.disabledModules.size).toBe(0);
    expect(flags.allowDestructiveTools).toBe(false);
  });
});

describe("parseFlags — module-system flags (Phase 3a)", () => {
  it("collects every --enable-module:<id> occurrence into enabledModules", () => {
    const flags = parseFlags([
      "--enable-module:device-control",
      "--enable-module:metro",
    ]);
    expect([...flags.enabledModules].sort()).toEqual([
      "device-control",
      "metro",
    ]);
  });

  it("collects every --disable-module:<id> occurrence into disabledModules", () => {
    const flags = parseFlags([
      "--disable-module:foo",
      "--disable-module:bar",
    ]);
    expect([...flags.disabledModules].sort()).toEqual(["bar", "foo"]);
  });

  it("ignores --enable-module: with empty id", () => {
    const flags = parseFlags(["--enable-module:"]);
    expect(flags.enabledModules.size).toBe(0);
  });

  it("trims whitespace-only ids", () => {
    const flags = parseFlags(["--enable-module:   "]);
    expect(flags.enabledModules.size).toBe(0);
  });

  it("parses --allow-destructive-tools", () => {
    expect(parseFlags([]).allowDestructiveTools).toBe(false);
    expect(parseFlags(["--allow-destructive-tools"]).allowDestructiveTools).toBe(
      true,
    );
  });

  it("allows enabling + disabling the same id — consumer decides precedence", () => {
    // parseFlags just records both sets; the tool-proxy (Phase 3b) enforces
    // that `disabledModules` wins when a conflict exists.
    const flags = parseFlags([
      "--enable-module:contested",
      "--disable-module:contested",
    ]);
    expect(flags.enabledModules.has("contested")).toBe(true);
    expect(flags.disabledModules.has("contested")).toBe(true);
  });
});
