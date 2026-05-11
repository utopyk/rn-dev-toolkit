// Phase H2e — concrete `HookHostCapability` factory bound to the
// `build/` slot prefix. The first H2 consumer is internal host code
// (the `client-rpcs.ts builder/build` handler in H2g fires `build/pre`
// + `build/post` directly via the HookManager); the capability surface
// exists for forward-compatibility with H3+ where other built-ins
// adopt the same pattern, and for 3p modules holding the
// `host:hooks:dispatch` permission to fire build hooks programmatically.
//
// Capability id `"build:hooks"` is on `KNOWN_CAPABILITIES`; permission
// gate is `"host:hooks:dispatch"`.

import type {
  HookFireFailure,
  HookFireOutcome,
  HookHostCapability,
} from "@rn-dev/module-sdk";
import type { ValidatedProfile } from "../../daemon/profile-guard.js";
import type { HookManager } from "../../core/hooks/manager.js";
import type { FireFailure, FireOutcome } from "../../core/hooks/dispatcher.js";

/** Capability id registered with the host's CapabilityRegistry. */
export const BUILD_HOOKS_CAPABILITY_ID = "build:hooks" as const;

/** Permission gate on the capability (host:hooks:dispatch). */
export const BUILD_HOOKS_CAPABILITY_PERMISSION = "host:hooks:dispatch" as const;

/** Hook names declared by `buildManifest.provides.hooks`. */
export type BuildHookName = "pre" | "post" | "custom";
const BUILD_HOOK_NAMES: ReadonlyArray<BuildHookName> = ["pre", "post", "custom"];

export interface CreateBuildHostCapabilityOptions {
  /** HookManager owning the build/* slots (constructed in bootSessionServices). */
  hookManager: HookManager;
  /**
   * Profile resolver. The HookManager fire signature requires a
   * `ValidatedProfile` brand on every fire; the daemon re-validates per
   * RPC and passes a function so the capability picks up profile
   * changes mid-session (e.g. after `session/profile-update`) without
   * being recreated.
   */
  resolveProfile(): ValidatedProfile;
}

/**
 * Construct a `HookHostCapability` bound to the build module.
 * `cap.fire("pre", payload)` dispatches `build/pre`; `"post"` →
 * `build/post`; `"custom"` → `build/custom`. Other names reject with a
 * programmer-error message naming the legal slots.
 *
 * The outcome shape from `HookManager.fire` (core's `FireOutcome`) is
 * mapped to the SDK's `HookFireOutcome` so 3p modules don't have to
 * reach into core types.
 */
export function createBuildHostCapability(
  opts: CreateBuildHostCapabilityOptions,
): HookHostCapability {
  return {
    async fire(name: string, payload: unknown): Promise<HookFireOutcome> {
      if (!isBuildHookName(name)) {
        throw new Error(
          `BuildHostCapability.fire("${name}"): unknown hook. Legal names: ${BUILD_HOOK_NAMES.join(", ")}.`,
        );
      }
      const target = `build/${name}` as const;
      const profile = opts.resolveProfile();
      const outcome = await opts.hookManager.fire(target, payload, profile);
      return mapOutcome(outcome);
    },
  };
}

function isBuildHookName(name: string): name is BuildHookName {
  return (BUILD_HOOK_NAMES as ReadonlyArray<string>).includes(name);
}

function mapOutcome(outcome: FireOutcome): HookFireOutcome {
  return {
    ok: outcome.ok,
    fired: outcome.fired,
    skipped: outcome.skipped,
    failures: outcome.failures.map(mapFailure),
  };
}

function mapFailure(failure: FireFailure): HookFireFailure {
  return {
    registration: {
      target: failure.registration.target,
      sourceKind: failure.registration.source.kind,
    },
    reason: failure.reason,
    // The dispatcher's FireFailure.error is a HookError whose details may
    // include an `outcome` discriminator (E_HOOK_FAILED variants). Surface
    // it when present so SDK clients can switch on it.
    ...(failure.error.details.code === "E_HOOK_FAILED" &&
    "outcome" in failure.error.details
      ? { outcome: failure.error.details.outcome }
      : {}),
  };
}
