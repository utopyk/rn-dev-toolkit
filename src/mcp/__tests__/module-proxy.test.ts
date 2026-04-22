import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverModuleContributedTools } from "../module-proxy.js";
import type { McpContext, McpFlags, ToolResult } from "../tools.js";
import type { IpcMessage } from "../../core/ipc.js";

// ---------------------------------------------------------------------------
// Fake IpcClient — controllable per-test
// ---------------------------------------------------------------------------

function makeIpcClient(options: {
  modulesListPayload?: unknown;
  callPayload?: unknown;
  rejectList?: boolean;
  rejectCall?: boolean;
}): McpContext["ipcClient"] {
  const sendSpy = vi.fn(async (msg: IpcMessage) => {
    if (msg.action === "modules/list") {
      if (options.rejectList) throw new Error("unreachable");
      return {
        id: msg.id,
        type: "response",
        action: msg.action,
        payload: options.modulesListPayload,
      } satisfies IpcMessage;
    }
    if (msg.action === "modules/call") {
      if (options.rejectCall) throw new Error("boom");
      return {
        id: msg.id,
        type: "response",
        action: msg.action,
        payload: options.callPayload,
      } satisfies IpcMessage;
    }
    throw new Error(`unexpected action ${msg.action}`);
  });
  return {
    send: sendSpy,
    isServerRunning: vi.fn(async () => true),
  } as unknown as McpContext["ipcClient"];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(
  ipcClient: McpContext["ipcClient"] | null,
): McpContext {
  return {
    projectRoot: "/tmp/fake",
    profileStore: {} as McpContext["profileStore"],
    artifactStore: {} as McpContext["artifactStore"],
    metro: null,
    preflightEngine: {} as McpContext["preflightEngine"],
    ipcClient,
  };
}

function makeFlags(
  overrides: Partial<McpFlags> = {},
): McpFlags {
  return {
    enableDevtoolsMcp: false,
    mcpCaptureBodies: false,
    enabledModules: new Set<string>(),
    disabledModules: new Set<string>(),
    allowDestructiveTools: false,
    ...overrides,
  };
}

const echoRow = {
  id: "echo",
  version: "0.1.0",
  scope: "global",
  scopeUnit: "global",
  state: "inert",
  isBuiltIn: false,
  lastCrashReason: null,
  pid: null,
  tools: [
    {
      name: "echo__ping",
      description: "Ping the echo module.",
      inputSchema: {},
    },
    {
      name: "echo__destroy",
      description: "Irreversibly destroy something.",
      inputSchema: {},
      destructiveHint: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// discoverModuleContributedTools
// ---------------------------------------------------------------------------

describe("discoverModuleContributedTools — discovery", () => {
  it("returns [] when no ipcClient is attached (headless mode)", async () => {
    const tools = await discoverModuleContributedTools(
      makeCtx(null),
      makeFlags(),
    );
    expect(tools).toEqual([]);
  });

  it("returns [] when the daemon doesn't answer modules/list", async () => {
    const ipc = makeIpcClient({ rejectList: true });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags(),
    );
    expect(tools).toEqual([]);
  });

  it("returns one ToolDefinition per manifest tool", async () => {
    const ipc = makeIpcClient({
      modulesListPayload: { modules: [echoRow] },
    });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags(),
    );
    expect(tools.map((t) => t.name)).toEqual(["echo__ping", "echo__destroy"]);
  });

  it("filters modules out via disabledModules", async () => {
    const ipc = makeIpcClient({
      modulesListPayload: { modules: [echoRow] },
    });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags({ disabledModules: new Set(["echo"]) }),
    );
    expect(tools).toEqual([]);
  });

  it("when enabledModules is non-empty, only those ids surface", async () => {
    const other = { ...echoRow, id: "other", tools: echoRow.tools.map((t) => ({ ...t, name: t.name.replace("echo__", "other__") })) };
    const ipc = makeIpcClient({
      modulesListPayload: { modules: [echoRow, other] },
    });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags({ enabledModules: new Set(["other"]) }),
    );
    expect(tools.map((t) => t.name)).toEqual(["other__ping", "other__destroy"]);
  });
});

// ---------------------------------------------------------------------------
// Proxied handler behavior
// ---------------------------------------------------------------------------

