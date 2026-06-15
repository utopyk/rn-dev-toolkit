import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { listRecentProjects } from "../core/recent-projects.js";
import type { ProfileStore } from "../core/profile.js";
import type { ArtifactStore } from "../core/artifact.js";
import type { MetroManager } from "../core/metro.js";
import type { PreflightEngine } from "../core/preflight.js";
import type { IpcMessage } from "../core/ipc.js";
import type { DaemonSession } from "../app/client/session.js";
import { connectToDaemonSession } from "../app/client/session.js";
import type { Platform, Profile } from "../core/types.js";
import { asSessionId, type SessionId } from "../core/identifiers.js";
import { listDevices, bootDevice } from "../core/device.js";
import { getWorktrees } from "../core/project.js";
import { CleanManager } from "../core/clean.js";
import { buildHooksTools } from "./tools-hooks.js";

// ---------------------------------------------------------------------------
// McpContext
// ---------------------------------------------------------------------------

/**
 * CLI-driven flags for MCP server. Phase 9 removed the built-in
 * devtools-network surface (`--enable-devtools-mcp` / `--mcp-capture-bodies`);
 * that functionality now ships via `@rn-dev-modules/devtools-network` with
 * `captureBodies` as a per-module config value. Phase 11 retired the
 * legacy `rn-dev/metro-logs` tool (reading `.rn-dev/logs/*.log` from
 * disk); that surface now lives on the `@rn-dev-modules/metro-logs`
 * module and reads from the in-memory ring buffer via the `metro-logs`
 * host capability.
 */
export interface McpFlags {
  /**
   * Module ids explicitly enabled via `--enable-module:<id>`. When both
   * this set AND `disabledModules` are empty, all loaded modules are
   * treated as enabled. Precedence: `--disable-module:<id>` wins.
   */
  enabledModules: ReadonlySet<string>;
  /** Module ids disabled via `--disable-module:<id>`. */
  disabledModules: ReadonlySet<string>;
  /**
   * Headless consent for destructiveHint tools. When `true`, the MCP
   * module-proxy lets `destructiveHint: true` tools through without
   * per-call confirmation. Phase 3b enforces this at tools/call.
   */
  allowDestructiveTools: boolean;
}

/**
 * Phase M1 — one entry per attached daemon session. Each session carries
 * the multiplexed `DaemonSession` (subscribe socket + per-adapter clients)
 * alongside the profile it was booted with. `profile` powers per-session
 * defaults in `rn-dev/build` (platform / variant / scheme / configuration /
 * port) and lets `rn-dev/start-session` restart a stopped session without
 * re-reading profiles from disk.
 */
export interface McpSessionRecord {
  session: DaemonSession;
  profile: Profile;
}

export interface McpContext {
  projectRoot: string;
  profileStore: ProfileStore;
  artifactStore: ArtifactStore;
  metro: MetroManager | null;
  preflightEngine: PreflightEngine;
  /**
   * Phase M1 — replaces the single `session: DaemonSession | null`. Every
   * attached daemon session keys into this map by its server-minted
   * `SessionId`. Empty when MCP starts before a daemon exists or after
   * every session has been torn down.
   *
   * Phase 13.6 PR-C — each entry's `.session.client.send` still rides the
   * long-lived subscribe socket so `modules/bind-sender` and
   * `modules/host-call` share the same `connectionId`.
   */
  sessions: Map<SessionId, McpSessionRecord>;
  /**
   * Phase M1 — session resolved when an agent omits `sessionId` from a
   * session-scoped tool call. Per DR-2: when exactly one session is
   * attached, this is that session; when more than one is attached, the
   * tool returns `E_SESSION_AMBIGUOUS` and the agent must pass an
   * explicit id (discoverable via `rn-dev/list-sessions`).
   */
  defaultSessionId: SessionId | null;
  /** Optional — older call sites pre-date the flag system; default OFF. */
  flags?: McpFlags;
  /**
   * Phase M1 — profile MCP discovered at boot (the one that auto-started
   * session #1). `rn-dev/start-session` falls back to this when no
   * `profileName` is supplied AND there are zero attached sessions,
   * mirroring the pre-M1 idempotent restart path. Null when MCP started
   * without a default profile (headless mode).
   *
   * Per-session profiles live inside `sessions.get(sid).profile`.
   */
  bootProfile?: Profile | null;
  /**
   * Phase M3 — callback that registers a freshly-attached daemon session
   * with the multi-session shell. Wired by `server.ts` at boot; it adds
   * the record to `ctx.sessions`, points `defaultSessionId` at it if no
   * default is set, and subscribes the modules-event listener so a
   * tools/listChanged notification fires after install/crash. Optional
   * because unit-test contexts that never call `rn-dev/start-session
   * { profileName }` don't need to provide it.
   */
  attachSession?: (record: McpSessionRecord) => void;
  /**
   * Switch the whole server to a different RN project — the MCP analogue
   * of the Electron project picker (one active project, switch replaces).
   * Validates the path, records it in the shared recents store, tears down
   * the current sessions, re-scopes `projectRoot`/`profileStore`/
   * `artifactStore`/`preflightEngine` to the new project, and boots its
   * default profile (if any). Wired by `server.ts`; optional because
   * unit-test contexts that never call `rn-dev/open-project` don't need it.
   */
  openProject?: (path: string) => Promise<OpenProjectResult>;
}

/** Result of `ctx.openProject` / the `rn-dev/open-project` tool. */
export interface OpenProjectResult {
  ok: boolean;
  /** Resolved project root (the RN package.json dir), on success. */
  projectRoot?: string;
  /** `basename(projectRoot)`, on success. */
  name?: string;
  /** Default profile booted for the new project, or null if none existed. */
  profileName?: string | null;
  /** SessionId of the auto-booted session, or null if the daemon was unreachable / no profile. */
  bootedSessionId?: string | null;
  /** Failure reason, on `ok: false`. */
  error?: string;
}

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

/**
 * Tool-handler return wrapper. Handlers may return either:
 *  - plain data (server.ts stringifies into `content[0].text`), or
 *  - a `ToolResult` with explicit `structuredContent`, `content`, or
 *    `isError` flags. The second shape is what the MCP spec expects for
 *    agents that consume `structuredContent` and branch on `isError`.
 */
export interface ToolResult {
  /** Structured object — recommended for agent consumers. */
  structuredContent?: Record<string, unknown>;
  /** Text fallback — if omitted, server.ts stringifies structuredContent. */
  content?: Array<{ type: "text"; text: string }>;
  /** True when the call failed. The text/structured payload describes why. */
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  /** Optional — describes the shape of `structuredContent` on success. */
  outputSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown | ToolResult>;
}

// ---------------------------------------------------------------------------
// Helper: send IPC command
// ---------------------------------------------------------------------------

