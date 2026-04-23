/**
 * Per-worktree ring buffer for Metro stdout/stderr. Subscribed to by the
 * host at `startServicesAsync` time — each `log` event from `MetroManager`
 * lands here as a numbered entry, and each `status` event that flips a
 * worktree back to `running` bumps the epoch (Metro restarted → old
 * cursors stale).
 *
 * The `metro-logs` host capability (see `./host-capability.ts`) wraps a
 * single store instance; the module subprocess calls it over
 * `vscode-jsonrpc` `host/call` with its declared worktree.
 */

import type {
  MetroLogLine,
  MetroLogsCursor,
  MetroLogsFilter,
  MetroLogsListResult,
  MetroLogsMeta,
  MetroLogsStatus,
  MetroLogStream,
  ProcessStatus,
} from "./types.js";

/**
 * Max entries a single `list()` call may return — clamps `filter.limit`.
 * Matches the capacity of the devtools network ring so agents get a
 * consistent "page" size regardless of surface.
 */
export const MAX_LIST_LIMIT = 1000;

/** Default per-worktree ring capacity. Tunable via constructor options. */
export const DEFAULT_BUFFER_CAPACITY = 2000;

/**
 * Defense-in-depth per-line cap on captured Metro output (security
 * review P2). A hostile app running under Metro could emit a multi-GB
 * single-line blob to exhaust daemon memory; truncate longer lines
 * before they hit the ring. 64 KiB is ~2–3x the largest legitimate
 * single stack trace line from an unminified RN app.
 */
export const MAX_LINE_BYTES = 64 * 1024;

const KNOWN_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  "idle",
  "starting",
  "running",
  "stopped",
  "error",
]);

/**
 * Normalize a raw Metro-emitted status string to the `ProcessStatus`
 * union. Unknown values fall back to `"stopped"` so a misspelled emit
 * can't leave the ring flagged "running". Exhaustive against the union
 * type — adding a member to `ProcessStatus` without updating
 * `KNOWN_STATUSES` is an immediate tsc break (the Set's element type
 * narrows on every element).
 */
export function normalizeProcessStatus(raw: string): ProcessStatus {
  return KNOWN_STATUSES.has(raw as ProcessStatus)
    ? (raw as ProcessStatus)
    : "stopped";
}

interface WorktreeRing {
  capacity: number;
  // Held as a plain array; `entries.length <= capacity`. When full, the
  // oldest entry is dropped. The sequence counter runs independently.
  entries: MetroLogLine[];
  bufferEpoch: number;
  totalLinesReceived: number;
  evictedCount: number;
  nextSequence: number;
  metroStatus: ProcessStatus;
}

export interface MetroLogsStoreOptions {
  /** Per-worktree ring capacity. Defaults to `DEFAULT_BUFFER_CAPACITY`. */
  capacity?: number;
}

export class MetroLogsStore {
  private readonly rings = new Map<string, WorktreeRing>();
  private readonly capacity: number;

  constructor(options: MetroLogsStoreOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_BUFFER_CAPACITY;
  }

  /** Append a log line for `worktreeKey`. Allocates a ring on first touch. */
  append(worktreeKey: string, stream: MetroLogStream, line: string, at: number = Date.now()): MetroLogLine {
    const ring = this.ensureRing(worktreeKey);
    const safeLine =
      line.length > MAX_LINE_BYTES
        ? line.slice(0, MAX_LINE_BYTES) + " [truncated]"
        : line;
    const entry: MetroLogLine = {
      sequence: ring.nextSequence++,
      at,
      stream,
      line: safeLine,
    };
    ring.entries.push(entry);
    ring.totalLinesReceived++;
    if (ring.entries.length > ring.capacity) {
      ring.entries.shift();
      ring.evictedCount++;
    }
    return entry;
  }

  /**
   * Bump the epoch for `worktreeKey`, drop all held lines. Called on:
   *   - explicit `capability.clear()` from the module
   *   - Metro status transition from non-running → `running` (restart)
   */
  clear(worktreeKey: string): MetroLogsMeta {
    const ring = this.ensureRing(worktreeKey);
    ring.entries = [];
    ring.bufferEpoch++;
    // Sequence counter intentionally NOT reset. Sequences are globally
    // monotonic per worktree — an agent that was watching sequence 500
    // sees its cursor go stale via the epoch bump, and the next emitted
    // line is 501 (not 0). Cleaner than colliding sequences across clears.
    return this.metaFor(ring, worktreeKey);
  }

