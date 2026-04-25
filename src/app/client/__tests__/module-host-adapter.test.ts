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
    // Phase 13.6 PR-C — constructor split: (sender, rawClient, nextId).
    // The tests here only exercise dispatch/notifyDisconnected, so passing
    // noopClient for both sender and rawClient is sufficient.
    const sink: AdapterSink<ModuleHostEventKind> = new ModuleHostClient(
      noopClient,
      noopClient,
      noopId,
    );
    expect(typeof sink.dispatch).toBe("function");
    expect(typeof sink.notifyDisconnected).toBe("function");
  });

  it("emits 'modules-event' with state=to when to==='active'", () => {
    const host = new ModuleHostClient(noopClient, noopClient, noopId);
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
    const host = new ModuleHostClient(noopClient, noopClient, noopId);
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
    const host = new ModuleHostClient(noopClient, noopClient, noopId);
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
    const host = new ModuleHostClient(noopClient, noopClient, noopId);
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
    const host = new ModuleHostClient(noopClient, noopClient, noopId);
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
    const host = new ModuleHostClient(noopClient, noopClient, noopId);
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
    const host = new ModuleHostClient(noopClient, noopClient, noopId);
    const listener = vi.fn();
    host.on("disconnected", listener);
    host.notifyDisconnected(new Error("gone"));
    expect(listener).toHaveBeenCalledWith(new Error("gone"));
  });
});

// ---------------------------------------------------------------------------
// RPC methods — Phase 13.4.1. Each method is a thin wrapper that builds an
// IpcMessage, forwards it through the client, and returns the typed payload.
// The tests stub `client.send` and assert the wire shape + passthrough of
// daemon replies. Replies flowing back unchanged is the whole contract here;
// any error shaping happens at the caller.
// ---------------------------------------------------------------------------

function makeStubClient(): {
  client: IpcClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  // Phase 13.6 PR-C: `client` is passed as both `sender` (proxied IpcSender)
  // and `rawClient` (full IpcClient) in tests — these tests only exercise
  // RPC `.send()` calls, not `subscribeToEvents()`, so both roles use the same stub.
  return { client: { send } as unknown as IpcClient, send };
}

