// Pure resolution logic for module-config IPC. The Electron-bound
// `ipcMain.handle` wiring lives in `modules-config-register.ts` so this
// file can be imported in vitest without pulling in the `electron` runtime.
//
// Wire-format: renderer / panel preload → Electron main
//   - modules:config-get   → read persisted config (safe, read-only)
//   - modules:config-set   → shallow-merge patch, validate, persist, notify
//
// Electron shares a process with the daemon, so we call the daemon's
// `getModuleConfig` / `setModuleConfig` helpers directly with a locally-
// composed `ModulesIpcOptions` — no socket hop. The bus we hand in is the
// one published on `serviceBus.moduleEventsBus`, which is also what MCP
// `modules/subscribe` consumers listen on, so both paths emit through a
// single fan-out point.

import type { EventEmitter } from "node:events";
import type { ModuleHostManager } from "../../src/core/module-host/manager.js";
import type { ModuleRegistry } from "../../src/modules/registry.js";
import {
  getModuleConfig as daemonGetConfig,
  setModuleConfig as daemonSetConfig,
  type ModuleConfigGetResult,
  type ModuleConfigSetRequest,
  type ModuleConfigSetResult,
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
  manager: ModuleHostManager;
  registry: ModuleRegistry;
  /**
   * Shared event emitter from `registerModulesIpc`. `setConfig` emits
   * `config-changed` onto it so MCP `modules/subscribe` consumers see it.
   */
  moduleEvents: EventEmitter;
  /**
   * Called for every `modules:config-set` attempt regardless of outcome.
   * Electron registrar routes this to the `service:log` channel — mirrors
   * the Phase 4 `modules:host-call` audit-log pattern.
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

export function handleConfigGet(
  deps: ModulesConfigIpcDeps,
  payload: ConfigGetPayload,
): ConfigGetReply {
  return daemonGetConfig(
    {
      manager: deps.manager,
      registry: deps.registry,
      moduleEvents: deps.moduleEvents,
    },
    payload,
  );
}

export function handleConfigSet(
  deps: ModulesConfigIpcDeps,
  payload: ConfigSetPayload,
): ConfigSetReply {
  const result = daemonSetConfig(
    {
      manager: deps.manager,
      registry: deps.registry,
      moduleEvents: deps.moduleEvents,
    },
    payload,
  );
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
