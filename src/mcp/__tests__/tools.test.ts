import { describe, it, expect, vi } from "vitest";
import { createToolDefinitions } from "../tools.js";
import type { McpContext } from "../tools.js";
import type { IpcMessage } from "../../core/ipc.js";

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

function makeMockContext(overrides: Partial<McpContext> = {}): McpContext {
  return {
    projectRoot: "/tmp/mock-project",
    profileStore: {
      list: vi.fn(() => []),
      load: vi.fn(() => null),
      save: vi.fn(),
      findDefault: vi.fn(() => null),
      findForWorktreeBranch: vi.fn(() => []),
      setDefault: vi.fn(),
      delete: vi.fn(() => false),
    } as unknown as McpContext["profileStore"],
    artifactStore: {
      load: vi.fn(() => null),
      save: vi.fn(),
      worktreeHash: vi.fn(() => "root"),
      list: vi.fn(() => []),
      remove: vi.fn(),
      hasChecksumChanged: vi.fn(() => true),
    } as unknown as McpContext["artifactStore"],
    metro: null,
    preflightEngine: {
      register: vi.fn(),
      getChecksForPlatform: vi.fn(() => []),
      filterByConfig: vi.fn(() => []),
      runAll: vi.fn(async () => new Map()),
      fix: vi.fn(async () => false),
    } as unknown as McpContext["preflightEngine"],
    ipcClient: null,
    ...overrides,
  };
}

function makeMockIpcClient(
  respond: (action: string, payload?: unknown) => unknown | Promise<unknown>
): McpContext["ipcClient"] {
  return {
    send: vi.fn(async (msg: IpcMessage) => {
      const payload = await respond(msg.action, msg.payload);
      return {
        type: "response",
        action: msg.action,
        id: msg.id,
        payload,
      } satisfies IpcMessage;
    }),
    isServerRunning: vi.fn(async () => true),
  } as unknown as McpContext["ipcClient"];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createToolDefinitions()", () => {
  it("returns 30 tool definitions (23 legacy + 5 modules/* lifecycle + 2 modules/config/*)", () => {
    const tools = createToolDefinitions(makeMockContext());
    expect(tools).toHaveLength(30);
  });

  it("each tool has name, description, inputSchema, and handler", () => {
    const tools = createToolDefinitions(makeMockContext());
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.inputSchema).toBe("object");
      expect(tool.inputSchema).not.toBeNull();
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("all tool names follow the 'rn-dev/' prefix convention", () => {
    const tools = createToolDefinitions(makeMockContext());
    for (const tool of tools) {
      expect(tool.name).toMatch(/^rn-dev\//);
    }
  });

  it("all tool names are unique", () => {
    const tools = createToolDefinitions(makeMockContext());
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("rn-dev/clean requires 'mode' in inputSchema", () => {
    const tools = createToolDefinitions(makeMockContext());
    const clean = tools.find((t) => t.name === "rn-dev/clean");
    expect(clean).toBeDefined();
    const required = (clean!.inputSchema as { required?: string[] }).required;
    expect(required).toContain("mode");
  });

  it("rn-dev/build requires 'platform' in inputSchema", () => {
    const tools = createToolDefinitions(makeMockContext());
    const build = tools.find((t) => t.name === "rn-dev/build");
    expect(build).toBeDefined();
    const required = (build!.inputSchema as { required?: string[] }).required;
    expect(required).toContain("platform");
  });

  it("rn-dev/select-device requires 'deviceId' in inputSchema", () => {
    const tools = createToolDefinitions(makeMockContext());
    const selectDevice = tools.find((t) => t.name === "rn-dev/select-device");
    expect(selectDevice).toBeDefined();
    const required = (
      selectDevice!.inputSchema as { required?: string[] }
    ).required;
    expect(required).toContain("deviceId");
  });

  it("rn-dev/fix-preflight requires 'check' in inputSchema", () => {
    const tools = createToolDefinitions(makeMockContext());
    const fixPreflight = tools.find((t) => t.name === "rn-dev/fix-preflight");
    expect(fixPreflight).toBeDefined();
    const required = (
      fixPreflight!.inputSchema as { required?: string[] }
    ).required;
    expect(required).toContain("check");
  });

  it("rn-dev/save-profile requires 'name' in inputSchema", () => {
    const tools = createToolDefinitions(makeMockContext());
    const saveProfile = tools.find((t) => t.name === "rn-dev/save-profile");
    expect(saveProfile).toBeDefined();
    const required = (
      saveProfile!.inputSchema as { required?: string[] }
    ).required;
    expect(required).toContain("name");
  });

  it("all inputSchemas are of type 'object'", () => {
    const tools = createToolDefinitions(makeMockContext());
    for (const tool of tools) {
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });

  it("contains the expected set of tool names", () => {
    const tools = createToolDefinitions(makeMockContext());
    const names = new Set(tools.map((t) => t.name));
    const expected = [
      "rn-dev/start-session",
      "rn-dev/stop-session",
      "rn-dev/list-sessions",
      "rn-dev/reload",
      "rn-dev/dev-menu",
      "rn-dev/metro-status",
      "rn-dev/metro-logs",
      "rn-dev/clean",
      "rn-dev/build",
      "rn-dev/install-deps",
      "rn-dev/list-devices",
      "rn-dev/select-device",
      "rn-dev/boot-device",
      "rn-dev/preflight",
      "rn-dev/fix-preflight",
      "rn-dev/list-worktrees",
      "rn-dev/create-worktree",
      "rn-dev/switch-worktree",
      "rn-dev/list-profiles",
      "rn-dev/get-profile",
      "rn-dev/save-profile",
      "rn-dev/run-lint",
      "rn-dev/run-typecheck",
    ];
    for (const name of expected) {
      expect(names.has(name), `missing tool: ${name}`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Handler integration tests (with mock context)
  // -------------------------------------------------------------------------

  it("rn-dev/list-profiles handler calls profileStore.list()", async () => {
    const ctx = makeMockContext();
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/list-profiles")!;

    await tool.handler({});
    expect(ctx.profileStore.list).toHaveBeenCalledOnce();
  });

  it("rn-dev/get-profile handler calls profileStore.findDefault()", async () => {
    const ctx = makeMockContext();
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/get-profile")!;

    await tool.handler({});
    expect(ctx.profileStore.findDefault).toHaveBeenCalled();
  });

  it("rn-dev/preflight handler calls preflightEngine.runAll()", async () => {
    const ctx = makeMockContext();
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/preflight")!;

    await tool.handler({ platform: "ios" });
    expect(ctx.preflightEngine.getChecksForPlatform).toHaveBeenCalledWith("ios");
    expect(ctx.preflightEngine.runAll).toHaveBeenCalled();
  });

  it("rn-dev/fix-preflight handler calls preflightEngine.fix()", async () => {
    const ctx = makeMockContext();
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/fix-preflight")!;

    await tool.handler({ check: "node-version" });
    expect(ctx.preflightEngine.fix).toHaveBeenCalledWith("node-version");
  });

  it("rn-dev/metro-status returns not-running when no metro or ipc", async () => {
    const ctx = makeMockContext();
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/metro-status")!;

    const result = await tool.handler({});
    expect(result).toEqual({ status: "not-running" });
  });
});
