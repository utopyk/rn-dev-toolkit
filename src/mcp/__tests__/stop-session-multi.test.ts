// Phase M4 — `rn-dev/stop-session` requires explicit consent and routes
// by sessionId.
//
// Pins:
//   - Without `permissionsAccepted: ["rn-dev/stop-session"]` AND without
//     --allow-destructive-tools, the tool returns
//     E_DESTRUCTIVE_REQUIRES_CONFIRM and does NOT send session/stop.
//   - With per-call consent, the tool resolves the session via DR-2
//     and sends session/stop with the resolved sessionId.
//   - With --allow-destructive-tools, the tool also sends without
//     per-call consent (headless mode).
//   - >1 session attached + no sessionId arg + consent given →
//     E_SESSION_AMBIGUOUS (resolveSession path); no daemon call made.
//
// Matches the existing destructive-gating pattern for
// `rn-dev/modules-config-set` at src/mcp/tools.ts:1101-1123.

import { describe, it, expect, vi } from "vitest";
import { createToolDefinitions } from "../tools.js";
import type {
  McpContext,
  McpFlags,
  McpSessionRecord,
  ToolResult,
} from "../tools.js";
import type { IpcMessage } from "../../core/ipc.js";
import type { DaemonSession } from "../../app/client/session.js";
import { asSessionId, type SessionId } from "../../core/identifiers.js";
import type { Profile } from "../../core/types.js";

function makeProfile(name: string): Profile {
  return {
    name,
    isDefault: false,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "dirty",
    metroPort: 8081,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot: "/tmp/mock-project",
  } as Profile;
}

