// Phase H2e — build module manifest + createBuildHostCapability factory
// shape. Drives the factory against a fake HookManager so we pin both
// the slot-prefix binding (`pre` → `build/pre`) and the SDK outcome
// mapping (core FireOutcome → SDK HookFireOutcome).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { HookError, HookErrorCode } from "@rn-dev/module-sdk";
import {
  BUILD_HOOKS_CAPABILITY_ID,
  BUILD_HOOKS_CAPABILITY_PERMISSION,
  createBuildHostCapability,
} from "../build-host-capability.js";
import { buildManifest } from "../manifests.js";
import type { HookManager } from "../../../core/hooks/manager.js";
import type { ValidatedProfile } from "../../../daemon/profile-guard.js";
import type { FireOutcome } from "../../../core/hooks/dispatcher.js";

const STUB_PROFILE = { name: "stub" } as unknown as ValidatedProfile;

function fakeHookManager(
  outcome: FireOutcome,
): { fire: ReturnType<typeof vi.fn>; mgr: HookManager } {
  const fire = vi.fn(async () => outcome);
  const mgr = { fire } as unknown as HookManager;
  return { fire, mgr };
}

const okOutcome: FireOutcome = { ok: true, fired: 1, skipped: 0, failures: [] };

describe("buildManifest (H2e)", () => {
  it("declares id 'build' with the three hook names: pre, post, custom", () => {
    expect(buildManifest.id).toBe("build");
    expect(buildManifest.scope).toBe("global");
    expect(buildManifest.provides?.hooks).toEqual(["pre", "post", "custom"]);
  });

  it("uses the H1 hostRange convention (no contributions to TUI/MCP)", () => {
    expect(buildManifest.hostRange).toBe(">=0.1.0");
    expect(buildManifest.contributes).toBeUndefined();
  });
});

describe("createBuildHostCapability (H2e)", () => {
  let resolveProfile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resolveProfile = vi.fn(() => STUB_PROFILE);
  });

  it("exposes the canonical capability id + permission constants", () => {
    expect(BUILD_HOOKS_CAPABILITY_ID).toBe("build:hooks");
    expect(BUILD_HOOKS_CAPABILITY_PERMISSION).toBe("host:hooks:dispatch");
  });

  it("fire('pre', payload) dispatches build/pre with the resolved profile", async () => {
    const { fire, mgr } = fakeHookManager(okOutcome);
    const cap = createBuildHostCapability({ hookManager: mgr, resolveProfile });
    const result = await cap.fire("pre", { ts: 123 });

    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith("build/pre", { ts: 123 }, STUB_PROFILE);
    expect(result).toEqual({ ok: true, fired: 1, skipped: 0, failures: [] });
  });

  it("fire('post') dispatches build/post", async () => {
    const { fire, mgr } = fakeHookManager(okOutcome);
    const cap = createBuildHostCapability({ hookManager: mgr, resolveProfile });
    await cap.fire("post", null);
    expect(fire).toHaveBeenCalledWith("build/post", null, STUB_PROFILE);
  });

  it("fire('custom') dispatches build/custom (registration-time gate is loadProjectHooks's job)", async () => {
    const { fire, mgr } = fakeHookManager(okOutcome);
    const cap = createBuildHostCapability({ hookManager: mgr, resolveProfile });
    await cap.fire("custom", null);
    expect(fire).toHaveBeenCalledWith("build/custom", null, STUB_PROFILE);
  });

  it("rejects unknown hook names with a programmer-error message", async () => {
    const { mgr } = fakeHookManager(okOutcome);
    const cap = createBuildHostCapability({ hookManager: mgr, resolveProfile });
    await expect(cap.fire("nope", null)).rejects.toThrow(
      /unknown hook\. Legal names: pre, post, custom/,
    );
  });

  it("re-resolves the profile on every fire (reflects session/profile-update mid-session)", async () => {
    const { mgr } = fakeHookManager(okOutcome);
    const cap = createBuildHostCapability({ hookManager: mgr, resolveProfile });
    await cap.fire("pre", null);
    await cap.fire("post", null);
    expect(resolveProfile).toHaveBeenCalledTimes(2);
  });

  it("maps a failed FireOutcome to the SDK's HookFireOutcome shape", async () => {
    const failedOutcome: FireOutcome = {
      ok: false,
      fired: 0,
      skipped: 0,
      failures: [
        {
          registration: {
            target: "build/pre",
            source: { kind: "project", configPath: "/x" },
            resolved: {
              kind: "script",
              script: {
                declaredPath: "/x/y.sh",
                absolutePath: "/x/y.sh",
                fingerprint: { realPath: "/x/y.sh", dev: 1, ino: 1 },
              },
            },
            priority: 0,
            registrationOrder: 0,
            onFail: "warn",
            isOverride: false,
            orphaned: false,
          },
          reason: "subprocess",
          error: new HookError("test failure", {
            code: HookErrorCode.E_HOOK_FAILED,
            // The H1 papercut documented in 2026-05-04-next-session-prompt-h1-pr-open.md
            // maps exit-nonzero → outcome:"timeout" until H4 formalizes
            // the wider HookSubprocessOutcome → HookFailedOutcome map.
            // Using a value that's actually in the HookFailedOutcome union
            // keeps the test honest about what the SDK exposes today.
            outcome: "timeout",
            phase: "build/pre",
            moduleId: "build",
            hookName: "pre",
            exitCode: 7,
          }),
        },
      ],
    };
    const { mgr } = fakeHookManager(failedOutcome);
    const cap = createBuildHostCapability({ hookManager: mgr, resolveProfile });

    const result = await cap.fire("pre", null);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({
      registration: { target: "build/pre", sourceKind: "project" },
      reason: "subprocess",
      outcome: "timeout",
    });
  });
});
