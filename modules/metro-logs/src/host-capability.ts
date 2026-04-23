/**
 * Local mirror of the `metro-logs` host capability surface. The host impl
 * lives at `src/core/metro-logs/host-capability.ts`; the module cannot
 * import it directly (bundling boundary), so the shape is duplicated
 * here. Parity is covered by `__tests__/parity.test.ts`.
 */

import type {
  MetroLogsFilter,
  MetroLogsListResult,
  MetroLogsMeta,
  MetroLogsStatus,
} from "./types.js";

export const METRO_LOGS_CAPABILITY_ID = "metro-logs" as const;

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
