import { describe, it, expect } from "vitest";
import { SubscribeRegistry } from "../subscribe-registry.js";
import { matchesKindFilter, parseKinds } from "../subscribe-registry.js";

describe("SubscribeRegistry", () => {
  it("records a bidirectional subscriber and reports it", () => {
    const reg = new SubscribeRegistry();
    // P0-4: kindFilter is no longer stored in SubscribeEntry — it is captured
    // as a closure variable in handleEventsSubscribe and not readable from the
    // registry. Register only the fields the entry actually carries.
    reg.register("c1", { bidirectional: true });
    expect(reg.isBidirectional("c1")).toBe(true);
    expect(reg.has("c1")).toBe(true);
  });
});

describe("matchesKindFilter", () => {
  it("null filter matches every event", () => {
    expect(matchesKindFilter(null, "metro/log")).toBe(true);
    expect(matchesKindFilter(null, "modules/state-changed")).toBe(true);
  });

  it("empty array filter matches no event", () => {
    expect(matchesKindFilter([], "metro/log")).toBe(false);
  });

  it("exact match", () => {
    expect(matchesKindFilter(["metro/log"], "metro/log")).toBe(true);
    expect(matchesKindFilter(["metro/log"], "metro/status")).toBe(false);
  });

  it("prefix glob with /*", () => {
    expect(matchesKindFilter(["modules/*"], "modules/state-changed")).toBe(true);
    expect(matchesKindFilter(["modules/*"], "modules/crashed")).toBe(true);
    expect(matchesKindFilter(["modules/*"], "metro/log")).toBe(false);
  });

  it("multiple entries union", () => {
    expect(matchesKindFilter(["modules/*", "session/status"], "modules/x")).toBe(true);
    expect(matchesKindFilter(["modules/*", "session/status"], "session/status")).toBe(true);
    expect(matchesKindFilter(["modules/*", "session/status"], "metro/log")).toBe(false);
  });
});

describe("parseKinds", () => {
  it("undefined → null (back-compat: all events)", () => {
    expect(parseKinds(undefined)).toEqual({ ok: true, kinds: null });
  });

  it("empty array → empty array (no events)", () => {
    expect(parseKinds([])).toEqual({ ok: true, kinds: [] });
  });

  it("valid exact and prefix entries", () => {
    const r = parseKinds(["modules/*", "session/status"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kinds).toEqual(["modules/*", "session/status"]);
  });

  it("rejects non-array", () => {
    expect(parseKinds("modules/*").ok).toBe(false);
    expect(parseKinds({}).ok).toBe(false);
  });

  it("rejects non-string entries", () => {
    expect(parseKinds([1, 2]).ok).toBe(false);
  });

  it("rejects empty-string entries", () => {
    expect(parseKinds([""]).ok).toBe(false);
  });

  it("rejects mid-string globs (only trailing /* allowed)", () => {
    expect(parseKinds(["foo/*/bar"]).ok).toBe(false);
    expect(parseKinds(["*"]).ok).toBe(false);
  });

  // P1-4: size + length bounds
  it("rejects arrays exceeding 256 entries", () => {
    const oversized = Array.from({ length: 257 }, (_, i) => `metro/log-${i}`);
    const r = parseKinds(oversized);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("E_SUBSCRIBE_INVALID_KINDS");
  });

  it("rejects entries longer than 128 chars", () => {
    const longEntry = "a/".padEnd(130, "b");
    const r = parseKinds([longEntry]);
    expect(r.ok).toBe(false);
  });

  // P1-2: result is a defensive copy — mutating input does not affect kinds
  it("returns a defensive copy (P1-2: no post-parse mutation poisoning)", () => {
    const input = ["metro/log", "modules/*"];
    const r = parseKinds(input);
    expect(r.ok).toBe(true);
    if (r.ok && r.kinds) {
      input.push("injected/evil");
      // The returned array must be a copy — pushed entry must NOT appear
      expect(r.kinds).not.toContain("injected/evil");
    }
  });
});
