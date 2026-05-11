// Phase H2d — surface a built-in module exposes so other modules (and
// internal host code) can fire its hooks programmatically.
//
// The first concrete factory is `createBuildHostCapability` (Phase H2e);
// H3 adds Clean / Metro / DevTools / Preflight factories using the same
// shape. Each factory binds the module's slot prefix (e.g. `"build/"`)
// so callers pass a relative hook name — `cap.fire("pre", payload)` for
// the build module dispatches `build/pre`.
//
// The outcome shape is structurally compatible with `FireOutcome` from
// `src/core/hooks/dispatcher.ts`. The SDK owns the interface so 3p
// modules can declare `host.capability<HookHostCapability>("…")`
// without dragging in core internals.

import type { HookFailedOutcome } from "./errors.js";

/** Discriminator on `FireFailure.reason` mirrored for SDK consumers. */
export type HookFireFailureReason =
  | "subprocess"
  | "in-process-throw"
  | "path-mutated"
  | "queue-full";

export interface HookFireFailure {
  /**
   * Identifying information for the failed registration. The SDK keeps
   * this minimal — full registration internals (path-resolver
   * fingerprints, source kind, priority) live in core types and are not
   * meant to leak across module boundaries.
   */
  registration: {
    /** Fully-qualified target the registration was bound to. */
    target: string;
    /** "project" | "module:<id>" — kind of the registration source. */
    sourceKind: string;
  };
  reason: HookFireFailureReason;
  /**
   * Optional finer-grained outcome surfaced for `subprocess` failures
   * (timeout, exit-nonzero, …). Mirrors `HookFailedOutcome` from the
   * shared error catalog so SDK clients can switch on it directly.
   */
  outcome?: HookFailedOutcome;
}

export interface HookFireOutcome {
  /** True iff every non-orphaned registration in the slot succeeded. */
  ok: boolean;
  /** Count of registrations that ran (success or fail). */
  fired: number;
  /** Count of registrations skipped (orphaned at fire time, etc.). */
  skipped: number;
  failures: HookFireFailure[];
}

/**
 * Capability surface for firing the host module's hooks.
 *
 * Permission gate: every register site MUST set `requiredPermission` to
 * `"host:hooks:dispatch"`. Modules that only need to consume hooks (via
 * `consumes.hooks` in their manifest) do NOT need this capability —
 * the host fires consumed hooks automatically. This capability exists
 * only for modules that need to fire OTHER modules' hooks
 * programmatically (rare; mostly internal host code in H2 / H3).
 */
export interface HookHostCapability {
  /**
   * Fire all consumers registered against this module's `<name>` hook.
   * `name` is relative to the module's own `provides.hooks` namespace —
   * the factory prepends the module-id prefix.
   *
   * Resolves with the dispatch outcome regardless of whether any
   * consumer failed; callers map onFail policies on top. Rejects only
   * for programmer errors (unknown hook name on this host).
   */
  fire(name: string, payload: unknown): Promise<HookFireOutcome>;
}
