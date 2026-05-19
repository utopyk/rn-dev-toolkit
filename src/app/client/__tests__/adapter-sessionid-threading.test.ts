import { describe, it, expect, vi } from "vitest";
import { BuilderClient } from "../builder-adapter.js";
import { MetroClient } from "../metro-adapter.js";
import { DevToolsClient } from "../devtools-adapter.js";
import { WatcherClient } from "../watcher-adapter.js";
import type { IpcMessage } from "../../../core/ipc.js";
import type { IpcSender } from "../session.js";

// Phase E wire-contract follow-on — under N>1 sessions the daemon's
// `resolveSessionServices` rejects RPCs with `E_SESSION_AMBIGUOUS` when
// `payload.sessionId` is missing (the back-compat "use the only session"
// fallback only kicks in when sessions.size === 1). Every per-session
// adapter must stamp sessionId on its outgoing RPCs.
//
// Sister tests live alongside `module-host-adapter.test.ts` which covers
// the same wire-contract for `modules/call`, `modules/host-call`, and
// `modules/bind-sender`.

function makeStub(): { client: IpcSender; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return {
    client: { send } as unknown as IpcSender,
    send,
  };
}

describe("BuilderClient — sessionId wire-contract parity (Phase E)", () => {
  it("build(): payload includes sessionId when getSessionId returns one", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "builder/build",
      id: "id-0",
      payload: {},
    } satisfies IpcMessage);
    const builder = new BuilderClient(client, () => "id-0", {
      getSessionId: () => "sess-builder" as never,
    });
    await builder.build({
      projectRoot: "/x",
      platform: "ios",
      port: 8081,
      variant: "debug",
      env: {},
    });
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "builder/build",
      id: "id-0",
      payload: {
        projectRoot: "/x",
        platform: "ios",
        port: 8081,
        variant: "debug",
        env: {},
        sessionId: "sess-builder",
      },
    });
  });

  it("build(): payload omits sessionId when getSessionId returns null (pre-ack)", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "builder/build",
      id: "id-1",
      payload: {},
    } satisfies IpcMessage);
    const builder = new BuilderClient(client, () => "id-1", {
      getSessionId: () => null,
    });
    await builder.build({
      projectRoot: "/x",
      platform: "android",
      port: 8082,
      variant: "debug",
      env: {},
    });
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "builder/build",
      id: "id-1",
      payload: {
        projectRoot: "/x",
        platform: "android",
        port: 8082,
        variant: "debug",
        env: {},
      },
    });
  });
});

describe("MetroClient — sessionId wire-contract parity (Phase E)", () => {
  it("reload(): payload includes sessionId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "metro/reload",
      id: "id-2",
      payload: { ok: true },
    } satisfies IpcMessage);
    const metro = new MetroClient(client, () => "id-2", () => "sess-metro" as never);
    await metro.reload();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "metro/reload",
      id: "id-2",
      payload: { sessionId: "sess-metro" },
    });
  });

  it("devMenu(): payload includes sessionId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "metro/devMenu",
      id: "id-3",
      payload: { ok: true },
    } satisfies IpcMessage);
    const metro = new MetroClient(client, () => "id-3", () => "sess-metro" as never);
    await metro.devMenu();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "metro/devMenu",
      id: "id-3",
      payload: { sessionId: "sess-metro" },
    });
  });

  it("getInstance(): payload includes sessionId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "metro/getInstance",
      id: "id-4",
      payload: { instance: null },
    } satisfies IpcMessage);
    const metro = new MetroClient(client, () => "id-4", () => "sess-metro" as never);
    await metro.getInstance();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "metro/getInstance",
      id: "id-4",
      payload: { sessionId: "sess-metro" },
    });
  });

  it("reload(): omits sessionId when getSessionId returns null", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "metro/reload",
      id: "id-5",
      payload: { ok: true },
    } satisfies IpcMessage);
    const metro = new MetroClient(client, () => "id-5", () => null);
    await metro.reload();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "metro/reload",
      id: "id-5",
      payload: undefined,
    });
  });
});

describe("DevToolsClient — sessionId wire-contract parity (Phase E)", () => {
  it("status(): payload includes sessionId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "devtools/status",
      id: "id-6",
      payload: {},
    } satisfies IpcMessage);
    const dt = new DevToolsClient(client, () => "id-6", () => "sess-dt" as never);
    await dt.status();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "devtools/status",
      id: "id-6",
      payload: { sessionId: "sess-dt" },
    });
  });

  it("restart(): payload includes sessionId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "devtools/restart",
      id: "id-7",
      payload: { proxyPort: 1234, sessionNonce: "abc" },
    } satisfies IpcMessage);
    const dt = new DevToolsClient(client, () => "id-7", () => "sess-dt" as never);
    await dt.restart();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "devtools/restart",
      id: "id-7",
      payload: { sessionId: "sess-dt" },
    });
  });

  it("selectTarget(): payload includes sessionId + targetId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "devtools/selectTarget",
      id: "id-8",
      payload: { ok: true },
    } satisfies IpcMessage);
    const dt = new DevToolsClient(client, () => "id-8", () => "sess-dt" as never);
    await dt.selectTarget("target-1");
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "devtools/selectTarget",
      id: "id-8",
      payload: { targetId: "target-1", sessionId: "sess-dt" },
    });
  });

  it("listNetwork(): payload includes sessionId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "devtools/listNetwork",
      id: "id-9",
      payload: { entries: [], total: 0, nextCursor: null },
    } satisfies IpcMessage);
    const dt = new DevToolsClient(client, () => "id-9", () => "sess-dt" as never);
    await dt.listNetwork();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "devtools/listNetwork",
      id: "id-9",
      payload: { sessionId: "sess-dt" },
    });
  });
});

describe("WatcherClient — sessionId wire-contract parity (Phase E)", () => {
  it("start(): payload includes sessionId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "watcher/start",
      id: "id-10",
      payload: {},
    } satisfies IpcMessage);
    const w = new WatcherClient(client, () => "id-10", () => "sess-w" as never);
    await w.start();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "watcher/start",
      id: "id-10",
      payload: { sessionId: "sess-w" },
    });
  });

  it("stop(): payload includes sessionId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "watcher/stop",
      id: "id-11",
      payload: {},
    } satisfies IpcMessage);
    const w = new WatcherClient(client, () => "id-11", () => "sess-w" as never);
    await w.stop();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "watcher/stop",
      id: "id-11",
      payload: { sessionId: "sess-w" },
    });
  });

  it("isRunning(): payload includes sessionId", async () => {
    const { client, send } = makeStub();
    send.mockResolvedValueOnce({
      type: "response",
      action: "watcher/isRunning",
      id: "id-12",
      payload: { running: false },
    } satisfies IpcMessage);
    const w = new WatcherClient(client, () => "id-12", () => "sess-w" as never);
    await w.isRunning();
    expect(send).toHaveBeenCalledWith({
      type: "command",
      action: "watcher/isRunning",
      id: "id-12",
      payload: { sessionId: "sess-w" },
    });
  });
});
