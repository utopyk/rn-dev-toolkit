import { describe, expect, it, vi } from "vitest";
import { ModuleHostClient } from "../module-host-adapter.js";
import type { IpcClient } from "../../../core/ipc.js";
import type { AdapterSink, ModuleHostEventKind } from "../adapter-sink.js";

// Phase 13.4 prereq #3 — the ModuleHostClient is the adapter for
// `modules/state-changed|crashed|failed` events the daemon fans out
// via `events/subscribe`. It re-emits each on the `modules-event`
// topic, matching the pre-13.4 in-process `moduleEventsBus` shape.
// The shim keeps Electron's renderer-forwarding path working without
// editing electron/ipc/index.ts during the 13.4.1 flip.

describe("ModuleHostClient", () => {
  const noopClient = {} as unknown as IpcClient;
  const noopId = (): string => "id";

  it("implements AdapterSink<ModuleHostEventKind>", () => {
    const sink: AdapterSink<ModuleHostEventKind> = new ModuleHostClient(
      noopClient,
      noopId,
    );
    expect(typeof sink.dispatch).toBe("function");
    expect(typeof sink.notifyDisconnected).toBe("function");
  });

  it("emits 'modules-event' with state=to when to==='active'", () => {
    const host = new ModuleHostClient(noopClient, noopId);
    const moduleEvent = vi.fn();
    host.on("modules-event", moduleEvent);

    host.dispatch("modules/state-changed", {
      moduleId: "x",
      scopeUnit: "u",
      from: "inactive",
      to: "active",
    });

    expect(moduleEvent).toHaveBeenCalledWith({
      kind: "state-changed",
      moduleId: "x",
      scopeUnit: "u",
      state: "active",
    });
  });

  it("suppresses 'modules-event' for internal transitions", () => {
    // Matches the pre-13.4 registerModulesIpc filter — renderer only
    // cares about transitions touching `active`. Internal state-machine
    // ticks (e.g. `starting → running`) should not wake the renderer.
    const host = new ModuleHostClient(noopClient, noopId);
    const moduleEvent = vi.fn();
    host.on("modules-event", moduleEvent);

    host.dispatch("modules/state-changed", {
      moduleId: "x",
      scopeUnit: "u",
      from: "starting",
      to: "running",
    });

    expect(moduleEvent).not.toHaveBeenCalled();
  });

  it("emits 'modules-event' on modules/crashed", () => {
    const host = new ModuleHostClient(noopClient, noopId);
    const moduleEvent = vi.fn();
    host.on("modules-event", moduleEvent);

    host.dispatch("modules/crashed", {
      moduleId: "x",
      scopeUnit: "u",
      reason: "OOM",
    });

    expect(moduleEvent).toHaveBeenCalledWith({
      kind: "crashed",
      moduleId: "x",
      scopeUnit: "u",
      reason: "OOM",
    });
  });

  it("emits 'modules-event' on modules/failed", () => {
    const host = new ModuleHostClient(noopClient, noopId);
    const moduleEvent = vi.fn();
    host.on("modules-event", moduleEvent);

    host.dispatch("modules/failed", {
      moduleId: "x",
      scopeUnit: "u",
      reason: "manifest rejected",
    });

    expect(moduleEvent).toHaveBeenCalledWith({
      kind: "failed",
      moduleId: "x",
      scopeUnit: "u",
      reason: "manifest rejected",
    });
  });

  it("drops malformed state-changed payloads loudly instead of emitting undefined fields", () => {
    const host = new ModuleHostClient(noopClient, noopId);
    const moduleEvent = vi.fn();
    host.on("modules-event", moduleEvent);

    // Missing `to` — the renderer filter + downstream consumers
    // would see `state: undefined`. Guard drops it.
    host.dispatch("modules/state-changed", {
      moduleId: "x",
      scopeUnit: "u",
      from: "inactive",
    } as unknown);

    expect(moduleEvent).not.toHaveBeenCalled();
  });

  it("drops malformed crashed/failed payloads with missing reason", () => {
    const host = new ModuleHostClient(noopClient, noopId);
    const moduleEvent = vi.fn();
    host.on("modules-event", moduleEvent);

    host.dispatch("modules/crashed", {
      moduleId: "x",
      scopeUnit: "u",
    } as unknown);
    host.dispatch("modules/failed", {
      moduleId: "x",
      scopeUnit: "u",
    } as unknown);

    expect(moduleEvent).not.toHaveBeenCalled();
  });

  it("re-emits as 'disconnected' via notifyDisconnected", () => {
    const host = new ModuleHostClient(noopClient, noopId);
    const listener = vi.fn();
    host.on("disconnected", listener);
    host.notifyDisconnected(new Error("gone"));
    expect(listener).toHaveBeenCalledWith(new Error("gone"));
  });
});
