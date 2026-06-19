/**
 * Unified ring buffer for native device logs (iOS unified-log + Android
 * logcat). One ring per `deviceId`; sequence numbers are GLOBAL across
 * devices so a `list()` call without a `deviceId` filter can merge by
 * sequence and yield a consistent timeline.
 *
 * Subscribed to by the `TapManager` (see `./tap-manager.ts`): every
 * parsed line lands here via `append()`. The `device-logs` host
 * capability (see `./host-capability.ts`) wraps a single store + manager
 * pair; the module subprocess calls it over vscode-jsonrpc `host/call`.
 */

import type {
  DeviceLogLevel,
  DeviceLogLine,
  DeviceLogSource,
  DeviceLogsFilter,
  DeviceLogsListResult,
  DeviceLogsMeta,
  DeviceLogsStatus,
  DeviceLogsTap,
} from "./types.js";

export const MAX_LIST_LIMIT = 1000;
export const DEFAULT_BUFFER_CAPACITY = 2000;

/** Defense-in-depth per-line cap. A misbehaving native process could
 *  emit a multi-MB single line and exhaust daemon memory. Truncate
 *  before the ring sees it. Same shape as metro-logs/buffer.ts. */
export const MAX_LINE_BYTES = 64 * 1024;

const LEVEL_ORDER: ReadonlyArray<DeviceLogLevel> = [
  "debug",
  "info",
  "warn",
  "error",
  "fault",
];
function levelGte(line: DeviceLogLevel, threshold: DeviceLogLevel): boolean {
  return LEVEL_ORDER.indexOf(line) >= LEVEL_ORDER.indexOf(threshold);
}

interface DeviceRing {
  capacity: number;
  entries: DeviceLogLine[];
  bufferEpoch: number;
  totalLinesReceived: number;
  evictedCount: number;
}

export interface DeviceLogsStoreOptions {
  capacity?: number;
}

/** Input shape for `append()` — mirrors `DeviceLogLine` minus the
 *  store-assigned `sequence` + `at` defaults. */
export interface AppendArgs {
  source: DeviceLogSource;
  deviceId: string;
  level: DeviceLogLevel;
  tag?: string;
  pid?: number;
  message: string;
  at?: number;
}

export class DeviceLogsStore {
  private readonly rings = new Map<string, DeviceRing>();
  private readonly capacity: number;
  /** Sequence counter shared ACROSS devices so a cross-device merge
   *  preserves capture order. Per-device sequence would require a
   *  multi-cursor in the protocol; cross-device sequencing keeps the
   *  module's surface identical to metro-logs. */
  private nextSequence = 1;

  constructor(options: DeviceLogsStoreOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_BUFFER_CAPACITY;
  }

  append(args: AppendArgs): DeviceLogLine {
    const ring = this.ensureRing(args.deviceId);
    const safeMsg =
      args.message.length > MAX_LINE_BYTES
        ? args.message.slice(0, MAX_LINE_BYTES) + " [truncated]"
        : args.message;
    const entry: DeviceLogLine = {
      sequence: this.nextSequence++,
      at: args.at ?? Date.now(),
      source: args.source,
      deviceId: args.deviceId,
      level: args.level,
      tag: args.tag ?? "",
      pid: args.pid ?? -1,
      message: safeMsg,
    };
    ring.entries.push(entry);
    ring.totalLinesReceived++;
    if (ring.entries.length > ring.capacity) {
      ring.entries.shift();
      ring.evictedCount++;
    }
    return entry;
  }

  /** Bump the epoch for `deviceId` (or all devices when omitted) +
   *  drop their entries. Sequence counter intentionally NOT reset —
   *  see metro-logs/buffer.ts for the rationale (cursor invalidates
   *  via epoch; sequence stays monotonic). */
  clear(deviceId: string | undefined, taps: readonly DeviceLogsTap[]): DeviceLogsMeta {
    if (deviceId === undefined) {
      for (const ring of this.rings.values()) {
        ring.entries = [];
        ring.bufferEpoch++;
      }
    } else {
      const ring = this.ensureRing(deviceId);
      ring.entries = [];
      ring.bufferEpoch++;
    }
    return this.metaAcross(taps);
  }

