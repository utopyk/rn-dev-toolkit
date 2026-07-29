import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createToolDefinitions } from "./tools.js";
import type {
  McpContext,
  McpFlags,
  McpSessionRecord,
  OpenProjectResult,
  ToolDefinition,
  ToolResult,
} from "./tools.js";
import { recordOpenedProject } from "../core/recent-projects.js";
import { discoverModuleContributedTools } from "./module-proxy.js";
import { ProfileStore } from "../core/profile.js";
import { ArtifactStore } from "../core/artifact.js";
import { createDefaultPreflightEngine } from "../core/preflight.js";
import { connectToDaemonSession } from "../app/client/session.js";
import {
  DEFAULT_IDLE_RELEASE_MS,
  IDLE_CHECK_INTERVAL_MS,
  IdleTracker,
  resolveIdleReleaseMs,
} from "./idle-release.js";
import { type SessionId } from "../core/identifiers.js";
import { detectProjectRoot } from "../core/project.js";

/**
 * Parse MCP flags out of `process.argv`. Kept argv-driven to avoid pulling
 * commander into the MCP server.
 *
 * Module-system flags (Phase 3a):
 *   --enable-module:<id>      enable a specific module (repeatable); when
 *                             this AND --disable-module are both empty,
 *                             every loaded module is enabled.
 *   --disable-module:<id>     disable a specific module (repeatable);
 *                             wins over --enable-module for the same id.
 *   --allow-destructive-tools  permit `destructiveHint: true` tools to run
 *                              without per-call confirmation (headless
 *                              consent). Phase 3b enforces at tools/call.
 *
 * Phase 9 retired the `--enable-devtools-mcp` / `--mcp-capture-bodies`
 * flags when the DevTools Network tools moved into the 3p
 * `@rn-dev-modules/devtools-network` module. Body pass-through is now
 * controlled by that module's `captureBodies` config.
 */
export function parseFlags(argv: readonly string[]): McpFlags {
  return {
    enabledModules: collectPrefixed(argv, "--enable-module:"),
    disabledModules: collectPrefixed(argv, "--disable-module:"),
    allowDestructiveTools: argv.includes("--allow-destructive-tools"),
  };
}

function collectPrefixed(
  argv: readonly string[],
  prefix: string,
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      const id = arg.slice(prefix.length).trim();
      if (id) set.add(id);
    }
  }
  return set;
}

/**
 * Best-effort narrowing of a handler's return value into the MCP
 * `CallToolResult` shape. Handlers either return:
 *   (a) plain data — legacy path; wrapped as a single text block.
 *   (b) a ToolResult — new path; structuredContent + isError respected.
 */
function toCallToolResult(
  raw: unknown
): { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } {
  if (raw && typeof raw === "object") {
    const maybe = raw as ToolResult;
    const hasStructured = maybe.structuredContent !== undefined;
    const hasContent = Array.isArray(maybe.content);
    const hasIsError = typeof maybe.isError === "boolean";
    if (hasStructured || hasContent || hasIsError) {
      const content =
        maybe.content ??
        (maybe.structuredContent
          ? [
              {
                type: "text" as const,
                text: JSON.stringify(maybe.structuredContent, null, 2),
              },
            ]
          : [{ type: "text" as const, text: "" }]);
      return {
        content,
        ...(maybe.structuredContent !== undefined && {
          structuredContent: maybe.structuredContent,
        }),
        ...(maybe.isError !== undefined && { isError: maybe.isError }),
      };
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(raw, null, 2) }],
  };
}

