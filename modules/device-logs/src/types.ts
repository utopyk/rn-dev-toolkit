/**
 * Type mirrors for the device-logs capture payload shapes the host returns
 * via `ctx.host.capability<DeviceLogsHostCapability>("device-logs")`.
 *
 * These duplicate the host's `src/core/device-logs/types.ts` intentionally
 * — module packages cannot import from host source paths (bundling
 * boundary). The `src/__tests__/parity.test.ts` asserts shape equivalence
 * against the host types so drift surfaces at vitest time.
 */

/** Platform a tap is bound to. Maps 1:1 to the spawn-strategy on the
 *  host side (`ios` → idevicesyslog/simctl, `android` → adb logcat). */
export type DeviceLogSource = "ios" | "android";

/** Apple unified-log style severity levels — used by both platforms with
 *  Android levels remapped (`v/d` → debug, `i` → info, `w` → warn,
 *  `e` → error, `f` → fault). Ordered low→high; the `list` filter treats
 *  the supplied `level` as inclusive minimum. */
export type DeviceLogLevel = "debug" | "info" | "warn" | "error" | "fault";

export interface DeviceLogLine {
  readonly sequence: number;
  /** Capture-time millis epoch — the daemon's local clock at ingest,
   *  NOT the device's clock. Device clocks drift; daemon-side timestamps
   *  let us merge with metro-logs lines on a single timeline. */
  readonly at: number;
  readonly source: DeviceLogSource;
  /** UDID (iOS) or adb serial (Android). Stable across reconnects. */
  readonly deviceId: string;
  readonly level: DeviceLogLevel;
  /** iOS: subsystem/category (e.g. "com.acme.beta:Networking").
   *  Android: logcat tag. Empty string when the source doesn't supply one. */
  readonly tag: string;
  /** Process id on the device. -1 when unknown. */
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

/** Lifecycle of a single tap. Mirrors the metro-logs `ProcessStatus`
 *  shape so the panel can reuse status-pill styling. */
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
  /** Cause of failure when status === 'error'. */
  readonly error?: string;
  /** How many consumers asked for this tap (refcount). The tap stops
   *  when this drops to 0 via stop-tap. */
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
