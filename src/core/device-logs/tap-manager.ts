/**
 * TapManager — owns the per-device subprocess lifecycle for native log
 * capture. One process per (source, deviceId); multiple consumers
 * share a single tap via refcounting (Map<tapKey, InternalTap>).
 *
 * Spawn strategy (implemented in Phase 2/3 below — Phase 1 is a stub
 * that errors out of startTap until the platform adapters land):
 *   - iOS physical:   idevicesyslog -u <udid> [--process <bundleId>]
 *   - iOS simulator:  xcrun simctl spawn <udid> log stream --style ndjson
 *                     [--predicate 'subsystem CONTAINS "<bundleId>"']
 *   - Android:        adb -s <serial> logcat -v threadtime
 *                     [--pid=$(adb shell pidof <packageName>)]
 *
 * Each spawned process pipes lines through a per-platform parser
 * (`./parsers/ios.ts`, `./parsers/android.ts`) into `DeviceLogsStore`.
 * On process exit, the tap's `status` flips to "stopped" or "error";
 * captured entries persist in the ring until cleared.
 */

import type { DeviceLogsStore } from "./buffer.js";
import type {
  DeviceLogsStartTapArgs,
} from "./host-capability.js";
import type {
  DeviceLogSource,
  DeviceLogsTap,
} from "./types.js";

interface InternalTap {
  descriptor: DeviceLogsTap;
  // Phase 2/3 will populate these:
  // process?: ChildProcessWithoutNullStreams;
  // killToken?: AbortController;
}

function tapKey(source: DeviceLogSource, deviceId: string): string {
  return `${source}:${deviceId}`;
}

function makeTapId(source: DeviceLogSource, deviceId: string): string {
  // Deterministic — re-requesting a tap returns the same id so the
  // refcount path is observable from the consumer side.
  return `tap-${source}-${deviceId}`;
}

export interface TapManagerOptions {
  /** Optional override — Phase 2/3 platform adapters wire actual spawns
   *  through here. Tests inject a fake to assert lifecycle without
   *  touching real adb/idevicesyslog. */
  spawnAdapter?: SpawnAdapter;
}

/** Phase 2/3 will replace this with a concrete adapter that spawns
 *  idevicesyslog/simctl/adb logcat and pumps parsed lines into the
 *  store. Phase 1 ships with a default that throws — startTap reports
 *  the failure via the tap descriptor's `status: "error"` field. */
export interface SpawnAdapter {
  start(args: DeviceLogsStartTapArgs, store: DeviceLogsStore): Promise<SpawnHandle>;
}
export interface SpawnHandle {
  kill(): void;
}

const NOT_YET_IMPLEMENTED: SpawnAdapter = {
  async start() {
    throw new Error(
      "device-logs taps not yet implemented — Phase 2 (iOS) + Phase 3 (Android) wire the platform adapters",
    );
  },
};

export class TapManager {
  private readonly taps = new Map<string, InternalTap>();
  private readonly handles = new Map<string, SpawnHandle>();
  private readonly store: DeviceLogsStore;
  private readonly adapter: SpawnAdapter;

  constructor(store: DeviceLogsStore, options: TapManagerOptions = {}) {
    this.store = store;
    this.adapter = options.spawnAdapter ?? NOT_YET_IMPLEMENTED;
  }

  listTaps(): readonly DeviceLogsTap[] {
    return [...this.taps.values()].map((t) => t.descriptor);
  }

  async startTap(args: DeviceLogsStartTapArgs): Promise<DeviceLogsTap> {
    const key = tapKey(args.platform, args.deviceId);
    const existing = this.taps.get(key);
    if (existing) {
      // Refcount++ — idempotent for the consumer; one subprocess shared.
      existing.descriptor = {
        ...existing.descriptor,
        refcount: existing.descriptor.refcount + 1,
      };
      return existing.descriptor;
    }
    const tapId = makeTapId(args.platform, args.deviceId);
    const startedAt = Date.now();
    const placeholder: DeviceLogsTap = {
      tapId,
      source: args.platform,
      deviceId: args.deviceId,
      simulator: args.simulator === true,
      bundleId: args.bundleId,
      packageName: args.packageName,
      status: "starting",
      startedAt,
      refcount: 1,
    };
    const internal: InternalTap = { descriptor: placeholder };
    this.taps.set(key, internal);
    try {
      const handle = await this.adapter.start(args, this.store);
      this.handles.set(key, handle);
      internal.descriptor = { ...placeholder, status: "running" };
    } catch (err) {
      internal.descriptor = {
        ...placeholder,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return internal.descriptor;
  }

  async stopTap(tapId: string): Promise<{ status: "stopped" | "still-running" }> {
    for (const [key, tap] of this.taps) {
      if (tap.descriptor.tapId !== tapId) continue;
      if (tap.descriptor.refcount > 1) {
        tap.descriptor = { ...tap.descriptor, refcount: tap.descriptor.refcount - 1 };
        return { status: "still-running" };
      }
      // Last consumer — kill the underlying process.
      const handle = this.handles.get(key);
      if (handle) {
        try { handle.kill(); } catch { /* ignore */ }
        this.handles.delete(key);
      }
      tap.descriptor = { ...tap.descriptor, status: "stopped", refcount: 0 };
      // Keep the tap descriptor visible briefly so consumers polling
      // status can observe the transition; the manager prunes stopped
      // taps lazily on the next startTap for the same key.
      this.taps.delete(key);
      return { status: "stopped" };
    }
    return { status: "stopped" }; // unknown tapId — treat as no-op idempotent
  }

  /** Kill every running tap. Called at daemon shutdown. */
  async shutdown(): Promise<void> {
    for (const handle of this.handles.values()) {
      try { handle.kill(); } catch { /* ignore */ }
    }
    this.handles.clear();
    this.taps.clear();
  }
}
