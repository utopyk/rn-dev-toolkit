import { describe, it, expect, expectTypeOf } from "vitest";
import { validateProfile, type ValidatedProfile } from "../profile-guard.js";
import type { Profile } from "../../core/types.js";

const baseProfile: Profile = {
  name: "test",
  isDefault: false,
  worktree: null,
  branch: "main",
  platform: "ios",
  mode: "clean",
  metroPort: 8081,
  devices: { ios: null, android: null },
  buildVariant: "Debug",
  preflight: { checks: [], frequency: "once" },
  onSave: [],
  env: {},
  projectRoot: "/abs/project",
};

describe("ValidatedProfile branded type", () => {
  it("is assignable from validateProfile success result", () => {
    const result = validateProfile(baseProfile);
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    // Type-level assertion: result.profile is ValidatedProfile, not just Profile.
    expectTypeOf(result.profile).toEqualTypeOf<ValidatedProfile>();
  });

  it("rejects a raw Profile assignment without re-validation (type-level)", () => {
    // The runtime test is just that this code path compiles; the brand
    // is a phantom and doesn't change runtime shape.
    function acceptsValidated(_p: ValidatedProfile): void {
      /* noop */
    }
    // @ts-expect-error — raw Profile is missing the brand and must not flow in.
    acceptsValidated(baseProfile);
    // The validated form does flow in.
    const r = validateProfile(baseProfile);
    if (r.ok) acceptsValidated(r.profile);
  });

  it("preserves Profile shape at runtime (brand is phantom)", () => {
    const r = validateProfile(baseProfile);
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
    expect(r.profile.name).toBe("test");
    expect(r.profile.metroPort).toBe(8081);
    expect(r.profile.platform).toBe("ios");
    // No own enumerable brand key — brand is type-only.
    expect(Object.keys(r.profile)).not.toContain("ValidatedProfileBrand");
  });
});
