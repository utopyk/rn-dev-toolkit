import { describe, expect, it } from "vitest";
import { shouldResetMetroCache } from "../metro-cache-policy.js";
import type { RunMode } from "../../types.js";

// 2026-09-14 — a production build served a staging JS bundle. The chain:
// `enumerateEnvs` writes the wizard's pick to `profile.env.APP_ENV`, the
// project's `build/pre` hook rewrites `.env` from it, react-native-dotenv
// inlines `.env` values at babel transform time, and `.env` is not part of
// Metro's transform cache key. A warm Metro therefore kept serving the
// previous env's inlined values with no error anywhere. The prod profiles
// were `mode: "quick"`, which is exactly where the old rule suppressed
// `--reset-cache`.
//
// These pin the rule that closed it: an env-carrying profile is cold,
// full stop, and mode can only ever ADD a reset, never remove one.

describe("shouldResetMetroCache", () => {
  const MODES: RunMode[] = ["quick", "dirty", "clean", "ultra-clean"];

  it("forces a reset for every mode once APP_ENV is set", () => {
    for (const mode of MODES) {
      expect(
        shouldResetMetroCache({ mode, env: { APP_ENV: "PRODUCTION" } }),
        `mode=${mode} with APP_ENV must reset`,
      ).toBe(true);
    }
  });

  it("keeps the warm-start fast path for quick/dirty with no APP_ENV", () => {
    expect(shouldResetMetroCache({ mode: "quick", env: {} })).toBe(false);
    expect(shouldResetMetroCache({ mode: "dirty", env: {} })).toBe(false);
  });

  it("still resets for clean/ultra-clean with no APP_ENV", () => {
    expect(shouldResetMetroCache({ mode: "clean", env: {} })).toBe(true);
    expect(shouldResetMetroCache({ mode: "ultra-clean", env: {} })).toBe(true);
  });

  it("treats an empty-string APP_ENV as absent", () => {
    // The wizard blocks Next until a pick is made, but a hand-edited
    // profile can carry `APP_ENV: ""`. An empty value switches nothing,
    // so it must not cost every quick-mode boot a cold start.
    expect(shouldResetMetroCache({ mode: "quick", env: { APP_ENV: "" } })).toBe(
      false,
    );
  });

  it("ignores unrelated env keys", () => {
    expect(
      shouldResetMetroCache({ mode: "quick", env: { NODE_ENV: "production" } }),
    ).toBe(false);
  });
});