describe("ModuleHostClient — RPC methods", () => {
  it("list(): action=modules/list, no payload, passes through response", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/list",
      id: "id-0",
      payload: { modules: [{ id: "one", version: "1.0.0" }] },
    });
    const host = new ModuleHostClient(client, client, () => "id-0");
    const result = await host.list();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/list",
      id: "id-0",
    });
    expect(result.modules).toEqual([{ id: "one", version: "1.0.0" }]);
  });

  it("listPanels(): action=modules/list-panels, passes through response", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/list-panels",
      id: "id-1",
      payload: { modules: [{ moduleId: "m", title: "m", panels: [] }] },
    });
    const host = new ModuleHostClient(client, client, () => "id-1");
    const result = await host.listPanels();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/list-panels",
      id: "id-1",
    });
    expect(result.modules).toHaveLength(1);
  });

  it("resolvePanel(moduleId, panelId): action=modules/resolve-panel with correct payload", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/resolve-panel",
      id: "id-2",
      payload: {
        kind: "ok",
        moduleId: "m",
        moduleRoot: "/x/m",
        contribution: {
          id: "p",
          title: "P",
          webviewEntry: "./p.html",
          hostApi: [],
        },
      },
    });
    const host = new ModuleHostClient(client, client, () => "id-2");
    const result = await host.resolvePanel("m", "p");
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/resolve-panel",
      id: "id-2",
      payload: { moduleId: "m", panelId: "p" },
    });
    expect((result as { kind: string }).kind).toBe("ok");
  });

  it("call(payload): action=modules/call with payload", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/call",
      id: "id-3",
      payload: { kind: "ok", result: { pong: true } },
    });
    const host = new ModuleHostClient(client, client, () => "id-3");
    const result = await host.call({
      moduleId: "m",
      tool: "ping",
      args: { x: 1 },
    });
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/call",
      id: "id-3",
      payload: { moduleId: "m", tool: "ping", args: { x: 1 } },
    });
    expect((result as { kind: string }).kind).toBe("ok");
  });

  it("hostCall(payload): action=modules/host-call with payload", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/host-call",
      id: "id-4",
      payload: { kind: "ok", result: "echoed" },
    });
    const host = new ModuleHostClient(client, client, () => "id-4");
    const result = await host.hostCall({
      moduleId: "m",
      capabilityId: "log",
      method: "info",
      args: ["hello"],
    });
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/host-call",
      id: "id-4",
      payload: {
        moduleId: "m",
        capabilityId: "log",
        method: "info",
        args: ["hello"],
      },
    });
    expect((result as { kind: string }).kind).toBe("ok");
  });

  it("configGet(moduleId): omits scopeUnit when undefined", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/config/get",
      id: "id-5",
      payload: { moduleId: "m", config: { k: "v" } },
    });
    const host = new ModuleHostClient(client, client, () => "id-5");
    await host.configGet("m");
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/config/get",
      id: "id-5",
      payload: { moduleId: "m" },
    });
  });

  it("configGet(moduleId, scopeUnit): includes scopeUnit when passed", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/config/get",
      id: "id-6",
      payload: { moduleId: "m", config: {} },
    });
    const host = new ModuleHostClient(client, client, () => "id-6");
    await host.configGet("m", "wt-1");
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/config/get",
      id: "id-6",
      payload: { moduleId: "m", scopeUnit: "wt-1" },
    });
  });

  it("configSet(payload): action=modules/config/set, passes through response", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/config/set",
      id: "id-7",
      payload: { kind: "ok", config: { k: "v" } },
    });
    const host = new ModuleHostClient(client, client, () => "id-7");
    const result = await host.configSet({
      moduleId: "m",
      patch: { k: "v" },
    });
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/config/set",
      id: "id-7",
      payload: { moduleId: "m", patch: { k: "v" } },
    });
    expect(result.kind).toBe("ok");
  });

  it("install(payload): action=modules/install", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/install",
      id: "id-8",
      payload: {
        kind: "ok",
        moduleId: "m",
        version: "1.0.0",
        installPath: "/x/m",
        tarballSha256: "deadbeef",
      },
    });
    const host = new ModuleHostClient(client, client, () => "id-8");
    const result = await host.install({
      moduleId: "m",
      permissionsAccepted: [],
    });
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/install",
      id: "id-8",
      payload: { moduleId: "m", permissionsAccepted: [] },
    });
    expect((result as { kind: string }).kind).toBe("ok");
  });

  it("uninstall(payload): action=modules/uninstall", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/uninstall",
      id: "id-9",
      payload: { kind: "ok", moduleId: "m", removed: "/x/m", keptData: false },
    });
    const host = new ModuleHostClient(client, client, () => "id-9");
    const result = await host.uninstall({ moduleId: "m" });
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/uninstall",
      id: "id-9",
      payload: { moduleId: "m" },
    });
    expect((result as { kind: string }).kind).toBe("ok");
  });

  it("marketplaceList(): action=marketplace/list", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "marketplace/list",
      id: "id-10",
      payload: {
        kind: "ok",
        registrySha256: "abc",
        registryUrl: "https://example.com",
        entries: [],
      },
    });
    const host = new ModuleHostClient(client, client, () => "id-10");
    const result = await host.marketplaceList();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "marketplace/list",
      id: "id-10",
    });
    expect((result as { kind: string }).kind).toBe("ok");
  });

  it("marketplaceInfo(moduleId): action=marketplace/info", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "marketplace/info",
      id: "id-11",
      payload: { kind: "ok", entry: {}, installed: false, registrySha256: "abc" },
    });
    const host = new ModuleHostClient(client, client, () => "id-11");
    const result = await host.marketplaceInfo("m");
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "marketplace/info",
      id: "id-11",
      payload: { moduleId: "m" },
    });
    expect((result as { kind: string }).kind).toBe("ok");
  });

  // Phase 13.6 PR-C P0-2: bindSender issues modules/bind-sender over the
  // shared subscribe socket so host-call can share the same connectionId.
  it("bindSender(moduleId): action=modules/bind-sender with { moduleId }, resolves on ok", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/bind-sender",
      id: "id-12",
      payload: { kind: "ok" },
    });
    const host = new ModuleHostClient(client, client, () => "id-12");
    await expect(host.bindSender("my-module")).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "modules/bind-sender",
      id: "id-12",
      payload: { moduleId: "my-module" },
    });
  });

  it("bindSender(moduleId): rejects with error message when daemon returns error kind", async () => {
    const { client, send } = makeStubClient();
    send.mockResolvedValueOnce({
      type: "response",
      action: "modules/bind-sender",
      id: "id-13",
      payload: { kind: "error", code: "BIND_INVALID_PAYLOAD", message: "bad payload" },
    });
    const host = new ModuleHostClient(client, client, () => "id-13");
    await expect(host.bindSender("bad-module")).rejects.toThrow(
      "bindSender(bad-module): BIND_INVALID_PAYLOAD — bad payload",
    );
  });
});
