/**
 * Shared types for the DevTools module.
 *
 * Design notes:
 *   - `NetworkEntry` is a discriminated union on `terminalState`. A `finished`
 *     entry always has `status`, `responseHeaders`, `responseBody`. A `pending`
 *     entry has none of those. Illegal states are unrepresentable.
 *   - `CapturedBody` is a discriminated union on `kind`. The body and its
 *     encoding live together so you can't assert `utf8` with no bytes.
 *   - `NetworkCursor` is branded. Agents echo cursors verbatim and never
 *     fabricate them.
 *   - `CaptureMeta` / `CaptureListResult<T>` are domain-agnostic — future
 *     subtools (Console, Performance) reuse them verbatim. The only per-domain
 *     piece is the entry type parameter.
 */

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CDP stack traces & initiators (used by Network.requestWillBeSent.initiator)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// NetworkEntry (discriminated on terminalState)
// ---------------------------------------------------------------------------

interface NetworkEntryBase {
  readonly requestId: string; // CDP requestId
  readonly sequence: number; // monotonic within bufferEpoch
  readonly version: number; // bumped on each upsert; cheap diff key
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

// ---------------------------------------------------------------------------
// Cursor — branded so agents can't fabricate
// ---------------------------------------------------------------------------

declare const NetworkCursorBrand: unique symbol;

export type NetworkCursor = {
  readonly bufferEpoch: number;
  readonly sequence: number;
  readonly [NetworkCursorBrand]: "NetworkCursor";
};

/** Constructor for internal use only. Do not export beyond the devtools module. */
export function makeNetworkCursor(
  bufferEpoch: number,
  sequence: number
): NetworkCursor {
  return { bufferEpoch, sequence } as NetworkCursor;
}

// ---------------------------------------------------------------------------
// Envelope — domain-agnostic; reused for Console / Performance
// ---------------------------------------------------------------------------

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

/**
 * An enable command the target refused (CDP error response) or that never
 * reached it (transport failure / timeout) at the last (re)attach.
 */
export interface EnableCommandError {
  method: string;
  message: string;
}

export interface CaptureMeta {
  worktreeKey: string;
  bufferEpoch: number;
  /** Lowest sequence still resident in the ring. Used to detect cursor eviction. */
  oldestSequence: number;
  /** Highest sequence seen so far (this epoch). Monotonic freshness signal. */
  lastEventSequence: number;
  proxyStatus: ProxyStatus;
  selectedTargetId: string | null;
  /** Entries dropped by FIFO eviction since bufferEpoch start. */
  evictedCount: number;
  /** Events dropped by tap backpressure (e.g. body-fetch queue overflow). */
  tapDroppedCount: number;
  /** Bodies truncated at size cap this epoch. */
  bodyTruncatedCount: number;
  bodyCapture: BodyCaptureMode;
  sessionBoundary: SessionBoundary | null;
  /**
   * Present only when at least one tap enable command failed at the last
   * (re)attach. The load-bearing case: RN refuses `Network.enable` with
   * "The Network domain is unavailable when multiple React Native hosts
   * are registered" (2026-06-11 acme iOS battle-test) — without this
   * field the session reports `connected` with an eternally empty buffer
   * and zero diagnostics.
   */
  enableErrors?: readonly EnableCommandError[];
}

export interface CaptureListResult<T> {
  entries: readonly T[];
  /** True if caller's since-cursor fell below oldestSequence. */
  cursorDropped: boolean;
  meta: CaptureMeta;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface NetworkFilter {
  urlRegex?: string;
  methods?: string[];
  statusRange?: [number, number];
  since?: NetworkCursor;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Targets (from Metro /json)
// ---------------------------------------------------------------------------

export interface TargetDescriptor {
  id: string;
  type: string;
  title: string;
  description?: string;
  url?: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
}

// ---------------------------------------------------------------------------
// Manager status (returned by DevToolsManager.status)
// ---------------------------------------------------------------------------

export interface DevToolsStatus {
  meta: CaptureMeta;
  targets: TargetDescriptor[];
  rnVersion: string | null;
  /** Proxy URL (for Fusebox rewrite), null before start(). */
  proxyPort: number | null;
  /** Session nonce for the current proxy, null before start(). */
  sessionNonce: string | null;
  /** True if body capture is fully enabled in this process (Electron/Ink view). */
  bodyCaptureEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface DevToolsOpts {
  /** Max entries retained per worktree. Default 300. */
  ringCapacity?: number;
  /** Max text-body bytes per request (request side). Default 64 KiB. */
  requestBodyCap?: number;
  /** Max text-body bytes per response (response side). Default 512 KiB. */
  responseBodyCap?: number;
  /** Body-fetch worker concurrency. Default 4. */
  bodyFetchConcurrency?: number;
  /** Body-fetch per-request timeout (ms). Default 2000. */
  bodyFetchTimeoutMs?: number;
  /** Body-fetch queue cap. Oldest dropped when full. Default 200. */
  bodyFetchQueueCap?: number;
  /**
   * If false, bodies are never captured regardless of other flags. Defaults to
   * true. MCP-layer redaction (S5) is applied separately at DTO time.
   */
  captureBodies?: boolean;
  /** Delta emit cadence (ms). Default 100. */
  deltaFlushIntervalMs?: number;
  /**
   * `/json` poll cadence (ms). Default 10_000. Drives target discovery,
   * Hermes reload detection, and preemption recovery. Disabled if set
   * to 0 (useful for tests).
   */
  pollIntervalMs?: number;
}

export const DEFAULTS = {
  ringCapacity: 300,
  requestBodyCap: 64 * 1024,
  responseBodyCap: 512 * 1024,
  bodyFetchConcurrency: 4,
  bodyFetchTimeoutMs: 2000,
  bodyFetchQueueCap: 200,
  captureBodies: true,
  deltaFlushIntervalMs: 100,
  // Metro `/json` discovery poll. Kept short so that when an app connects,
  // its Hermes target is discovered + capture auto-armed (Network.enable)
  // within ~1s — before the app's JS bundle finishes downloading and fires
  // its launch fetch burst. The previous 10s interval routinely missed
  // that burst (target discovered long after the requests completed, then
  // an idle app makes nothing more). A localhost GET /json per second is
  // negligible overhead for a dev tool.
  pollIntervalMs: 1_000,
} as const;
