// Phase M1 — DR-2 contract for session resolution in MCP tool handlers.
//
// `resolveSession` is the entry point for every session-scoped tool in
// `src/mcp/tools.ts` and (via the shared export) `src/mcp/module-proxy.ts`.
// It enforces:
//
//   - zero attached sessions          → E_NO_SESSION
//   - explicit sessionId not in map   → E_UNKNOWN_SESSION
//   - exactly one session, no arg     → auto-resolve to that session
//   - >1 session, no arg              → E_SESSION_AMBIGUOUS
//   - explicit sessionId in map       → resolve to that session
//
// These tests pin the contract independently of any specific tool so the
// behavior can't drift when a tool's handler is refactored.

import { describe, it, expect, vi } from "vitest";
import {
  resolveAnySession,
  resolveSession,
  withSessionIdProp,
  type McpContext,
  type McpSessionRecord,
  type ToolResult,
} from "../tools.js";
import { asSessionId, type SessionId } from "../../core/identifiers.js";
import type { DaemonSession } from "../../app/client/session.js";
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

function makeSession(id: string): DaemonSession {
  return {
    client: { send: vi.fn() },
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

function makeCtx(records: McpSessionRecord[], defaultId: string | null = null): McpContext {
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

describe("resolveSession — DR-2 contract", () => {
  it("returns E_NO_SESSION when no sessions are attached", () => {
    const ctx = makeCtx([]);
    const out = resolveSession(ctx, {});
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect((out.result.structuredContent as { code: string }).code).toBe(
      "E_NO_SESSION",
    );
    expect(out.result.isError).toBe(true);
  });

  it("auto-resolves to the single attached session when sessionId is omitted", () => {
    const session = makeSession("sid-1");
    const ctx = makeCtx([{ session, profile: makeProfile("p1") }], "sid-1");
    const out = resolveSession(ctx, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sessionId).toBe("sid-1");
    expect(out.record.profile.name).toBe("p1");
  });

  it("returns E_SESSION_AMBIGUOUS when >1 session is attached and no sessionId is given", () => {
    const s1 = makeSession("sid-1");
    const s2 = makeSession("sid-2");
    const ctx = makeCtx(
      [
        { session: s1, profile: makeProfile("p1") },
        { session: s2, profile: makeProfile("p2") },
      ],
      "sid-1",
    );
    const out = resolveSession(ctx, {});
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect((out.result.structuredContent as { code: string }).code).toBe(
      "E_SESSION_AMBIGUOUS",
    );
    const available = (out.result.structuredContent as { availableSessions: string[] })
      .availableSessions;
    expect(available).toEqual(["sid-1", "sid-2"]);
  });

  it("resolves to the explicitly-named session when sessionId matches", () => {
    const s1 = makeSession("sid-1");
    const s2 = makeSession("sid-2");
    const ctx = makeCtx(
      [
        { session: s1, profile: makeProfile("p1") },
        { session: s2, profile: makeProfile("p2") },
      ],
      "sid-1",
    );
    const out = resolveSession(ctx, { sessionId: "sid-2" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sessionId).toBe("sid-2");
    expect(out.record.profile.name).toBe("p2");
  });

  it("returns E_UNKNOWN_SESSION when sessionId does not match any attached session", () => {
    const s1 = makeSession("sid-1");
    const ctx = makeCtx([{ session: s1, profile: makeProfile("p1") }], "sid-1");
    const out = resolveSession(ctx, { sessionId: "sid-nope" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect((out.result.structuredContent as { code: string }).code).toBe(
      "E_UNKNOWN_SESSION",
    );
    const available = (out.result.structuredContent as { availableSessions: string[] })
      .availableSessions;
    expect(available).toEqual(["sid-1"]);
  });

  it("ignores an empty-string sessionId (treats as omitted)", () => {
    // Belt-and-braces — the resolver guards against `args.sessionId === ""`
    // because some MCP transports serialize an omitted optional arg as the
    // empty string, and we want auto-resolve behavior in that case rather
    // than an E_UNKNOWN_SESSION lookup against the empty key.
    const session = makeSession("sid-1");
    const ctx = makeCtx([{ session, profile: makeProfile("p1") }], "sid-1");
    const out = resolveSession(ctx, { sessionId: "" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sessionId).toBe("sid-1");
  });
});

describe("resolveAnySession — daemon-global fallback", () => {
  it("returns null when no sessions are attached", () => {
    const ctx = makeCtx([]);
    expect(resolveAnySession(ctx)).toBeNull();
  });

  it("returns the default session when set", () => {
    const s1 = makeSession("sid-1");
    const s2 = makeSession("sid-2");
    const ctx = makeCtx(
      [
        { session: s1, profile: makeProfile("p1") },
        { session: s2, profile: makeProfile("p2") },
      ],
      "sid-2",
    );
    const out = resolveAnySession(ctx);
    expect(out?.session.sessionId).toBe("sid-2");
  });

  it("falls back to the first attached session when defaultSessionId is null", () => {
    const s1 = makeSession("sid-1");
    const s2 = makeSession("sid-2");
    const ctx = makeCtx(
      [
        { session: s1, profile: makeProfile("p1") },
        { session: s2, profile: makeProfile("p2") },
      ],
      null,
    );
    const out = resolveAnySession(ctx);
    // Map iteration order is insertion order — first attached wins.
    expect(out?.session.sessionId).toBe("sid-1");
  });

  it("falls back to the first attached session when defaultSessionId no longer matches", () => {
    // E.g. the default session was stopped and removed from the Map but
    // defaultSessionId hasn't been re-pointed yet.
    const s1 = makeSession("sid-1");
    const ctx = makeCtx([{ session: s1, profile: makeProfile("p1") }], "sid-stale");
    const out = resolveAnySession(ctx);
    expect(out?.session.sessionId).toBe("sid-1");
  });
});

describe("withSessionIdProp", () => {
  it("prepends sessionId to existing properties", () => {
    const schema = withSessionIdProp({
      type: "object",
      properties: { foo: { type: "string" } },
    });
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        sessionId: { type: "string" },
        foo: { type: "string" },
      },
    });
    const keys = Object.keys(
      (schema.properties as Record<string, unknown>) ?? {},
    );
    expect(keys[0]).toBe("sessionId");
  });

  it("preserves required[] and other schema fields", () => {
    const schema = withSessionIdProp({
      type: "object",
      properties: { mode: { type: "string" } },
      required: ["mode"],
    });
    expect((schema as { required: string[] }).required).toEqual(["mode"]);
  });

  it("defaults type to object when omitted (defensive)", () => {
    const schema = withSessionIdProp({ properties: {} });
    expect(schema.type).toBe("object");
  });
});

// Sanity — TS-only — keep ToolResult type re-exported so tool authors can
// build error-result objects in the same shape resolveSession produces.
// (If this stops compiling we'll catch it at gate time.)
const _typecheck: ToolResult = {
  isError: true,
  content: [{ type: "text", text: "..." }],
};
void _typecheck;