function makeIpcMessage(action: string, payload?: unknown): IpcMessage {
  return {
    type: "command",
    action,
    payload,
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

// ---------------------------------------------------------------------------
// Phase M1 — session resolution helpers
//
// `resolveSession` is the entry point for every session-scoped tool. It
// implements DR-2:
//   - sessions.size === 0  → E_NO_SESSION
//   - explicit sessionId, not in map → E_UNKNOWN_SESSION
//   - sessions.size === 1, no sessionId in args → auto-resolve to that one
//   - sessions.size > 1,  no sessionId in args → E_SESSION_AMBIGUOUS
//
// The returned `ToolResult` on error matches the shape used elsewhere
// in this file (structuredContent + content array + isError), so handlers
// can `return resolved.result` directly.
//
// `resolveAnySession` is the looser variant used by tools whose payload
// is daemon-global (modules-config-*, modules-available, …). They need
// any open daemon channel — the default if present, else any first
// entry — but do NOT add `sessionId` to their input schema.
// ---------------------------------------------------------------------------

export const SESSION_ID_PROP: Readonly<Record<string, unknown>> = {
  type: "string",
  description:
    "Session identifier. Optional when exactly one session is running (auto-resolves); required when multiple sessions are running (per DR-2). Discover ids via `rn-dev/list-sessions`.",
};

/**
 * Inject `sessionId` into a session-scoped tool's input schema without
 * mutating the caller's literal. Properties are ordered with sessionId
 * first so the rendered schema lists it ahead of tool-specific args.
 */
export function withSessionIdProp(
  base: Record<string, unknown>,
): Record<string, unknown> {
  const props = (base.properties as Record<string, unknown> | undefined) ?? {};
  return {
    ...base,
    type: typeof base.type === "string" ? base.type : "object",
    properties: { sessionId: SESSION_ID_PROP, ...props },
  };
}

export type SessionResolved =
  | { ok: true; record: McpSessionRecord; sessionId: SessionId }
  | { ok: false; result: ToolResult };

function sessionResolutionError(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  const structuredContent: Record<string, unknown> = {
    code,
    message,
    ...(extra ?? {}),
  };
  return {
    isError: true,
    structuredContent,
    content: [
      { type: "text" as const, text: `${code}: ${message}` },
    ],
  };
}

export function resolveSession(
  ctx: McpContext,
  args: Record<string, unknown>,
): SessionResolved {
  if (ctx.sessions.size === 0) {
    return {
      ok: false,
      result: sessionResolutionError(
        "E_NO_SESSION",
        "No daemon session is attached. Call `rn-dev/start-session` to boot one.",
      ),
    };
  }

  const rawId =
    typeof args["sessionId"] === "string" && args["sessionId"].length > 0
      ? (args["sessionId"] as string)
      : null;

  if (rawId) {
    const sid = asSessionId(rawId);
    const record = ctx.sessions.get(sid);
    if (!record) {
      return {
        ok: false,
        result: sessionResolutionError(
          "E_UNKNOWN_SESSION",
          `No session with id "${rawId}". Available: ${[...ctx.sessions.keys()].join(", ")}`,
          { availableSessions: [...ctx.sessions.keys()] },
        ),
      };
    }
    return { ok: true, record, sessionId: sid };
  }

  if (ctx.sessions.size === 1) {
    const [sessionId, record] = ctx.sessions.entries().next().value as [
      SessionId,
      McpSessionRecord,
    ];
    return { ok: true, record, sessionId };
  }

  return {
    ok: false,
    result: sessionResolutionError(
      "E_SESSION_AMBIGUOUS",
      `Multiple sessions running (${ctx.sessions.size}); pass an explicit \`sessionId\`.`,
      { availableSessions: [...ctx.sessions.keys()] },
    ),
  };
}

/**
 * Loose variant for daemon-global tools (modules-config-*, modules-list,
 * modules-available, …). These don't take a `sessionId` arg — they need
 * any open daemon channel to send their IPC through. Returns the
 * default session if set, otherwise an arbitrary attached session,
 * otherwise null (caller falls back to `noSessionError`).
 */
export function resolveAnySession(ctx: McpContext): McpSessionRecord | null {
  if (ctx.defaultSessionId) {
    const r = ctx.sessions.get(ctx.defaultSessionId);
    if (r) return r;
  }
  const first = ctx.sessions.values().next();
  return first.done ? null : first.value;
}

// ---------------------------------------------------------------------------
// Helper: detect package manager
// ---------------------------------------------------------------------------

function detectPm(projectRoot: string): "npm" | "yarn" | "pnpm" {
  if (existsSync(join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

// ---------------------------------------------------------------------------
// modules-available — shape + guards
//
// Phase 11 Kieran P2-c — validate every field we project out of the
// `marketplace/list` reply rather than dropping `Record<string, unknown>`
// straight onto the MCP wire. The reply is typed upstream, but this
// seam crosses from host IPC → MCP output, and a schema drift must
// not leak undefined fields to agent consumers. Missing required
// fields → entire entry dropped; missing optional fields → omitted.
// ---------------------------------------------------------------------------

interface ModulesAvailableEntry {
  id: string;
  description: string;
  permissions: string[];
  installed: boolean;
  author?: string;
  version?: string;
  homepage?: string;
  installedVersion?: string;
  installedState?: string;
}

function toAvailableEntry(raw: unknown): ModulesAvailableEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["id"] !== "string" || r["id"].length === 0) return null;
  if (typeof r["description"] !== "string") return null;
  if (typeof r["installed"] !== "boolean") return null;
  const permsRaw = r["permissions"];
  if (!Array.isArray(permsRaw)) return null;
  const permissions = permsRaw.filter(
    (p): p is string => typeof p === "string",
  );
  if (permissions.length !== permsRaw.length) return null;
  const out: ModulesAvailableEntry = {
    id: r["id"],
    description: r["description"],
    permissions,
    installed: r["installed"],
  };
  if (typeof r["author"] === "string") out.author = r["author"];
  if (typeof r["version"] === "string") out.version = r["version"];
  if (typeof r["homepage"] === "string") out.homepage = r["homepage"];
  if (typeof r["installedVersion"] === "string") {
    out.installedVersion = r["installedVersion"];
  }
  if (typeof r["installedState"] === "string") {
    out.installedState = r["installedState"];
  }
  return out;
}

// ---------------------------------------------------------------------------
// createToolDefinitions
// ---------------------------------------------------------------------------

export function createToolDefinitions(ctx: McpContext): ToolDefinition[] {
  const flags: McpFlags = ctx.flags ?? {
    enabledModules: new Set<string>(),
    disabledModules: new Set<string>(),
    allowDestructiveTools: false,
  };

  return [
    ...buildModulesLifecycleTools(ctx),
    ...buildHooksTools(),
    // Session management
    //
    // Wire contract note: the daemon-side handlers use slash-cased
    // action names (`session/start`, `session/stop`, `session/status`).
    // These tools used to send hyphen-cased names (`start-session` etc.)
    // which the daemon never registered, so every call fell through to
    // the now-deleted `ctx.metro` branch — which in MCP is always null
    // (server.ts) — and returned `{ error: "No running session" }`
    // regardless of actual state. Agents could not start, stop, or
    // observe a session through MCP.
    //
    // The session is auto-started by `connectToDaemonSession` at MCP
    // boot, so `start-session` is normally idempotent: it returns the
    // current session/status, or boots if the session is stopped (e.g.
    // after a previous `stop-session`).
    {
      name: "rn-dev/start-session",
      description:
        "Ensure a development session is running and return its `{ sessionId, status }`. Three modes:\n" +
        "  - `profileName` given → boot a session for that named profile (loaded from `.rn-dev/profiles`). If a session for that profile is already attached, the existing sessionId is returned; otherwise a new subscribe socket is opened (boot-or-join via events/subscribe { profile }) and the new session is registered for follow-up RPCs.\n" +
        "  - `sessionId` given → idempotent restart for the named session: returns its current status, or re-issues session/start with the session's profile when stopped.\n" +
        "  - Neither → behaves as the idempotent restart against the resolved session (auto-resolves when exactly one session is attached; falls back to MCP's boot profile when zero sessions are attached).\n" +
        "Discover profile names via `rn-dev/list-profiles`; discover sessionIds via `rn-dev/list-sessions`.",
      inputSchema: withSessionIdProp({
        type: "object",
        properties: {
          profileName: {
            type: "string",
            description:
              "Name of a profile in `.rn-dev/profiles` to boot a session for. Use this for cold-start (zero attached sessions and you want to pick which profile to start) or to open an additional session alongside the existing default.",
          },
        },
      }),
      outputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          status: { type: "string" },
          alreadyAttached: { type: "boolean" },
          error: { type: "string" },
        },
      },
      handler: async (args) => {
        const profileName =
          typeof args["profileName"] === "string" && args["profileName"].length > 0
            ? (args["profileName"] as string)
            : null;

        // Path A — profileName provided. Either reuse an already-attached
        // session for that profile, or call connectToDaemonSession to
        // boot-or-join and register the new session.
        if (profileName) {
          const existing = [...ctx.sessions.entries()].find(
            ([, record]) => record.profile.name === profileName,
          );
          if (existing) {
            const [sid, record] = existing;
            const statusResp = await record.session.client.send(
              makeIpcMessage("session/status", { sessionId: sid }),
            );
            const payload = statusResp.payload as
              | { status?: string }
              | undefined;
            return {
              sessionId: sid,
              status: payload?.status ?? "running",
              alreadyAttached: true,
            };
          }

          // Profile not already attached — load from disk + attach.
          const profile = ctx.profileStore
            .list()
            .find((p) => p.name === profileName);
          if (!profile) {
            return sessionResolutionError(
              "E_UNKNOWN_PROFILE",
              `No profile named "${profileName}" in .rn-dev/profiles. Run \`rn-dev/list-profiles\` to discover available names.`,
            );
          }
          if (!ctx.attachSession) {
            // Defensive — server.ts wires this. Unit-test contexts that
            // call this code path must provide attachSession.
            return sessionResolutionError(
              "E_NOT_WIRED",
              "MCP server has no attachSession callback wired — this build cannot open additional sessions.",
            );
          }

          let newSession: DaemonSession;
          try {
            newSession = await connectToDaemonSession(ctx.projectRoot, profile, {
              kinds: ["modules/*", "session/log", "session/status", "builder/*"],
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return sessionResolutionError(
              "E_SESSION_ATTACH_FAILED",
              `Failed to attach a session for profile "${profileName}": ${message}`,
            );
          }

          // boot-or-join may have returned an already-attached session
          // (a separate client booted it). Guard against duplicating
          // the entry: keep the first DaemonSession, release the new
          // duplicate's subscribe socket so the daemon's refcount
          // doesn't grow unboundedly.
          const alreadyAttached = ctx.sessions.has(newSession.sessionId);
          if (alreadyAttached) {
            try {
              newSession.disconnect();
            } catch {
              // best-effort
            }
            return {
              sessionId: newSession.sessionId,
              status: "running",
              alreadyAttached: true,
            };
          }

          ctx.attachSession({ session: newSession, profile });
          return {
            sessionId: newSession.sessionId,
            status: "starting",
            alreadyAttached: false,
          };
        }

        // Path B — no profileName, at least one session attached. M1
        // idempotent restart path against the resolved session.
        if (ctx.sessions.size > 0) {
          const resolved = resolveSession(ctx, args);
          if (!resolved.ok) return resolved.result;
          const { record } = resolved;

          const statusResp = await record.session.client.send(
            makeIpcMessage("session/status", {
              sessionId: resolved.sessionId,
            }),
          );
          const status = (statusResp.payload as { status?: string } | undefined)?.status;
          if (status && status !== "stopped") {
            return {
              sessionId: resolved.sessionId,
              status,
              alreadyAttached: true,
            };
          }

          // Stopped — restart with the profile this session was booted with.
          const startResp = await record.session.client.send(
            makeIpcMessage("session/start", { profile: record.profile }),
          );
          return startResp.payload ?? {
            sessionId: resolved.sessionId,
            status: "started",
          };
        }

        // Path C — no profileName, zero sessions. Fall back to bootProfile.
        if (!ctx.bootProfile) {
          return sessionResolutionError(
            "E_NO_SESSION",
            "No daemon session is attached and no `profileName` was provided. Either pass `profileName` (discoverable via rn-dev/list-profiles) or restart MCP inside a project that has a default profile.",
          );
        }
        const anySession = resolveAnySession(ctx);
        if (!anySession) {
          return sessionResolutionError(
            "E_NO_DAEMON",
            "No daemon connection. Restart MCP inside a project with a default profile to auto-spawn the daemon.",
          );
        }
        const startResp = await anySession.session.client.send(
          makeIpcMessage("session/start", { profile: ctx.bootProfile }),
        );
        return startResp.payload ?? { status: "started" };
      },
    },
    {
      name: "rn-dev/stop-session",
      description:
        "Stop a development session via session/stop. Tears down Metro, the module host, and any active services for the resolved session. Pass `sessionId` to target a specific session; required when more than one session is attached. [destructive] Stopping a session terminates in-flight builds and any agent capture sessions (DevTools, Metro logs) for that session — re-call with `{ permissionsAccepted: [\"rn-dev/stop-session\"] }` or start the MCP server with --allow-destructive-tools to confirm.",
      inputSchema: withSessionIdProp({
        type: "object",
        properties: {
          permissionsAccepted: {
            type: "array",
            items: { type: "string" },
            description:
              "Pass [\"rn-dev/stop-session\"] to confirm the destructive stop.",
          },
        },
      }),
      outputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          status: { type: "string" },
          stoppedSession: { type: "boolean" },
          code: { type: "string" },
          message: { type: "string" },
        },
      },
      handler: async (args) => {
        // Phase M4 — destructive gating mirrors `rn-dev/modules-config-set`
        // (tools.ts:1101-1123). Two ways to bypass the confirm:
        //   1. Per-call: pass `permissionsAccepted: ["rn-dev/stop-session"]`
        //   2. Global:   start MCP with `--allow-destructive-tools`
        //
        // Phase M4 explicitly requires sessionId in multi-session shells —
        // E_SESSION_AMBIGUOUS surfaces here via `resolveSession`. The
        // ambiguous-error payload already carries `availableSessions`
        // so an agent can retry with one of the listed ids.
        if (!flags.allowDestructiveTools) {
          const accepted = Array.isArray(args.permissionsAccepted)
            ? args.permissionsAccepted.filter((v): v is string => typeof v === "string")
            : [];
          if (!accepted.includes("rn-dev/stop-session")) {
            return {
              isError: true,
              structuredContent: {
                code: "E_DESTRUCTIVE_REQUIRES_CONFIRM",
                message:
                  'rn-dev/stop-session is destructive: re-call with { permissionsAccepted: ["rn-dev/stop-session"] } or start MCP with --allow-destructive-tools.',
              },
              content: [
                {
                  type: "text" as const,
                  text: 'rn-dev/stop-session requires { permissionsAccepted: ["rn-dev/stop-session"] } or --allow-destructive-tools.',
                },
              ],
            } satisfies ToolResult;
          }
        }

        const resolved = resolveSession(ctx, args);
        if (!resolved.ok) return resolved.result;
        const resp = await resolved.record.session.client.send(
          makeIpcMessage("session/stop", { sessionId: resolved.sessionId }),
        );
        const payload = (resp.payload as Record<string, unknown>) ?? {};
        // outputSchema declared above means the MCP SDK rejects responses
        // without structuredContent. Wrap so the schema and the wire shape
        // agree.
        return {
          structuredContent: {
            sessionId: resolved.sessionId,
            ...payload,
          },
        };
      },
    },
    {
      name: "rn-dev/list-sessions",
      description:
        "Return every session the daemon knows about (running, starting, stopped). Wraps the daemon's `sessions/list` RPC. Each entry carries `{ sessionId, profileName, worktreeKey, status, services }` — pass `sessionId` into any session-scoped tool (`rn-dev/build`, `rn-dev/build-status`, `rn-dev/devtools-network__*`, …) to target it. Returns an empty array when no daemon is attached or when the daemon has no sessions.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: {
        type: "object",
        required: ["sessions"],
        properties: {
          sessions: {
            type: "array",
            items: {
              type: "object",
              required: ["sessionId", "status"],
              properties: {
                sessionId: { type: "string" },
                profileName: { type: "string" },
                worktreeKey: { type: "string" },
                status: { type: "string" },
                services: { type: "object" },
              },
            },
          },
        },
      },
      handler: async () => {
        // Phase M2 — sessions/list is daemon-global. Any attached
        // session's subscribe socket works; resolveAnySession picks the
        // default (or any first entry as fallback).
        const anySession = resolveAnySession(ctx);
        if (!anySession) {
          return { structuredContent: { sessions: [] } };
        }
        const resp = await anySession.session.client.send(
          makeIpcMessage("sessions/list"),
        );
        const payload = resp.payload as { sessions?: unknown } | undefined;
        const raw = Array.isArray(payload?.sessions) ? payload.sessions : [];
        return { structuredContent: { sessions: raw } };
      },
    },
    {
      name: "rn-dev/session-logs",
      description:
        "Return recent daemon-emitted session log lines for the resolved session. Surfaces boot progress (preflight, install, watchman setup, port-kill, simulator boot) and other session-level state changes. Useful immediately after `rn-dev/start-session` to observe what the daemon is doing. Pass `sessionId` to target a specific session.",
      inputSchema: withSessionIdProp({
        type: "object",
        properties: {
          limit: {
            type: "number",
            description:
              "Maximum number of most-recent lines to return. Default: 50. Max: 200 (the SessionClient ring size).",
          },
        },
      }),
      handler: async (args) => {
        const resolved = resolveSession(ctx, args);
        if (!resolved.ok) return resolved.result;
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(args.limit, 200)
            : 50;
        const all = resolved.record.session.lifecycle.recentLogs();
        const lines = all.slice(-limit);
        return { structuredContent: { lines } };
      },
    },
    // Metro control
    //
    // Wire-contract note (M1 follow-up surfaced by M6 PROBE):
    // the daemon's `resolveSessionServices` (src/daemon/client-rpcs.ts:113)
    // routes session-scoped RPCs by `payload.sessionId`, NOT by socket
    // affinity. So even though MCP sends each call through the resolved
    // session's per-session subscribe socket, the daemon still needs
    // `sessionId` in the payload — otherwise its back-compat fallback
    // sees N > 1 active sessions and returns E_SESSION_AMBIGUOUS.
    // Every send below threads `resolved.sessionId` accordingly.
    {
      name: "rn-dev/reload",
      description:
        "Reload the running app for the resolved session. Pass `sessionId` to target a specific session.",
      inputSchema: withSessionIdProp({ type: "object", properties: {} }),
      handler: async (args) => {
        // Phase M1 — only the daemon-routed path remains session-aware.
        // The legacy adb / metro-HTTP fallbacks were untargeted (they
        // would reload whichever app the device was showing, ignoring
        // sessionId entirely); keeping them under multi-session would
        // silently reload the wrong app, so the multi-session contract
        // makes the daemon RPC the single source of truth.
        const resolved = resolveSession(ctx, args);
        if (!resolved.ok) return resolved.result;
        const resp = await resolved.record.session.client.send(
          makeIpcMessage("reload", { sessionId: resolved.sessionId }),
        );
        return resp.payload ?? { status: "reloaded" };
      },
    },
    {
      name: "rn-dev/devtools-reconnect",
      description:
        "Restart the resolved session's DevTools CDP proxy (stop + fresh target discovery + re-arm capture). The agent-side equivalent of the GUI's DevTools Reconnect button — use when capture status reports `no-target`/`preempted` after the app relaunched, or when a raw debugger probe preempted the capture slot. Pass `sessionId` to target a specific session.",
      inputSchema: withSessionIdProp({ type: "object", properties: {} }),
      handler: async (args) => {
        // Agent-native parity (2026-06-11 battle-test): the GUI has had
        // Reconnect since the Phase 3 polish, but agents had no
        // equivalent — recovering a wedged capture required a same-id
        // select-target workaround. devtools/restart is the single
        // atomic verb the daemon exposes for exactly this (stop+start
        // composed inside DevToolsManager so concurrent observers never
        // see the stop/start gap).
        const resolved = resolveSession(ctx, args);
        if (!resolved.ok) return resolved.result;
        const { proxyPort, sessionNonce } =
          await resolved.record.session.devtools.restart();
        return okResult({
          status: "reconnected",
          sessionId: resolved.sessionId,
          proxyPort,
          sessionNonce,
        });
      },
    },
    {
      name: "rn-dev/dev-menu",
      description:
        "Open the device developer menu for the resolved session. Pass `sessionId` to target a specific session.",
      inputSchema: withSessionIdProp({ type: "object", properties: {} }),
      handler: async (args) => {
        // Phase M1 — see rn-dev/reload for the same daemon-routed-only
        // rationale. The pre-M1 fallback `adb shell input keyevent 82`
        // is device-global; under multi-session it would open the dev
        // menu on the wrong target.
        const resolved = resolveSession(ctx, args);
        if (!resolved.ok) return resolved.result;
        const resp = await resolved.record.session.client.send(
          makeIpcMessage("dev-menu", { sessionId: resolved.sessionId }),
        );
        return resp.payload ?? { status: "opened" };
      },
    },
    {
      name: "rn-dev/metro-status",
      description:
        "Get Metro bundler status for the resolved session. Pass `sessionId` to target a specific session.",
      inputSchema: withSessionIdProp({ type: "object", properties: {} }),
      handler: async (args) => {
        const resolved = resolveSession(ctx, args);
        if (!resolved.ok) return resolved.result;
        const resp = await resolved.record.session.client.send(
          makeIpcMessage("metro-status", { sessionId: resolved.sessionId }),
        );
        return resp.payload ?? { status: "unknown" };
      },
    },
    // Build & Clean
    {
      name: "rn-dev/clean",
      description: "Run clean operations",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["dirty", "clean", "ultra-clean"] },
          platform: { type: "string", enum: ["ios", "android", "both"] },
        },
        required: ["mode"],
      },
      handler: async (args) => {
        const mode = args.mode as "dirty" | "clean" | "ultra-clean";
        const platform = (args.platform as Platform) ?? "both";
        const cleaner = new CleanManager(ctx.projectRoot);
        const results = await cleaner.execute(mode, platform);
        return { results };
      },
    },
    {
      name: "rn-dev/build-status",
      description:
        "Return recent builder events (line/progress/done) buffered for the resolved session since the daemon last booted. Pair with rn-dev/build to observe progress: kick off the build, then poll this tool every 1-2s and look for a `done` event whose `success` field tells you whether the build passed. Build progress also surfaces here as line events whose `stream` is 'stdout' (xcodebuild/gradle output) or 'stderr' (build warnings/errors). Pass `sessionId` to target a specific session.",
      inputSchema: withSessionIdProp({
        type: "object",
        properties: {
          limit: {
            type: "number",
            description:
              "Maximum number of most-recent events to return. Default: 100. Max: 500 (matches the BuilderClient ring size).",
          },
        },
      }),
      handler: async (args) => {
        const resolved = resolveSession(ctx, args);
        if (!resolved.ok) return resolved.result;
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(args.limit, 500)
            : 100;
        const all = resolved.record.session.builder.recentEvents();
        const events = all.slice(-limit);
        return { structuredContent: { events } };
      },
    },
    {
      name: "rn-dev/build",
      description:
        "Trigger a build via the daemon's builder/build RPC for the resolved session. Returns immediately; observe progress + completion via rn-dev/build-status. Defaults pull from the session's profile when `platform`, `variant`, etc. are omitted. Pass `sessionId` to target a specific session.",
      inputSchema: withSessionIdProp({
        type: "object",
        properties: {
          platform: { type: "string", enum: ["ios", "android"] },
          variant: { type: "string", enum: ["debug", "release"] },
          deviceId: { type: "string", description: "iOS UDID or Android device id; defaults to the session profile's selected device." },
          scheme: { type: "string", description: "iOS scheme; falls back to the session profile's value." },
          configuration: { type: "string", description: "Build configuration / variant, maps to RN CLI --mode (iOS Xcode configuration e.g. Debug; Android Gradle variant e.g. betaDebug). Falls back to the profile or variant default." },
          appIdSuffix: { type: "string", description: "Android applicationId suffix (e.g. beta → com.acme.beta), passed as --appIdSuffix. Falls back to the session profile's value." },
        },
      }),
      handler: async (args) => {
        const resolved = resolveSession(ctx, args);
        if (!resolved.ok) return resolved.result;
        const profile = resolved.record.profile;
        // Platform fallback: caller args win; otherwise pick from the
        // session's profile (which can be "both" — default to ios since
        // the daemon's builder/build only accepts ios|android).
        const platform: "ios" | "android" =
          (args.platform as "ios" | "android" | undefined) ??
          (profile.platform === "android" ? "android" : "ios");
        const variant = (args.variant as "debug" | "release" | undefined) ?? profile.buildVariant ?? "debug";
        const deviceId = (args.deviceId as string | undefined) ?? profile.devices?.[platform] ?? undefined;
        const scheme = (args.scheme as string | undefined) ?? profile.scheme ?? undefined;
        const configuration = (args.configuration as string | undefined) ?? profile.configuration ?? undefined;
        const appIdSuffix = (args.appIdSuffix as string | undefined) ?? profile.appIdSuffix ?? undefined;
        const port = profile.metroPort;

        const payload: Record<string, unknown> = {
          sessionId: resolved.sessionId,
          projectRoot: ctx.projectRoot,
          platform,
          variant,
          port,
        };
        if (deviceId) payload.deviceId = deviceId;
        if (scheme) payload.scheme = scheme;
        if (configuration) payload.configuration = configuration;
        if (appIdSuffix) payload.appIdSuffix = appIdSuffix;

        const resp = await resolved.record.session.client.send(
          makeIpcMessage("builder/build", payload),
        );
        return resp.payload ?? { ok: true };
      },
    },
    {
      name: "rn-dev/install-deps",
      description: "Reinstall node_modules and pods if needed",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const pm = detectPm(ctx.projectRoot);
        const installCmd =
          pm === "yarn"
            ? "yarn install"
            : pm === "pnpm"
              ? "pnpm install"
              : "npm install";
        const results: Array<{ step: string; success: boolean; output: string }> = [];

        try {
          const output = execSync(installCmd, {
            cwd: ctx.projectRoot,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          results.push({ step: installCmd, success: true, output: output.slice(-1000) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ step: installCmd, success: false, output: msg.slice(-1000) });
        }

        // pod install if ios directory exists
        const iosDir = join(ctx.projectRoot, "ios");
        if (existsSync(iosDir)) {
          try {
            const output = execSync("pod install", {
              cwd: iosDir,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });
            results.push({ step: "pod install", success: true, output: output.slice(-1000) });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ step: "pod install", success: false, output: msg.slice(-1000) });
          }
        }

        return { results };
      },
    },
    // Device management
    {
      name: "rn-dev/list-devices",
      description: "List available iOS simulators and Android devices",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["ios", "android", "both"] },
        },
      },
      handler: async (args) => {
        const platform = (args.platform as "ios" | "android" | "both") ?? "both";
        const devices = await listDevices(platform);
        return { devices };
      },
    },
    {
      name: "rn-dev/select-device",
      description: "Select a device for the current session",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
        },
        required: ["deviceId"],
      },
      handler: async (args) => {
        const deviceId = args.deviceId as string;
        // Find the device in all available devices
        const devices = await listDevices("both");
        const device = devices.find((d) => d.id === deviceId);
        if (!device) {
          return { error: `Device not found: ${deviceId}` };
        }
        return { status: "selected", device };
      },
    },
    {
      name: "rn-dev/boot-device",
      description: "Boot a simulator or start an emulator",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
        },
        required: ["deviceId"],
      },
      handler: async (args) => {
        const deviceId = args.deviceId as string;
        const devices = await listDevices("both");
        const device = devices.find((d) => d.id === deviceId);
        if (!device) {
          return { error: `Device not found: ${deviceId}` };
        }
        const success = await bootDevice(device);
        return { status: success ? "booted" : "failed", device };
      },
    },
    // Environment
    {
      name: "rn-dev/preflight",
      description: "Run preflight environment checks",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["ios", "android", "both"] },
        },
      },
      handler: async (args) => {
        const platform = (args.platform as Platform) ?? "both";
        const checks = ctx.preflightEngine.getChecksForPlatform(platform);
        const config = { checks: checks.map((c) => c.id), frequency: "always" as const };
        const results = await ctx.preflightEngine.runAll(platform, config);
        const output: Record<string, { passed: boolean; message: string; details?: string }> = {};
        for (const [id, result] of results) {
          output[id] = result;
        }
        return output;
      },
    },
    {
      name: "rn-dev/fix-preflight",
      description: "Auto-fix a specific failing preflight check",
      inputSchema: {
        type: "object",
        properties: {
          check: { type: "string", description: "Check ID to fix" },
        },
        required: ["check"],
      },
      handler: async (args) => {
        const checkId = args.check as string;
        const success = await ctx.preflightEngine.fix(checkId);
        return { check: checkId, fixed: success };
      },
    },
    // Project selection — the MCP analogue of the Electron project picker.
    // The server's project is auto-detected from its launch directory at
    // startup; these tools let an agent SEE that choice and CHANGE it
    // explicitly instead of being pinned to the launch cwd.
    {
      name: "rn-dev/list-projects",
      description:
        "List the current RN project and recently-opened ones. `current` is the project this MCP server is scoped to right now (auto-detected from its launch directory unless changed via `rn-dev/open-project`). `recents` is the shared most-recent-first list (the same store the Electron GUI picker reads/writes), each `{ path, name, lastOpenedAt, exists }`. Pass a `recents[].path` (or any other RN project path) to `rn-dev/open-project` to switch.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const current = {
          path: ctx.projectRoot,
          name: basename(ctx.projectRoot),
        };
        const recents = listRecentProjects().map((r) => ({
          path: r.path,
          name: r.name,
          lastOpenedAt: r.lastOpenedAt,
          exists: existsSync(r.path),
        }));
        return { current, recents };
      },
    },
    {
      name: "rn-dev/open-project",
      description:
        "Switch this MCP server to a different React Native project (one active project at a time — switching replaces the current one, mirroring the Electron picker). Validates that `path` is an RN project, records it in the shared recents store, disconnects the current sessions, re-scopes the server (profiles, artifacts, preflight) to the new project, and boots its default profile if one exists. Returns `{ ok, projectRoot, name, profileName, bootedSessionId }` on success or `{ ok: false, error }` on a bad path. After this, project-scoped tools (build, clean, list-profiles, preflight, worktrees) operate on the new project.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute path to the RN project (or any directory inside it — the server walks up to the package.json that declares react-native).",
          },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const path = args.path;
        if (typeof path !== "string" || path.length === 0) {
          return {
            structuredContent: {
              kind: "error",
              code: "E_INVALID_PATH",
              message: "open-project requires a non-empty `path`.",
            },
            isError: true,
          };
        }
        if (!ctx.openProject) {
          // Defensive — server.ts wires this. Unit-test contexts that
          // don't exercise project switching won't provide it.
          return {
            structuredContent: {
              kind: "error",
              code: "E_NOT_WIRED",
              message:
                "MCP server has no openProject callback wired — this build cannot switch projects.",
            },
            isError: true,
          };
        }
        const result = await ctx.openProject(path);
        if (!result.ok) {
          return {
            structuredContent: {
              kind: "error",
              code: "E_NOT_A_PROJECT",
              message: result.error ?? "Could not open that project.",
            },
            isError: true,
          };
        }
        return { structuredContent: { kind: "ok", ...result } };
      },
    },
    // Worktree
    {
      name: "rn-dev/list-worktrees",
      description: "List git worktrees with session status",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const worktrees = await getWorktrees(ctx.projectRoot);
        return { worktrees };
      },
    },
    {
      name: "rn-dev/create-worktree",
      description: "Create a new git worktree",
      inputSchema: {
        type: "object",
        properties: {
          branch: { type: "string" },
          name: { type: "string" },
        },
        required: ["branch"],
      },
      handler: async (args) => {
        const branch = args.branch as string;
        const name = (args.name as string) ?? branch;
        const worktreePath = join(ctx.projectRoot, "..", `worktree-${name}`);
        try {
          execSync(`git worktree add "${worktreePath}" -b "${branch}"`, {
            cwd: ctx.projectRoot,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { status: "created", path: worktreePath, branch };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: msg };
        }
      },
    },
    {
      name: "rn-dev/switch-worktree",
      description: "Switch to a different worktree",
      inputSchema: {
        type: "object",
        properties: {
          worktree: { type: "string" },
          copyProfile: { type: "boolean" },
        },
        required: ["worktree"],
      },
      handler: async (args) => {
        const worktree = args.worktree as string;
        const worktrees = await getWorktrees(ctx.projectRoot);
        const target = worktrees.find(
          (w) => w.path === worktree || w.branch === worktree
        );
        if (!target) {
          return { error: `Worktree not found: ${worktree}` };
        }
        return { status: "switched", worktree: target };
      },
    },
    // Profile
    {
      name: "rn-dev/list-profiles",
      description: "List saved profiles",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const profiles = ctx.profileStore.list();
        return { profiles };
      },
    },
    {
      name: "rn-dev/get-profile",
      description: "Get current active profile details",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const profile = ctx.profileStore.findDefault(null, "main");
        if (!profile) {
          return { error: "No default profile found" };
        }
        return { profile };
      },
    },
    {
      name: "rn-dev/save-profile",
      description: "Save current session as profile",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
      handler: async (args) => {
        const name = args.name as string;
        // Load existing profile or create a minimal one
        const existing = ctx.profileStore.findDefault(null, "main");
        const profile = existing
          ? { ...existing, name }
          : {
              name,
              isDefault: false,
              worktree: null,
              branch: "main",
              platform: "both" as const,
              mode: "clean" as const,
              metroPort: 8081,
              devices: {},
              buildVariant: "debug" as const,
              preflight: { checks: [], frequency: "once" as const },
              onSave: [],
              env: {},
              projectRoot: ctx.projectRoot,
            };
        ctx.profileStore.save(profile);
        return { status: "saved", name };
      },
    },
    // Tools
    {
      name: "rn-dev/run-lint",
      description: "Run project linter and return results",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        try {
          const output = execSync("npx eslint src/ --format json", {
            cwd: ctx.projectRoot,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { status: "success", output: output.slice(-5000) };
        } catch (err) {
          // ESLint exits non-zero when there are lint errors
          const msg = err instanceof Error ? (err as { stdout?: string }).stdout ?? err.message : String(err);
          return { status: "lint-errors", output: String(msg).slice(-5000) };
        }
      },
    },
    {
      name: "rn-dev/run-typecheck",
      description: "Run TypeScript type checking",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        try {
          const output = execSync("npx tsc --noEmit", {
            cwd: ctx.projectRoot,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { status: "success", output: output.slice(-5000) };
        } catch (err) {
          const msg = err instanceof Error ? (err as { stdout?: string }).stdout ?? err.message : String(err);
          return { status: "type-errors", output: String(msg).slice(-5000) };
        }
      },
    },
    {
      // Phase M5 — agent-native readback of the host audit log
      // (~/.rn-dev/audit.log). The TUI / Electron renderer do not (yet)
      // surface a log viewer, so the MCP tool is the parity surface for
      // agents that need to audit `install`, `host-call`, `config-set`,
      // `panel-bridge`, and `hook` outcomes. Read-only; no destructive
      // gating required.
      name: "rn-dev/audit-tail",
      description:
        "Return recent entries from the HMAC-chained host audit log at `~/.rn-dev/audit.log`. Use after a destructive call (e.g. rn-dev/modules-config-set, rn-dev/stop-session) to confirm the audit-side record landed. Entries carry `{ kind, ts, seq, outcome, ... }`; the per-kind shape is documented in src/core/audit-log.ts (AuditEntryInput). Filters: `since` (epoch ms; entries strictly after this), `kind` (exact match — e.g. \"hook\", \"install\", \"config-set\"), `sessionId` (forward-compat — v1 audit entries do not carry sessionId so passing this returns no rows until session-scoped audit kinds land). `limit` defaults to 50; max 200.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description:
              "Maximum entries to return. Default: 50. Max: 200.",
          },
          since: {
            type: "number",
            description:
              "Epoch ms; entries with `ts > since` are returned. Omit for the full tail.",
          },
          kind: {
            type: "string",
            description:
              "Exact audit kind to filter by (install / uninstall / host-call / config-set / panel-bridge / hook).",
          },
          sessionId: {
            type: "string",
            description:
              "Forward-compat sessionId filter — v1 audit entries do not include sessionId so passing this returns no rows. Will become useful once session-scoped audit kinds (e.g. session-start / session-stop) are added.",
          },
        },
      },
      outputSchema: {
        type: "object",
        required: ["entries"],
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              required: ["kind", "ts", "seq"],
              properties: {
                kind: { type: "string" },
                ts: { type: "number" },
                seq: { type: "number" },
                outcome: { type: "string" },
              },
            },
          },
          path: { type: "string" },
        },
      },
      handler: async (args) => {
        const limit = (() => {
          const v = args["limit"];
          if (typeof v === "number" && v > 0) return Math.min(v, 200);
          return 50;
        })();
        const since =
          typeof args["since"] === "number" ? (args["since"] as number) : null;
        const kindFilter =
          typeof args["kind"] === "string" ? (args["kind"] as string) : null;
        const sessionIdFilter =
          typeof args["sessionId"] === "string" && args["sessionId"].length > 0
            ? (args["sessionId"] as string)
            : null;
        const entries = readAuditTail({
          limit,
          since,
          kind: kindFilter,
          sessionId: sessionIdFilter,
        });
        return { structuredContent: { entries, path: defaultAuditLogPath() } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Phase M5 — audit-log tail helper
//
// Reads `~/.rn-dev/audit.log` (NDJSON, HMAC-chained — chain verification is
// out of scope here; that's `AuditLog.verify()`). Returns the most-recent
// `limit` entries in chronological order (oldest → newest after reverse).
// Missing file → empty array (a fresh install has never written audit).
//
// Mirrors `readHookAuditTail` in tools-hooks.ts; lifted here because
// audit-tail is generic across all kinds (not hook-specific).
// ---------------------------------------------------------------------------

function defaultAuditLogPath(): string {
  return join(homedir(), ".rn-dev", "audit.log");
}

interface ReadAuditTailOpts {
  limit: number;
  since: number | null;
  kind: string | null;
  sessionId: string | null;
  auditLogPath?: string;
}

export function readAuditTail(opts: ReadAuditTailOpts): Record<string, unknown>[] {
  const path = opts.auditLogPath ?? defaultAuditLogPath();
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");
  const matches: Record<string, unknown>[] = [];

  // Walk lines newest → oldest so we can stop as soon as we've gathered
  // `limit` matches. Reverse at the end so the agent sees chronological
  // order, matching readHookAuditTail.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (opts.kind && e["kind"] !== opts.kind) continue;
    if (opts.sessionId && e["sessionId"] !== opts.sessionId) continue;
    if (opts.since !== null) {
      const ts = typeof e["ts"] === "number" ? (e["ts"] as number) : 0;
      if (ts <= opts.since) continue;
    }
    matches.push(e);
    if (matches.length >= opts.limit) break;
  }
  return matches.reverse();
}

// ---------------------------------------------------------------------------
// Shared IPC helpers used by the `modules/*` lifecycle + config tool surface.
// The MCP server runs out-of-process from the host; these helpers wrap the
// unix-socket send + the common "no session" ToolResult.
// ---------------------------------------------------------------------------

function ipcAction(
  ctx: McpContext,
  action: string,
  payload?: unknown
): Promise<IpcMessage | null> {
  // Phase M1 — `modules/*` + `marketplace/*` are daemon-global; any
  // attached session's subscribe socket works. resolveAnySession picks
  // the default session if set, otherwise an arbitrary first entry.
  const anySession = resolveAnySession(ctx);
  if (!anySession) return Promise.resolve(null);
  return anySession.session.client
    .send({
      type: "command",
      action,
      payload,
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
    .catch(() => null);
}

function noSessionError(): ToolResult {
  return {
    isError: true,
    structuredContent: { error: "no-session", message: "No running rn-dev session. Start one with `rn-dev start`." },
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { error: "no-session", message: "No running rn-dev session. Start one with `rn-dev start`." },
          null,
          2
        ),
      },
    ],
  };
}

