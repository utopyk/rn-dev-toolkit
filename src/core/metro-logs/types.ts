/**
 * Metro log capture types — shared between the host-side `MetroLogsStore`
 * and the 3p `@rn-dev-modules/metro-logs` subprocess that queries it via
 * the `metro-logs` host capability.
 *
 * Phase 11: Metro log lines are untrusted external content — anything the
 * running RN app prints to stdout / stderr. Modules mirror these shapes
 * locally (module-boundary rule: no cross-bundle imports into host
 * source), and a `parity.test.ts` asserts structural equivalence.
 */

export type MetroLogStream = "stdout" | "stderr";

export interface MetroLogLine {
  readonly sequence: number;
  readonly at: number;
  readonly stream: MetroLogStream;
  readonly line: string;
}

/**
 * Opaque-ish pagination token. Holders pass the `meta` envelope's
 * `bufferEpoch` + `lastEventSequence` back as `since`; the store drops
 * the cursor (sets `cursorDropped: true`) when the epoch has bumped —
 * Metro restart, `clear()`, or worktree handoff.
 */
export interface MetroLogsCursor {
  readonly bufferEpoch: number;
  readonly sequence: number;
}

export interface MetroLogsFilter {
  /** Case-sensitive substring match against `line`. */
  substring?: string;
  stream?: MetroLogStream;
  since?: MetroLogsCursor;
  /**
   * Max entries returned. Clamped at the store layer to `MAX_LIST_LIMIT`
   * so a rogue caller can't pull the whole ring in one response.
   */
  limit?: number;
}

export type ProcessStatus = "idle" | "starting" | "running" | "stopped" | "error";

export interface MetroLogsMeta {
  readonly worktreeKey: string;
  /** Bumps on: ring `clear()`, Metro restart, fresh worktree. */
  readonly bufferEpoch: number;
  /** Sequence of the oldest retained line (1-based; 0 if empty). */
  readonly oldestSequence: number;
  /** Sequence of the last appended line (0 if empty). */
  readonly lastEventSequence: number;
  /** Total lines ever received for this worktree, pre-eviction. */
  readonly totalLinesReceived: number;
  /** Count of lines evicted by the ring. */
  readonly evictedCount: number;
  /** Last-known Metro status at capture time. */
  readonly metroStatus: ProcessStatus;
}

export interface MetroLogsListResult {
  readonly entries: readonly MetroLogLine[];
  /**
   * True when the caller passed a `since` cursor from a stale epoch —
   * caller should restart pagination from `meta.oldestSequence`.
   */
  readonly cursorDropped: boolean;
  readonly meta: MetroLogsMeta;
}

export interface MetroLogsStatus {
  readonly meta: MetroLogsMeta;
  /** Number of lines currently retained in the ring. */
  readonly bufferSize: number;
  /** The ring's max capacity. */
  readonly bufferCapacity: number;
}
