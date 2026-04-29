import { describe, expect, it } from "vitest";
import { validateProfile } from "../profile-guard.js";
import type { Profile } from "../../core/types.js";

// Phase 13.6 follow-up — `Profile.devices` is typed `{ ios?: string |
// null; android?: string | null }` ([src/core/types.ts:23-26]) so an
// unconfigured device slot serializes to `null` (the wizard does this
// explicitly when only one platform is selected). The guard previously
// rejected null with `E_PROFILE_DEVICE_ID`, so opening Electron and
// picking any single-platform profile errored on `events/subscribe`
// (Bug from 2026-04-25 follow-up to PR-C).
//
// These tests pin both ends of the contract so a future tightening
// can't drift back.

const baseProfile: Profile = {
  name: "test",
  isDefault: false,
  worktree: null,
  branch: "main",
  platform: "ios",
  mode: "quick",
  metroPort: 8081,
  devices: {},
  buildVariant: "debug",
  preflight: { checks: [], frequency: "once" },
  onSave: [],
  env: {},
  projectRoot: "/tmp/test-project",
};

describe("validateProfile — devices", () => {
  it("accepts a profile where unset device slots serialize to null", () => {
    // Real-world shape from a movie-nights-club profile: iOS device
    // configured, Android slot left explicitly null. The wizard writes
    // exactly this shape on every save.
    const result = validateProfile({
      ...baseProfile,
      devices: { ios: "00008130-001A653A3E11001C", android: null },
    });
    expect(result.ok, `validation should accept null device slot: ${JSON.stringify(result)}`).toBe(true);
  });

  it("accepts a profile where both device slots are null", () => {
    const result = validateProfile({
      ...baseProfile,
      devices: { ios: null, android: null },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a profile with omitted device slots", () => {
    const result = validateProfile({ ...baseProfile, devices: {} });
    expect(result.ok).toBe(true);
  });

  it("rejects a profile where a device slot is a non-string non-null value", () => {
    const result = validateProfile({
      ...baseProfile,
      devices: { ios: 42, android: null },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_PROFILE_DEVICE_ID");
    }
  });
});
