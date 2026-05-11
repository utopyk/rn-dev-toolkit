import { describe, it, expect } from "vitest";
import { parseHookRecord } from "../runner-subprocess.js";

describe("parseHookRecord — happy paths", () => {
  it("parses an ack record", () => {
    expect(parseHookRecord('{"kind":"ack","replaced":true}')).toEqual({
      kind: "ack",
      replaced: true,
    });
  });

  it("parses a log record at every level", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(
        parseHookRecord(`{"kind":"log","level":"${level}","text":"hi"}`),
      ).toEqual({ kind: "log", level, text: "hi" });
    }
  });

  it("parses a progress record with optional text", () => {
    expect(parseHookRecord('{"kind":"progress","percent":42,"text":"halfway"}')).toEqual({
      kind: "progress",
      percent: 42,
      text: "halfway",
    });
    expect(parseHookRecord('{"kind":"progress","percent":42}')).toEqual({
      kind: "progress",
      percent: 42,
      text: undefined,
    });
  });

  it("parses a result record with arbitrary data", () => {
    expect(parseHookRecord('{"kind":"result","data":{"ok":true}}')).toEqual({
      kind: "result",
      data: { ok: true },
    });
  });
});

describe("parseHookRecord — security", () => {
  it("strips __proto__ pollution", () => {
    const polluted =
      '{"kind":"result","data":{"__proto__":{"polluted":true},"safe":1}}';
    const parsed = parseHookRecord(polluted);
    expect(parsed).toBeTruthy();
    if (parsed && parsed.kind === "result" && parsed.data) {
      const data = parsed.data as Record<string, unknown>;
      expect(data.safe).toBe(1);
      expect(data.polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("strips constructor and prototype keys", () => {
    const polluted =
      '{"kind":"result","data":{"constructor":{"a":1},"prototype":{"b":2},"ok":true}}';
    const parsed = parseHookRecord(polluted);
    expect(parsed).toBeTruthy();
    if (parsed && parsed.kind === "result" && parsed.data) {
      const data = parsed.data as Record<string, unknown>;
      // Reviver dropped both keys — the parsed object's own keys do not
      // include them. (Accessing `data.constructor` falls through to
      // Object.prototype.constructor; we check `Object.keys` to verify
      // the parser did its job rather than the prototype chain.)
      expect(Object.prototype.hasOwnProperty.call(data, "constructor")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(data, "prototype")).toBe(false);
      expect(data.ok).toBe(true);
    }
  });
});

describe("parseHookRecord — rejections", () => {
  it("returns undefined on empty input", () => {
    expect(parseHookRecord("")).toBeUndefined();
    expect(parseHookRecord("   ")).toBeUndefined();
  });

  it("returns undefined on invalid JSON", () => {
    expect(parseHookRecord("{not json}")).toBeUndefined();
    expect(parseHookRecord("[1,2,")).toBeUndefined();
  });

  it("returns null on non-object JSON values", () => {
    expect(parseHookRecord("42")).toBeNull();
    expect(parseHookRecord('"plain string"')).toBeNull();
    expect(parseHookRecord("null")).toBeNull();
  });

  it("returns undefined on objects with unknown kinds", () => {
    expect(parseHookRecord('{"kind":"unknown","x":1}')).toBeUndefined();
  });

  it("returns undefined on ack with non-boolean replaced", () => {
    expect(parseHookRecord('{"kind":"ack","replaced":"yes"}')).toBeUndefined();
  });

  it("returns undefined on log with bad level", () => {
    expect(
      parseHookRecord('{"kind":"log","level":"chatty","text":"hi"}'),
    ).toBeUndefined();
  });

  it("returns undefined on progress without numeric percent", () => {
    expect(parseHookRecord('{"kind":"progress","percent":"50%"}')).toBeUndefined();
  });
});
