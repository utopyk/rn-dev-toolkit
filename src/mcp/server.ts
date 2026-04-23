import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createToolDefinitions } from "./tools.js";
import type { McpContext, McpFlags, ToolDefinition, ToolResult } from "./tools.js";
import { discoverModuleContributedTools } from "./module-proxy.js";
import { ProfileStore } from "../core/profile.js";
import { ArtifactStore } from "../core/artifact.js";
import { createDefaultPreflightEngine } from "../core/preflight.js";
import { IpcClient, type IpcMessage } from "../core/ipc.js";
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

  // Build context from the current working directory
  const projectRoot = detectProjectRoot(process.cwd()) ?? process.cwd();
  const rnDevDir = path.join(projectRoot, ".rn-dev");

  const ctx: McpContext = {
    projectRoot,
    profileStore: new ProfileStore(path.join(rnDevDir, "profiles")),
    artifactStore: new ArtifactStore(path.join(rnDevDir, "artifacts")),
    metro: null, // MCP server runs standalone, no metro manager
    preflightEngine: createDefaultPreflightEngine(projectRoot),
    ipcClient: new IpcClient(path.join(rnDevDir, "sock")),
    flags,
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

  // Register tools/call handler. Handlers may throw — that's an infrastructure
  // failure (e.g. tool lookup missed). Per-tool logical failures come back as
  // `{ isError: true, ... }` in the ToolResult shape.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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

  // Phase 3d: subscribe to the daemon's module-event stream so we can refresh
  // the tool snapshot and notify connected clients when modules change.
  // Silent best-effort: if no daemon is running we stay on the startup
  // snapshot. Callers can always re-handshake.
  void subscribeToModuleChanges({
    ctx,
    flags,
    notifyToolListChanged: () => server.sendToolListChanged(),
    refreshTools: async () => {
      const next = await discoverModuleContributedTools(ctx, flags);
      moduleTools = next;
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 3d — module-change subscription. Exported for unit tests.
// ---------------------------------------------------------------------------

export interface SubscribeToModuleChangesArgs {
  ctx: McpContext;
  flags: McpFlags;
  notifyToolListChanged: () => Promise<void>;
  refreshTools: () => Promise<void>;
}

export async function subscribeToModuleChanges(
  args: SubscribeToModuleChangesArgs,
): Promise<{ close: () => void } | null> {
  const { ctx, notifyToolListChanged, refreshTools } = args;
  if (!ctx.ipcClient) return null;

  const subscribeMessage: IpcMessage = {
    type: "command",
    action: "modules/subscribe",
    payload: {},
    id: `mcp-subscribe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };

  try {
    const sub = await ctx.ipcClient.subscribe(subscribeMessage, {
      onEvent: async () => {
        try {
          await refreshTools();
        } catch {
          // If the refetch fails (daemon flaky), keep the old snapshot and
          // still notify — a re-handshake by the agent will retry.
        }
        try {
          await notifyToolListChanged();
        } catch {
          // Transport may be closed (client already disconnected).
        }
      },
      onError: () => {
        // Connection hiccup — give up silently; the next MCP session
        // will re-subscribe on startup.
      },
    });
    return { close: sub.close };
  } catch {
    // No daemon, or daemon failed the subscribe handshake. Static tool list
    // is still serviceable — drop the subscription quietly.
    return null;
  }
}
