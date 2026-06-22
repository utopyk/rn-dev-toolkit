/**
 * Per-session ring of Redux actions + the latest state snapshot. Fed by
 * the WS ingest layer (`./ingest.ts`, P2) — one frame per dispatched
 * action — and read via the `redux` host capability (`./host-capability.ts`,
 * P3). Modeled on `MetroLogsStore`: per-key ring, monotonic sequences,
 * epoch bumps invalidate stale cursors, FIFO eviction at capacity.
 *
 * Stores values RAW; redaction (`./redact.ts`) is applied by readers at
 * the boundary that crosses into an agent's context. Size caps here are
 * memory defense (a hostile/buggy app could dispatch a multi-MB payload),
 * not redaction.
 */

import type {
  ReduxActionRecord,
  ReduxActionsFilter,
  ReduxActionsResult,
  ReduxIngestFrame,
  ReduxMeta,
  ReduxStateResult,
  ReduxStatus,
} from "./types.js";

export const MAX_LIST_LIMIT = 1000;
export const DEFAULT_BUFFER_CAPACITY = 2000;

/**
 * Per-value size cap (stringified bytes) on payload / diff / state. An
 * oversized value is replaced wholesale by a marker and `truncatedCount`
 * is bumped — prevents a single huge dispatch from exhausting daemon
 * memory or producing an unbounded MCP response.
 */
export const MAX_VALUE_BYTES = 256 * 1024;

interface SessionRing {
  capacity: number;
  actions: ReduxActionRecord[];
  latestState: unknown;
  hasState: boolean;
  bufferEpoch: number;
  totalActionsReceived: number;
  evictedCount: number;
  truncatedCount: number;
  nextSequence: number;
}

export interface ReduxStoreOptions {
  capacity?: number;
}

/** Cap a value by stringified size; returns the value or a marker + flag. */
function capValue(value: unknown): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value: undefined, truncated: false };
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    // Circular / non-serializable — refuse to retain it raw.
    return { value: "<unserializable>", truncated: true };
  }
  if (size > MAX_VALUE_BYTES) {
    return { value: `<oversized:${size}bytes>`, truncated: true };
  }
  return { value, truncated: false };
}

/** Navigate a dot/bracket path (`a.b[0].c`) into a value tree. */
export function navigatePath(root: unknown, path: string): { value: unknown; present: boolean } {
  if (path === "") return { value: root, present: true };
  // Tokenize: `.key` and `[index]`.
  const tokens = path.match(/[^.[\]]+/g);
  if (!tokens) return { value: undefined, present: false };
  let cur: unknown = root;
  for (const tok of tokens) {
    if (cur === null || typeof cur !== "object") return { value: undefined, present: false };
    const container = cur as Record<string, unknown>;
    if (!(tok in container)) return { value: undefined, present: false };
    cur = container[tok];
  }
  return { value: cur, present: true };
}

export class ReduxStore {
  private readonly rings = new Map<string, SessionRing>();
  private readonly capacity: number;
  /** Ingest server lifecycle (defaults to "deferred" — the store exists
   *  before the WS server attempts to bind, and stays deferred until
   *  boot signals success via setIngestStatus("bound")). */
  private ingestStatus: import("./types.js").IngestStatus = "deferred";
  private ingestError = "ingest not yet started";

  constructor(options: ReduxStoreOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_BUFFER_CAPACITY;
  }

  /** Called by boot.ts after reduxIngest.start() resolves (or rejects).
   *  The status is surfaced in every meta envelope so the panel can
   *  render a "no capture" banner when bind failed. */
  setIngestStatus(status: import("./types.js").IngestStatus, errorMessage = ""): void {
    this.ingestStatus = status;
    this.ingestError = status === "bound" ? "" : errorMessage;
  }

  /** Record a dispatched action (+ optional new state) for `sessionKey`. */
  append(sessionKey: string, frame: ReduxIngestFrame, at: number = Date.now()): ReduxActionRecord {
    const ring = this.ensureRing(sessionKey);

    const cappedPayload = capValue(frame.payload);
    const cappedDiff = capValue(frame.diff);
    if (cappedPayload.truncated) ring.truncatedCount++;
    if (cappedDiff.truncated) ring.truncatedCount++;

    const record: ReduxActionRecord = {
      sequence: ring.nextSequence++,
      at,
      type: typeof frame.type === "string" ? frame.type : "<unknown>",
      payload: cappedPayload.value,
      diff: cappedDiff.value ?? null,
    };
    ring.actions.push(record);
    ring.totalActionsReceived++;
    if (ring.actions.length > ring.capacity) {
      ring.actions.shift();
      ring.evictedCount++;
    }

    if (frame.stateAfter !== undefined) {
      const cappedState = capValue(frame.stateAfter);
      if (cappedState.truncated) ring.truncatedCount++;
      ring.latestState = cappedState.value;
      ring.hasState = true;
    }
    return record;
  }

