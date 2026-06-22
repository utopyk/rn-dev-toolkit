/**
 * Type mirrors for the Metro-logs capture payload shapes the host returns
 * to this module via `ctx.host.capability<MetroLogsHostCapability>("metro-logs")`.
 *
 * These duplicate the host's `src/core/metro-logs/types.ts` intentionally —
 * module packages cannot import from host source paths (that's a bundling
 * boundary violation). The `src/__tests__/parity.test.ts` asserts shape
 * equivalence against the host types so drift surfaces at vitest time.
 */

export type MetroLogStream = "stdout" | "stderr";

export interface MetroLogLine {
  readonly sequence: number;
  readonly at: number;
  readonly stream: MetroLogStream;
  readonly line: string;
}

export interface MetroLogsCursor {
  readonly bufferEpoch: number;
  readonly sequence: number;
}

export interface MetroLogsFilter {
  substring?: string;
  stream?: MetroLogStream;
  since?: MetroLogsCursor;
  limit?: number;
}

export type ProcessStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopped"
  | "error";

export interface MetroLogsMeta {
  readonly worktreeKey: string;
  readonly bufferEpoch: number;
  readonly oldestSequence: number;
  readonly lastEventSequence: number;
  readonly totalLinesReceived: number;
  readonly evictedCount: number;
  readonly metroStatus: ProcessStatus;
}

export interface MetroLogsListResult {
  readonly entries: readonly MetroLogLine[];
  readonly cursorDropped: boolean;
  readonly meta: MetroLogsMeta;
}

export interface MetroLogsStatus {
  readonly meta: MetroLogsMeta;
  readonly bufferSize: number;
  readonly bufferCapacity: number;
}

// ── Native device-logs surface (folded from the old `device-logs` module) ──

export type DeviceLogSource = "ios" | "android";
export type DeviceLogLevel = "debug" | "info" | "warn" | "error" | "fault";

export interface DeviceLogLine {
  readonly sequence: number;
  readonly at: number;
  readonly source: DeviceLogSource;
  readonly deviceId: string;
  readonly level: DeviceLogLevel;
  readonly tag: string;
  readonly pid: number;
  readonly message: string;
}

export interface DeviceLogsCursor {
  readonly bufferEpoch: number;
  readonly sequence: number;
}

export interface DeviceLogsFilter {
  deviceId?: string;
  source?: DeviceLogSource;
  level?: DeviceLogLevel;
  substring?: string;
  since?: DeviceLogsCursor;
  limit?: number;
}

export type TapStatus = "idle" | "starting" | "running" | "stopped" | "error";

export interface DeviceLogsTap {
  readonly tapId: string;
  readonly source: DeviceLogSource;
  readonly deviceId: string;
  readonly simulator: boolean;
  readonly bundleId?: string;
  readonly packageName?: string;
  readonly status: TapStatus;
  readonly startedAt: number;
  readonly error?: string;
  readonly refcount: number;
}

export interface DeviceLogsMeta {
  readonly bufferEpoch: number;
  readonly oldestSequence: number;
  readonly lastEventSequence: number;
  readonly totalLinesReceived: number;
  readonly evictedCount: number;
  readonly taps: readonly DeviceLogsTap[];
}

export interface DeviceLogsListResult {
  readonly entries: readonly DeviceLogLine[];
  readonly cursorDropped: boolean;
  readonly meta: DeviceLogsMeta;
}

export interface DeviceLogsStatus {
  readonly meta: DeviceLogsMeta;
  readonly bufferSize: number;
  readonly bufferCapacity: number;
}
