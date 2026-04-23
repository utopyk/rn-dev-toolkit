/**
 * Local mirror of the `devtools` host capability surface. The host impl
 * lives at `src/core/devtools/host-capability.ts`; the module cannot
 * import it directly (bundling boundary), so the shape is duplicated
 * here. Parity is covered by `__tests__/parity.test.ts`.
 */

import type {
  CaptureListResult,
  CaptureMeta,
  DevToolsStatus,
  NetworkEntry,
  NetworkFilter,
} from "./types.js";

export const DEVTOOLS_CAPABILITY_ID = "devtools" as const;

export interface DevtoolsHostCapability {
  status(worktreeKey?: string): Promise<DevToolsStatus>;
  list(args: {
    worktreeKey?: string;
    filter?: NetworkFilter;
  }): Promise<CaptureListResult<NetworkEntry>>;
  get(args: {
    worktreeKey?: string;
    requestId: string;
  }): Promise<NetworkEntry | null>;
  selectTarget(args: {
    worktreeKey?: string;
    targetId: string;
  }): Promise<{ status: "switched"; meta: CaptureMeta }>;
  clear(args: {
    worktreeKey?: string;
  }): Promise<{ status: "cleared"; meta: CaptureMeta }>;
}
