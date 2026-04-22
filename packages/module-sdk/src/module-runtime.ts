import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type { ModuleManifest } from "./types.js";
import type { AppInfo, HostApi, Logger } from "./host-rpc.js";
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
  /**
   * Persisted per-module config blob loaded from
   * `~/.rn-dev/modules/<id>/config.json`. Always present: `{}` when the
   * module declares no `contributes.config.schema`, or when no config has
   * been persisted yet. Implemented as a getter by `runModule` — reading
   * `ctx.appInfo.config` (or `ctx.config`, which is a pass-through)
   * always returns the latest persisted value, so `config/changed`
   * notifications are visible without an extra round-trip. Use
   * `onConfigChanged` to react at the moment of change.
   */
  readonly config: Record<string, unknown>;
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
  /**
   * Host API surface — generic capability lookup. `log` and `appInfo` are
   * synthesized locally (no RPC). Everything else proxies to the daemon
   * over `host/call`.
   */
  host: HostApi;
  /**
   * Mirrors `appInfo.config` for ergonomics. Implemented as a getter on
   * the context object — destructuring (`const { config } = ctx`) still
   * gives you a snapshot, but reading `ctx.config` on each tool call
   * (or from an `onConfigChanged` callback) always returns the latest
   * persisted value, including updates delivered via `config/changed`
   * after `activate` has already run.
   */
  readonly config: Record<string, unknown>;
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
   * Invoked whenever the host writes a new config blob via
   * `modules/config/set`. The module process receives a `config/changed`
   * notification (vscode-jsonrpc); this callback fires AFTER the internal
   * `latestConfig` slot has been replaced, so reads of `ctx.config` or
   * `ctx.appInfo.config` from inside the callback return the new value.
   *
   * Notifications arriving before the `initialize` handshake completes
   * are buffered; once `activate` resolves the most-recent buffered
   * value is applied (as if it had arrived just after activation) and
   * the callback fires exactly once for it. Pre-initialize notifications
   * that get superseded in the buffer window are dropped — they were
   * never observable anyway.
   */
  onConfigChanged?: (config: Record<string, unknown>) => void | Promise<void>;
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
  // `latestConfig` is the single source of truth; `ctx.config` and
  // `ctx.appInfo.config` both read it through getters so authors who
  // close over the context see the current value, not a stale reference.
  let latestConfig: Record<string, unknown> = {};
  let initialized = false;
  // Buffer a config/changed notification that races ahead of the
  // initialize handshake — the doc promises "notifications arriving
  // before handshake are buffered until activate completes", so honor it.
  let pendingConfig: Record<string, unknown> | null = null;

  connection.onRequest("initialize", async (params: unknown) => {
    const parsed = normalizeInitializeParams(params);
    latestConfig = parsed.config;
    const host = createHostApi(connection, {
      log,
      appInfo: parsed,
      manifest: opts.manifest,
    });

    // `appInfo.config` mirrors `ctx.config` — both readthrough getters so
    // code that stashes `const {config} = ctx` or `const {appInfo} = ctx`
    // at activation time still sees post-`config/changed` values.
    const appInfoView: ModuleAppInfo = Object.defineProperty(
      { ...parsed } as ModuleAppInfo,
      "config",
      {
        get: () => latestConfig,
        enumerable: true,
        configurable: false,
      },
    );
    const ctxLocal: ModuleToolContext = {
      log,
      appInfo: appInfoView,
      hostVersion: parsed.hostVersion,
      sdkVersion: SDK_VERSION,
      host,
      // Placeholder; replaced by the getter below before anyone reads it.
      config: latestConfig,
    };
    Object.defineProperty(ctxLocal, "config", {
      get: () => latestConfig,
      enumerable: true,
      configurable: false,
    });
    ctx = ctxLocal;

    const extras = opts.onInitialize ? await opts.onInitialize(parsed) : {};
    if (opts.activate) {
      await opts.activate(ctx);
    }
    initialized = true;

    // Flush any config/changed notification that arrived before activate
    // completed. Fires onConfigChanged exactly once for the buffered value.
    if (pendingConfig !== null) {
      const flush = pendingConfig;
      pendingConfig = null;
      latestConfig = flush;
      fireConfigChanged(flush);
    }

    const toolCount = opts.manifest.contributes?.mcp?.tools?.length ?? 0;
    return {
      moduleId: opts.manifest.id,
      toolCount,
      sdkVersion: SDK_VERSION,
      ...extras,
    };
  });

  connection.onNotification("config/changed", (rawConfig: unknown) => {
    const nextConfig = coerceConfig(rawConfig);
    if (!initialized) {
      // Buffer — the initialize handler flushes after activate resolves.
      // Only the most recent pending value is kept; intermediate updates
      // that arrive in the same pre-initialize window would never have
      // been observable anyway.
      pendingConfig = nextConfig;
      return;
    }
    latestConfig = nextConfig;
    fireConfigChanged(nextConfig);
  });

  function fireConfigChanged(config: Record<string, unknown>): void {
    if (!opts.onConfigChanged) return;
    void Promise.resolve(opts.onConfigChanged(config)).catch((err) => {
      log.error("onConfigChanged threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  const prefix = `${opts.manifest.id}__`;
  for (const [toolName, handler] of Object.entries(opts.tools)) {
    const bare = toolName.startsWith(prefix)
      ? toolName.slice(prefix.length)
      : toolName;
    const wireMethod = `tool/${bare}`;
    connection.onRequest(wireMethod, async (params: unknown) => {
      const effective =
        ctx ??
        fallbackContext(
          log,
          opts.manifest.contributes?.mcp?.tools?.length ?? 0,
          connection,
          opts.manifest,
        );
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
  const config = coerceConfig(params.config);
  return { capabilities, hostVersion, config };
}

function coerceConfig(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * A tool request that arrives before `initialize` is extraordinary (the host
 * handshakes first by contract). We surface a minimal context so handlers
 * can still log a diagnostic instead of crashing the subprocess.
 */
function fallbackContext(
  log: Logger,
  _toolCount: number,
  connection: MessageConnection,
  manifest: ModuleManifest,
): ModuleToolContext {
  const appInfo: ModuleAppInfo = {
    capabilities: [],
    hostVersion: "0.0.0",
    config: {},
  };
  return {
    log,
    appInfo,
    hostVersion: "0.0.0",
    sdkVersion: SDK_VERSION,
    host: createHostApi(connection, { log, appInfo, manifest }),
    config: {},
  };
}

// ---------------------------------------------------------------------------
// HostApi — ctx.host.capability<T>(id)
// ---------------------------------------------------------------------------

interface HostApiContext {
  log: Logger;
  appInfo: ModuleAppInfo;
  manifest: ModuleManifest;
}

/**
 * Build the `HostApi` surface exposed on `ctx.host`. Lookup is synchronous:
 *   - `"log"` and `"appInfo"` are synthesized locally (no round-trip).
 *   - Other ids are permission-checked against the descriptor set the host
 *     sent at `initialize`. Pass → return a Proxy whose property access
 *     dispatches `host/call` RPC. Fail (unknown id or missing permission)
 *     → return `null`, matching `HostApi.capability`'s `T | null` contract.
 *
 * The daemon-side `attachHostRpc` enforces the same gate as a defense-in-
 * depth check; a malicious module bypassing this SDK proxy still gets
 * rejected server-side.
 */
function createHostApi(
  connection: MessageConnection,
  ctx: HostApiContext,
): HostApi {
  const granted = ctx.manifest.permissions ?? [];
  const appInfo: AppInfo = {
    hostVersion: ctx.appInfo.hostVersion,
    platform: process.platform,
    worktreeKey: null,
  };

  return {
    capability<T>(id: string): T | null {
      if (id === "log") return ctx.log as unknown as T;
      if (id === "appInfo") return appInfo as unknown as T;

      const descriptor = ctx.appInfo.capabilities.find((c) => c.id === id);
      if (!descriptor) return null;
      if (
        descriptor.requiredPermission &&
        !granted.includes(descriptor.requiredPermission)
      ) {
        return null;
      }

      return new Proxy(
        {},
        {
          get(_target, prop) {
            if (typeof prop !== "string") return undefined;
            return (...args: unknown[]) =>
              connection.sendRequest("host/call", {
                capabilityId: id,
                method: prop,
                args,
              });
          },
        },
      ) as T;
    },
  };
}
