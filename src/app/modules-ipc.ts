/**
 * Modules IPC dispatcher — Phase 3a.
 *
 * Wires the module-lifecycle actions that `src/mcp/tools.ts` calls into the
 * running `ModuleHostManager` + `ModuleRegistry` on the daemon side. The MCP
 * server (separate process) talks to the host here via the unix-socket
 * `IpcServer` started by `start-flow.ts`.
 *
 * Action shapes — all three use `{ moduleId, scopeUnit? }` payloads:
 *
 *   modules/list           payload: {}
 *     reply: { modules: Array<RegisteredModuleRow> }
 *
 *   modules/status         payload: { moduleId: string, scopeUnit?: string }
 *     reply: RegisteredModuleRow | null
 *
 *   modules/restart        payload: { moduleId: string, scopeUnit?: string }
 *     reply: { status: "restarted", pid } | { error: string }
 *
 * Scope resolution: if `scopeUnit` is omitted, we look for any registered
 * manifest matching the moduleId regardless of scope and pick the first.
 *
 * Future Phase 3b surface (intentionally not here):
 *   - modules/enable + modules/disable (persistent toggle + MCP tools/listChanged)
 *   - module-contributed tool proxying (<moduleId>__<tool> routed via moduleHost)
 *   - destructiveHint runtime confirmation
 */

import { EventEmitter } from "node:events";
import type { IpcMessage, IpcServer, IpcMessageEvent } from "../core/ipc.js";
import type {
  ModuleHostManager,
} from "../core/module-host/manager.js";
import type {
  ModuleRegistry,
  RegisteredModule,
} from "../modules/registry.js";
import type { ModuleInstanceState } from "../core/module-host/instance.js";
import type { ModuleConfigStore } from "../modules/config-store.js";
import {
  defaultModulesRoot,
  isDisabled,
  setDisabled,
} from "../modules/disabled-flag.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ModulesIpcOptions {
  manager: ModuleHostManager;
  registry: ModuleRegistry;
  /**
   * Root directory for on-disk disabled-flag persistence. Defaults to
   * `~/.rn-dev/modules/`. Tests override this to an isolated tmpdir.
   */
  modulesDir?: string;
  /** Host version used when re-loading manifests after `modules/enable`. */
  hostVersion?: string;
  /** Scope unit used when re-loading manifests after `modules/enable`. */
  scopeUnit?: string;
  /**
   * Local bus used to fan out registry-level changes to `modules/subscribe`
   * consumers. Created by `registerModulesIpc` when omitted.
   *
   * Tests that call `dispatchModulesAction` directly and want to assert
   * event emission can pass one in and listen for `modules-event` events.
   */
  moduleEvents?: EventEmitter;
  /**
   * Per-module config store. Defaults to `manager.configStore` so every
   * caller hits the same on-disk state. Tests can inject a custom store
   * to isolate filesystem side effects.
   */
  configStore?: ModuleConfigStore;
}

/**
 * Payload shape for `modules/subscribe` event pushes. `kind` groups the
 * cause; agents treat any value as "the tool list may have changed".
 */
export interface ModulesEvent {
  kind:
    | "enabled"
    | "disabled"
    | "restarted"
    | "crashed"
    | "failed"
    | "state-changed"
    | "config-changed";
  moduleId: string;
  scopeUnit?: string;
  /** Present on state-changed. */
  state?: string;
  /** Present on crashed / failed. */
  reason?: string;
  /**
   * Present on config-changed — the freshly persisted blob. Lets renderer
   * subscribers rebuild their views without a second round-trip.
   */
  config?: Record<string, unknown>;
}

export type ModulesIpcAction =
  | "modules/list"
  | "modules/status"
  | "modules/restart"
  | "modules/call"
  | "modules/enable"
  | "modules/disable"
  | "modules/subscribe"
  | "modules/config/get"
  | "modules/config/set";

