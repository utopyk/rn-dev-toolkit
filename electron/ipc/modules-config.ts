// Pure resolution logic for module-config IPC. The Electron-bound
// `ipcMain.handle` wiring lives in `modules-config-register.ts` so this
// file can be imported in vitest without pulling in the `electron` runtime.
//
// Wire-format: renderer / panel preload → Electron main
//   - modules:config-get   → read persisted config (safe, read-only)
//   - modules:config-set   → shallow-merge patch, validate, persist, notify
//
// Phase 13.4.1 — the dispatcher routes both reads + writes through the
// daemon client. The Electron process no longer holds a `ModuleHostManager`
// / `ModuleRegistry`; the daemon owns those and `ModuleHostClient.configGet`
// / `.configSet` are the single source of truth. Electron's audit sink
// (service:log) still fires per set attempt — kept here because the daemon's
// own HMAC-chained audit log doesn't drive the renderer's log pane.

import type { ModuleHostClient } from "../../src/app/client/module-host-adapter.js";
import type {
  ModuleConfigGetResult,
  ModuleConfigSetRequest,
  ModuleConfigSetResult,
} from "../../src/app/modules-ipc.js";

// ---------------------------------------------------------------------------
// Wire-format types
// ---------------------------------------------------------------------------

export interface ConfigGetPayload {
  moduleId: string;
  scopeUnit?: string;
}

export interface ConfigSetPayload extends ModuleConfigSetRequest {}

export type ConfigGetReply = ModuleConfigGetResult | { error: string };
export type ConfigSetReply = ModuleConfigSetResult;

export interface ModulesConfigIpcDeps {
  modulesClient: ModuleHostClient;
  /**
   * Called for every `modules:config-set` attempt regardless of outcome.
   * Electron registrar routes this to the `service:log` channel so the
   * renderer's log pane sees what happened — the daemon's HMAC-chained
   * audit log still runs server-side.
   */
  auditConfigSet?: (event: ConfigSetAuditEvent) => void;
}

export interface ConfigSetAuditEvent {
  moduleId: string;
  scopeUnit?: string;
  /**
   * Keys merged in by this patch. Value bodies are not included — audit
   * logs should not echo secrets. Sorted for deterministic diffs.
   */
  patchKeys: string[];
  outcome: "ok" | "error";
  /** Error code when outcome is "error". */
  code?: string;
}

// ---------------------------------------------------------------------------
// Pure resolution — exported for unit tests
// ---------------------------------------------------------------------------

export async function handleConfigGet(
  deps: ModulesConfigIpcDeps,
  payload: ConfigGetPayload,
): Promise<ConfigGetReply> {
  return deps.modulesClient.configGet(payload.moduleId, payload.scopeUnit);
}

export async function handleConfigSet(
  deps: ModulesConfigIpcDeps,
  payload: ConfigSetPayload,
): Promise<ConfigSetReply> {
  const result = await deps.modulesClient.configSet(payload);
  if (deps.auditConfigSet) {
    const patchKeys =
      payload && payload.patch && typeof payload.patch === "object"
        ? Object.keys(payload.patch).sort()
        : [];
    deps.auditConfigSet({
      moduleId: payload?.moduleId ?? "",
      scopeUnit: payload?.scopeUnit,
      patchKeys,
      outcome: result.kind === "ok" ? "ok" : "error",
      code: result.kind === "error" ? result.code : undefined,
    });
  }
  return result;
}
