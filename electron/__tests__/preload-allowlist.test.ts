// F5 — verify the host-renderer preload allowlist accepts every channel the
// renderer actually uses and rejects anything else. The preload.js file
// self-guards its `require('electron')` call so vitest can require it
// directly without a module mock.

import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const allowlist = require("../preload.cjs") as {
  INVOKE_EXACT: readonly string[];
  INVOKE_PREFIX: readonly string[];
  ON_EXACT: readonly string[];
  isAllowedInvoke: (channel: unknown) => boolean;
  isAllowedOn: (channel: unknown) => boolean;
};

describe("preload allowlist — isAllowedInvoke", () => {
  it("accepts every channel in INVOKE_EXACT", () => {
    for (const ch of allowlist.INVOKE_EXACT) {
      expect(allowlist.isAllowedInvoke(ch)).toBe(true);
    }
  });

  it("accepts channels that match INVOKE_PREFIX with a non-empty suffix", () => {
    // prompt:respond:<promptId> is the dynamic channel created in
    // electron/ipc/services.ts — the suffix is legitimately user-generated.
    expect(allowlist.isAllowedInvoke("prompt:respond:pm-main-8081-1234")).toBe(
      true,
    );
  });

  it("rejects the prefix itself without a suffix", () => {
    expect(allowlist.isAllowedInvoke("prompt:respond:")).toBe(false);
  });

  it("rejects channels outside the allowlist", () => {
    expect(allowlist.isAllowedInvoke("fs:read")).toBe(false);
    expect(allowlist.isAllowedInvoke("metro:__proto__")).toBe(false);
    expect(allowlist.isAllowedInvoke("")).toBe(false);
  });

  it("rejects non-string channels", () => {
    expect(allowlist.isAllowedInvoke(undefined)).toBe(false);
    expect(allowlist.isAllowedInvoke(null)).toBe(false);
    expect(allowlist.isAllowedInvoke(42)).toBe(false);
    expect(allowlist.isAllowedInvoke({ toString: () => "profiles:list" })).toBe(
      false,
    );
  });
});

describe("preload allowlist — isAllowedOn", () => {
  it("accepts every channel in ON_EXACT", () => {
    for (const ch of allowlist.ON_EXACT) {
      expect(allowlist.isAllowedOn(ch)).toBe(true);
    }
  });

  it("rejects channels outside the allowlist (no prefix fallback for on/off)", () => {
    expect(allowlist.isAllowedOn("prompt:respond:anything")).toBe(false);
    expect(allowlist.isAllowedOn("modules:config-set")).toBe(false);
    expect(allowlist.isAllowedOn("")).toBe(false);
  });

  it("rejects non-string channels", () => {
    expect(allowlist.isAllowedOn(undefined)).toBe(false);
    expect(allowlist.isAllowedOn(null)).toBe(false);
  });
});

describe("preload allowlist — lists are frozen", () => {
  it("INVOKE_EXACT cannot be mutated at runtime", () => {
    expect(() => {
      (allowlist.INVOKE_EXACT as string[]).push("fs:write");
    }).toThrow();
  });

  it("ON_EXACT cannot be mutated at runtime", () => {
    expect(() => {
      (allowlist.ON_EXACT as string[]).push("fs:changed");
    }).toThrow();
  });
});