function makeSession(
  id: string,
  respond: (action: string, payload?: unknown) => unknown = () => ({
    status: "stopped",
    stoppedSession: true,
  }),
): DaemonSession {
  return {
    client: {
      send: vi.fn(async (msg: IpcMessage) => ({
        type: "response",
        action: msg.action,
        id: msg.id,
        payload: await respond(msg.action, msg.payload),
      }) satisfies IpcMessage),
    },
    metro: {} as DaemonSession["metro"],
    devtools: {} as DaemonSession["devtools"],
    builder: {} as DaemonSession["builder"],
    watcher: {} as DaemonSession["watcher"],
    modules: {} as DaemonSession["modules"],
    lifecycle: {} as DaemonSession["lifecycle"],
    worktreeKey: "root",
    sessionId: asSessionId(id),
    disconnect: vi.fn(),
    release: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as DaemonSession;
}

function makeCtx(opts: {
  records: McpSessionRecord[];
  defaultId?: string | null;
  flags?: Partial<McpFlags>;
}): McpContext {
  const sessions = new Map<SessionId, McpSessionRecord>();
  for (const r of opts.records) {
    sessions.set(r.session.sessionId, r);
  }
  return {
    projectRoot: "/tmp/mock-project",
    profileStore: {} as McpContext["profileStore"],
    artifactStore: {} as McpContext["artifactStore"],
    metro: null,
    preflightEngine: {} as McpContext["preflightEngine"],
    sessions,
    defaultSessionId: opts.defaultId ? asSessionId(opts.defaultId) : null,
    flags: {
      enabledModules: new Set<string>(),
      disabledModules: new Set<string>(),
      allowDestructiveTools: false,
      ...(opts.flags ?? {}),
    },
  };
}

describe("rn-dev/stop-session (M4) — destructive gating", () => {
  it("refuses without permissionsAccepted or --allow-destructive-tools", async () => {
    const session = makeSession("sid-1");
    const ctx = makeCtx({
      records: [{ session, profile: makeProfile("iphone") }],
      defaultId: "sid-1",
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/stop-session")!;

    const out = (await tool.handler({})) as ToolResult;
    expect(out.isError).toBe(true);
    expect((out.structuredContent as { code: string }).code).toBe(
      "E_DESTRUCTIVE_REQUIRES_CONFIRM",
    );
    // The session/stop RPC must NOT have been sent.
    expect(session.client.send).not.toHaveBeenCalled();
  });

  it("proceeds when permissionsAccepted: [\"rn-dev/stop-session\"] is provided", async () => {
    const session = makeSession("sid-1");
    const ctx = makeCtx({
      records: [{ session, profile: makeProfile("iphone") }],
      defaultId: "sid-1",
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/stop-session")!;

    const out = (await tool.handler({
      permissionsAccepted: ["rn-dev/stop-session"],
    })) as { sessionId: string; status?: string };
    expect(out.sessionId).toBe("sid-1");
    expect(session.client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session/stop",
        payload: { sessionId: "sid-1" },
      }),
    );
  });

  it("proceeds with --allow-destructive-tools even without per-call consent", async () => {
    const session = makeSession("sid-1");
    const ctx = makeCtx({
      records: [{ session, profile: makeProfile("iphone") }],
      defaultId: "sid-1",
      flags: { allowDestructiveTools: true },
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/stop-session")!;

    const out = (await tool.handler({})) as { sessionId: string };
    expect(out.sessionId).toBe("sid-1");
    expect(session.client.send).toHaveBeenCalled();
  });
});

describe("rn-dev/stop-session (M4) — sessionId routing", () => {
  it("returns E_SESSION_AMBIGUOUS when >1 session and no sessionId is given (even with consent)", async () => {
    const s1 = makeSession("sid-1");
    const s2 = makeSession("sid-2");
    const ctx = makeCtx({
      records: [
        { session: s1, profile: makeProfile("p1") },
        { session: s2, profile: makeProfile("p2") },
      ],
      defaultId: "sid-1",
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/stop-session")!;

    const out = (await tool.handler({
      permissionsAccepted: ["rn-dev/stop-session"],
    })) as ToolResult;
    expect(out.isError).toBe(true);
    expect((out.structuredContent as { code: string }).code).toBe(
      "E_SESSION_AMBIGUOUS",
    );
    const available = (out.structuredContent as { availableSessions: string[] })
      .availableSessions;
    expect(available).toEqual(["sid-1", "sid-2"]);
    // No daemon call sent.
    expect(s1.client.send).not.toHaveBeenCalled();
    expect(s2.client.send).not.toHaveBeenCalled();
  });

  it("routes to the named session when sessionId is explicit", async () => {
    const s1 = makeSession("sid-1");
    const s2 = makeSession("sid-2");
    const ctx = makeCtx({
      records: [
        { session: s1, profile: makeProfile("p1") },
        { session: s2, profile: makeProfile("p2") },
      ],
      defaultId: "sid-1",
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/stop-session")!;

    const out = (await tool.handler({
      sessionId: "sid-2",
      permissionsAccepted: ["rn-dev/stop-session"],
    })) as { sessionId: string };
    expect(out.sessionId).toBe("sid-2");
    expect(s2.client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session/stop",
        payload: { sessionId: "sid-2" },
      }),
    );
    expect(s1.client.send).not.toHaveBeenCalled();
  });

  it("returns E_UNKNOWN_SESSION when the named sessionId is not attached", async () => {
    const s1 = makeSession("sid-1");
    const ctx = makeCtx({
      records: [{ session: s1, profile: makeProfile("p1") }],
      defaultId: "sid-1",
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/stop-session")!;

    const out = (await tool.handler({
      sessionId: "sid-ghost",
      permissionsAccepted: ["rn-dev/stop-session"],
    })) as ToolResult;
    expect(out.isError).toBe(true);
    expect((out.structuredContent as { code: string }).code).toBe(
      "E_UNKNOWN_SESSION",
    );
    expect(s1.client.send).not.toHaveBeenCalled();
  });
});

describe("rn-dev/stop-session (M4) — schema", () => {
  it("declares permissionsAccepted in its input schema", async () => {
    const ctx = makeCtx({ records: [] });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/stop-session")!;
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.["permissionsAccepted"]).toBeDefined();
    expect(schema.properties?.["sessionId"]).toBeDefined();
  });

  it("flags [destructive] in its description", async () => {
    const ctx = makeCtx({ records: [] });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/stop-session")!;
    expect(tool.description).toMatch(/\[destructive\]/);
  });
});