function okResult(structuredContent: Record<string, unknown>): ToolResult {
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Phase 3a — module lifecycle MCP tools.
//
// These talk to the daemon's `modules-ipc` dispatcher (see
// `src/app/modules-ipc.ts`). If there is no daemon running, every tool
// returns `{ isError: true, ... }` with a clear "no session" message —
// exactly the same posture as the devtools-network-* tools.
// ---------------------------------------------------------------------------

function buildModulesLifecycleTools(ctx: McpContext): ToolDefinition[] {
  // Match createToolDefinitions' default — a context without flags is
  // treated as the safe (non-destructive) posture.
  const flags: McpFlags = ctx.flags ?? {
    enabledModules: new Set<string>(),
    disabledModules: new Set<string>(),
    allowDestructiveTools: false,
  };
  return [
    {
      name: "rn-dev/modules-list",
      description:
        "List installed rn-dev modules (3p + built-in) with current lifecycle state (inert|spawning|handshaking|active|updating|restarting|crashed|failed|stopping).",
      inputSchema: {
        type: "object",
        properties: {},
      },
      outputSchema: {
        type: "object",
        required: ["modules"],
        properties: {
          modules: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "version", "scope", "scopeUnit", "state", "isBuiltIn"],
              properties: {
                id: { type: "string" },
                version: { type: "string" },
                scope: {
                  type: "string",
                  enum: ["global", "per-worktree", "workspace"],
                },
                scopeUnit: { type: "string" },
                state: { type: "string" },
                isBuiltIn: { type: "boolean" },
                pid: { type: ["number", "null"] },
                lastCrashReason: { type: ["string", "null"] },
              },
            },
          },
        },
      },
      handler: async () => {
        const resp = await ipcAction(ctx, "modules/list", {});
        if (!resp) return noSessionError();
        return okResult(resp.payload as Record<string, unknown>);
      },
    },
    {
      name: "rn-dev/modules-status",
      description:
        "Get lifecycle state + last-crash reason for a specific module. Returns null when the module id is unknown.",
      inputSchema: {
        type: "object",
        required: ["moduleId"],
        properties: {
          moduleId: { type: "string" },
          scopeUnit: {
            type: "string",
            description:
              "Optional — disambiguates per-worktree modules. Omit to match any scope.",
          },
        },
      },
      handler: async (args) => {
        // The MCP SDK does not enforce inputSchema.required server-side,
        // so a missing moduleId used to fall through to the daemon and
        // come back as a bare `{found:false}` — indistinguishable from
        // "module exists but isn't loaded" (2026-06-11 battle-test
        // confusion). Reject with usage guidance instead.
        if (typeof args.moduleId !== "string" || args.moduleId.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: 'rn-dev/modules-status requires { moduleId } (e.g. "devtools-network"). Use rn-dev/modules-list to see loaded modules.',
              },
            ],
          } satisfies ToolResult;
        }
        const resp = await ipcAction(ctx, "modules/status", args);
        if (!resp) return noSessionError();
        return okResult(
          (resp.payload as Record<string, unknown>) ?? { moduleId: args.moduleId, found: false },
        );
      },
    },
    {
      name: "rn-dev/modules-restart",
      description:
        "Manually restart a module. Exposes the GUI 'Retry' button to agents — useful when a module is in the FAILED state and the user has fixed the underlying cause.",
      inputSchema: {
        type: "object",
        required: ["moduleId"],
        properties: {
          moduleId: { type: "string" },
          scopeUnit: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          pid: { type: "number" },
          error: { type: "string" },
        },
      },
      handler: async (args) => {
        const resp = await ipcAction(ctx, "modules/restart", args);
        if (!resp) return noSessionError();
        const payload = resp.payload as Record<string, unknown>;
        if (payload && typeof payload.error === "string") {
          return {
            isError: true,
            structuredContent: payload,
            content: [
              { type: "text" as const, text: `modules/restart error: ${payload.error}` },
            ],
          };
        }
        return okResult(payload);
      },
    },
    {
      name: "rn-dev/modules-enable",
      description:
        "Enable a previously-disabled module. Removes the persistent disabled.flag file and re-registers the module in inert state; it will spawn on first tools/call.",
      inputSchema: {
        type: "object",
        required: ["moduleId"],
        properties: {
          moduleId: { type: "string" },
          scopeUnit: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          alreadyEnabled: { type: "boolean" },
          state: { type: ["string", "null"] },
          error: { type: "string" },
        },
      },
      handler: async (args) => {
        const resp = await ipcAction(ctx, "modules/enable", args);
        if (!resp) return noSessionError();
        const payload = resp.payload as Record<string, unknown>;
        if (payload && typeof payload.error === "string") {
          return {
            isError: true,
            structuredContent: payload,
            content: [
              { type: "text" as const, text: `modules/enable error: ${payload.error}` },
            ],
          };
        }
        return okResult(payload);
      },
    },
    {
      name: "rn-dev/modules-disable",
      description:
        "Disable a module persistently. Writes the disabled.flag file, shuts down the running subprocess (if any), and removes the module from the manifest map so its tools stop surfacing in tools/list at the next snapshot.",
      inputSchema: {
        type: "object",
        required: ["moduleId"],
        properties: {
          moduleId: { type: "string" },
          scopeUnit: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          alreadyDisabled: { type: "boolean" },
          error: { type: "string" },
        },
      },
      handler: async (args) => {
        const resp = await ipcAction(ctx, "modules/disable", args);
        if (!resp) return noSessionError();
        const payload = resp.payload as Record<string, unknown>;
        if (payload && typeof payload.error === "string") {
          return {
            isError: true,
            structuredContent: payload,
            content: [
              { type: "text" as const, text: `modules/disable error: ${payload.error}` },
            ],
          };
        }
        return okResult(payload);
      },
    },
    {
      name: "rn-dev/modules-config-get",
      description:
        "Read a module's persisted config blob from ~/.rn-dev/modules/<id>/config.json. Returns `{}` when the module has no stored config. Advisory permissions do not gate config reads in v1.",
      inputSchema: {
        type: "object",
        required: ["moduleId"],
        properties: {
          moduleId: { type: "string" },
          scopeUnit: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        required: ["moduleId", "config"],
        properties: {
          moduleId: { type: "string" },
          config: { type: "object" },
          error: { type: "string" },
        },
      },
      handler: async (args) => {
        const resp = await ipcAction(ctx, "modules/config/get", args);
        if (!resp) return noSessionError();
        const payload = resp.payload as Record<string, unknown>;
        if (payload && typeof payload.error === "string") {
          return {
            isError: true,
            structuredContent: payload,
            content: [
              { type: "text" as const, text: `modules/config/get error: ${payload.error}` },
            ],
          };
        }
        return okResult(payload);
      },
    },
    {
      name: "rn-dev/modules-config-set",
      description:
        "Shallow-merge `patch` into a module's persisted config, validate the result against the module's contributed JSON Schema, and atomically write to ~/.rn-dev/modules/<id>/config.json. Emits config-changed to live subscribers and pushes a config/changed notification to the running subprocess. Returns E_CONFIG_VALIDATION on schema failure. Destructive: flipping module security toggles (e.g. devtools-network `captureBodies`) can weaken the session's privacy posture — re-call with { permissionsAccepted: [\"rn-dev/modules-config-set\"] } or start the MCP server with --allow-destructive-tools.",
      inputSchema: {
        type: "object",
        required: ["moduleId", "patch"],
        properties: {
          moduleId: { type: "string" },
          scopeUnit: { type: "string" },
          patch: {
            type: "object",
            description: "Shallow-merged into the current config before validation.",
          },
          permissionsAccepted: {
            type: "array",
            items: { type: "string" },
            description: "Pass [\"rn-dev/modules-config-set\"] to confirm a destructive-hinted write.",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["ok", "error"] },
          config: { type: "object" },
          code: { type: "string" },
          message: { type: "string" },
        },
      },
      handler: async (args) => {
        if (!flags.allowDestructiveTools) {
          const accepted = Array.isArray(args.permissionsAccepted)
            ? args.permissionsAccepted.filter((v): v is string => typeof v === "string")
            : [];
          if (!accepted.includes("rn-dev/modules-config-set")) {
            return {
              isError: true,
              structuredContent: {
                kind: "error",
                code: "E_DESTRUCTIVE_REQUIRES_CONFIRM",
                message:
                  'rn-dev/modules-config-set is destructive: re-call with { permissionsAccepted: ["rn-dev/modules-config-set"] } or start MCP with --allow-destructive-tools.',
              },
              content: [
                {
                  type: "text" as const,
                  text: 'rn-dev/modules-config-set requires { permissionsAccepted: ["rn-dev/modules-config-set"] } or --allow-destructive-tools.',
                },
              ],
            } satisfies ToolResult;
          }
        }
        const { permissionsAccepted: _ignored, ...payloadArgs } = args as {
          permissionsAccepted?: unknown;
        } & Record<string, unknown>;
        const resp = await ipcAction(ctx, "modules/config/set", payloadArgs);
        if (!resp) return noSessionError();
        const payload = resp.payload as Record<string, unknown>;
        if (
          payload &&
          typeof payload.kind === "string" &&
          payload.kind === "error"
        ) {
          return {
            isError: true,
            structuredContent: payload,
            content: [
              {
                type: "text" as const,
                text: `modules/config/set ${String(payload.code)}: ${String(payload.message)}`,
              },
            ],
          };
        }
        return okResult(payload);
      },
    },
    {
      // Phase 10 P1-3 — agent discoverability meta-tool. Agents that fail
      // to find a capability via `tools/list` (e.g. they need "network
      // capture" but devtools-network is not installed) now have a
      // canonical probe: call `rn-dev/modules-available`, scan for the
      // entry whose `description` matches, then call the user-facing
      // install flow. Without this, agents would have to guess module
      // names or ask the user to wire things up.
      name: "rn-dev/modules-available",
      description:
        "Discover rn-dev modules available in the curated registry (installed + installable). Returns one entry per module with { id, description, permissions, installed, installedVersion, installedState }. Use this when `tools/list` doesn't surface the capability you need — the entry's `description` tells you what the module does, and `installed: false` means the user can install it via the Marketplace panel. Read-only; safe to call without consent.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description:
              "Optional case-insensitive substring match against each entry's id + description. Omit to return everything.",
          },
          installedOnly: {
            type: "boolean",
            description:
              "When true, return only entries already installed. Defaults to false (include installable entries too).",
          },
        },
      },
      outputSchema: {
        type: "object",
        required: ["entries"],
        properties: {
          registryUrl: { type: "string" },
          registrySha256: { type: "string" },
          entries: {
            type: "array",
            items: {
              type: "object",
              required: [
                "id",
                "description",
                "permissions",
                "installed",
              ],
              properties: {
                id: { type: "string" },
                description: { type: "string" },
                author: { type: "string" },
                version: { type: "string" },
                permissions: {
                  type: "array",
                  items: { type: "string" },
                },
                homepage: { type: "string" },
                installed: { type: "boolean" },
                installedVersion: { type: "string" },
                installedState: { type: "string" },
              },
            },
          },
        },
      },
      handler: async (args) => {
        const resp = await ipcAction(ctx, "marketplace/list", {});
        if (!resp) return noSessionError();
        const payload = resp.payload as Record<string, unknown>;
        if (
          payload &&
          typeof payload["kind"] === "string" &&
          payload["kind"] === "error"
        ) {
          return {
            isError: true,
            structuredContent: payload,
            content: [
              {
                type: "text" as const,
                text: `modules-available ${String(payload["code"])}: ${String(payload["message"])}`,
              },
            ],
          };
        }
        // Phase 11 Kieran P2-c — tighten payload parsing. The IPC payload
        // is typed as `Record<string, unknown>` on the wire; a rogue
        // daemon reply (or a schema drift we haven't noticed) must not
        // leak undefined fields into the MCP output. Guard every field
        // and drop entries that fail the shape check.
        const rawEntries = Array.isArray(payload["entries"])
          ? (payload["entries"] as unknown[])
          : [];
        const filter =
          typeof args?.["filter"] === "string"
            ? (args["filter"] as string).toLowerCase().trim()
            : "";
        const installedOnly = args?.["installedOnly"] === true;
        const entries = rawEntries
          .map((raw): ModulesAvailableEntry | null => toAvailableEntry(raw))
          .filter((e): e is ModulesAvailableEntry => e !== null)
          .filter((e) => {
            if (installedOnly && !e.installed) return false;
            if (!filter) return true;
            return (
              e.id.toLowerCase().includes(filter) ||
              e.description.toLowerCase().includes(filter)
            );
          });
        return okResult({
          registryUrl:
            typeof payload["registryUrl"] === "string"
              ? payload["registryUrl"]
              : undefined,
          registrySha256:
            typeof payload["registrySha256"] === "string"
              ? payload["registrySha256"]
              : undefined,
          entries,
        });
      },
    },
  ];
}

