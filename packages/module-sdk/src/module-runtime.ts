import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type { ModuleManifest } from "./types.js";
import type { Logger } from "./host-rpc.js";
import { SDK_VERSION } from "./index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Host metadata surfaced to tool handlers. Populated from the `initialize`
 * RPC request that the host sends on spawn.
 *
 * Note: this is NOT the same as the `AppInfo` capability exposed via
 * `host.capability<AppInfo>("appInfo")` — that reverse-channel capability
 * lookup isn't wired in v1. For Phase 3d, modules only see capability
 * *names* at initialize time, not values.
 */
export interface ModuleAppInfo {
  capabilities: ReadonlyArray<{
    id: string;
    requiredPermission?: string;
  }>;
  hostVersion: string;
}

/**
 * Per-tool-call context. Created once during `initialize` and reused for
 * every subsequent `tool/<name>` request on the same subprocess.
 */
export interface ModuleToolContext {
  /** Scoped logger; writes go to the host via `log` notifications. */
  log: Logger;
  /** Snapshot of the host handshake params. */
  appInfo: ModuleAppInfo;
  /** Mirrors `appInfo.hostVersion` at the top level for ergonomics. */
  hostVersion: string;
  /** Version of `@rn-dev/module-sdk` the module is linked against. */
  sdkVersion: string;
}

export type ToolHandler<
  Args = Record<string, unknown>,
  Result = unknown,
> = (args: Args, ctx: ModuleToolContext) => Result | Promise<Result>;

export interface RunModuleOptions {
  manifest: ModuleManifest;
  /**
   * Map of tool name → handler. Keys match the manifest's
   * `contributes.mcp.tools[].name` — i.e. `<moduleId>__<tool>` for 3p
   * modules, bare name for built-ins.
   *
   * The runtime strips the `<moduleId>__` prefix when registering the
   * vscode-jsonrpc handler so the wire method is `tool/<tool>`. If a key
   * has no prefix, it registers under `tool/<key>` verbatim.
   */
  tools: Record<string, ToolHandler>;
  /** Invoked once after a successful `initialize` handshake. */
  activate?: (ctx: ModuleToolContext) => void | Promise<void>;
  /** Invoked during `handle.dispose()`. Runs before the connection closes. */
  deactivate?: () => void | Promise<void>;
  /**
   * Contribute extra fields to the `initialize` response. Runs before
   * `activate`; whatever it returns is merged onto `{ moduleId, toolCount,
   * sdkVersion }`. Author-supplied values win on key collision, but
   * clobbering `moduleId` / `sdkVersion` is a bad idea — hosts depend on
   * those for compat gates.
   */
  onInitialize?: (
    params: ModuleAppInfo,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Escape hatch: the raw `vscode-jsonrpc` connection is handed to this
   * callback so authors can register arbitrary request or notification
   * handlers that don't fit the `tool/<name>` pattern. Runs before
   * `connection.listen()`.
   *
   * 99% of modules should leave this unset — the `tools` map is the
   * supported contribution surface. Exposed for fixtures and forward-
   * compat situations the SDK hasn't modeled yet.
   */
  onConnection?: (connection: MessageConnection) => void;
  /** Override `process.stdin`. Tests use this to drive RPC over a pipe. */
  input?: NodeJS.ReadableStream;
  /** Override `process.stdout`. Tests use this to capture RPC output. */
  output?: NodeJS.WritableStream;
}

export interface RunModuleHandle {
  /**
   * Tear down the RPC connection and run the author's `deactivate` hook.
   * In production, modules are killed by the host (SIGTERM/SIGKILL) and
   * don't need to call this. Tests use it to release stream resources.
   */
  dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// runModule
// ---------------------------------------------------------------------------

/**
 * Entry point for module subprocesses. Wires `initialize` + every
 * `tool/<name>` request to the author's handlers over vscode-jsonrpc
 * Content-Length framing on stdio.
 *
 * Returns a handle synchronously — the handshake resolves the first time
 * the host sends `initialize`. Calling `dispose()` early aborts the
 * connection before initialize completes.
 *
 * ```ts
 * runModule({
 *   manifest,
 *   tools: {
 *     "my-mod__greet": (args, ctx) => {
 *       ctx.log.info(`greeting ${String(args.who)}`);
 *       return { message: `hi ${args.who}` };
 *     },
 *   },
 *   activate: (ctx) => ctx.log.info("my-mod activated"),
 * });
 * ```
 */
export function runModule(opts: RunModuleOptions): RunModuleHandle {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  const reader = new StreamMessageReader(input);
  const writer = new StreamMessageWriter(output);
  const connection = createMessageConnection(reader, writer);
  const log = createLogger(connection);

  let ctx: ModuleToolContext | null = null;

  connection.onRequest("initialize", async (params: unknown) => {
    const parsed = normalizeInitializeParams(params);
    ctx = {
      log,
      appInfo: parsed,
      hostVersion: parsed.hostVersion,
      sdkVersion: SDK_VERSION,
    };
    const extras = opts.onInitialize ? await opts.onInitialize(parsed) : {};
    if (opts.activate) {
      await opts.activate(ctx);
    }
    const toolCount = opts.manifest.contributes?.mcp?.tools?.length ?? 0;
    return {
      moduleId: opts.manifest.id,
      toolCount,
      sdkVersion: SDK_VERSION,
      ...extras,
    };
  });

  const prefix = `${opts.manifest.id}__`;
  for (const [toolName, handler] of Object.entries(opts.tools)) {
    const bare = toolName.startsWith(prefix)
      ? toolName.slice(prefix.length)
      : toolName;
    const wireMethod = `tool/${bare}`;
    connection.onRequest(wireMethod, async (params: unknown) => {
      const effective =
        ctx ??
        fallbackContext(log, opts.manifest.contributes?.mcp?.tools?.length ?? 0);
      return handler(
        (params ?? {}) as Record<string, unknown>,
        effective,
      );
    });
  }

  if (opts.onConnection) {
    opts.onConnection(connection);
  }

  connection.listen();

  return {
    dispose: async () => {
      try {
        if (opts.deactivate) {
          await opts.deactivate();
        }
      } finally {
        connection.dispose();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function createLogger(connection: MessageConnection): Logger {
  const send = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    void connection.sendNotification("log", { level, message, data });
  };
  return {
    debug: (msg, data) => send("debug", msg, data),
    info: (msg, data) => send("info", msg, data),
    warn: (msg, data) => send("warn", msg, data),
    error: (msg, data) => send("error", msg, data),
  };
}

function normalizeInitializeParams(raw: unknown): ModuleAppInfo {
  const params =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawCapabilities = Array.isArray(params.capabilities)
    ? params.capabilities
    : [];
  const capabilities = rawCapabilities
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => {
      const id = typeof c.id === "string" ? c.id : "";
      const requiredPermission =
        typeof c.requiredPermission === "string"
          ? c.requiredPermission
          : undefined;
      return { id, requiredPermission };
    })
    .filter((c) => c.id.length > 0);
  const hostVersion =
    typeof params.hostVersion === "string" ? params.hostVersion : "0.0.0";
  return { capabilities, hostVersion };
}

/**
 * A tool request that arrives before `initialize` is extraordinary (the host
 * handshakes first by contract). We surface a minimal context so handlers
 * can still log a diagnostic instead of crashing the subprocess.
 */
function fallbackContext(log: Logger, _toolCount: number): ModuleToolContext {
  return {
    log,
    appInfo: { capabilities: [], hostVersion: "0.0.0" },
    hostVersion: "0.0.0",
    sdkVersion: SDK_VERSION,
  };
}
