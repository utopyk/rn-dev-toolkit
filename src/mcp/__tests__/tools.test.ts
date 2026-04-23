import { describe, it, expect, vi } from "vitest";
import { createToolDefinitions } from "../tools.js";
import type { McpContext, ToolResult } from "../tools.js";
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
  it("returns 30 tool definitions (22 legacy + 5 modules/* lifecycle + 2 modules/config/* + modules-available; Phase 11 retired legacy `rn-dev/metro-logs`)", () => {
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

  // -------------------------------------------------------------------------
  // Phase 10 P1-3 — rn-dev/modules-available discoverability tool
  // -------------------------------------------------------------------------

  describe("rn-dev/modules-available", () => {
    const marketplacePayload = {
      kind: "ok",
      registrySha256: "deadbeef",
      registryUrl: "https://example.invalid/modules.json",
      entries: [
        {
          id: "devtools-network",
          description: "DevTools Network capture over CDP.",
          author: "rn-dev",
          version: "0.1.0",
          permissions: ["devtools:capture"],
          tarballSha256: "a".repeat(64),
          npmPackage: "@rn-dev-modules/devtools-network",
          homepage: "https://example.invalid/dn",
          installed: true,
          installedVersion: "0.1.0",
          installedState: "active",
        },
        {
          id: "device-control",
          description: "adb / simctl device control.",
          author: "rn-dev",
          version: "0.1.0",
          permissions: ["exec:adb", "exec:simctl"],
          tarballSha256: "b".repeat(64),
          npmPackage: "@rn-dev-modules/device-control",
          homepage: "https://example.invalid/dc",
          installed: false,
        },
      ],
    };

    it("returns no-session error when ipc client is null", async () => {
      const ctx = makeMockContext();
      const tools = createToolDefinitions(ctx);
      const tool = tools.find((t) => t.name === "rn-dev/modules-available")!;

      const result = (await tool.handler({})) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: "no-session" });
    });

    it("proxies marketplace/list and returns { entries, registryUrl, registrySha256 }", async () => {
      const ctx = makeMockContext({
        ipcClient: makeMockIpcClient((action) => {
          expect(action).toBe("marketplace/list");
          return marketplacePayload;
        }),
      });
      const tools = createToolDefinitions(ctx);
      const tool = tools.find((t) => t.name === "rn-dev/modules-available")!;

      const result = (await tool.handler({})) as ToolResult;
      expect(result.isError).toBeUndefined();
      const body = result.structuredContent as {
        registryUrl: string;
        registrySha256: string;
        entries: Array<Record<string, unknown>>;
      };
      expect(body.registryUrl).toBe("https://example.invalid/modules.json");
      expect(body.registrySha256).toBe("deadbeef");
      expect(body.entries).toHaveLength(2);
      expect(body.entries[0]).toMatchObject({
        id: "devtools-network",
        installed: true,
        installedVersion: "0.1.0",
      });
      expect(body.entries[1]).toMatchObject({
        id: "device-control",
        installed: false,
      });
    });

    it("filter narrows by id + description substring (case-insensitive)", async () => {
      const ctx = makeMockContext({
        ipcClient: makeMockIpcClient(() => marketplacePayload),
      });
      const tools = createToolDefinitions(ctx);
      const tool = tools.find((t) => t.name === "rn-dev/modules-available")!;

      const result = (await tool.handler({ filter: "NETWORK" })) as ToolResult;
      const body = result.structuredContent as {
        entries: Array<Record<string, unknown>>;
      };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]?.["id"]).toBe("devtools-network");
    });

    it("installedOnly hides installable-but-not-installed entries", async () => {
      const ctx = makeMockContext({
        ipcClient: makeMockIpcClient(() => marketplacePayload),
      });
      const tools = createToolDefinitions(ctx);
      const tool = tools.find((t) => t.name === "rn-dev/modules-available")!;

      const result = (await tool.handler({ installedOnly: true })) as ToolResult;
      const body = result.structuredContent as {
        entries: Array<Record<string, unknown>>;
      };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]?.["id"]).toBe("devtools-network");
    });

    it("surfaces a metro-logs entry (Phase 11 agent-native discoverability regression)", async () => {
      // After Phase 11, metro-logs is an installable 3p module — agents
      // must be able to find it via modules-available so they can prompt
      // the user to install without guessing package names.
      const withMetroLogs = {
        ...marketplacePayload,
        entries: [
          ...marketplacePayload.entries,
          {
            id: "metro-logs",
            description:
              "Agent-native Metro bundler log capture — tail, filter, and clear Metro stdout/stderr over MCP.",
            author: "rn-dev",
            version: "0.1.0",
            permissions: ["metro:logs:read", "metro:logs:mutate"],
            tarballSha256: "c".repeat(64),
            npmPackage: "@rn-dev-modules/metro-logs",
            homepage: "https://example.invalid/ml",
            installed: false,
          },
        ],
      };
      const ctx = makeMockContext({
        ipcClient: makeMockIpcClient(() => withMetroLogs),
      });
      const tools = createToolDefinitions(ctx);
      const tool = tools.find((t) => t.name === "rn-dev/modules-available")!;

      const result = (await tool.handler({ filter: "metro" })) as ToolResult;
      const body = result.structuredContent as {
        entries: Array<Record<string, unknown>>;
      };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]).toMatchObject({
        id: "metro-logs",
        installed: false,
        permissions: ["metro:logs:read", "metro:logs:mutate"],
      });
    });

    it("drops entries that fail the shape guard (Phase 11 Kieran P2-c)", async () => {
      const malformed = {
        ...marketplacePayload,
        entries: [
          marketplacePayload.entries[0], // valid devtools-network
          { id: 42, description: "bad id type" }, // dropped: id not a string
          { id: "no-perms", description: "missing permissions" }, // dropped: no permissions
          {
            id: "mixed-perms",
            description: "permissions has a non-string",
            permissions: ["exec:adb", 7],
            installed: false,
          }, // dropped: non-string permission
        ],
      };
      const ctx = makeMockContext({
        ipcClient: makeMockIpcClient(() => malformed),
      });
      const tools = createToolDefinitions(ctx);
      const tool = tools.find((t) => t.name === "rn-dev/modules-available")!;
      const result = (await tool.handler({})) as ToolResult;
      const body = result.structuredContent as {
        entries: Array<Record<string, unknown>>;
      };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]?.["id"]).toBe("devtools-network");
    });

    it("propagates registry errors as isError results", async () => {
      const ctx = makeMockContext({
        ipcClient: makeMockIpcClient(() => ({
          kind: "error",
          code: "E_REGISTRY_FETCH_FAILED",
          message: "network is down",
        })),
      });
      const tools = createToolDefinitions(ctx);
      const tool = tools.find((t) => t.name === "rn-dev/modules-available")!;

      const result = (await tool.handler({})) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        kind: "error",
        code: "E_REGISTRY_FETCH_FAILED",
      });
    });
  });
});
