// Daemon dev/prod mode gate (Phase H2a).
//
// `RN_DEV_DAEMON_MODE` selects between:
//   - "prod" (default) — production-grade defaults; dev-only MCP tools
//     refuse to operate (`hooks/run` with mode "real" or "synthetic" is
//     denied with `E_HOOK_RUN_REAL_DENIED`).
//   - "dev"            — relaxes those gates for tooling that exercises
//     real subsystems for debugging.
//
// The error code `E_HOOK_RUN_REAL_DENIED` was reserved in
// `@rn-dev/module-sdk` during H1; this module is the canonical raise
// site. Other dev-only tools (planned in H6) adopt the same gate by
// calling `assertDevMode(...)`.
//
// Read on every call rather than memoized — a few daemon-test harnesses
// flip the env mid-process and the cost of a `process.env` read is
// negligible compared with the security value of always reflecting the
// current setting.

import { HookError, HookErrorCode } from "@rn-dev/module-sdk";

export type DaemonMode = "dev" | "prod";

const DAEMON_MODE_ENV = "RN_DEV_DAEMON_MODE";

/**
 * Read the daemon's current mode from the environment.
 *
 * Default is `"prod"` — fail-closed for production safety. Anything other
 * than the literal string `"dev"` (case-sensitive, no whitespace) reads
 * as `"prod"` so misspellings like `"DEV"`, `"development"`, or `" dev"`
 * cannot accidentally open the gate.
 */
export function getDaemonMode(): DaemonMode {
  return process.env[DAEMON_MODE_ENV] === "dev" ? "dev" : "prod";
}

/**
 * Throw `E_HOOK_RUN_REAL_DENIED` if the daemon is not in dev mode.
 *
 * Used by dev-only MCP tools — `hooks/run` with `mode: "real"` and the
 * synthetic-mode variant both fall under the same gate. The `mode`
 * argument is recorded in the error details so MCP clients can surface
 * which sub-mode the caller asked for, and so the audit log can
 * distinguish the two denial paths.
 */
export function assertDevMode(mode: "real" | "synthetic"): void {
  const current = getDaemonMode();
  if (current === "dev") return;
  throw new HookError(
    `RN_DEV_DAEMON_MODE=${current} denies hooks/run with mode="${mode}". ` +
      `Set RN_DEV_DAEMON_MODE=dev to enable.`,
    {
      code: HookErrorCode.E_HOOK_RUN_REAL_DENIED,
      mode,
      daemonMode: current,
    },
  );
}
