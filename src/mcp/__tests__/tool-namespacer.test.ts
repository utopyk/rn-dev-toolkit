import { describe, expect, it } from "vitest";
import {
  assertMcpToolName,
  isFlatNamespaceTool,
  splitNamespacedToolName,
} from "../tool-namespacer.js";

describe("splitNamespacedToolName", () => {
  it("returns null for a flat/built-in tool name", () => {
    expect(splitNamespacedToolName("metro/reload")).toBeNull();
    expect(splitNamespacedToolName("modules/list")).toBeNull();
    expect(splitNamespacedToolName("rn-dev/start-session")).toBeNull();
  });

  it("extracts moduleId + tool suffix for a double-underscore tool name", () => {
    expect(splitNamespacedToolName("device-control__screenshot")).toEqual({
      moduleId: "device-control",
      tool: "screenshot",
    });
  });

  it("handles tool names that themselves contain double underscores after the prefix", () => {
    expect(
      splitNamespacedToolName("device-control__record__stop"),
    ).toEqual({
      moduleId: "device-control",
      tool: "record__stop",
    });
  });

  it("returns null when the separator is present but prefix is empty", () => {
    expect(splitNamespacedToolName("__broken")).toBeNull();
  });
});

describe("isFlatNamespaceTool", () => {
  it("flags built-in flat names as such", () => {
    expect(isFlatNamespaceTool("metro/reload")).toBe(true);
    expect(isFlatNamespaceTool("modules/list")).toBe(true);
    expect(isFlatNamespaceTool("rn-dev/start-session")).toBe(true);
  });

  it("rejects 3p-style double-underscore names", () => {
    expect(isFlatNamespaceTool("device-control__screenshot")).toBe(false);
  });
});

describe("assertMcpToolName (3p check matches Phase-1 SDK policy)", () => {
  it("accepts a correctly-prefixed 3p tool", () => {
    expect(() =>
      assertMcpToolName({
        moduleId: "echo",
        name: "echo__ping",
        isBuiltIn: false,
      }),
    ).not.toThrow();
  });

  it("rejects 3p tool without prefix", () => {
    expect(() =>
      assertMcpToolName({
        moduleId: "echo",
        name: "ping",
        isBuiltIn: false,
      }),
    ).toThrow(/echo__/);
  });

  it("accepts built-in with flat-namespace name", () => {
    expect(() =>
      assertMcpToolName({
        moduleId: "metro",
        name: "metro/reload",
        isBuiltIn: true,
      }),
    ).not.toThrow();
  });

  it("rejects built-in that accidentally uses 3p form (design smell)", () => {
    expect(() =>
      assertMcpToolName({
        moduleId: "metro",
        name: "metro__reload",
        isBuiltIn: true,
      }),
    ).toThrow(/flat/i);
  });
});
