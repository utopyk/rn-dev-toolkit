// Type surface for the host-RPC client surfaced to module authors.
// The actual transport (vscode-jsonrpc over stdio) lands in Phase 2. This file
// locks in the generic `host.capability<T>(id)` shape so SDK consumers can
// build against a stable contract before the transport exists.

/**
 * Generic capability lookup. Built-ins and third-party modules register into
 * a single host-side registry keyed by string id. Modules declare what they
 * want via `host.capability<T>(id)` — no specific capability name is frozen
 * into the SDK contract.
 *
 * Returns `null` when the capability is unknown OR when the module lacks the
 * permission required to access it (advisory in v1; enforced in V2 sandboxing).
 *
 * Known v1 built-in capability ids (subject to addition — never removal
 * within 1.x):
 *   - `log`         : scoped logger with debug/info/warn/error methods
 *   - `appInfo`     : host version, platform, worktree key
 *   - `metro`       : MetroManager façade (Phase 2+)
 *   - `artifacts`   : artifact store (gated on `fs:artifacts`)
 *   - `modules`     : module-lifecycle queries (used by Marketplace)
 */
export interface HostApi {
  capability<T>(id: string): T | null;
}

/**
 * Per-module logger shape — concrete capability contract for `host.capability<Logger>("log")`.
 * Exposed here so SDK consumers can import a ready-made type for the most
 * common capability lookup.
 */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Static host metadata — concrete capability contract for `host.capability<AppInfo>("appInfo")`.
 */
export interface AppInfo {
  hostVersion: string;
  platform: NodeJS.Platform;
  worktreeKey: string | null;
}
