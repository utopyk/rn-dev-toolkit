import { describe, expect, it } from "vitest";
import {
  num,
  requireNum,
  requireStr,
  ringCursor,
  str,
  strArr,
  type Args,
} from "../index.js";

describe("str", () => {
  it("returns the value when it is a non-empty string", () => {
    expect(str({ name: "metro" }, "name")).toBe("metro");
  });

  it("returns undefined for an empty string", () => {
    expect(str({ name: "" }, "name")).toBeUndefined();
  });

  it("returns undefined when the key is missing", () => {
    expect(str({}, "name")).toBeUndefined();
  });

  it("returns undefined when the value is not a string", () => {
    expect(str({ name: 7 }, "name")).toBeUndefined();
    expect(str({ name: null }, "name")).toBeUndefined();
    expect(str({ name: undefined }, "name")).toBeUndefined();
    expect(str({ name: {} }, "name")).toBeUndefined();
  });
});

describe("num", () => {
  it("returns the value when it is a finite number", () => {
    expect(num({ x: 42 }, "x")).toBe(42);
    expect(num({ x: 0 }, "x")).toBe(0);
    expect(num({ x: -1.5 }, "x")).toBe(-1.5);
  });

  it("returns undefined for non-finite numbers", () => {
    expect(num({ x: Number.POSITIVE_INFINITY }, "x")).toBeUndefined();
    expect(num({ x: Number.NEGATIVE_INFINITY }, "x")).toBeUndefined();
    expect(num({ x: Number.NaN }, "x")).toBeUndefined();
  });

  it("returns undefined when the key is missing or the value is not a number", () => {
    expect(num({}, "x")).toBeUndefined();
    expect(num({ x: "42" }, "x")).toBeUndefined();
    expect(num({ x: null }, "x")).toBeUndefined();
  });
});

describe("strArr", () => {
  it("returns the array when every entry is a non-empty string", () => {
    expect(strArr({ m: ["GET", "POST"] }, "m")).toEqual(["GET", "POST"]);
  });

  it("filters out non-string / empty entries", () => {
    expect(strArr({ m: ["GET", "", 7, null, "POST"] }, "m")).toEqual([
      "GET",
      "POST",
    ]);
  });

  it("returns undefined when the filter leaves the array empty", () => {
    expect(strArr({ m: ["", 7, null] }, "m")).toBeUndefined();
  });

  it("returns undefined when the value is not an array", () => {
    expect(strArr({ m: "GET" }, "m")).toBeUndefined();
    expect(strArr({}, "m")).toBeUndefined();
  });
});

describe("requireStr", () => {
  it("returns the string when present", () => {
    expect(requireStr({ name: "metro" }, "name", "metro__tool")).toBe("metro");
  });

  it("throws with a descriptive message when missing", () => {
    expect(() => requireStr({}, "name", "metro__tool")).toThrow(
      "metro__tool: name is required",
    );
  });

  it("throws when the value is the wrong type", () => {
    expect(() => requireStr({ name: 7 }, "name", "metro__tool")).toThrow(
      "metro__tool: name is required",
    );
  });
});

describe("requireNum", () => {
  it("returns the number when present", () => {
    expect(requireNum({ x: 42 }, "x", "tap")).toBe(42);
  });

  it("throws when missing", () => {
    expect(() => requireNum({}, "x", "tap")).toThrow("tap: x is required");
  });

  it("throws when non-finite", () => {
    expect(() =>
      requireNum({ x: Number.NaN }, "x", "tap"),
    ).toThrow("tap: x is required");
  });
});

describe("ringCursor", () => {
  it("returns the cursor when both fields are finite numbers", () => {
    const args: Args = { since: { bufferEpoch: 1, sequence: 42 } };
    expect(ringCursor(args)).toEqual({ bufferEpoch: 1, sequence: 42 });
  });

  it("returns undefined when the value is missing", () => {
    expect(ringCursor({})).toBeUndefined();
  });

  it("returns undefined when the value is not an object", () => {
    expect(ringCursor({ since: "cursor" })).toBeUndefined();
    expect(ringCursor({ since: 7 })).toBeUndefined();
    expect(ringCursor({ since: null })).toBeUndefined();
  });

  it("returns undefined when fields are the wrong type", () => {
    expect(ringCursor({ since: { bufferEpoch: "1", sequence: 2 } })).toBeUndefined();
    expect(ringCursor({ since: { bufferEpoch: 1, sequence: "2" } })).toBeUndefined();
    expect(ringCursor({ since: { bufferEpoch: 1 } })).toBeUndefined();
    expect(ringCursor({ since: {} })).toBeUndefined();
  });

  it("returns undefined when fields are non-finite", () => {
    expect(
      ringCursor({ since: { bufferEpoch: Number.NaN, sequence: 2 } }),
    ).toBeUndefined();
    expect(
      ringCursor({ since: { bufferEpoch: 1, sequence: Number.POSITIVE_INFINITY } }),
    ).toBeUndefined();
  });

  it("honours a custom key", () => {
    expect(
      ringCursor({ cursor: { bufferEpoch: 3, sequence: 4 } }, "cursor"),
    ).toEqual({ bufferEpoch: 3, sequence: 4 });
    expect(
      ringCursor({ cursor: { bufferEpoch: 3, sequence: 4 } }, "since"),
    ).toBeUndefined();
  });

  it("drops extra fields on the cursor — returns only the known shape", () => {
    const result = ringCursor({
      since: { bufferEpoch: 1, sequence: 2, extra: "ignored" },
    });
    expect(result).toEqual({ bufferEpoch: 1, sequence: 2 });
    expect(result).not.toHaveProperty("extra");
  });
});