  /**
   * Report the last-known Metro lifecycle status. Used by the capability's
   * `status()` surface so agents can tell "buffer empty because Metro not
   * running" from "buffer empty because nothing logged yet".
   *
   * Accepts a raw string and normalizes via `normalizeProcessStatus` —
   * the store owns the status vocabulary, so a misspelled emit from
   * `MetroManager` lands as `"stopped"` rather than writing an
   * unknown literal into the meta envelope. Uses a `Set` membership
   * check (not `Record<string, ...>`) so prototype-inherited keys
   * (`__proto__` / `constructor` / `toString`) can't slip through —
   * see Phase 11 Security review P1.
   *
   * Epoch bumps on `stopped | error → running` transitions — Metro
   * restart invalidates cursor continuity. Initial `idle → running`
   * (fresh session, pre-banner stderr lines may already be in the
   * ring) does NOT bump, so those early lines remain visible to the
   * agent — see Phase 11 Architecture review P1-B.
   */
  setMetroStatus(worktreeKey: string, status: string): void {
    const ring = this.ensureRing(worktreeKey);
    const normalized = normalizeProcessStatus(status);
    const restarting =
      (ring.metroStatus === "stopped" || ring.metroStatus === "error") &&
      normalized === "running";
    ring.metroStatus = normalized;
    if (restarting) {
      // Stopped-or-error → running: new Metro session. Drop any held
      // lines from the prior session and bump so agent cursors don't
      // straddle restarts. Bump unconditionally — if the ring was
      // already empty, there are no cursors to invalidate and the
      // extra bump is free.
      ring.entries = [];
      ring.bufferEpoch++;
    }
  }

  list(worktreeKey: string, filter?: MetroLogsFilter): MetroLogsListResult {
    const ring = this.ensureRing(worktreeKey);
    const since = filter?.since;
    const cursorDropped =
      since !== undefined && since.bufferEpoch !== ring.bufferEpoch;

    let pool: readonly MetroLogLine[] = ring.entries;
    if (since !== undefined && !cursorDropped) {
      pool = pool.filter((e) => e.sequence > since.sequence);
    }
    if (filter?.stream) {
      pool = pool.filter((e) => e.stream === filter.stream);
    }
    if (filter?.substring) {
      const needle = filter.substring;
      pool = pool.filter((e) => e.line.includes(needle));
    }
    const limit = clampLimit(filter?.limit);
    const entries = pool.slice(-limit);
    // Phase 11 Kieran P1-1 — advance the meta cursor to the last RETURNED
    // entry when non-empty, not the ring's latest. Without this, a
    // caller using `substring` + small `limit` on a busy buffer would
    // see their cursor jump past unreturned matches on each poll,
    // silently dropping middle entries from agent pagination.
    const lastReturnedSequence =
      entries.length > 0 ? entries[entries.length - 1]!.sequence : null;
    return {
      entries,
      cursorDropped,
      meta: this.metaFor(ring, worktreeKey, lastReturnedSequence),
    };
  }

  status(worktreeKey: string): MetroLogsStatus {
    const ring = this.ensureRing(worktreeKey);
    return {
      meta: this.metaFor(ring, worktreeKey),
      bufferSize: ring.entries.length,
      bufferCapacity: ring.capacity,
    };
  }

  /** Test/debug accessor — current retained count without filtering. */
  size(worktreeKey: string): number {
    return this.rings.get(worktreeKey)?.entries.length ?? 0;
  }

  private ensureRing(worktreeKey: string): WorktreeRing {
    let ring = this.rings.get(worktreeKey);
    if (!ring) {
      ring = {
        capacity: this.capacity,
        entries: [],
        bufferEpoch: 1,
        totalLinesReceived: 0,
        evictedCount: 0,
        nextSequence: 1,
        metroStatus: "idle",
      };
      this.rings.set(worktreeKey, ring);
    }
    return ring;
  }

  private metaFor(
    ring: WorktreeRing,
    worktreeKey: string,
    cursorOverride: number | null = null,
  ): MetroLogsMeta {
    const oldest = ring.entries[0]?.sequence ?? 0;
    const ringLast = ring.entries[ring.entries.length - 1]?.sequence ?? 0;
    // `lastEventSequence` is the position a caller should pass back as
    // `since.sequence`. For `list()` with filters + limit, it advances
    // to the LAST RETURNED entry so the caller can forward-paginate
    // without losing middle matches. For `status()` / `clear()`, it's
    // the ring's latest so callers see the true end-of-stream.
    const last = cursorOverride ?? ringLast;
    return {
      worktreeKey,
      bufferEpoch: ring.bufferEpoch,
      oldestSequence: oldest,
      lastEventSequence: last,
      totalLinesReceived: ring.totalLinesReceived,
      evictedCount: ring.evictedCount,
      metroStatus: ring.metroStatus,
    };
  }
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return MAX_LIST_LIMIT;
  }
  return Math.min(raw, MAX_LIST_LIMIT);
}

export type { MetroLogsCursor };
