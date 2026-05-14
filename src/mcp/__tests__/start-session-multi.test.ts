// Phase M3 — `rn-dev/start-session` accepts `profileName` for cold-start
// and additional-session attachment.
//
// Three modes pinned here:
//   1. profileName matches an already-attached session → idempotent ack
//      returning that sessionId + alreadyAttached: true. No new socket
//      is opened.
//   2. profileName matches a profile on disk but is not yet attached →
//      ctx.attachSession is invoked with the new record and the tool
//      returns the new sessionId.
//   3. profileName is unknown → E_UNKNOWN_PROFILE structuredContent.
//
// Path 2's actual socket dance (`connectToDaemonSession`) lives in the
// e2e harness — see start-session-multi-e2e gating in M6. Here we mock
// `connectToDaemonSession` via vi.mock so the unit covers the wire
// without spinning a real daemon.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  McpContext,
  McpSessionRecord,
  ToolResult,
} from "../tools.js";
import type { IpcMessage } from "../../core/ipc.js";
import type { DaemonSession } from "../../app/client/session.js";
import { asSessionId, type SessionId } from "../../core/identifiers.js";
import type { Profile } from "../../core/types.js";
import type { ProfileStore } from "../../core/profile.js";

// Stub `connectToDaemonSession` so the new-attachment path doesn't open
// a real socket. The mock returns a synthetic DaemonSession whose
// `sessionId` is read by the tool's handler.
const mockConnectToDaemonSession = vi.fn();
vi.mock("../../app/client/session.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../app/client/session.js")>(
      "../../app/client/session.js",
    );
  return {
    ...actual,
    connectToDaemonSession: (...args: unknown[]) => mockConnectToDaemonSession(...args),
  };
});

// Import AFTER the vi.mock above so the tools module picks up the mocked
// `connectToDaemonSession` reference. Without this ordering the real
// `connectToDaemonSession` would be bound into the module's closure.
const { createToolDefinitions } = await import("../tools.js");

