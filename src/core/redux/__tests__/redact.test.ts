import { describe, it, expect } from "vitest";
import {
  DEFAULT_BLACKLIST,
  REDACTED,
  isWhitelisted,
  makeBlacklistMatcher,
  redactValue,
  MAX_DEPTH,
} from "../redact.js";
import type { RedactionConfig } from "../types.js";

function cfg(over: Partial<RedactionConfig> = {}): RedactionConfig {
  return { whitelist: [], blacklist: [], mode: "mcp-redacted", ...over };
}

describe("makeBlacklistMatcher", () => {
  it("matches case-insensitively with glob stars", () => {
    const m = makeBlacklistMatcher(["*token*", "email"]);
    expect(m("authToken")).toBe(true);
    expect(m("ACCESS_TOKEN")).toBe(true);
    expect(m("email")).toBe(true);
    expect(m("Email")).toBe(true);
    expect(m("username")).toBe(false);
  });
  it("bare word is whole-key anchored (no accidental substring match)", () => {
    const m = makeBlacklistMatcher(["email"]);
    expect(m("email")).toBe(true);
    expect(m("emailVerified")).toBe(false); // use *email* to catch this
  });
});

describe("isWhitelisted", () => {
  it("segment-aware prefix match", () => {
    expect(isWhitelisted("ui", ["ui"])).toBe(true);
    expect(isWhitelisted("ui.theme", ["ui"])).toBe(true);
    expect(isWhitelisted("uiSettings", ["ui"])).toBe(false); // not a segment boundary
    expect(isWhitelisted("", ["ui"])).toBe(false);
  });
});

describe("redactValue — mcp-redacted (agent default)", () => {
  it("structure-only by default: keys + types kept, values hidden", () => {
    const { value } = redactValue({ a: 1, b: "hi", c: { d: true } }, cfg());
    expect(value).toEqual({ a: "<number>", b: "<string>", c: { d: "<boolean>" } });
  });

  it("whitelisted slice is revealed in full", () => {
    const { value } = redactValue(
      { ui: { theme: "dark", scale: 2 }, auth: { userId: "u1" } },
      cfg({ whitelist: ["ui"] }),
    );
    expect(value).toEqual({ ui: { theme: "dark", scale: 2 }, auth: { userId: "<string>" } });
  });

  it("blacklist force-redacts even INSIDE a whitelisted slice", () => {
    const { value } = redactValue(
      { ui: { theme: "dark", authToken: "abc123" } },
      cfg({ whitelist: ["ui"], blacklist: ["*token*"] }),
    );
    expect(value).toEqual({ ui: { theme: "dark", authToken: REDACTED } });
  });

  it("counts redactions", () => {
    const { redactedCount } = redactValue({ a: 1, b: 2 }, cfg());
    expect(redactedCount).toBe(2);
  });

  it("preserves array shape, hides leaf values", () => {
    const { value } = redactValue({ xs: [1, 2, 3] }, cfg());
    expect(value).toEqual({ xs: ["<number>", "<number>", "<number>"] });
  });
});

describe("redactValue — full (human panel) still honors blacklist", () => {
  it("reveals everything except blacklisted keys", () => {
    const { value } = redactValue(
      { user: { name: "Ada", email: "a@b.co", password: "x" } },
      cfg({ mode: "full", blacklist: ["email", "*password*"] }),
    );
    expect(value).toEqual({ user: { name: "Ada", email: REDACTED, password: REDACTED } });
  });
});

describe("redactValue — bounds", () => {
  it("collapses beyond MAX_DEPTH and flags truncated", () => {
    // Build a tree deeper than the cap.
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < MAX_DEPTH + 3; i++) deep = { nest: deep };
    const { truncated } = redactValue(deep, cfg({ mode: "full" }));
    expect(truncated).toBe(true);
  });
});

describe("DEFAULT_BLACKLIST", () => {
  it("catches the payment/auth/PII fields it's meant to", () => {
    const m = makeBlacklistMatcher(DEFAULT_BLACKLIST);
    for (const k of ["accessToken", "password", "cardNumber", "cvv", "apiKey", "email", "phoneNumber", "authorization"]) {
      expect(m(k), `expected ${k} blacklisted`).toBe(true);
    }
    expect(m("conversationId")).toBe(false);
  });
});
