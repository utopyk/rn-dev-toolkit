import { describe, it, expect } from "vitest";
import { computeShallowDiff, parseIngestUrl } from "../../enhancer.js";

describe("computeShallowDiff", () => {
  it("detects replaced top-level slices by reference", () => {
    const auth1 = { id: "u1" };
    const auth2 = { id: "u2" };
    const ui = { theme: "dark" };
    const diff = computeShallowDiff({ auth: auth1, ui }, { auth: auth2, ui });
    // ui unchanged (same ref) → not in diff; auth replaced.
    expect(diff).toEqual([{ path: "auth", op: "replace", before: auth1, after: auth2 }]);
  });

  it("detects added + removed slices", () => {
    const diff = computeShallowDiff({ a: 1 }, { b: 2 });
    expect(diff).toContainEqual({ path: "a", op: "remove", before: 1 });
    expect(diff).toContainEqual({ path: "b", op: "add", after: 2 });
  });

  it("non-object roots compare by value", () => {
    expect(computeShallowDiff(1, 2)).toEqual([{ path: "", op: "replace", before: 1, after: 2 }]);
    expect(computeShallowDiff(5, 5)).toEqual([]);
  });
});

describe("parseIngestUrl", () => {
  it("derives ws://host:(port+offset) from a Metro scriptURL", () => {
    expect(parseIngestUrl("http://10.0.2.2:8081/index.bundle?platform=android&dev=true")).toBe(
      "ws://10.0.2.2:12081",
    );
    expect(parseIngestUrl("http://localhost:8090/index.bundle")).toBe("ws://localhost:12090");
  });

  it("honors a custom offset", () => {
    expect(parseIngestUrl("http://localhost:8081/x", 100)).toBe("ws://localhost:8181");
  });

  it("returns null for an unparseable URL", () => {
    expect(parseIngestUrl("not a url")).toBeNull();
  });
});