describe("discoverModuleContributedTools — handler invocation", () => {
  it("proxies call result to structuredContent on success", async () => {
    const ipc = makeIpcClient({
      modulesListPayload: { modules: [echoRow] },
      callPayload: { kind: "ok", result: { pong: true, echoed: { a: 1 } } },
    });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags(),
    );
    const ping = tools.find((t) => t.name === "echo__ping");
    if (!ping) throw new Error("ping tool missing");
    const out = (await ping.handler({ a: 1 })) as ToolResult;
    expect(out.structuredContent).toEqual({ pong: true, echoed: { a: 1 } });
    expect(out.isError).toBeUndefined();
  });

  it("surfaces modules/call errors as isError with the code in structuredContent", async () => {
    const ipc = makeIpcClient({
      modulesListPayload: { modules: [echoRow] },
      callPayload: {
        kind: "error",
        code: "E_MODULE_CALL_FAILED",
        message: "subprocess refused",
      },
    });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags(),
    );
    const ping = tools.find((t) => t.name === "echo__ping")!;
    const out = (await ping.handler({})) as ToolResult;
    expect(out.isError).toBe(true);
    expect(out.structuredContent?.code).toBe("E_MODULE_CALL_FAILED");
  });
});

// ---------------------------------------------------------------------------
// destructiveHint gating
// ---------------------------------------------------------------------------

describe("discoverModuleContributedTools — destructiveHint gate", () => {
  it("rejects without confirmation when neither flag nor permissionsAccepted is present", async () => {
    const ipc = makeIpcClient({
      modulesListPayload: { modules: [echoRow] },
      callPayload: { kind: "ok", result: {} },
    });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags(),
    );
    const destroy = tools.find((t) => t.name === "echo__destroy")!;
    const out = (await destroy.handler({})) as ToolResult;
    expect(out.isError).toBe(true);
    expect(out.structuredContent?.code).toBe("E_DESTRUCTIVE_REQUIRES_CONFIRM");
  });

  it("allows the call when --allow-destructive-tools is set", async () => {
    const ipc = makeIpcClient({
      modulesListPayload: { modules: [echoRow] },
      callPayload: { kind: "ok", result: { deleted: true } },
    });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags({ allowDestructiveTools: true }),
    );
    const destroy = tools.find((t) => t.name === "echo__destroy")!;
    const out = (await destroy.handler({})) as ToolResult;
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({ deleted: true });
  });

  it("allows the call when permissionsAccepted contains the tool name", async () => {
    const ipc = makeIpcClient({
      modulesListPayload: { modules: [echoRow] },
      callPayload: { kind: "ok", result: { deleted: true } },
    });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags(),
    );
    const destroy = tools.find((t) => t.name === "echo__destroy")!;
    const out = (await destroy.handler({
      permissionsAccepted: ["echo__destroy"],
    })) as ToolResult;
    expect(out.isError).toBeUndefined();
  });

  it("strips permissionsAccepted from the args sent to the subprocess", async () => {
    const sentCalls: IpcMessage[] = [];
    const ipc = {
      send: vi.fn(async (msg: IpcMessage) => {
        sentCalls.push(msg);
        if (msg.action === "modules/list") {
          return {
            id: msg.id,
            type: "response",
            action: msg.action,
            payload: { modules: [echoRow] },
          };
        }
        return {
          id: msg.id,
          type: "response",
          action: msg.action,
          payload: { kind: "ok", result: {} },
        };
      }),
      isServerRunning: vi.fn(async () => true),
    } as unknown as McpContext["ipcClient"];

    const tools = await discoverModuleContributedTools(makeCtx(ipc), makeFlags());
    const destroy = tools.find((t) => t.name === "echo__destroy")!;
    await destroy.handler({
      permissionsAccepted: ["echo__destroy"],
      targetPath: "/tmp/x",
    });

    const callMsg = sentCalls.find((m) => m.action === "modules/call");
    const args = (callMsg?.payload as { args: Record<string, unknown> }).args;
    expect(args).toEqual({ targetPath: "/tmp/x" });
    expect("permissionsAccepted" in args).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Description decoration
// ---------------------------------------------------------------------------

describe("discoverModuleContributedTools — description decoration", () => {
  it("appends the untrusted-input warning to every tool description", async () => {
    const ipc = makeIpcClient({ modulesListPayload: { modules: [echoRow] } });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags(),
    );
    for (const tool of tools) {
      expect(tool.description).toMatch(/untrusted data/i);
    }
  });

  it("prepends a [destructive] marker to destructive tool descriptions", async () => {
    const ipc = makeIpcClient({ modulesListPayload: { modules: [echoRow] } });
    const tools = await discoverModuleContributedTools(
      makeCtx(ipc),
      makeFlags(),
    );
    const destroy = tools.find((t) => t.name === "echo__destroy")!;
    expect(destroy.description).toMatch(/\[destructive\]/);
  });
});
