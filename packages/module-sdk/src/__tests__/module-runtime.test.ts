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
});
