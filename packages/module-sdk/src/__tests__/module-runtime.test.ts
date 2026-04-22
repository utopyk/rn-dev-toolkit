import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import {
  runModule,
  SDK_VERSION,
  type ModuleManifest,
  type ModuleToolContext,
} from "../index.js";

// ---------------------------------------------------------------------------
// Harness — instantiates `runModule` on one end of a PassThrough pair and
// returns a client-side `MessageConnection` so tests can send requests.
// ---------------------------------------------------------------------------

function harness(manifestOverrides: Partial<ModuleManifest> = {}): {
  manifest: ModuleManifest;
  clientConnect: () => MessageConnection;
  moduleInput: PassThrough;
  moduleOutput: PassThrough;
} {
  const manifest: ModuleManifest = {
    id: "sample",
    version: "0.1.0",
    hostRange: ">=0.1.0",
    scope: "per-worktree",
    contributes: {
      mcp: {
        tools: [
          {
            name: "sample__ping",
            description: "ping",
            inputSchema: {},
          },
        ],
      },
    },
    ...manifestOverrides,
  };

  // Module subprocess reads from moduleInput, writes to moduleOutput.
  // Client side: writes to moduleInput, reads from moduleOutput.
  const moduleInput = new PassThrough();
  const moduleOutput = new PassThrough();

  return {
    manifest,
    moduleInput,
    moduleOutput,
    clientConnect: () => {
      const reader = new StreamMessageReader(moduleOutput);
      const writer = new StreamMessageWriter(moduleInput);
      const conn = createMessageConnection(reader, writer);
      conn.listen();
      return conn;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runModule", () => {
  it("responds to `initialize` with { moduleId, toolCount, sdkVersion }", async () => {
    const h = harness();
    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": () => ({ pong: true }),
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      const result = await client.sendRequest<unknown, {
        moduleId: string;
        toolCount: number;
        sdkVersion: string;
      }>("initialize", { capabilities: [], hostVersion: "0.9.0" });

      expect(result.moduleId).toBe("sample");
      expect(result.toolCount).toBe(1);
      expect(result.sdkVersion).toBe(SDK_VERSION);
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("routes tool/<bare> requests to tools[<moduleId>__<bare>]", async () => {
    const h = harness();
    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (args) => ({ echoed: args }),
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "0.9.0",
      });
      const result = await client.sendRequest<
        unknown,
        { echoed: Record<string, unknown> }
      >("tool/ping", { hello: "world" });
      expect(result.echoed).toEqual({ hello: "world" });
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("passes ctx { log, appInfo, hostVersion, sdkVersion } to handlers", async () => {
    const h = harness();
    let seen: ModuleToolContext | null = null;

    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          seen = ctx;
          return { ok: true };
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [
          { id: "log" },
          { id: "artifacts", requiredPermission: "fs:artifacts" },
        ],
        hostVersion: "1.2.3",
      });
      await client.sendRequest("tool/ping", {});

      expect(seen).not.toBeNull();
      expect(seen!.hostVersion).toBe("1.2.3");
      expect(seen!.sdkVersion).toBe(SDK_VERSION);
      expect(seen!.appInfo.capabilities).toEqual([
        { id: "log", requiredPermission: undefined },
        { id: "artifacts", requiredPermission: "fs:artifacts" },
      ]);
      expect(typeof seen!.log.info).toBe("function");
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("invokes activate() after initialize resolves", async () => {
    const h = harness();
    const activationLog: string[] = [];

    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": () => ({}),
      },
      activate: (ctx) => {
        activationLog.push(`activated:${ctx.hostVersion}`);
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "0.1.0",
      });
      expect(activationLog).toEqual(["activated:0.1.0"]);
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("runs deactivate() during dispose()", async () => {
    const h = harness();
    let deactivated = false;

    const handle = runModule({
      manifest: h.manifest,
      tools: { "sample__ping": () => ({}) },
      deactivate: () => {
        deactivated = true;
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    await client.sendRequest("initialize", {
      capabilities: [],
      hostVersion: "0.1.0",
    });
    client.dispose();
    await handle.dispose();

    expect(deactivated).toBe(true);
  });

  it("emits `log` notifications via ctx.log", async () => {
    const h = harness();
    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          ctx.log.info("hello", { n: 42 });
          return { ok: true };
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    const seenLogs: Array<{ level: string; message: string }> = [];
    client.onNotification("log", (params: unknown) => {
      const p = params as { level?: string; message?: string };
      seenLogs.push({ level: p?.level ?? "", message: p?.message ?? "" });
    });

    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "0.1.0",
      });
      await client.sendRequest("tool/ping", {});
      // Notifications flow async; give the reader a tick.
      await new Promise((r) => setTimeout(r, 20));
      expect(seenLogs.some((l) => l.level === "info" && l.message === "hello")).toBe(
        true,
      );
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("merges onInitialize extras into the initialize response", async () => {
    const h = harness();
    const handle = runModule({
      manifest: h.manifest,
      tools: { "sample__ping": () => ({}) },
      onInitialize: (appInfo) => ({
        capabilityCount: appInfo.capabilities.length,
        customField: "hello",
      }),
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      const result = await client.sendRequest<
        unknown,
        {
          moduleId: string;
          sdkVersion: string;
          capabilityCount: number;
          customField: string;
        }
      >("initialize", {
        capabilities: [{ id: "log" }, { id: "artifacts" }],
        hostVersion: "0.1.0",
      });

      expect(result.moduleId).toBe("sample");
      expect(result.sdkVersion).toBe(SDK_VERSION);
      expect(result.capabilityCount).toBe(2);
      expect(result.customField).toBe("hello");
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("exposes the raw connection via onConnection for custom RPC handlers", async () => {
    const h = harness();
    const handle = runModule({
      manifest: h.manifest,
      tools: { "sample__ping": () => ({}) },
      onConnection: (conn) => {
        conn.onRequest("legacy-method", (params) => ({
          legacy: true,
          received: params,
        }));
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "0.1.0",
      });
      const result = await client.sendRequest<
        unknown,
        { legacy: boolean; received: unknown }
      >("legacy-method", { hi: 1 });
      expect(result.legacy).toBe(true);
      expect(result.received).toEqual({ hi: 1 });
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("ctx.host.capability('log') returns the local logger (no RPC round-trip)", async () => {
    const h = harness();
    let seen: unknown = null;

    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          seen = ctx.host.capability<{ info: Function }>("log");
          return { ok: true };
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "0.1.0",
      });
      await client.sendRequest("tool/ping", {});
      expect(seen).not.toBeNull();
      expect(typeof (seen as { info: unknown }).info).toBe("function");
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("ctx.host.capability('appInfo') synthesizes locally with hostVersion + platform", async () => {
    const h = harness();
    let seen: unknown = null;
    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          seen = ctx.host.capability<{
            hostVersion: string;
            platform: NodeJS.Platform;
            worktreeKey: string | null;
          }>("appInfo");
          return { ok: true };
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "1.2.3",
      });
      await client.sendRequest("tool/ping", {});
      expect(seen).toEqual({
        hostVersion: "1.2.3",
        platform: process.platform,
        worktreeKey: null,
      });
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("ctx.host.capability(unknownId) returns null", async () => {
    const h = harness();
    let seen: unknown = "not-set";
    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          seen = ctx.host.capability("nonexistent");
          return { ok: true };
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [{ id: "log" }],
        hostVersion: "0.1.0",
      });
      await client.sendRequest("tool/ping", {});
      expect(seen).toBeNull();
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("ctx.host.capability returns null when manifest lacks the required permission", async () => {
    const h = harness({ permissions: [] });
    let seen: unknown = "not-set";
    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          seen = ctx.host.capability("artifacts");
          return { ok: true };
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [
          { id: "artifacts", requiredPermission: "fs:artifacts" },
        ],
        hostVersion: "0.1.0",
      });
      await client.sendRequest("tool/ping", {});
      expect(seen).toBeNull();
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("ctx.host.capability returns a Proxy that dispatches method calls as host/call RPC", async () => {
    const h = harness({ permissions: ["fs:artifacts"] });
    const hostCallsReceived: Array<{
      capabilityId: string;
      method: string;
      args: unknown[];
    }> = [];

    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": async (_args, ctx) => {
          const artifacts = ctx.host.capability<{
            save: (name: string, bytes: Uint8Array) => Promise<string>;
          }>("artifacts");
          if (!artifacts) return { ok: false };
          const result = await artifacts.save(
            "report.log",
            new Uint8Array([1, 2, 3]),
          );
          return { ok: true, result };
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    client.onRequest("host/call", (params: unknown) => {
      const p = params as {
        capabilityId: string;
        method: string;
        args: unknown[];
      };
      hostCallsReceived.push(p);
      return "/path/to/report.log";
    });

    try {
      await client.sendRequest("initialize", {
        capabilities: [
          { id: "artifacts", requiredPermission: "fs:artifacts" },
        ],
        hostVersion: "0.1.0",
      });
      const result = await client.sendRequest<
        unknown,
        { ok: boolean; result: string }
      >("tool/ping", {});
      expect(result).toEqual({ ok: true, result: "/path/to/report.log" });
      expect(hostCallsReceived).toHaveLength(1);
      expect(hostCallsReceived[0].capabilityId).toBe("artifacts");
      expect(hostCallsReceived[0].method).toBe("save");
      expect(hostCallsReceived[0].args[0]).toBe("report.log");
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("supports built-in-style unprefixed tool keys", async () => {
    const manifest: ModuleManifest = {
      id: "built-in",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "global",
      contributes: {
        mcp: {
          tools: [
            {
              name: "my-flat-tool",
              description: "built-in",
              inputSchema: {},
            },
          ],
        },
      },
    };
    const moduleInput = new PassThrough();
    const moduleOutput = new PassThrough();

    const handle = runModule({
      manifest,
      tools: {
        "my-flat-tool": () => ({ flat: true }),
      },
      input: moduleInput,
      output: moduleOutput,
    });

    const reader = new StreamMessageReader(moduleOutput);
    const writer = new StreamMessageWriter(moduleInput);
    const client = createMessageConnection(reader, writer);
    client.listen();

    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "0.1.0",
      });
      const result = await client.sendRequest<unknown, { flat: boolean }>(
        "tool/my-flat-tool",
        {},
      );
      expect(result.flat).toBe(true);
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  // -------------------------------------------------------------------------
  // Phase 5a — per-module config surface.
  // -------------------------------------------------------------------------

  it("initialize propagates params.config into ctx.config + appInfo.config", async () => {
    const h = harness();
    let seen: ModuleToolContext | null = null;

    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          seen = ctx;
          return { ok: true };
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "1.0.0",
        config: { greeting: "hello", loud: true },
      });
      await client.sendRequest("tool/ping", {});

      expect(seen).not.toBeNull();
      expect(seen!.config).toEqual({ greeting: "hello", loud: true });
      expect(seen!.appInfo.config).toEqual({ greeting: "hello", loud: true });
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("config/changed notification replaces ctx.config + fires onConfigChanged", async () => {
    const h = harness();
    const observed: Array<Record<string, unknown>> = [];
    let ctxRef: ModuleToolContext | null = null;

    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          ctxRef = ctx;
          return { config: ctx.config };
        },
      },
      onConfigChanged: (config) => {
        observed.push(config);
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "1.0.0",
        config: { v: 1 },
      });
      await client.sendRequest("tool/ping", {});
      expect(ctxRef!.config).toEqual({ v: 1 });

      client.sendNotification("config/changed", { v: 2 });

      // Round-trip a tool call so the reader drains the pending notification
      // first — vscode-jsonrpc processes inbound messages in order, so by the
      // time the reply lands the notification handler has definitely run.
      const follow = await client.sendRequest<unknown, {
        config: Record<string, unknown>;
      }>("tool/ping", {});
      expect(follow.config).toEqual({ v: 2 });
      expect(observed).toEqual([{ v: 2 }]);
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("initialize defaults config to {} when params.config is missing", async () => {
    const h = harness();
    let seen: ModuleToolContext | null = null;

    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          seen = ctx;
          return {};
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "1.0.0",
      });
      await client.sendRequest("tool/ping", {});
      expect(seen!.config).toEqual({});
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("ctx.config is a live getter — destructured aliases stay stale but ctx reads see updates", async () => {
    const h = harness();
    // `capturedCtx` is the same reference across the two tool calls;
    // the test reads `ctx.config` via the reference both times.
    let capturedCtx: ModuleToolContext | null = null;

    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => {
          capturedCtx = ctx;
          return { config: ctx.config, appInfoConfig: ctx.appInfo.config };
        },
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      await client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "1.0.0",
        config: { v: 1 },
      });
      await client.sendRequest("tool/ping", {});
      expect(capturedCtx!.config).toEqual({ v: 1 });

      client.sendNotification("config/changed", { v: 2 });

      // Second tool call — same ctx reference; config getter sees the
      // replacement without needing to re-enter a handler.
      const followup = await client.sendRequest<unknown, {
        config: Record<string, unknown>;
        appInfoConfig: Record<string, unknown>;
      }>("tool/ping", {});
      expect(followup.config).toEqual({ v: 2 });
      expect(followup.appInfoConfig).toEqual({ v: 2 });
      // Reading through the outer reference — same value, live.
      expect(capturedCtx!.config).toEqual({ v: 2 });
      expect(capturedCtx!.appInfo.config).toEqual({ v: 2 });
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });

  it("config/changed arriving before initialize is buffered + flushed after activate", async () => {
    const h = harness();
    const observed: Array<Record<string, unknown>> = [];
    // Gate `activate` on a manually-controlled promise so the test can
    // deterministically interleave: initialize sent → config/changed
    // arrives → activate resolves → callback fires.
    let releaseActivate: () => void = () => {};
    const activateGate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });

    const handle = runModule({
      manifest: h.manifest,
      tools: {
        "sample__ping": (_args, ctx) => ({ config: ctx.config }),
      },
      activate: async () => {
        await activateGate;
      },
      onConfigChanged: (config) => {
        observed.push(config);
      },
      input: h.moduleInput,
      output: h.moduleOutput,
    });

    const client = h.clientConnect();
    try {
      // Don't await — initialize stays pending inside activate.
      const initPromise = client.sendRequest("initialize", {
        capabilities: [],
        hostVersion: "1.0.0",
        config: { v: 1 },
      });
      // Give the module a chance to process initialize + enter activate.
      await new Promise((r) => setImmediate(r));
      // Now fire a config/changed while activate is still pending.
      client.sendNotification("config/changed", { v: 9 });
      // Allow the notification to cross the stream before we release
      // activate — this asserts it lands in the pending buffer, not the
      // post-init path.
      await new Promise((r) => setImmediate(r));
      expect(observed).toEqual([]); // not flushed yet

      releaseActivate();
      await initPromise;

      // Force a round-trip so any queued async work resolves.
      const result = await client.sendRequest<unknown, {
        config: Record<string, unknown>;
      }>("tool/ping", {});
      expect(result.config).toEqual({ v: 9 });
      expect(observed).toEqual([{ v: 9 }]);
    } finally {
      client.dispose();
      await handle.dispose();
    }
  });
});