const MODULES_ACTIONS: ReadonlySet<string> = new Set<ModulesIpcAction>([
  "modules/list",
  "modules/status",
  "modules/restart",
  "modules/call",
  "modules/enable",
  "modules/disable",
  "modules/subscribe",
  "modules/config/get",
  "modules/config/set",
]);

export interface RegisteredModuleRow {
  id: string;
  version: string;
  scope: RegisteredModule["manifest"]["scope"];
  scopeUnit: string;
  state: ModuleInstanceState | "inert";
  isBuiltIn: boolean;
  /** Only populated after the module has ever spawned. */
  lastCrashReason: string | null;
  /** Only populated when the instance is live. */
  pid: number | null;
  /**
   * Shallow view of the module's MCP tool contributions so MCP clients can
   * register them without a second IPC round-trip. `inputSchema` is included
   * verbatim from the manifest; handlers don't live here.
   */
  tools: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Dispatcher — exported for unit tests
// ---------------------------------------------------------------------------

export async function dispatchModulesAction(
  opts: ModulesIpcOptions,
  msg: IpcMessage,
): Promise<unknown> {
  switch (msg.action) {
    case "modules/list":
      return { modules: listRows(opts) };
    case "modules/status":
      return statusRow(opts, msg.payload as { moduleId: string; scopeUnit?: string });
    case "modules/restart":
      return restart(opts, msg.payload as { moduleId: string; scopeUnit?: string });
    case "modules/call":
      return callModuleTool(
        opts,
        msg.payload as ModuleCallRequest,
      );
    case "modules/enable":
      return enableModule(
        opts,
        msg.payload as { moduleId: string; scopeUnit?: string },
      );
    case "modules/disable":
      return disableModule(
        opts,
        msg.payload as { moduleId: string; scopeUnit?: string },
      );
    case "modules/config/get":
      return getModuleConfig(
        opts,
        msg.payload as { moduleId: string; scopeUnit?: string },
      );
    case "modules/config/set":
      return setModuleConfig(
        opts,
        msg.payload as ModuleConfigSetRequest,
      );
    case "modules/subscribe":
      // Subscribe is stream-shaped — not routed through the request/response
      // dispatcher. `registerModulesIpc` handles it directly.
      throw new Error(
        "[modules-ipc] modules/subscribe must be handled by registerModulesIpc, not dispatchModulesAction",
      );
    default:
      throw new Error(
        `[modules-ipc] unreachable: action=${msg.action}`,
      );
  }
}

// ---------------------------------------------------------------------------
// modules/call — proxy a tools/call request to the owning subprocess
// ---------------------------------------------------------------------------

export interface ModuleCallRequest {
  moduleId: string;
  scopeUnit?: string;
  /** Tool name WITHOUT the `<moduleId>__` prefix. */
  tool: string;
  args: Record<string, unknown>;
  /** Per-request override of the cold-start SLO; rarely used. */
  callTimeoutMs?: number;
}

export interface ModuleCallSuccess {
  kind: "ok";
  result: unknown;
}

export interface ModuleCallError {
  kind: "error";
  code:
    | "MODULE_UNAVAILABLE"
    | "MODULE_ACTIVATION_TIMEOUT"
    | "E_MODULE_CALL_FAILED";
  message: string;
}

// ---------------------------------------------------------------------------
// modules/enable + modules/disable — persist via disabled-flag file
// ---------------------------------------------------------------------------

function enableModule(
  opts: ModulesIpcOptions,
  payload: { moduleId: string; scopeUnit?: string } | null,
):
  | { status: "enabled"; alreadyEnabled: boolean; state: string | null }
  | { error: string } {
  if (!payload || typeof payload.moduleId !== "string") {
    return { error: "modules/enable requires { moduleId: string }" };
  }
  const root = opts.modulesDir ?? defaultModulesRoot();
  const wasDisabled = isDisabled(payload.moduleId, root);
  setDisabled(payload.moduleId, false, root);

  // Already present in the manifest map? Nothing to do (flag just flipped).
  const existing = resolveRegistered(opts, payload.moduleId, payload.scopeUnit);
  if (existing) {
    const result = {
      status: "enabled" as const,
      alreadyEnabled: !wasDisabled,
      state:
        opts.manager.inspect(existing.manifest.id, existing.scopeUnit)
          ?.state ?? "inert",
    };
    if (!result.alreadyEnabled) {
      emitModuleEvent(opts, {
        kind: "enabled",
        moduleId: existing.manifest.id,
        scopeUnit: existing.scopeUnit,
      });
    }
    return result;
  }

  // Not yet loaded — re-run the loader so the flag flip takes effect.
  const hostVersion = opts.hostVersion ?? "0.0.0";
  const loadResult = opts.registry.loadUserGlobalModules({
    hostVersion,
    scopeUnit: opts.scopeUnit ?? "global",
    modulesDir: root,
  });
  const registered = loadResult.modules.find(
    (m) => m.manifest.id === payload.moduleId,
  );
  const alreadyEnabled = !wasDisabled && registered !== undefined;
  if (registered && !alreadyEnabled) {
    emitModuleEvent(opts, {
      kind: "enabled",
      moduleId: registered.manifest.id,
      scopeUnit: registered.scopeUnit,
    });
  }
  return {
    status: "enabled",
    alreadyEnabled,
    state: registered ? "inert" : null,
  };
}

async function disableModule(
  opts: ModulesIpcOptions,
  payload: { moduleId: string; scopeUnit?: string } | null,
): Promise<
  | { status: "disabled"; alreadyDisabled: boolean }
  | { error: string }
> {
  if (!payload || typeof payload.moduleId !== "string") {
    return { error: "modules/disable requires { moduleId: string }" };
  }
  const root = opts.modulesDir ?? defaultModulesRoot();
  const alreadyDisabled = isDisabled(payload.moduleId, root);
  setDisabled(payload.moduleId, true, root);

  // Tear down the live subprocess (if any) + remove from the manifest map so
  // modules/call immediately stops working.
  const reg = resolveRegistered(opts, payload.moduleId, payload.scopeUnit);
  if (reg) {
    try {
      await opts.manager.shutdown(reg.manifest.id, reg.scopeUnit);
    } catch {
      /* already gone — acceptable */
    }
    opts.registry.unregisterManifest(reg.manifest.id, reg.scopeUnit);
    if (!alreadyDisabled) {
      emitModuleEvent(opts, {
        kind: "disabled",
        moduleId: reg.manifest.id,
        scopeUnit: reg.scopeUnit,
      });
    }
  } else if (!alreadyDisabled) {
    emitModuleEvent(opts, {
      kind: "disabled",
      moduleId: payload.moduleId,
      scopeUnit: payload.scopeUnit,
    });
  }

  return { status: "disabled", alreadyDisabled };
}

// ---------------------------------------------------------------------------
// modules/config/get + modules/config/set — per-module persistent config.
// Exported so the Electron IPC layer can call them directly (same process as
// the daemon); routing through the unix-socket dispatch would be a no-op.
// ---------------------------------------------------------------------------

export interface ModuleConfigSetRequest {
  moduleId: string;
  scopeUnit?: string;
  /**
   * Shallow merge into the currently-persisted config. Use the full blob
   * as the patch when a replace semantic is needed.
   */
  patch: Record<string, unknown>;
}

export interface ModuleConfigGetResult {
  moduleId: string;
  config: Record<string, unknown>;
}

export type ModuleConfigSetResult =
  | { kind: "ok"; config: Record<string, unknown> }
  | {
      kind: "error";
      code:
        | "E_CONFIG_VALIDATION"
        | "E_CONFIG_MODULE_UNKNOWN"
        | "E_CONFIG_BAD_PATCH"
        /** Electron main only — handler invoked before services resolved. */
        | "E_CONFIG_SERVICES_PENDING"
        /** Electron main only — sender's webContents is not bound to moduleId. */
        | "E_CONFIG_SENDER_MISMATCH";
      message: string;
    };

export function getModuleConfig(
  opts: ModulesIpcOptions,
  payload: { moduleId: string; scopeUnit?: string } | null,
): ModuleConfigGetResult | { error: string } {
  if (!payload || typeof payload.moduleId !== "string") {
    return { error: "modules/config/get requires { moduleId: string }" };
  }
  const store = resolveStore(opts);
  return {
    moduleId: payload.moduleId,
    config: store.get(payload.moduleId),
  };
}

export function setModuleConfig(
  opts: ModulesIpcOptions,
  payload: ModuleConfigSetRequest | null,
): ModuleConfigSetResult {
  if (!payload || typeof payload.moduleId !== "string") {
    return {
      kind: "error",
      code: "E_CONFIG_BAD_PATCH",
      message: "modules/config/set requires { moduleId, patch }",
    };
  }
  if (
    !payload.patch ||
    typeof payload.patch !== "object" ||
    Array.isArray(payload.patch)
  ) {
    return {
      kind: "error",
      code: "E_CONFIG_BAD_PATCH",
      message: "modules/config/set patch must be a JSON object",
    };
  }
  // `undefined` survives the in-memory JS merge but is stripped by
  // `JSON.stringify` — authors who pass it expect a delete, get a
  // silent no-op. Reject rather than corrupt. `null` is legal JSON and
  // passes through unchanged (schema decides if it's allowed).
  for (const [key, value] of Object.entries(payload.patch)) {
    if (value === undefined) {
      return {
        kind: "error",
        code: "E_CONFIG_BAD_PATCH",
        message: `modules/config/set: patch key "${key}" has value undefined; use null or omit the key.`,
      };
    }
  }

  const reg = resolveRegistered(opts, payload.moduleId, payload.scopeUnit);
  if (!reg) {
    return {
      kind: "error",
      code: "E_CONFIG_MODULE_UNKNOWN",
      message: `Module "${payload.moduleId}" is not registered`,
    };
  }

  const store = resolveStore(opts);
  const current = store.get(reg.manifest.id);
  const next = { ...current, ...payload.patch };

  const schema = extractConfigSchema(reg);
  const validation = store.validate(next, schema);
  if (!validation.valid) {
    const lines = validation.errors.map(
      (e) => `  ${e.path}: ${e.message} (${e.keyword})`,
    );
    return {
      kind: "error",
      code: "E_CONFIG_VALIDATION",
      message: `Config validation failed for "${reg.manifest.id}":\n${lines.join("\n")}`,
    };
  }

  store.write(reg.manifest.id, next);
  opts.manager.notifyConfigChanged(reg.manifest.id, reg.scopeUnit, next);
  emitModuleEvent(opts, {
    kind: "config-changed",
    moduleId: reg.manifest.id,
    scopeUnit: reg.scopeUnit,
    config: next,
  });
  return { kind: "ok", config: next };
}

function resolveStore(opts: ModulesIpcOptions): ModuleConfigStore {
  return opts.configStore ?? opts.manager.configStore;
}

function extractConfigSchema(
  reg: RegisteredModule,
): Record<string, unknown> | undefined {
  const contributes = reg.manifest.contributes as
    | { config?: { schema?: Record<string, unknown> } }
    | undefined;
  return contributes?.config?.schema;
}

async function callModuleTool(
  opts: ModulesIpcOptions,
  payload: ModuleCallRequest | null,
): Promise<ModuleCallSuccess | ModuleCallError> {
  if (!payload || typeof payload.moduleId !== "string" || typeof payload.tool !== "string") {
    return {
      kind: "error",
      code: "E_MODULE_CALL_FAILED",
      message: "modules/call requires { moduleId, tool, args? }",
    };
  }

  const reg = resolveRegistered(opts, payload.moduleId, payload.scopeUnit);
  if (!reg) {
    return {
      kind: "error",
      code: "MODULE_UNAVAILABLE",
      message: `Module "${payload.moduleId}" is not registered.`,
    };
  }
  if (reg.kind === "built-in-privileged") {
    return {
      kind: "error",
      code: "MODULE_UNAVAILABLE",
      message: `Module "${reg.manifest.id}" is a built-in-privileged module and does not expose subprocess tools; call the host-native MCP surface directly.`,
    };
  }

  const live = opts.manager.inspect(reg.manifest.id, reg.scopeUnit);
  if (live?.state === "failed") {
    return {
      kind: "error",
      code: "MODULE_UNAVAILABLE",
      message: `Module "${reg.manifest.id}" is in FAILED state; call modules/restart to recover.`,
    };
  }

  const consumerId = `modules-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const managed = await opts.manager.acquire(reg, consumerId);
    try {
      const result = await managed.rpc.sendRequest<
        Record<string, unknown>,
        unknown
      >(`tool/${payload.tool}`, payload.args ?? {});
      return { kind: "ok", result };
    } finally {
      await opts.manager.release(
        reg.manifest.id,
        reg.scopeUnit,
        consumerId,
      );
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    const code =
      message.includes("MODULE_ACTIVATION_TIMEOUT") ||
      message.includes("activation timeout")
        ? "MODULE_ACTIVATION_TIMEOUT"
        : "E_MODULE_CALL_FAILED";
    return { kind: "error", code, message };
  }
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export function registerModulesIpc(
  ipc: IpcServer,
  options: ModulesIpcOptions,
): { unregister: () => void; moduleEvents: EventEmitter } {
  // Local event bus — dispatchers emit into it, subscribers fan out.
  // Callers may supply their own for test introspection; default one is
  // created here so the dispatcher always has a destination.
  const moduleEvents = options.moduleEvents ?? new EventEmitter();
  const effectiveOptions: ModulesIpcOptions = { ...options, moduleEvents };

  // Bridge ModuleHostManager lifecycle events → moduleEvents so subscribers
  // see crashes / failed-state transitions without polling. Kept here rather
  // than on the manager itself to keep the bus file-scoped.
  const forwardCrashed = (p: {
    moduleId: string;
    scopeUnit: string;
    reason?: string;
  }): void => {
    moduleEvents.emit("modules-event", {
      kind: "crashed",
      moduleId: p.moduleId,
      scopeUnit: p.scopeUnit,
      reason: p.reason,
    } satisfies ModulesEvent);
  };
  const forwardFailed = (p: {
    moduleId: string;
    scopeUnit: string;
    reason?: string;
  }): void => {
    moduleEvents.emit("modules-event", {
      kind: "failed",
      moduleId: p.moduleId,
      scopeUnit: p.scopeUnit,
      reason: p.reason,
    } satisfies ModulesEvent);
  };
  const forwardStateChanged = (p: {
    moduleId: string;
    scopeUnit: string;
    from: string;
    to: string;
  }): void => {
    // Only forward transitions that affect tool callability — otherwise we'd
    // wake every agent on every internal state machine tick.
    if (p.to !== "active" && p.from !== "active") return;
    moduleEvents.emit("modules-event", {
      kind: "state-changed",
      moduleId: p.moduleId,
      scopeUnit: p.scopeUnit,
      state: p.to,
    } satisfies ModulesEvent);
  };
  options.manager.on("crashed", forwardCrashed);
  options.manager.on("failed", forwardFailed);
  options.manager.on("state-changed", forwardStateChanged);

  const listener = (event: IpcMessageEvent): void => {
    if (!MODULES_ACTIONS.has(event.message.action)) return;

    if (event.message.action === "modules/subscribe") {
      handleSubscribe(moduleEvents, event);
      return;
    }

    void dispatchModulesAction(effectiveOptions, event.message)
      .then((payload) => {
        event.reply({
          type: "response",
          action: event.message.action,
          payload,
          id: event.message.id,
        });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : String(err);
        event.reply({
          type: "response",
          action: event.message.action,
          payload: { error: message },
          id: event.message.id,
        });
      });
  };
  ipc.on("message", listener);

  return {
    unregister: () => {
      ipc.off("message", listener);
      options.manager.off("crashed", forwardCrashed);
      options.manager.off("failed", forwardFailed);
      options.manager.off("state-changed", forwardStateChanged);
    },
    moduleEvents,
  };
}

function handleSubscribe(
  moduleEvents: EventEmitter,
  event: IpcMessageEvent,
): void {
  // 1. Confirm the subscription so the client's promise resolves.
  event.reply({
    type: "response",
    action: "modules/subscribe",
    payload: { subscribed: true },
    id: event.message.id,
  });

  // 2. Stream every subsequent event on the same socket using the same id,
  //    so the client can route it back to this subscription.
  const pushEvent = (payload: ModulesEvent): void => {
    event.reply({
      type: "event",
      action: "modules/event",
      payload,
      id: event.message.id,
    });
  };

  moduleEvents.on("modules-event", pushEvent);
  event.onClose(() => {
    moduleEvents.off("modules-event", pushEvent);
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function listRows(opts: ModulesIpcOptions): RegisteredModuleRow[] {
  return opts.registry.getAllManifests().map((reg) => rowFor(opts, reg));
}

function statusRow(
  opts: ModulesIpcOptions,
  payload: { moduleId: string; scopeUnit?: string },
): RegisteredModuleRow | null {
  if (!payload || typeof payload.moduleId !== "string") {
    return null;
  }
  const reg = resolveRegistered(opts, payload.moduleId, payload.scopeUnit);
  return reg ? rowFor(opts, reg) : null;
}

async function restart(
  opts: ModulesIpcOptions,
  payload: { moduleId: string; scopeUnit?: string },
): Promise<{ status: "restarted"; pid: number } | { error: string }> {
  if (!payload || typeof payload.moduleId !== "string") {
    return { error: "modules/restart requires { moduleId: string }" };
  }
  const reg = resolveRegistered(opts, payload.moduleId, payload.scopeUnit);
  if (!reg) {
    return {
      error: `unknown module "${payload.moduleId}"${payload.scopeUnit ? ` (scope "${payload.scopeUnit}")` : ""}`,
    };
  }

  try {
    await opts.manager.shutdown(reg.manifest.id, reg.scopeUnit);
    const consumerId = `modules-restart-${Date.now()}`;
    const managed = await opts.manager.acquire(reg, consumerId);
    // Release immediately — the restart API's contract is "module is up
    // again"; we don't hold a refcount on the caller's behalf.
    await opts.manager.release(reg.manifest.id, reg.scopeUnit, consumerId);
    emitModuleEvent(opts, {
      kind: "restarted",
      moduleId: reg.manifest.id,
      scopeUnit: reg.scopeUnit,
    });
    return { status: "restarted", pid: managed.pid };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "restart failed",
    };
  }
}

function emitModuleEvent(opts: ModulesIpcOptions, event: ModulesEvent): void {
  opts.moduleEvents?.emit("modules-event", event);
}

function resolveRegistered(
  opts: ModulesIpcOptions,
  moduleId: string,
  scopeUnit: string | undefined,
): RegisteredModule | null {
  if (scopeUnit !== undefined) {
    return opts.registry.getManifest(moduleId, scopeUnit) ?? null;
  }
  // Match first by id regardless of scope — matches the ergonomic MCP
  // surface where agents rarely know the worktree key for a call.
  return (
    opts.registry
      .getAllManifests()
      .find((r) => r.manifest.id === moduleId) ?? null
  );
}

function rowFor(
  opts: ModulesIpcOptions,
  reg: RegisteredModule,
): RegisteredModuleRow {
  const live = opts.manager.inspect(reg.manifest.id, reg.scopeUnit);
  return {
    id: reg.manifest.id,
    version: reg.manifest.version,
    scope: reg.manifest.scope,
    scopeUnit: reg.scopeUnit,
    state: live?.state ?? "inert",
    isBuiltIn: reg.isBuiltIn,
    lastCrashReason: live?.lastCrashReason ?? null,
    pid: live?.pid ?? null,
    tools: reg.manifest.contributes?.mcp?.tools ?? [],
  };
}
