/**
 * Type mirrors for the DevTools capture payload shapes the host returns
 * to this module via `ctx.host.capability<DevtoolsHostCapability>("devtools")`.
 *
 * These duplicate the host's `src/core/devtools/types.ts` intentionally —
 * module packages cannot import from host source paths (that's a bundling
 * boundary violation), and pulling the types into `@rn-dev/module-sdk`
 * would pollute the SDK with domain-specific detail every module would
 * carry. The `src/__tests__/parity.test.ts` asserts shape equivalence
 * against a fixture so drift surfaces at vitest time.
 */

export type CapturedBody =
  | { kind: "text"; data: string; truncated: boolean; droppedBytes: number }
  | { kind: "binary"; mimeType: string; byteLength: number }
  | {
      kind: "redacted";
      reason: "mcp-default" | "deny-list" | "operator-disabled";
    }
  | {
      kind: "absent";
      reason: "not-captured" | "fetch-failed" | "204-or-304";
    };

export interface CdpStackFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface CdpStackTrace {
  description?: string;
  callFrames: readonly CdpStackFrame[];
  parent?: CdpStackTrace;
}

export type Initiator =
  | { type: "parser"; url: string }
  | { type: "script"; stack: CdpStackTrace }
  | { type: "preload" }
  | { type: "other" };

interface NetworkEntryBase {
  readonly requestId: string;
  readonly sequence: number;
  readonly version: number;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody: CapturedBody;
  readonly timings: { readonly startedAt: number };
  readonly initiator?: Initiator;
  readonly redirectChain?: readonly string[];
  readonly source: "cdp";
}

export type NetworkEntry =
  | (NetworkEntryBase & { readonly terminalState: "pending" })
  | (NetworkEntryBase & {
      readonly terminalState: "finished";
      readonly status: number;
      readonly statusText: string;
      readonly mimeType: string;
      readonly responseHeaders: Readonly<Record<string, string>>;
      readonly responseBody: CapturedBody;
      readonly timings: {
        readonly startedAt: number;
        readonly completedAt: number;
        readonly durationMs: number;
      };
    })
  | (NetworkEntryBase & {
      readonly terminalState: "failed";
      readonly failureReason: string;
      readonly status?: number;
      readonly responseHeaders?: Readonly<Record<string, string>>;
      readonly timings: {
        readonly startedAt: number;
        readonly completedAt: number;
        readonly durationMs: number;
      };
    });

export type ProxyStatus =
  | "connected"
  | "disconnected"
  | "no-target"
  | "preempted"
  | "starting"
  | "stopping";

export type BodyCaptureMode =
  | "full"
  | "text-only"
  | "metadata-only"
  | "mcp-redacted";

export interface SessionBoundary {
  previousEpoch: number;
  reason: "clear" | "target-swap" | "proxy-restart" | "metro-restart";
  at: number;
}

export interface CaptureMeta {
  worktreeKey: string;
  bufferEpoch: number;
  oldestSequence: number;
  lastEventSequence: number;
  proxyStatus: ProxyStatus;
  selectedTargetId: string | null;
  evictedCount: number;
  tapDroppedCount: number;
  bodyTruncatedCount: number;
  bodyCapture: BodyCaptureMode;
  sessionBoundary: SessionBoundary | null;
}

export interface CaptureListResult<T> {
  entries: readonly T[];
  cursorDropped: boolean;
  meta: CaptureMeta;
}

export interface NetworkCursor {
  readonly bufferEpoch: number;
  readonly sequence: number;
}

export interface NetworkFilter {
  urlRegex?: string;
  methods?: string[];
  statusRange?: [number, number];
  since?: NetworkCursor;
  limit?: number;
}

export interface TargetDescriptor {
  id: string;
  type: string;
  title: string;
  description?: string;
  url?: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
}

export interface DevToolsStatus {
  meta: CaptureMeta;
  targets: TargetDescriptor[];
  rnVersion: string | null;
  proxyPort: number | null;
  sessionNonce: string | null;
  bodyCaptureEnabled: boolean;
}
