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
import {
  ModuleRegistry,
  type RegisteredModule,
} from "../modules/registry.js";
import type { ModuleInstanceState } from "../core/module-host/instance.js";
import type { ModuleConfigStore } from "../modules/config-store.js";
import { getDefaultAuditLog, type AuditOutcome } from "../core/audit-log.js";
import {
  defaultModulesRoot,
  isDisabled,
  setDisabled,
} from "../modules/disabled-flag.js";
import {
  RegistryFetcher,
  resolveRegistryUrl,
  type ModulesRegistry,
  type RegistryEntry,
} from "../modules/marketplace/registry.js";
import {
  installModule,
  uninstallModule,
  type InstallResult,
  type PacoteLike,
  type ArboristFactory,
} from "../modules/marketplace/installer.js";

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
  /**
   * Marketplace registry fetcher. Defaults to a fresh RegistryFetcher() per
   * dispatch — tests that want to stub the HTTP fetch inject one with a
   * pre-loaded cache.
   */
  registryFetcher?: RegistryFetcher;
  /**
   * pacote override used by the Marketplace installer. Defaults to the
   * real `pacote` package; tests inject a tarball stub.
   */
  pacote?: PacoteLike;
  /**
   * Arborist factory override used by the installer.
   */
  arboristFactory?: ArboristFactory;
}

/**
 * Payload shape for `modules/subscribe` event pushes. `kind` groups the
 * cause; agents treat any value as "the tool list may have changed".
 */
export interface ModulesEvent {
  kind:
    /**
     * `install` / `uninstall` are emitted from the Marketplace install flow.
     * They are distinct from `enabled` / `disabled` (which fire on the
     * `modules/enable` + `modules/disable` disabled-flag toggle) because the
     * renderer + MCP agents may want to react differently — e.g. Marketplace
     * rebuilds its "Available" section on install but not on enable.
     * Both still trigger `notifications/tools/list_changed` on the MCP side
     * because the tool snapshot has likely moved either way.
     */
    | "install"
    | "uninstall"
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
  /** Present on install — the version that just landed. */
  version?: string;
}

export type ModulesIpcAction =
  | "modules/list"
  | "modules/status"
  | "modules/restart"
  | "modules/call"
  | "modules/enable"
  | "modules/disable"
  | "modules/subscribe"
  | "modules/rescan"
  | "modules/config/get"
  | "modules/config/set"
  | "modules/install"
  | "modules/uninstall"
  | "modules/host-call"
  | "modules/list-panels"
  | "modules/resolve-panel"
  | "marketplace/list"
  | "marketplace/info";

export const MODULES_ACTIONS: ReadonlySet<string> = new Set<ModulesIpcAction>([
  "modules/list",
  "modules/status",
  "modules/restart",
  "modules/call",
  "modules/enable",
  "modules/disable",
  "modules/subscribe",
  "modules/rescan",
  "modules/config/get",
  "modules/config/set",
  "modules/install",
  "modules/uninstall",
  "modules/host-call",
  "modules/list-panels",
  "modules/resolve-panel",
  "marketplace/list",
  "marketplace/info",
]);

