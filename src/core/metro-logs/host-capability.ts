/**
 * Host capability for the `@rn-dev-modules/metro-logs` 3p module.
 *
 * Registered in `startServicesAsync` via `registerHostCapabilities`. The
 * capability baseline permission is `metro:logs:read`; `clear()` upgrades
 * to `metro:logs:mutate` via per-method permissions so a read-only module
 * grant can't drop a worktree's log buffer.
 *
 * Worktree scoping mirrors the Phase 9 devtools pattern — the capability
 * ALWAYS resolves against `defaultWorktreeKey`; caller-supplied
 * `worktreeKey` values are validated against a host-known allowlist and
 * silently ignored when unknown. Protects against a module with
 * `metro:logs:read` reading a worktree it wasn't intended to see.
 */

import type { MetroLogsStore } from "./buffer.js";
import type {
  MetroLogsFilter,
  MetroLogsListResult,
  MetroLogsMeta,
  MetroLogsStatus,
} from "./types.js";

export const METRO_LOGS_CAPABILITY_ID = "metro-logs" as const;

export const METRO_LOGS_CAPABILITY_READ_PERMISSION =
  "metro:logs:read" as const;

export const METRO_LOGS_CAPABILITY_MUTATE_PERMISSION =
  "metro:logs:mutate" as const;

export const METRO_LOGS_METHOD_PERMISSIONS: Readonly<Record<string, string>> = {
  status: METRO_LOGS_CAPABILITY_READ_PERMISSION,
  list: METRO_LOGS_CAPABILITY_READ_PERMISSION,
  clear: METRO_LOGS_CAPABILITY_MUTATE_PERMISSION,
};

export interface MetroLogsListArgs {
  worktreeKey?: string;
  filter?: MetroLogsFilter;
}

export interface MetroLogsClearArgs {
  worktreeKey?: string;
}

export interface MetroLogsHostCapability {
  status(worktreeKey?: string): Promise<MetroLogsStatus>;
  list(args: MetroLogsListArgs): Promise<MetroLogsListResult>;
  clear(
    args: MetroLogsClearArgs,
  ): Promise<{ status: "cleared"; meta: MetroLogsMeta }>;
}

export type AllowedWorktreeKeys = () => readonly string[];

export function createMetroLogsHostCapability(
  store: MetroLogsStore,
  defaultWorktreeKey: string,
  allowedWorktreeKeys?: AllowedWorktreeKeys,
): MetroLogsHostCapability {
  const allowedSet = (): Set<string> => {
    const arr = allowedWorktreeKeys?.() ?? [defaultWorktreeKey];
    return new Set(arr.length > 0 ? arr : [defaultWorktreeKey]);
  };
  const resolve = (wk?: string): string => {
    if (typeof wk !== "string" || wk.length === 0) return defaultWorktreeKey;
    return allowedSet().has(wk) ? wk : defaultWorktreeKey;
  };

  return {
    async status(wk) {
      return store.status(resolve(wk));
    },
    async list({ worktreeKey, filter }) {
      return store.list(resolve(worktreeKey), filter);
    },
    async clear({ worktreeKey }) {
      const wk = resolve(worktreeKey);
      const meta = store.clear(wk);
      return { status: "cleared", meta };
    },
  };
}