  list(
    filter: DeviceLogsFilter | undefined,
    taps: readonly DeviceLogsTap[],
  ): DeviceLogsListResult {
    const targetDeviceId = filter?.deviceId;
    const rings: DeviceRing[] =
      targetDeviceId !== undefined
        ? [this.ensureRing(targetDeviceId)]
        : [...this.rings.values()];

    // Cursor: epoch is per-ring, but the cross-device list needs a
    // single bool. Drop if ANY targeted ring's epoch differs from
    // the cursor's. (The single-device case is exact; the all-devices
    // case is conservative.)
    const since = filter?.since;
    const cursorDropped =
      since !== undefined &&
      rings.some((r) => r.bufferEpoch !== since.bufferEpoch);

    let pool: DeviceLogLine[] = [];
    for (const r of rings) pool = pool.concat(r.entries);
    pool.sort((a, b) => a.sequence - b.sequence);

    if (since !== undefined && !cursorDropped) {
      pool = pool.filter((e) => e.sequence > since.sequence);
    }
    if (filter?.source) {
      pool = pool.filter((e) => e.source === filter.source);
    }
    if (filter?.level) {
      const thr = filter.level;
      pool = pool.filter((e) => levelGte(e.level, thr));
    }
    if (filter?.substring) {
      const needle = filter.substring;
      pool = pool.filter((e) => e.message.includes(needle));
    }
    const limit = clampLimit(filter?.limit);
    const entries = pool.slice(-limit);

    const lastReturnedSequence =
      entries.length > 0 ? entries[entries.length - 1]!.sequence : null;
    return {
      entries,
      cursorDropped,
      meta: this.metaAcross(taps, lastReturnedSequence),
    };
  }

  status(taps: readonly DeviceLogsTap[]): DeviceLogsStatus {
    return {
      meta: this.metaAcross(taps),
      bufferSize: this.totalSize(),
      bufferCapacity: this.capacity * Math.max(1, this.rings.size),
    };
  }

  /** Test/debug accessor — total retained count across all rings. */
  size(): number {
    return this.totalSize();
  }

  private totalSize(): number {
    let n = 0;
    for (const r of this.rings.values()) n += r.entries.length;
    return n;
  }

  private ensureRing(deviceId: string): DeviceRing {
    let ring = this.rings.get(deviceId);
    if (!ring) {
      ring = {
        capacity: this.capacity,
        entries: [],
        bufferEpoch: 1,
        totalLinesReceived: 0,
        evictedCount: 0,
      };
      this.rings.set(deviceId, ring);
    }
    return ring;
  }

  /** Build the meta envelope across all known devices. `bufferEpoch` is
   *  the MAX across rings — a cursor with a lower epoch is automatically
   *  treated as stale by the list path. */
  private metaAcross(
    taps: readonly DeviceLogsTap[],
    cursorOverride: number | null = null,
  ): DeviceLogsMeta {
    let bufferEpoch = 1;
    let oldest = Number.POSITIVE_INFINITY;
    let ringLast = 0;
    let total = 0;
    let evicted = 0;
    for (const r of this.rings.values()) {
      bufferEpoch = Math.max(bufferEpoch, r.bufferEpoch);
      const first = r.entries[0]?.sequence;
      if (first !== undefined) oldest = Math.min(oldest, first);
      const last = r.entries[r.entries.length - 1]?.sequence;
      if (last !== undefined) ringLast = Math.max(ringLast, last);
      total += r.totalLinesReceived;
      evicted += r.evictedCount;
    }
    if (oldest === Number.POSITIVE_INFINITY) oldest = 0;
    const lastEventSequence = cursorOverride ?? ringLast;
    return {
      bufferEpoch,
      oldestSequence: oldest,
      lastEventSequence,
      totalLinesReceived: total,
      evictedCount: evicted,
      taps,
    };
  }
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return MAX_LIST_LIMIT;
  }
  return Math.min(raw, MAX_LIST_LIMIT);
}
