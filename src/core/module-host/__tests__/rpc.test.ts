import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { ModuleRpc, performInitialize } from "../rpc.js";

// ---------------------------------------------------------------------------
// Harness: an in-process host/module pair over PassThrough streams.
// ---------------------------------------------------------------------------

interface Pair {
  host: ModuleRpc;
  module: ModuleRpc;
  teardown: () => void;
}

function pair(): Pair {
  const hostToModule = new PassThrough();
  const moduleToHost = new PassThrough();

  const host = new ModuleRpc({
    readable: moduleToHost,
    writable: hostToModule,
  });
  const module = new ModuleRpc({
    readable: hostToModule,
    writable: moduleToHost,
  });

  host.listen();
  module.listen();

  return {
    host,
    module,
    teardown: () => {
      host.dispose();
      module.dispose();
      hostToModule.destroy();
      moduleToHost.destroy();
    },
  };
}

let active: Pair | null = null;

afterEach(() => {
  active?.teardown();
  active = null;
});

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

describe("ModuleRpc — request/response round-trip", () => {
  it("sends a request and receives a response", async () => {
    active = pair();
    active.module.onRequest<{ n: number }, { doubled: number }>(
      "math/double",
      (params) => ({ doubled: params.n * 2 }),
    );

    const result = await active.host.sendRequest<
      { n: number },
      { doubled: number }
    >("math/double", { n: 21 });
    expect(result).toEqual({ doubled: 42 });
  });

  it("propagates handler throws as rejected request promises", async () => {
    active = pair();
    active.module.onRequest("broken", () => {
      throw new Error("boom");
    });
    await expect(
      active.host.sendRequest("broken", {}),
    ).rejects.toThrow(/boom/);
  });

  it("supports async request handlers", async () => {
    active = pair();
    active.module.onRequest<{ ms: number }, { ok: true }>(
      "wait",
      async (params) => {
        await new Promise((r) => setTimeout(r, params.ms));
        return { ok: true };
      },
    );
    const result = await active.host.sendRequest("wait", { ms: 5 });
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe("ModuleRpc — notifications", () => {
  it("delivers a notification to the registered handler", async () => {
    active = pair();
    const received = new Promise<unknown>((resolve) => {
      active!.module.onNotification("telemetry", (params) => resolve(params));
    });

    active.host.sendNotification("telemetry", { event: "spawn" });
    const payload = await Promise.race([
      received,
      new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 200)),
    ]);
    expect(payload).toEqual({ event: "spawn" });
  });
});

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("ModuleRpc — dispose", () => {
  it("dispose() stops processing requests on the disposed side", async () => {
    active = pair();
    active.module.onRequest("echo", (p) => p);
    active.module.dispose();

    // After the module side is disposed, the host's request never gets a
    // response. Give it a short window and assert no resolve/reject.
    const result = active.host.sendRequest("echo", { hi: 1 });
    const settled = await Promise.race([
      result.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(settled).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// performInitialize (handshake helper)
// ---------------------------------------------------------------------------

describe("performInitialize — host-driven handshake", () => {
  it("sends 'initialize' and resolves with the module's 'initialized' payload", async () => {
    active = pair();
    active.module.onRequest<
      {
        capabilities: Array<{ id: string; requiredPermission?: string }>;
        hostVersion: string;
      },
      { moduleId: string; toolCount: number }
    >("initialize", (params) => {
      return {
        moduleId: "fixture",
        toolCount: 1,
        _echoedCaps: params.capabilities.length,
      } as { moduleId: string; toolCount: number };
    });

    const result = await performInitialize(active.host, {
      capabilities: [{ id: "log" }, { id: "appInfo" }],
      hostVersion: "0.1.0",
      config: {},
      timeoutMs: 1000,
    });
    expect(result.moduleId).toBe("fixture");
  });

  it("rejects with MODULE_ACTIVATION_TIMEOUT-shaped error when the module does not respond in time", async () => {
    active = pair();
    // Register an initialize handler that never resolves so we actually
    // exercise the timeout path (not vscode-jsonrpc's "Unhandled method").
    active.module.onRequest("initialize", () => {
      return new Promise(() => {
        /* never resolves */
      });
    });
    await expect(
      performInitialize(active.host, {
        capabilities: [],
        hostVersion: "0.1.0",
        config: {},
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timeout|activation/i);
  });
});