export async function startMcpServer(argv: readonly string[] = process.argv): Promise<void> {
  const flags = parseFlags(argv);

  const server = new Server(
    { name: "rn-dev-cli", version: "0.1.0" },
    // Phase 3d: declare `tools.listChanged` so connected clients know we may
    // emit `notifications/tools/list_changed` after module installs / crashes.
    { capabilities: { tools: { listChanged: true } } }
  );

  // Build context from the current working directory. `projectRoot` is a
  // `let`, not a `const`: `rn-dev/open-project` re-scopes the server to a
  // different project at runtime (the MCP analogue of the Electron picker),
  // and `connectSession` below reads it live so post-switch boots target
  // the new project.
  let projectRoot = detectProjectRoot(process.cwd()) ?? process.cwd();
  const rnDevDir = path.join(projectRoot, ".rn-dev");

  const profileStore = new ProfileStore(path.join(rnDevDir, "profiles"));
  // Resolve a profile for connectToDaemonSession: prefer the first
  // `isDefault === true` entry, then any entry, then null (degrade to
  // built-ins-only mode — same posture as the old IpcClient-null fallback).
  const profiles = profileStore.list();
  const profile = profiles.find((p) => p.isDefault) ?? profiles[0] ?? null;

  // Bug 6 — explicit allowlist (not `session/*` glob) so a future
  // `session/error` event with a sensitive payload doesn't auto-leak
  // into MCP's process address space. Security P1-3 on PR #27. Add new
  // entries here when the daemon emits new session-level kinds and the
  // MCP tool surface needs them.
  //
  // M2a — `builder/*` added so rn-dev/build-status can surface build
  // progress (line/progress/done) to agents that polled after kicking
  // the build off via rn-dev/build. builder events carry only
  // build-process telemetry (xcodebuild stdout, gradle phases, error
  // diagnostics) — no sensitive payloads, so the allowlist expansion is
  // bounded.
  //
  // Hoisted to a helper because the reconnect path (below) re-runs the
  // exact same connect — the kinds allowlist must never drift between
  // boot and reconnect.
  const connectSession = (p: NonNullable<typeof profile>) =>
    connectToDaemonSession(projectRoot, p, {
      kinds: ["modules/*", "session/log", "session/status", "builder/*"],
    });

  // Phase M1 — multi-session shell. The boot path attaches at most one
  // session today (the profile MCP discovered at startup); M3 will let
  // an agent open additional sessions via `rn-dev/start-session
  // { profileName }`. Each entry's `.session.sessionId` carries the
  // server-minted SessionId that keys this map.
  const sessions = new Map<SessionId, McpSessionRecord>();
  let defaultSessionId: SessionId | null = null;
  if (profile) {
    try {
      const session = await connectSession(profile);
      sessions.set(session.sessionId, { session, profile });
      defaultSessionId = session.sessionId;
    } catch (err) {
      // Degrade to built-ins-only mode (mirrors the old IpcClient-null
      // fallback) — but NEVER silently. A swallowed E_PORT_CONFLICT here
      // (default profile's port owned by a session booted under another
      // profile) left the MCP sessionless with no signal anywhere, and
      // agents then chased "no session" ghosts. stderr lands in the MCP
      // client's log surface.
      console.error(
        `rn-dev mcp: could not attach default session (profile "${profile.name}"): ` +
          `${err instanceof Error ? err.message : String(err)} — running built-ins-only; ` +
          `use rn-dev/start-session to attach manually.`,
      );
    }
  }

  const ctx: McpContext = {
    projectRoot,
    profileStore,
    artifactStore: new ArtifactStore(path.join(rnDevDir, "artifacts")),
    metro: null, // MCP server runs standalone, no metro manager
    preflightEngine: createDefaultPreflightEngine(projectRoot),
    sessions,
    defaultSessionId,
    flags,
    bootProfile: profile,
    // attachSession is wired below after `refreshModuleTools` is defined
    // so the new session immediately participates in tools/listChanged.
  };

  const builtInTools = createToolDefinitions(ctx);
  // Phase 3b: snapshot module-contributed tools from the daemon at startup.
  // If the daemon is unreachable we degrade to built-ins only — mirroring
  // the devtools-network-* fallback.
  const initialModuleTools = await discoverModuleContributedTools(ctx, flags);
  // Phase 3d: the module tool set is mutable. `modules/subscribe` drives
  // refreshes; `tools/list` reads this array on every call.
  let moduleTools: ToolDefinition[] = initialModuleTools;

  // Register tools/list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [...builtInTools, ...moduleTools];
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.outputSchema && { outputSchema: t.outputSchema }),
      })),
    };
  });

  // -------------------------------------------------------------------
  // Idle auto-release (see src/mcp/idle-release.ts for the full why).
  // A parked Claude window's MCP must not pin daemon sessions/Metro
  // ports forever: after `idleReleaseMs` without a tool call we
  // voluntarily disconnect every session (dropping the daemon-side
  // refcount — last client out tears the session down and frees its
  // port) and remember the profiles. The next tool call re-attaches
  // via boot-or-join before dispatching, so an agent coming back to a
  // parked window sees at most one slower first call, never an error.
  // Voluntary disconnects don't trigger wireSessionReconnect (it only
  // fires on unexpected socket death), so release and auto-reconnect
  // can't fight each other.
  // -------------------------------------------------------------------
  const idleReleaseMs = resolveIdleReleaseMs();
  const idleTracker = new IdleTracker(idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS);
  const releasedProfiles: McpSessionRecord["profile"][] = [];
  let reattachInFlight: Promise<void> | null = null;
  const reattachReleased = (): Promise<void> => {
    if (releasedProfiles.length === 0 && !reattachInFlight) {
      return Promise.resolve();
    }
    if (!reattachInFlight) {
      reattachInFlight = (async () => {
        const toRestore = releasedProfiles.splice(0, releasedProfiles.length);
        for (const p of toRestore) {
          try {
            const session = await connectSession(p);
            const record: McpSessionRecord = { session, profile: p };
            if (ctx.attachSession) {
              ctx.attachSession(record);
            } else {
              ctx.sessions.set(session.sessionId, record);
              if (!ctx.defaultSessionId) ctx.defaultSessionId = session.sessionId;
            }
            console.error(
              `rn-dev mcp: re-attached idle-released session (profile "${p.name}" -> ${session.sessionId})`,
            );
          } catch {
            // Daemon unreachable — keep the profile queued so the next
            // tool call retries instead of losing the session forever.
            releasedProfiles.push(p);
          }
        }
        reattachInFlight = null;
      })();
    }
    return reattachInFlight;
  };

  // Register tools/call handler. Handlers may throw — that's an infrastructure
  // failure (e.g. tool lookup missed). Per-tool logical failures come back as
  // `{ isError: true, ... }` in the ToolResult shape.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    idleTracker.touch();
    await reattachReleased();
    const tools = [...builtInTools, ...moduleTools];
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    try {
      const raw = await tool.handler(
        (request.params.arguments as Record<string, unknown>) ?? {}
      );
      return toCallToolResult(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Phase 13.6 PR-C: subscribe to the daemon's module-event stream via
  // each session's ModuleHostClient (which receives modules/* events
  // from the events/subscribe channel opened by connectToDaemonSession).
  // When modules change state we refresh the tool snapshot and notify
  // connected clients. Silent best-effort: if no session is running we
  // stay on the startup snapshot. Callers can always re-handshake.
  //
  // Phase M1 — wire every attached session, not just a singleton. M3
  // will call back into this same loop (factored to `wireSessionEvents`
  // when needed) to attach the listener to newly-created sessions.
  const refreshModuleTools = async (): Promise<void> => {
    try {
      const next = await discoverModuleContributedTools(ctx, flags);
      moduleTools = next;
    } catch {
      // If the refetch fails (daemon flaky), keep the old snapshot and
      // still notify — a re-handshake by the agent will retry.
    }
    try {
      await server.sendToolListChanged();
    } catch {
      // Transport may be closed (client already disconnected).
    }
  };

  const wireSessionEvents = (record: { session: { modules: { on: (kind: "modules-event", listener: () => void) => void } } }): void => {
    record.session.modules.on("modules-event", () => {
      void refreshModuleTools();
    });
  };

  // -------------------------------------------------------------------
  // Auto-reconnect (2026-06 acme battle-test blocker). The subscribe
  // socket opened by connectToDaemonSession is the ONLY transport for
  // every session-scoped RPC — pre-fix, a dead socket (daemon killed,
  // crashed, or upgraded) left every session tool throwing "connection
  // already closed" until the whole MCP client (i.e. Claude Code) was
  // restarted.
  //
  // `disconnected` fires only on UNEXPECTED socket death:
  // `notifyDisconnected` early-returns on voluntaryClose (disconnect/
  // release), and `rn-dev/stop-session` only sends the `session/stop`
  // RPC — the daemon leaves subscriber sockets open on session
  // teardown. So this never resurrects a session an agent intentionally
  // stopped.
  //
  // Recovery is boot-or-join by the record's profile: if the daemon
  // died, connectToDaemonSession cold-spawns a fresh one; if only our
  // socket died, it joins the still-running session. Bounded backoff
  // (~2.5 min total) — if every attempt fails, the record is dropped
  // cleanly and `rn-dev/start-session` remains the manual recovery, with
  // tools reporting "no session" instead of dead-socket errors.
  // -------------------------------------------------------------------
  const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000, 30_000];
  const reconnecting = new Set<SessionId>();

  const wireSessionReconnect = (record: McpSessionRecord): void => {
    const deadId = record.session.sessionId;
    record.session.lifecycle.on("disconnected", () => {
      if (reconnecting.has(deadId)) return;
      reconnecting.add(deadId);
      void (async () => {
        // Drop the dead record immediately so session tools degrade to
        // the honest "no session" error during the retry window instead
        // of "connection already closed".
        ctx.sessions.delete(deadId);
        if (ctx.defaultSessionId === deadId) ctx.defaultSessionId = null;
        try {
          record.session.disconnect();
        } catch {
          // already closed
        }
        console.error(
          `rn-dev mcp: daemon connection lost for session ${deadId} — reconnecting`,
        );

        for (const delayMs of RECONNECT_DELAYS_MS) {
          await new Promise((r) => setTimeout(r, delayMs));
          try {
            const fresh = await connectSession(record.profile);
            const freshRecord: McpSessionRecord = {
              session: fresh,
              profile: record.profile,
            };
            ctx.sessions.set(fresh.sessionId, freshRecord);
            if (ctx.defaultSessionId === null) {
              ctx.defaultSessionId = fresh.sessionId;
            }
            wireSessionEvents(freshRecord);
            wireSessionReconnect(freshRecord);
            void refreshModuleTools();
            console.error(
              `rn-dev mcp: session reconnected (${deadId} -> ${fresh.sessionId})`,
            );
            reconnecting.delete(deadId);
            return;
          } catch {
            // Daemon still down — keep backing off.
          }
        }
        reconnecting.delete(deadId);
        console.error(
          `rn-dev mcp: reconnect attempts for session ${deadId} exhausted — call rn-dev/start-session to recover`,
        );
      })();
    });
  };

  // Phase M3 — when `rn-dev/start-session { profileName }` opens a new
  // session, attach it to the multi-session shell here so the
  // tools/listChanged stream picks up the new session's modules and
  // the new entry surfaces in `rn-dev/list-sessions`.
  ctx.attachSession = (record) => {
    ctx.sessions.set(record.session.sessionId, record);
    if (!ctx.defaultSessionId) {
      ctx.defaultSessionId = record.session.sessionId;
    }
    wireSessionEvents(record);
    wireSessionReconnect(record);
    // Pick up any module the new session contributes that wasn't
    // present in the previous snapshot, and notify connected clients.
    void refreshModuleTools();
  };

  // Project switching — the MCP analogue of the Electron picker. One active
  // project at a time: switching tears down the current sessions, re-scopes
  // the context to the new project, and boots its default profile. Mirrors
  // the GUI's "switch = relaunch the window" model. `connectSession` reads
  // the `projectRoot` `let` live, so post-switch boots target the new root.
  ctx.openProject = async (rawPath: string): Promise<OpenProjectResult> => {
    const root = detectProjectRoot(rawPath);
    if (!root) {
      return {
        ok: false,
        error:
          "That path is not a React Native project (no react-native dependency found in package.json walking up from it).",
      };
    }
    recordOpenedProject(root);

    // Tear down the current project's sessions (switch replaces). The
    // daemon refcount-releases each session when our subscribe socket
    // drops; other clients attached to the same session stay running.
    for (const record of ctx.sessions.values()) {
      try {
        record.session.disconnect();
      } catch {
        // best-effort
      }
    }
    ctx.sessions.clear();
    ctx.defaultSessionId = null;
    // Idle-released sessions belong to the OLD project — re-attaching
    // them after the switch would boot old-project profiles against the
    // new root. Drop them.
    releasedProfiles.length = 0;

    // Re-scope every project-derived dependency to the new root.
    projectRoot = root;
    ctx.projectRoot = root;
    const nextRnDevDir = path.join(root, ".rn-dev");
    ctx.profileStore = new ProfileStore(path.join(nextRnDevDir, "profiles"));
    ctx.artifactStore = new ArtifactStore(path.join(nextRnDevDir, "artifacts"));
    ctx.preflightEngine = createDefaultPreflightEngine(root);

    const nextProfiles = ctx.profileStore.list();
    const nextProfile =
      nextProfiles.find((p) => p.isDefault) ?? nextProfiles[0] ?? null;
    ctx.bootProfile = nextProfile;

    let bootedSessionId: string | null = null;
    if (nextProfile) {
      try {
        const session = await connectSession(nextProfile);
        const record: McpSessionRecord = { session, profile: nextProfile };
        ctx.sessions.set(session.sessionId, record);
        ctx.defaultSessionId = session.sessionId;
        wireSessionEvents(record);
        wireSessionReconnect(record);
        bootedSessionId = session.sessionId;
      } catch {
        // Daemon unreachable for the new project — degrade to
        // built-ins-only (same posture as startup). The agent can retry
        // via rn-dev/start-session once the daemon is reachable.
      }
    }
    // Refresh the tool snapshot for the new session's modules + notify.
    await refreshModuleTools();

    return {
      ok: true,
      projectRoot: root,
      name: path.basename(root),
      profileName: nextProfile?.name ?? null,
      bootedSessionId,
    };
  };

  for (const record of ctx.sessions.values()) {
    wireSessionEvents(record);
    wireSessionReconnect(record);
  }

  // Idle-release timer. `.unref()` so it never keeps the MCP process
  // alive on its own — stdio closing remains the exit signal.
  if (idleReleaseMs !== null) {
    const idleTimer = setInterval(() => {
      if (ctx.sessions.size === 0 || !idleTracker.isIdle()) return;
      const records = [...ctx.sessions.values()];
      console.error(
        `rn-dev mcp: no tool calls for ${Math.round(idleTracker.idleFor() / 60_000)}m — ` +
          `releasing ${records.length} session(s) so this parked window doesn't pin ` +
          `daemon sessions/Metro ports. The next tool call re-attaches automatically.`,
      );
      for (const record of records) {
        if (!releasedProfiles.some((p) => p.name === record.profile.name)) {
          releasedProfiles.push(record.profile);
        }
        try {
          record.session.disconnect();
        } catch {
          // already closed
        }
      }
      ctx.sessions.clear();
      ctx.defaultSessionId = null;
    }, IDLE_CHECK_INTERVAL_MS);
    idleTimer.unref();
  }
}

