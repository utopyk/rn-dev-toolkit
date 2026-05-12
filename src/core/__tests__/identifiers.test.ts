import { describe, it, expect, expectTypeOf } from "vitest";
import {
  generateSessionId,
  asSessionId,
  asWorktreeKey,
  type SessionId,
  type WorktreeKey,
} from "../identifiers.js";

describe("SessionId branded type", () => {
  it("generateSessionId returns a UUID-shaped string", () => {
    const sid = generateSessionId();
    expect(typeof sid).toBe("string");
    // Standard UUID v4 shape: 8-4-4-4-12 hex.
    expect(sid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates collision-resistant ids across many calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generateSessionId());
    expect(ids.size).toBe(1000);
  });

  it("returns the branded SessionId type at compile time", () => {
    const sid = generateSessionId();
    expectTypeOf(sid).toEqualTypeOf<SessionId>();
  });

  it("asSessionId mints from a non-empty string", () => {
    const sid = asSessionId("hand-minted");
    expectTypeOf(sid).toEqualTypeOf<SessionId>();
    expect(sid).toBe("hand-minted");
  });

  it("asSessionId rejects empty input", () => {
    expect(() => asSessionId("")).toThrow(/empty string/);
  });

  it("refuses bare string assignment without minting (type-level)", () => {
    function takesSessionId(_s: SessionId): void {
      /* noop */
    }
    // @ts-expect-error — raw string can't flow into a SessionId slot.
    takesSessionId("not-branded");
    // Minted form flows in.
    takesSessionId(generateSessionId());
    takesSessionId(asSessionId("hand-minted"));
  });
});

describe("WorktreeKey branded type", () => {
  it("asWorktreeKey mints from a non-empty colon-free string", () => {
    const wk = asWorktreeKey("abc123def456");
    expectTypeOf(wk).toEqualTypeOf<WorktreeKey>();
    expect(wk).toBe("abc123def456");
  });

  it("rejects empty input", () => {
    expect(() => asWorktreeKey("")).toThrow(/empty string/);
  });

  it("rejects strings containing colon (composite-key delimiter)", () => {
    // See plan § A2: ModuleHostManager.keyFor uses single-colon
    // separator for `${moduleId}:${scopeUnit}`. A colon in a WorktreeKey
    // would round-trip ambiguously.
    expect(() => asWorktreeKey("has:colon")).toThrow(/colon/);
  });

  it("refuses bare string assignment without minting (type-level)", () => {
    function takesWorktreeKey(_k: WorktreeKey): void {
      /* noop */
    }
    // @ts-expect-error — raw string can't flow into a WorktreeKey slot.
    takesWorktreeKey("not-branded");
    takesWorktreeKey(asWorktreeKey("abc123"));
  });

  it("does not assign SessionId to WorktreeKey or vice versa (type-level)", () => {
    const sid: SessionId = generateSessionId();
    const wk: WorktreeKey = asWorktreeKey("abc123");
    function takesSessionId(_s: SessionId): void { /* noop */ }
    function takesWorktreeKey(_k: WorktreeKey): void { /* noop */ }
    // @ts-expect-error — WorktreeKey is not assignable to SessionId.
    takesSessionId(wk);
    // @ts-expect-error — SessionId is not assignable to WorktreeKey.
    takesWorktreeKey(sid);
    // Round-trip the variables so the linter doesn't flag them unused.
    expect(sid.length).toBeGreaterThan(0);
    expect(wk.length).toBeGreaterThan(0);
  });
});