export interface RegisteredModuleRow {
  id: string;
  version: string;
  scope: RegisteredModule["manifest"]["scope"];
  scopeUnit: string;
  state: ModuleInstanceState | "inert";
  isBuiltIn: boolean;
  /**
   * How the module's runtime is hosted. `"subprocess"` for 3p modules
   * spawned via `ModuleHostManager`; `"built-in-privileged"` for in-
   * process built-ins. Phase 5c — consumers (Marketplace panel, renderer
   * sidebar) branch on this rather than parsing `modulePath` or inferring
   * from `isBuiltIn`.
   */
  kind: "subprocess" | "built-in-privileged";
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
    case "modules/rescan":
      return rescanAction(opts);
    case "modules/install":
      return installAction(opts, msg.payload as ModuleInstallRequest);
    case "modules/uninstall":
      return uninstallAction(
        opts,
        msg.payload as { moduleId: string; scopeUnit?: string; keepData?: boolean },
      );
    case "modules/host-call":
      return hostCall(opts, msg.payload as HostCallRequest);
    case "modules/list-panels":
      return listElectronPanels(opts);
    case "modules/resolve-panel":
      return resolveElectronPanel(
        opts,
        msg.payload as { moduleId: string; panelId: string },
      );
    case "marketplace/list":
      return marketplaceList(opts);
    case "marketplace/info":
      return marketplaceInfo(opts, msg.payload as { moduleId: string });
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

/**
 * Security F3 — per-module serialization lock. Two concurrent
 * `modules/config/set` calls for the same moduleId used to race: both
 * read the current config, both `{...current, ...patch}`, both write.
 * The later write wins and the earlier caller's keys are silently lost.
 *
 * The lock is a `Map<moduleId+scopeUnit, Promise<void>>` — each set
 * chains off the previous one so sets for the same module serialize.
 * Sets for different modules run in parallel. The key includes scopeUnit
 * because the same moduleId may legally be registered against multiple
 * scopes (per-worktree 3p modules).
 */
const configSetLocks = new Map<string, Promise<unknown>>();

function lockKey(moduleId: string, scopeUnit: string): string {
  return `${moduleId}:${scopeUnit}`;
}

export async function setModuleConfig(
  opts: ModulesIpcOptions,
  payload: ModuleConfigSetRequest | null,
): Promise<ModuleConfigSetResult> {
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

  // Chain this set behind any in-flight set for the same (moduleId, scope).
  const key = lockKey(reg.manifest.id, reg.scopeUnit);
  const prior = configSetLocks.get(key) ?? Promise.resolve();
  const next = prior.then(() =>
    applyConfigSet(opts, reg, payload.patch),
  );
  // Swallow rejections on the chain promise so one failure doesn't poison
  // the next waiter — each caller still awaits `next` and sees its own
  // outcome. Clear the map entry once this chain tail completes so long-
  // idle keys don't leak.
  const cleanup = next.catch(() => undefined).finally(() => {
    if (configSetLocks.get(key) === cleanup) {
      configSetLocks.delete(key);
    }
  });
  configSetLocks.set(key, cleanup);
  return next;
}

function applyConfigSet(
  opts: ModulesIpcOptions,
  reg: RegisteredModule,
  patch: Record<string, unknown>,
): ModuleConfigSetResult {
  const store = resolveStore(opts);
  const current = store.get(reg.manifest.id);
  const next = { ...current, ...patch };

  const schema = extractConfigSchema(reg);
  const validation = store.validate(next, schema);
  const patchKeys = Object.keys(patch);
  if (!validation.valid) {
    const lines = validation.errors.map(
      (e) => `  ${e.path}: ${e.message} (${e.keyword})`,
    );
    void getDefaultAuditLog().append({
      kind: "config-set",
      moduleId: reg.manifest.id,
      outcome: "error",
      code: "E_CONFIG_VALIDATION",
      scopeUnit: reg.scopeUnit,
      patchKeys,
    });
    return {
      kind: "error",
      code: "E_CONFIG_VALIDATION",
      message: `Config validation failed for "${reg.manifest.id}":\n${lines.join("\n")}`,
    };
  }

  store.write(reg.manifest.id, next);
  opts.manager.notifyConfigChanged(reg.manifest.id, reg.scopeUnit, next);
  void getDefaultAuditLog().append({
    kind: "config-set",
    moduleId: reg.manifest.id,
    outcome: "ok",
    scopeUnit: reg.scopeUnit,
    patchKeys,
  });
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

export async function callModuleTool(
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
// modules/host-call — panel-preload → daemon CapabilityRegistry. Phase
// 13.4.1 moved this from electron/ipc/modules-panels.ts into the daemon
// dispatcher so Electron is a pure client. The Electron-side
// `auditHostCall` -> service:log forwarder is dropped: every host-call
// still writes to `~/.rn-dev/audit.log` via `getDefaultAuditLog()`, and
// operators who want the real-time echo can tail it.
// ---------------------------------------------------------------------------

export interface HostCallRequest {
  moduleId: string;
  capabilityId: string;
  method: string;
  args: unknown[];
}

export type HostCallReply =
  | { kind: "ok"; result: unknown }
  | {
      kind: "error";
      code:
        | "MODULE_UNAVAILABLE"
        | "HOST_CAPABILITY_NOT_FOUND_OR_DENIED"
        | "HOST_METHOD_NOT_FOUND"
        | "HOST_CALL_FAILED";
      message: string;
    };

export async function hostCall(
  opts: ModulesIpcOptions,
  payload: HostCallRequest | null,
): Promise<HostCallReply> {
  const auditOutcome = (outcome: AuditOutcome): void => {
    void getDefaultAuditLog().append({
      kind: "host-call",
      moduleId: payload?.moduleId ?? "",
      outcome,
      capabilityId: payload?.capabilityId ?? "",
      method: payload?.method ?? "",
    });
  };
  if (
    !payload ||
    typeof payload.moduleId !== "string" ||
    typeof payload.capabilityId !== "string" ||
    typeof payload.method !== "string"
  ) {
    auditOutcome("error");
    return {
      kind: "error",
      code: "HOST_CALL_FAILED",
      message:
        "modules/host-call requires { moduleId, capabilityId, method, args }",
    };
  }

  const reg = resolveRegistered(opts, payload.moduleId, undefined);
  if (!reg) {
    auditOutcome("denied");
    return {
      kind: "error",
      code: "MODULE_UNAVAILABLE",
      message: `Module "${payload.moduleId}" is not registered.`,
    };
  }

  const granted = reg.manifest.permissions ?? [];
  const impl = opts.manager.capabilities.resolve<Record<string, unknown>>(
    payload.capabilityId,
    granted,
  );
  if (!impl) {
    auditOutcome("denied");
    return {
      kind: "error",
      code: "HOST_CAPABILITY_NOT_FOUND_OR_DENIED",
      message: `Capability "${payload.capabilityId}" not found or not granted to "${payload.moduleId}"`,
    };
  }

  const fn = impl[payload.method];
  if (typeof fn !== "function") {
    auditOutcome("error");
    return {
      kind: "error",
      code: "HOST_METHOD_NOT_FOUND",
      message: `Method "${payload.method}" not found on capability "${payload.capabilityId}"`,
    };
  }

  try {
    const args = Array.isArray(payload.args) ? payload.args : [];
    const result = await (fn as (...a: unknown[]) => unknown).apply(impl, args);
    auditOutcome("ok");
    return { kind: "ok", result };
  } catch (err) {
    auditOutcome("error");
    return {
      kind: "error",
      code: "HOST_CALL_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// modules/list-panels — projects every registered module's Electron panel
// contributions for the renderer sidebar. Webview paths + moduleRoot are
// intentionally NOT included; callers fetch a single panel's full
// contribution via `modules/resolve-panel` when they're ready to mount it.
// This keeps the list-panels payload small enough to spray on every
// sidebar re-render without growing with module count.
// ---------------------------------------------------------------------------

export interface ListPanelsEntry {
  moduleId: string;
  title: string;
  panels: Array<{
    id: string;
    title: string;
    icon?: string;
    hostApi: string[];
  }>;
}

export interface ListPanelsReply {
  modules: ListPanelsEntry[];
}

export function listElectronPanels(
  opts: ModulesIpcOptions,
): ListPanelsReply {
  const modules = opts.registry
    .getAllManifests()
    .map<ListPanelsEntry>((registered) => ({
      moduleId: registered.manifest.id,
      title: registered.manifest.id,
      panels:
        registered.manifest.contributes?.electron?.panels?.map((p) => ({
          id: p.id,
          title: p.title,
          icon: p.icon,
          hostApi: [...p.hostApi],
        })) ?? [],
    }))
    .filter((m) => m.panels.length > 0);
  return { modules };
}

// ---------------------------------------------------------------------------
// modules/resolve-panel — returns the full ElectronPanelContribution + the
// absolute module root for a single (moduleId, panelId) pair. The Electron
// panel-bridge consumes this when activating a panel to build the
// WebContentsView: webviewEntry is resolved against moduleRoot, and the
// returned hostApi allowlist is forwarded into the preload's
// additionalArguments.
// ---------------------------------------------------------------------------

export interface ResolvePanelReply {
  kind: "ok";
  moduleId: string;
  moduleRoot: string;
  contribution: {
    id: string;
    title: string;
    icon?: string;
    webviewEntry: string;
    hostApi: string[];
  };
}

export type ResolvePanelError = {
  kind: "error";
  code: "E_PANEL_NOT_FOUND" | "E_PANEL_BAD_REQUEST";
  message: string;
};

export function resolveElectronPanel(
  opts: ModulesIpcOptions,
  payload: { moduleId: string; panelId: string } | null,
): ResolvePanelReply | ResolvePanelError {
  if (
    !payload ||
    typeof payload.moduleId !== "string" ||
    typeof payload.panelId !== "string"
  ) {
    return {
      kind: "error",
      code: "E_PANEL_BAD_REQUEST",
      message:
        "modules/resolve-panel requires { moduleId: string, panelId: string }",
    };
  }
  const reg = resolveRegistered(opts, payload.moduleId, undefined);
  if (!reg) {
    return {
      kind: "error",
      code: "E_PANEL_NOT_FOUND",
      message: `Module "${payload.moduleId}" is not registered.`,
    };
  }
  const contribution = reg.manifest.contributes?.electron?.panels?.find(
    (p) => p.id === payload.panelId,
  );
  if (!contribution) {
    return {
      kind: "error",
      code: "E_PANEL_NOT_FOUND",
      message: `Module "${payload.moduleId}" has no panel "${payload.panelId}"`,
    };
  }
  return {
    kind: "ok",
    moduleId: reg.manifest.id,
    moduleRoot: reg.modulePath,
    contribution: {
      id: contribution.id,
      title: contribution.title,
      icon: contribution.icon,
      webviewEntry: contribution.webviewEntry,
      hostApi: [...contribution.hostApi],
    },
  };
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
// Marketplace install / uninstall / list / info
// ---------------------------------------------------------------------------

export interface ModuleInstallRequest {
  moduleId: string;
  /**
   * Every declared permission from the registry entry must appear here
   * verbatim. Headless MCP callers populate this from the entry they got
   * back from `marketplace/info`; GUI callers fill it from the consent
   * dialog's checked state.
   */
  permissionsAccepted: string[];
  /**
   * Pass `true` after the one-time "third-party modules run as me" ack —
   * GUI walks this, MCP callers can pass an out-of-band pre-recorded ack.
   */
  thirdPartyAcknowledged?: boolean;
}

export type ModuleInstallReply =
  | {
      kind: "ok";
      moduleId: string;
      version: string;
      installPath: string;
      tarballSha256: string;
    }
  | {
      kind: "error";
      code: string;
      message: string;
    };

export type ModuleUninstallReply =
  | { kind: "ok"; moduleId: string; removed: string; keptData: boolean }
  | { kind: "error"; code: string; message: string };

export interface MarketplaceEntryRow extends RegistryEntry {
  installed: boolean;
  installedVersion?: string;
  installedState?: string;
}

export interface MarketplaceListReply {
  kind: "ok";
  registrySha256: string;
  /** Resolved URL the fetcher pulled from — shown in the consent dialog. */
  registryUrl: string;
  entries: MarketplaceEntryRow[];
}

export type MarketplaceInfoReply =
  | {
      kind: "ok";
      entry: RegistryEntry;
      installed: boolean;
      installedVersion?: string;
      registrySha256: string;
    }
  | { kind: "error"; code: "E_UNKNOWN_MODULE" | "E_REGISTRY_UNAVAILABLE"; message: string };

async function fetchRegistry(
  opts: ModulesIpcOptions,
): Promise<
  | { kind: "ok"; registry: ModulesRegistry; sha256: string }
  | { kind: "error"; code: string; message: string }
> {
  const fetcher = opts.registryFetcher ?? new RegistryFetcher();
  const result = await fetcher.fetch({});
  if (result.kind === "error") {
    return { kind: "error", code: result.code, message: result.message };
  }
  return { kind: "ok", registry: result.registry, sha256: result.sha256 };
}

export async function marketplaceList(opts: ModulesIpcOptions): Promise<MarketplaceListReply | {
  kind: "error";
  code: string;
  message: string;
}> {
  const reg = await fetchRegistry(opts);
  if (reg.kind === "error") return reg;

  const installed = new Map<string, RegisteredModule>();
  for (const m of opts.registry.getAllManifests()) {
    if (!m.isBuiltIn) installed.set(m.manifest.id, m);
  }

  return {
    kind: "ok",
    registrySha256: reg.sha256,
    registryUrl: resolveRegistryUrl(),
    entries: reg.registry.modules.map((e) => {
      const existing = installed.get(e.id);
      return {
        ...e,
        installed: existing !== undefined,
        installedVersion: existing?.manifest.version,
        installedState: existing?.state,
      };
    }),
  };
}

export async function marketplaceInfo(
  opts: ModulesIpcOptions,
  payload: { moduleId: string } | null,
): Promise<MarketplaceInfoReply> {
  if (!payload || typeof payload.moduleId !== "string") {
    return {
      kind: "error",
      code: "E_UNKNOWN_MODULE",
      message: "marketplace/info requires { moduleId: string }",
    };
  }
  const reg = await fetchRegistry(opts);
  if (reg.kind === "error") {
    return { kind: "error", code: "E_REGISTRY_UNAVAILABLE", message: reg.message };
  }
  const entry = reg.registry.modules.find((m) => m.id === payload.moduleId);
  if (!entry) {
    return {
      kind: "error",
      code: "E_UNKNOWN_MODULE",
      message: `module "${payload.moduleId}" is not listed in the curated registry`,
    };
  }
  const existing = opts.registry
    .getAllManifests()
    .find((m) => !m.isBuiltIn && m.manifest.id === payload.moduleId);
  return {
    kind: "ok",
    entry,
    installed: existing !== undefined,
    installedVersion: existing?.manifest.version,
    registrySha256: reg.sha256,
  };
}

// ---------------------------------------------------------------------------
// modules/rescan — diff the live ModuleRegistry against a fresh scan of
// `~/.rn-dev/modules/` + apply adds/removes/updates. Fires `install` /
// `uninstall` events so MCP + Electron subscribers converge without a
// daemon restart — closes the loop Phase 7's CLI install opened.
// ---------------------------------------------------------------------------

export interface ModuleRescanResult {
  kind: "ok";
  /** Module ids, sorted — platform-stable order across filesystems. */
  added: string[];
  removed: string[];
  updated: string[];
  /** `"${path}: ${code} - ${message}"` per rejected manifest. */
  rejected: string[];
}

export async function rescanAction(
  opts: ModulesIpcOptions,
): Promise<ModuleRescanResult> {
  const scopeUnit = opts.scopeUnit ?? "global";
  const hostVersion = opts.hostVersion ?? "0.0.0";
  const scan = ModuleRegistry.scanUserGlobalModules({
    hostVersion,
    scopeUnit,
    ...(opts.modulesDir !== undefined ? { modulesDir: opts.modulesDir } : {}),
  });

  const onDisk = new Map<string, RegisteredModule>();
  for (const m of scan.modules) onDisk.set(m.manifest.id, m);

  const registered = new Map<string, RegisteredModule>();
  for (const m of opts.registry.getAllManifests()) {
    if (!m.isBuiltIn) registered.set(m.manifest.id, m);
  }

  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];

  // Adds + updates — on disk, may or may not be in registry.
  for (const [id, candidate] of onDisk) {
    const existing = registered.get(id);
    if (!existing) {
      await applyManifestChange(opts, { kind: "install", candidate });
      added.push(id);
      continue;
    }
    if (existing.manifest.version !== candidate.manifest.version) {
      await applyManifestChange(opts, { kind: "update", existing, candidate });
      updated.push(id);
    }
  }

  // Removes — in registry, not on disk.
  for (const [id, existing] of registered) {
    if (onDisk.has(id)) continue;
    await applyManifestChange(opts, { kind: "uninstall", existing });
    removed.push(id);
  }

  return {
    kind: "ok",
    // Sort — `readdirSync` iteration order is filesystem-dependent,
    // and the result arrays otherwise become flaky across platforms +
    // leak into tests that assert exact order.
    added: [...added].sort(),
    removed: [...removed].sort(),
    updated: [...updated].sort(),
    rejected: scan.rejected
      .map((r) => `${r.manifestPath}: ${r.code} - ${r.message}`)
      .sort(),
  };
}

// ---------------------------------------------------------------------------
// applyManifestChange — Phase 10 P1-6 dedup of the register/unregister +
// event-emission dance across `rescanAction`. installAction /
// uninstallAction delegate the filesystem + register/unregister to
// `installModule` / `uninstallModule` and only emit afterwards — they
// deliberately don't go through this helper, since that would double-
// register. This helper owns the in-process branch of the lifecycle:
// scan discovered a new manifest / a version bump / a removed directory,
// and the registry + event bus need to be reconciled.
// ---------------------------------------------------------------------------

type ManifestChange =
  | { kind: "install"; candidate: RegisteredModule }
  | {
      kind: "update";
      existing: RegisteredModule;
      candidate: RegisteredModule;
    }
  | { kind: "uninstall"; existing: RegisteredModule };

async function applyManifestChange(
  opts: ModulesIpcOptions,
  change: ManifestChange,
): Promise<void> {
  switch (change.kind) {
    case "install": {
      opts.registry.registerManifest(change.candidate);
      emitModuleEvent(opts, {
        kind: "install",
        moduleId: change.candidate.manifest.id,
        scopeUnit: change.candidate.scopeUnit,
        version: change.candidate.manifest.version,
      });
      return;
    }

    case "uninstall": {
      // Tear down any live subprocess before unregistering so acquire()
      // never finds a dangling manifest with no running process.
      try {
        await opts.manager.shutdown(
          change.existing.manifest.id,
          change.existing.scopeUnit,
        );
      } catch {
        /* acceptable — module may not have been acquired */
      }
      opts.registry.unregisterManifest(
        change.existing.manifest.id,
        change.existing.scopeUnit,
      );
      emitModuleEvent(opts, {
        kind: "uninstall",
        moduleId: change.existing.manifest.id,
        scopeUnit: change.existing.scopeUnit,
      });
      return;
    }

    case "update": {
      // update — a version bump. Tear down + re-register with the new
      // manifest. Agents see tools/listChanged because we fire an
      // uninstall + install pair.
      try {
        await opts.manager.shutdown(
          change.existing.manifest.id,
          change.existing.scopeUnit,
        );
      } catch {
        /* acceptable */
      }
      opts.registry.unregisterManifest(
        change.existing.manifest.id,
        change.existing.scopeUnit,
      );
      opts.registry.registerManifest(change.candidate);
      emitModuleEvent(opts, {
        kind: "uninstall",
        moduleId: change.existing.manifest.id,
        scopeUnit: change.existing.scopeUnit,
      });
      emitModuleEvent(opts, {
        kind: "install",
        moduleId: change.candidate.manifest.id,
        scopeUnit: change.candidate.scopeUnit,
        version: change.candidate.manifest.version,
      });
      return;
    }

    default: {
      // Phase 10 reviewer follow-up (Kieran TS P1-b): exhaustiveness
      // anchor. If `ManifestChange` grows a new kind, TS rejects this
      // assignment at compile time so the new branch can't be silently
      // omitted. Keeps the dispatcher honest as the module lifecycle
      // expands (e.g. a future `"reload"` for manifest edits without a
      // version bump).
      const _exhaustive: never = change;
      throw new Error(
        `applyManifestChange: unreachable — got unexpected change ${JSON.stringify(
          _exhaustive,
        )}`,
      );
    }
  }
}

export async function installAction(
  opts: ModulesIpcOptions,
  payload: ModuleInstallRequest | null,
): Promise<ModuleInstallReply> {
  if (
    !payload ||
    typeof payload.moduleId !== "string" ||
    !Array.isArray(payload.permissionsAccepted)
  ) {
    return {
      kind: "error",
      code: "E_BAD_REQUEST",
      message:
        "modules/install requires { moduleId: string, permissionsAccepted: string[] }",
    };
  }

  const reg = await fetchRegistry(opts);
  if (reg.kind === "error") {
    return { kind: "error", code: reg.code, message: reg.message };
  }
  const entry = reg.registry.modules.find((m) => m.id === payload.moduleId);
  if (!entry) {
    return {
      kind: "error",
      code: "E_UNKNOWN_MODULE",
      message: `module "${payload.moduleId}" is not listed in the curated registry`,
    };
  }

  const result: InstallResult = await installModule({
    entry,
    permissionsAccepted: payload.permissionsAccepted,
    registry: opts.registry,
    hostVersion: opts.hostVersion ?? "0.0.0",
    scopeUnit: opts.scopeUnit ?? "global",
    modulesDir: opts.modulesDir,
    thirdPartyAcknowledged: !!payload.thirdPartyAcknowledged,
    pacote: opts.pacote,
    arboristFactory: opts.arboristFactory,
  });

  if (result.kind === "error") {
    return { kind: "error", code: result.code, message: result.message };
  }

  emitModuleEvent(opts, {
    kind: "install",
    moduleId: result.module.manifest.id,
    scopeUnit: result.module.scopeUnit,
    version: result.module.manifest.version,
  });

  return {
    kind: "ok",
    moduleId: result.module.manifest.id,
    version: result.module.manifest.version,
    installPath: result.installPath,
    tarballSha256: result.tarballSha256,
  };
}

export async function uninstallAction(
  opts: ModulesIpcOptions,
  payload: { moduleId: string; scopeUnit?: string; keepData?: boolean } | null,
): Promise<ModuleUninstallReply> {
  if (!payload || typeof payload.moduleId !== "string") {
    return {
      kind: "error",
      code: "E_BAD_REQUEST",
      message: "modules/uninstall requires { moduleId: string, keepData?: boolean }",
    };
  }

  const result = await uninstallModule({
    moduleId: payload.moduleId,
    registry: opts.registry,
    manager: opts.manager,
    scopeUnit: payload.scopeUnit ?? opts.scopeUnit ?? "global",
    keepData: payload.keepData,
    modulesDir: opts.modulesDir,
  });

  if (result.kind === "error") {
    return { kind: "error", code: result.code, message: result.message };
  }

  emitModuleEvent(opts, {
    kind: "uninstall",
    moduleId: payload.moduleId,
    scopeUnit: payload.scopeUnit ?? opts.scopeUnit ?? "global",
  });

  return {
    kind: "ok",
    moduleId: payload.moduleId,
    removed: result.removed,
    keptData: result.keptData,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Exported so the Electron ipcMain layer can project module rows into
 * its `modules:list` channel without re-implementing `rowFor`. Keeps
 * `rowFor` as the single source of truth for how a RegisteredModule
 * becomes an IPC row (arch #3).
 */
export function listRows(opts: ModulesIpcOptions): RegisteredModuleRow[] {
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
  const kind = reg.kind ?? "subprocess";
  // Arch #4 — branch on kind rather than inferring from presence/absence
  // of a live subprocess entry. Built-ins never spawn, so their state is
  // the registry state (always "active" after registerBuiltIn stamps it),
  // and pid/lastCrashReason stay null. Subprocess modules consult the
  // manager as before.
  if (kind === "built-in-privileged") {
    return {
      id: reg.manifest.id,
      version: reg.manifest.version,
      scope: reg.manifest.scope,
      scopeUnit: reg.scopeUnit,
      state: reg.state,
      isBuiltIn: reg.isBuiltIn,
      kind,
      lastCrashReason: null,
      pid: null,
      tools: reg.manifest.contributes?.mcp?.tools ?? [],
    };
  }
  const live = opts.manager.inspect(reg.manifest.id, reg.scopeUnit);
  return {
    id: reg.manifest.id,
    version: reg.manifest.version,
    scope: reg.manifest.scope,
    scopeUnit: reg.scopeUnit,
    state: live?.state ?? "inert",
    isBuiltIn: reg.isBuiltIn,
    kind,
    lastCrashReason: live?.lastCrashReason ?? null,
    pid: live?.pid ?? null,
    tools: reg.manifest.contributes?.mcp?.tools ?? [],
  };
}
