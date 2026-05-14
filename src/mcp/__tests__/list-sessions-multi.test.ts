// Phase M2 — `rn-dev/list-sessions` queries the daemon's `sessions/list`
// RPC and returns every session it knows about.
//
// Pre-M2 the tool wrapped `session/status` and returned the active session
// as a single-element array (or empty when stopped). Post-M2 it surfaces
// the full multi-session snapshot — sessionId + profileName + worktreeKey
// + status + services per entry — so agents can pick a target before
// passing `sessionId` into any session-scoped tool.
//
// This is a unit test against a mock daemon. The integration-with-real-daemon
// path is covered by `session-lifecycle-e2e.test.ts`; M6 adds the
// real-boot multi-session probe.

import { describe, it, expect, vi } from "vitest";
import { createToolDefinitions } from "../tools.js";
import type {
  McpContext,
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

function makeMockSession(
  id: string,
  respond: (action: string, payload?: unknown) => unknown,
): DaemonSession {
  return {
    client: {
      send: vi.fn(async (msg: IpcMessage) => {
        const payload = await respond(msg.action, msg.payload);
        return {
          type: "response",
          action: msg.action,
          id: msg.id,
          payload,
        } satisfies IpcMessage;
      }),
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

function makeCtx(records: McpSessionRecord[], defaultId: string | null): McpContext {
  const sessions = new Map<SessionId, McpSessionRecord>();
  for (const r of records) {
    sessions.set(r.session.sessionId, r);
  }
  return {
    projectRoot: "/tmp/mock-project",
    profileStore: {} as McpContext["profileStore"],
    artifactStore: {} as McpContext["artifactStore"],
    metro: null,
    preflightEngine: {} as McpContext["preflightEngine"],
    sessions,
    defaultSessionId: defaultId ? asSessionId(defaultId) : null,
  };
}

describe("rn-dev/list-sessions (M2)", () => {
  it("returns an empty array when no sessions are attached", async () => {
    const ctx = makeCtx([], null);
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/list-sessions")!;
    const out = (await tool.handler({})) as { sessions: unknown[] };
    expect(out).toEqual({ sessions: [] });
  });

  it("queries the daemon's sessions/list RPC and surfaces the full snapshot", async () => {
    // The daemon's `sessions/list` reply (per src/daemon/index.ts:681) shape:
    //   { sessions: [{ sessionId, profileName, worktreeKey, status, services }] }
    // The MCP tool passes that snapshot through unchanged.
    const daemonSnapshot = {
      sessions: [
        {
          sessionId: "sid-1",
          profileName: "iphone",
          worktreeKey: "root",
          status: "running",
          services: { metro: "running", devtools: "running" },
        },
        {
          sessionId: "sid-2",
          profileName: "android",
          worktreeKey: "root",
          status: "starting",
          services: { metro: "starting" },
        },
      ],
    };
    const session = makeMockSession("sid-1", (action) => {
      expect(action).toBe("sessions/list");
      return daemonSnapshot;
    });
    const ctx = makeCtx(
      [{ session, profile: makeProfile("iphone") }],
      "sid-1",
    );
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/list-sessions")!;
    const out = (await tool.handler({})) as { sessions: unknown[] };
    expect(out.sessions).toEqual(daemonSnapshot.sessions);
  });

  it("uses any attached session's socket — sessions/list is daemon-global", async () => {
    // The MCP tool calls sessions/list via resolveAnySession. If the
    // default session is set, that wins; otherwise any first attached
    // session is used. The RPC reply is the same daemon-wide snapshot
    // regardless of which socket carries it.
    const sentVia: string[] = [];
    const s1 = makeMockSession("sid-1", () => {
      sentVia.push("sid-1");
      return { sessions: [] };
    });
    const s2 = makeMockSession("sid-2", () => {
      sentVia.push("sid-2");
      return { sessions: [] };
    });
    const ctx = makeCtx(
      [
        { session: s1, profile: makeProfile("p1") },
        { session: s2, profile: makeProfile("p2") },
      ],
      "sid-2",
    );
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/list-sessions")!;
    await tool.handler({});
    expect(sentVia).toEqual(["sid-2"]);
  });

  it("declares an outputSchema describing the per-entry shape", async () => {
    // Agents reading tools/list rely on outputSchema to know what they
    // can pluck out of structuredContent. M2 added the schema since
    // the pre-M2 tool only ever returned single-element arrays.
    const ctx = makeCtx([], null);
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/list-sessions")!;
    const schema = tool.outputSchema as
      | { properties?: { sessions?: { items?: { required?: string[] } } } }
      | undefined;
    const required = schema?.properties?.sessions?.items?.required ?? [];
    expect(required).toContain("sessionId");
    expect(required).toContain("status");
  });

  it("returns an empty array when the daemon replies with a malformed sessions field", async () => {
    // Defense in depth — a rogue daemon reply or schema drift must not
    // leak undefined / non-array shapes into the MCP output.
    const session = makeMockSession("sid-1", () => ({ sessions: "nope" }));
    const ctx = makeCtx(
      [{ session, profile: makeProfile("iphone") }],
      "sid-1",
    );
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/list-sessions")!;
    const out = (await tool.handler({})) as { sessions: unknown[] };
    expect(out.sessions).toEqual([]);
  });
});

// Sanity — pin that ToolResult is still re-exportable; ensures the test
// file's `tools.js` import surface stays stable as M3+ refactor.
const _typecheck: ToolResult = {
  isError: false,
  content: [{ type: "text", text: "" }],
};
void _typecheck;