  listActions(sessionKey: string, filter?: ReduxActionsFilter): ReduxActionsResult {
    const ring = this.ensureRing(sessionKey);
    const since = filter?.since;
    const cursorDropped = since !== undefined && since.bufferEpoch !== ring.bufferEpoch;

    let pool: readonly ReduxActionRecord[] = ring.actions;
    if (since !== undefined && !cursorDropped) {
      pool = pool.filter((a) => a.sequence > since.sequence);
    }
    if (filter?.typeFilter) {
      const needle = filter.typeFilter.toLowerCase();
      pool = pool.filter((a) => a.type.toLowerCase().includes(needle));
    }
    const limit = clampLimit(filter?.limit);
    const entries = pool.slice(-limit);
    const lastReturned = entries.length > 0 ? entries[entries.length - 1]!.sequence : null;
    return { entries, cursorDropped, meta: this.metaFor(ring, sessionKey, lastReturned) };
  }

  /** Look up one action by sequence (for `redux__action { seq }`). */
  getAction(sessionKey: string, sequence: number): ReduxActionRecord | null {
    const ring = this.rings.get(sessionKey);
    return ring?.actions.find((a) => a.sequence === sequence) ?? null;
  }

  getState(sessionKey: string, path = ""): ReduxStateResult {
    const ring = this.ensureRing(sessionKey);
    if (!ring.hasState) {
      return { value: null, path, present: false, meta: this.metaFor(ring, sessionKey) };
    }
    const { value, present } = navigatePath(ring.latestState, path);
    return { value: present ? value : null, path, present, meta: this.metaFor(ring, sessionKey) };
  }

  /** Drop actions + state and bump the epoch (clear / fresh app connection). */
  clear(sessionKey: string): ReduxMeta {
    const ring = this.ensureRing(sessionKey);
    ring.actions = [];
    ring.latestState = undefined;
    ring.hasState = false;
    ring.bufferEpoch++;
    // nextSequence intentionally NOT reset — sequences stay monotonic per
    // session; stale cursors are invalidated by the epoch bump.
    return this.metaFor(ring, sessionKey);
  }

  status(sessionKey: string): ReduxStatus {
    const ring = this.ensureRing(sessionKey);
    return {
      meta: this.metaFor(ring, sessionKey),
      bufferSize: ring.actions.length,
      bufferCapacity: ring.capacity,
    };
  }

  size(sessionKey: string): number {
    return this.rings.get(sessionKey)?.actions.length ?? 0;
  }

  private ensureRing(sessionKey: string): SessionRing {
    let ring = this.rings.get(sessionKey);
    if (!ring) {
      ring = {
        capacity: this.capacity,
        actions: [],
        latestState: undefined,
        hasState: false,
        bufferEpoch: 1,
        totalActionsReceived: 0,
        evictedCount: 0,
        truncatedCount: 0,
        nextSequence: 1,
      };
      this.rings.set(sessionKey, ring);
    }
    return ring;
  }

  private metaFor(ring: SessionRing, sessionKey: string, cursorOverride: number | null = null): ReduxMeta {
    const oldest = ring.actions[0]?.sequence ?? 0;
    const ringLast = ring.actions[ring.actions.length - 1]?.sequence ?? 0;
    return {
      sessionKey,
      bufferEpoch: ring.bufferEpoch,
      oldestSequence: oldest,
      lastEventSequence: cursorOverride ?? ringLast,
      totalActionsReceived: ring.totalActionsReceived,
      evictedCount: ring.evictedCount,
      truncatedCount: ring.truncatedCount,
      hasState: ring.hasState,
      // The store keeps raw values; the redaction MODE is a read-time
      // concern, so meta reports the strict default. Readers that reveal
      // (the panel) override this in their own DTO.
      redactionMode: "mcp-redacted",
      ingestStatus: this.ingestStatus,
      ingestError: this.ingestError,
    };
  }
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return MAX_LIST_LIMIT;
  }
  return Math.min(raw, MAX_LIST_LIMIT);
}
