import { describe, expect, it, vi } from "vitest";
import { MetroClient } from "../metro-adapter.js";
import { DevToolsClient } from "../devtools-adapter.js";
import { BuilderClient } from "../builder-adapter.js";
import { WatcherClient } from "../watcher-adapter.js";
import type { IpcClient } from "../../../core/ipc.js";
import type {
  AdapterSink,
  BuilderEventKind,
  DevToolsEventKind,
  MetroEventKind,
  WatcherEventKind,
} from "../adapter-sink.js";

// Phase 13.4 prereq #2 — AdapterSink contract pins the public method
// names (`dispatch`, `notifyDisconnected`) every adapter must expose.
// The 13.3 `_dispatch` underscore convention broke down once Electron's
// main + renderer both needed to push events into an adapter; making
// the API explicit prevents future callers from wondering if the
// method is stable.

describe("AdapterSink conformance", () => {
  const noopClient = {} as unknown as IpcClient;
  const noopId = (): string => "id";

  it("MetroClient implements AdapterSink<MetroEventKind>", () => {
    const sink: AdapterSink<MetroEventKind> = new MetroClient(
      noopClient,
      noopId,
    );
    const listener = vi.fn();
    (sink as unknown as MetroClient).on("status", listener);
    sink.dispatch("metro/status", { status: "running" });
    expect(listener).toHaveBeenCalledWith({ status: "running" });
  });

  it("DevToolsClient implements AdapterSink<DevToolsEventKind>", () => {
    const sink: AdapterSink<DevToolsEventKind> = new DevToolsClient(
      noopClient,
      noopId,
    );
    const listener = vi.fn();
    (sink as unknown as DevToolsClient).on("delta", listener);
    sink.dispatch("devtools/delta", {
      addedIds: ["a"],
      updatedIds: [],
      evictedIds: [],
    });
    expect(listener).toHaveBeenCalledWith({
      addedIds: ["a"],
      updatedIds: [],
      evictedIds: [],
    });
  });

  it("BuilderClient implements AdapterSink<BuilderEventKind>", () => {
    const sink: AdapterSink<BuilderEventKind> = new BuilderClient(
      noopClient,
      noopId,
    );
    const listener = vi.fn();
    (sink as unknown as BuilderClient).on("progress", listener);
    sink.dispatch("builder/progress", { phase: "configure" });
    expect(listener).toHaveBeenCalledWith({ phase: "configure" });
  });

  it("WatcherClient implements AdapterSink<WatcherEventKind>", () => {
    const sink: AdapterSink<WatcherEventKind> = new WatcherClient(
      noopClient,
      noopId,
    );
    const listener = vi.fn();
    (sink as unknown as WatcherClient).on("action-complete", listener);
    sink.dispatch("watcher/action-complete", {
      name: "lint",
      result: {
        action: "lint",
        success: true,
        output: "",
        durationMs: 0,
      },
    });
    expect(listener).toHaveBeenCalled();
  });

  it("notifyDisconnected re-emits as a 'disconnected' event", () => {
    const sink = new MetroClient(noopClient, noopId);
    const listener = vi.fn();
    sink.on("disconnected", listener);
    const err = new Error("socket lost");
    sink.notifyDisconnected(err);
    expect(listener).toHaveBeenCalledWith(err);
  });

  it("notifyDisconnected tolerates an absent error (not every drop has one)", () => {
    const sink = new MetroClient(noopClient, noopId);
    const listener = vi.fn();
    sink.on("disconnected", listener);
    sink.notifyDisconnected();
    expect(listener).toHaveBeenCalledWith(undefined);
  });
});