function makeProfile(name: string, port = 8081): Profile {
  return {
    name,
    isDefault: false,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "dirty",
    metroPort: port,
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
  respond: (action: string, payload?: unknown) => unknown = () => undefined,
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

function makeProfileStore(profiles: Profile[]): ProfileStore {
  return {
    list: vi.fn(() => profiles),
    load: vi.fn(),
    save: vi.fn(),
    findDefault: vi.fn(),
    findForWorktreeBranch: vi.fn(() => []),
    setDefault: vi.fn(),
    delete: vi.fn(() => false),
  } as unknown as ProfileStore;
}

function makeCtx(opts: {
  records: McpSessionRecord[];
  defaultId?: string | null;
  profiles?: Profile[];
  attachSession?: (record: McpSessionRecord) => void;
}): McpContext {
  const sessions = new Map<SessionId, McpSessionRecord>();
  for (const r of opts.records) {
    sessions.set(r.session.sessionId, r);
  }
  return {
    projectRoot: "/tmp/mock-project",
    profileStore: makeProfileStore(opts.profiles ?? []),
    artifactStore: {} as McpContext["artifactStore"],
    metro: null,
    preflightEngine: {} as McpContext["preflightEngine"],
    sessions,
    defaultSessionId: opts.defaultId ? asSessionId(opts.defaultId) : null,
    ...(opts.attachSession ? { attachSession: opts.attachSession } : {}),
  };
}

beforeEach(() => {
  mockConnectToDaemonSession.mockReset();
});

describe("rn-dev/start-session (M3) — profileName arg", () => {
  it("returns alreadyAttached:true when the named profile is already attached", async () => {
    const existing = makeSession("sid-1");
    const ctx = makeCtx({
      records: [{ session: existing, profile: makeProfile("iphone") }],
      defaultId: "sid-1",
      profiles: [makeProfile("iphone"), makeProfile("android", 8082)],
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/start-session")!;

    const out = (await tool.handler({ profileName: "iphone" })) as {
      sessionId: string;
      alreadyAttached: boolean;
    };
    expect(out.sessionId).toBe("sid-1");
    expect(out.alreadyAttached).toBe(true);
    // No new socket — connectToDaemonSession must not have been called.
    expect(mockConnectToDaemonSession).not.toHaveBeenCalled();
  });

  it("opens a new session and calls attachSession when the profile is on disk but not attached", async () => {
    const newSession = makeSession("sid-android");
    mockConnectToDaemonSession.mockResolvedValueOnce(newSession);

    const attachSession = vi.fn();
    const existing = makeSession("sid-iphone");
    const ctx = makeCtx({
      records: [{ session: existing, profile: makeProfile("iphone") }],
      defaultId: "sid-iphone",
      profiles: [makeProfile("iphone"), makeProfile("android", 8082)],
      attachSession,
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/start-session")!;

    const out = (await tool.handler({ profileName: "android" })) as {
      sessionId: string;
      status: string;
      alreadyAttached: boolean;
    };
    expect(out.sessionId).toBe("sid-android");
    expect(out.status).toBe("starting");
    expect(out.alreadyAttached).toBe(false);
    expect(mockConnectToDaemonSession).toHaveBeenCalledWith(
      "/tmp/mock-project",
      expect.objectContaining({ name: "android", metroPort: 8082 }),
      expect.objectContaining({
        kinds: ["modules/*", "session/log", "session/status", "builder/*"],
      }),
    );
    expect(attachSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session: newSession,
        profile: expect.objectContaining({ name: "android" }),
      }),
    );
  });

  it("returns E_UNKNOWN_PROFILE when the profile is not on disk", async () => {
    const ctx = makeCtx({
      records: [],
      profiles: [makeProfile("iphone")],
      attachSession: vi.fn(),
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/start-session")!;

    const out = (await tool.handler({ profileName: "ghost" })) as ToolResult;
    expect(out.isError).toBe(true);
    expect((out.structuredContent as { code: string }).code).toBe(
      "E_UNKNOWN_PROFILE",
    );
    expect(mockConnectToDaemonSession).not.toHaveBeenCalled();
  });

  it("returns E_NOT_WIRED when attachSession is missing (defensive)", async () => {
    // Unit-test contexts that don't go through server.ts won't have
    // attachSession wired. The handler refuses to call
    // connectToDaemonSession in that mode rather than silently
    // dropping the new session.
    const ctx = makeCtx({
      records: [],
      profiles: [makeProfile("iphone")],
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/start-session")!;

    const out = (await tool.handler({ profileName: "iphone" })) as ToolResult;
    expect(out.isError).toBe(true);
    expect((out.structuredContent as { code: string }).code).toBe("E_NOT_WIRED");
  });

  it("releases the duplicate socket when boot-or-join returns an already-attached sessionId", async () => {
    // Concurrency edge: another client booted the daemon's session for
    // this profile a moment before us. `connectToDaemonSession` joins
    // and returns a DaemonSession whose sessionId we already hold in
    // ctx.sessions. The tool must NOT double-register; it must disconnect
    // the new socket so the daemon's refcount doesn't grow unboundedly.
    const existing = makeSession("sid-shared");
    const dupSocket = makeSession("sid-shared");
    mockConnectToDaemonSession.mockResolvedValueOnce(dupSocket);

    const attachSession = vi.fn();
    const ctx = makeCtx({
      records: [{ session: existing, profile: makeProfile("shared") }],
      defaultId: "sid-shared",
      profiles: [makeProfile("shared"), makeProfile("other")],
      attachSession,
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/start-session")!;

    // Bypass the already-attached fast path by passing a profileName
    // for a DIFFERENT profile that connectToDaemonSession will end up
    // joining to the shared session (simulating profile-key drift).
    const out = (await tool.handler({ profileName: "other" })) as {
      sessionId: string;
      alreadyAttached: boolean;
    };
    expect(out.sessionId).toBe("sid-shared");
    expect(out.alreadyAttached).toBe(true);
    expect(attachSession).not.toHaveBeenCalled();
    expect(dupSocket.disconnect).toHaveBeenCalled();
  });
});

describe("rn-dev/start-session (M3) — no-args back-compat", () => {
  it("auto-resolves to the only attached session for idempotent restart", async () => {
    const session = makeSession("sid-1", (action) => {
      if (action === "session/status") return { status: "running" };
      return undefined;
    });
    const ctx = makeCtx({
      records: [{ session, profile: makeProfile("iphone") }],
      defaultId: "sid-1",
    });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/start-session")!;

    const out = (await tool.handler({})) as {
      sessionId: string;
      status: string;
      alreadyAttached: boolean;
    };
    expect(out.sessionId).toBe("sid-1");
    expect(out.status).toBe("running");
    expect(out.alreadyAttached).toBe(true);
  });

  it("returns E_NO_SESSION when zero sessions and no bootProfile and no profileName", async () => {
    const ctx = makeCtx({ records: [], attachSession: vi.fn() });
    const tools = createToolDefinitions(ctx);
    const tool = tools.find((t) => t.name === "rn-dev/start-session")!;

    const out = (await tool.handler({})) as ToolResult;
    expect(out.isError).toBe(true);
    expect((out.structuredContent as { code: string }).code).toBe("E_NO_SESSION");
  });
});
