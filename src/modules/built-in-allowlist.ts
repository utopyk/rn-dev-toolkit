// Compiled-in allowlist of module IDs permitted to declare
// `kind: "built-in-privileged"`. A 3p manifest that smuggles `kind` past
// schema validation, or any code path that calls `registerBuiltIn` with
// an unknown id, must be rejected here — built-in-privileged modules run
// in-process inside the daemon and are exempt from the
// `<moduleId>__<tool>` prefix policy. Without this gate, any 3p
// installation could escalate from subprocess isolation to in-process.
//
// New built-ins land here as an explicit code change reviewable in PR.
// H1 adds `session`; H2 wraps Builder and adds `build`; H3 adds
// `clean`, `metro`, `devtools-core`, `preflight`. Keep this list in
// lockstep with the modules that actually exist on disk under
// `src/modules/built-in/manifests.ts` — the asserter does NOT cross-check.

import { ModuleError, ModuleErrorCode } from "@rn-dev/module-sdk";

/**
 * IDs permitted to be `kind: "built-in-privileged"`. Compile-time
 * constant — modifications require a code review and a host release.
 *
 * Pre-H1 built-ins (`dev-space`, `lint-test`, `settings`, `marketplace`)
 * are codified here from `src/modules/built-in/manifests.ts` and
 * `src/modules/built-in/marketplace.ts`. `session` is new in H1.
 */
const PRODUCTION_ALLOWLIST: ReadonlySet<string> = new Set([
  "dev-space",
  "lint-test",
  "settings",
  "marketplace",
  "session",
  "build", // Phase H2e — wraps src/core/builder.ts behind a hook host
]);

/**
 * Test-only extensions added via `__addBuiltInAllowedForTests`. Cleared
 * by `__resetBuiltInAllowlistForTests`. Production code paths never
 * touch this set; the seam exists so vitest can register synthetic
 * fixture ids without weakening the production gate.
 */
const testExtensions: Set<string> = new Set();

/**
 * Public read-only view of the production allowlist. Tests should NOT
 * read this directly — `isBuiltInAllowed` consults both prod and test
 * extensions and is what `registerBuiltIn` uses internally.
 */
export const BUILT_IN_MODULE_ALLOWLIST: ReadonlySet<string> = PRODUCTION_ALLOWLIST;

/**
 * Throw `E_INVALID_MANIFEST` if `id` is not on the allowlist. Called by
 * `ModuleRegistry.registerBuiltIn`. Callers MUST handle the throw —
 * built-in registration is a programmer-controlled path and a rejection
 * here is a configuration bug, not runtime state.
 */
export function assertBuiltInAllowed(id: string): void {
  if (isBuiltInAllowed(id)) return;
  throw new ModuleError(
    ModuleErrorCode.E_INVALID_MANIFEST,
    `Module "${id}" is not in the built-in-privileged allowlist. ` +
      `Only host-shipped modules may declare kind: "built-in-privileged"; ` +
      `add the id to src/modules/built-in-allowlist.ts to permit it.`,
    { id },
  );
}

/** Predicate form. Honors both the production list and active test extensions. */
export function isBuiltInAllowed(id: string): boolean {
  if (PRODUCTION_ALLOWLIST.has(id)) return true;
  if (testExtensions.has(id)) return true;
  // Cross-process test seam: when the daemon is spawned as a subprocess
  // by an integration test, the in-process `__addBuiltInAllowedForTests`
  // doesn't reach the child. RN_DEV_TEST_BUILTIN_ALLOWLIST is a
  // comma-separated id list that the child reads on each predicate
  // call; production never sets this. Same threat-model as the
  // RN_DEV_DAEMON_TEST_EXTRA_MANIFEST env hook in fake-boot.ts —
  // tests-only.
  const envExt = process.env.RN_DEV_TEST_BUILTIN_ALLOWLIST;
  if (envExt) {
    return envExt
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .includes(id);
  }
  return false;
}

/**
 * Test seam — temporarily permit a synthetic id to be registered as
 * built-in-privileged. Pair with `__resetBuiltInAllowlistForTests` in a
 * test-suite teardown so extensions don't leak between tests.
 */
export function __addBuiltInAllowedForTests(id: string): void {
  testExtensions.add(id);
}

/** Test seam — drop all extensions added by `__addBuiltInAllowedForTests`. */
export function __resetBuiltInAllowlistForTests(): void {
  testExtensions.clear();
}
