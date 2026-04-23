// Pure resolution logic for module-panel IPC. The Electron-bound
// `ipcMain.handle` wiring lives in `modules-panels-register.ts` so this
// file can be imported in vitest without pulling in the `electron`
// runtime module.
//
// Wire-format: renderer → Electron main
//   - modules:list-panels        → renderer sidebar discovery
//   - modules:activate-panel     → show WebContentsView, set bounds, focus
//   - modules:deactivate-panel   → hide
//   - modules:set-panel-bounds   → reapply bounds on renderer layout changes
//   - modules:host-call          → preload → capability registry (panel RPC)
//
// In Electron mode the daemon shares a process with main, so host-call
// resolves against the in-process `CapabilityRegistry` directly — no
// socket hop. The daemon's `modules/call` IPC is for MCP-side proxying
// and isn't used here.

import type { ElectronPanelContribution } from "@rn-dev/module-sdk";
import type { ModuleHostManager } from "../../src/core/module-host/manager.js";
import type {
  ModuleRegistry,
  RegisteredModule,
} from "../../src/modules/registry.js";
import type { PanelBridge, PanelBounds } from "../panel-bridge.js";
import {
  callModuleTool,
  type ModuleCallError,
  type ModuleCallSuccess,
} from "../../src/app/modules-ipc.js";

// ---------------------------------------------------------------------------
// Wire-format types
// ---------------------------------------------------------------------------

export interface PanelsListResponse {
  modules: Array<{
    moduleId: string;
    title: string;
    panels: Array<{
      id: string;
      title: string;
      icon?: string;
      hostApi: string[];
    }>;
  }>;
}

export interface ActivatePanelPayload {
  moduleId: string;
  panelId: string;
  bounds: PanelBounds;
}

export interface DeactivatePanelPayload {
  moduleId: string;
  panelId: string;
}

export interface SetPanelBoundsPayload {
  moduleId: string;
  panelId: string;
  bounds: PanelBounds;
}

export interface HostCallPayload {
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

/**
 * Payload for `modules:call-tool` — panels invoking their own subprocess
 * tools. Different from `modules:host-call` (which resolves against the
 * host `CapabilityRegistry` for cross-module capabilities). `moduleId`
 * is the panel's bound module — the Electron registrar derives it from
 * the sender identity, not from the renderer.
 */
export interface CallToolPayload {
  /**
   * Tool name WITHOUT the `<moduleId>__` prefix. Matches the manifest's
   * declared tool after `runModule` strips the prefix.
   */
  tool: string;
  args: Record<string, unknown>;
  /** Per-call override for the cold-start SLO; rarely set. */
  callTimeoutMs?: number;
  /**
   * Pass `true` when the panel has walked a user-visible confirmation
   * for a `destructiveHint: true` tool. `resolveCallTool` rejects
   * destructive tools without this token — the MCP-side proxy enforces
   * the same gate via `permissionsAccepted[tool]`, so Phase 7 keeps
   * agent-native parity with the panel surface.
   */
  confirmed?: boolean;
}

export type CallToolError =
  | ModuleCallError
  | {
      kind: "error";
      code: "E_DESTRUCTIVE_REQUIRES_CONFIRM";
      message: string;
    };

export type CallToolReply = ModuleCallSuccess | CallToolError;

// ---------------------------------------------------------------------------
// Pure resolution logic — exported for unit tests
// ---------------------------------------------------------------------------

export function listPanels(registry: ModuleRegistry): PanelsListResponse {
  const modules = registry
    .getAllManifests()
    .map((registered) => ({
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

export interface HostCallAuditEvent {
  moduleId: string;
  capabilityId: string;
  method: string;
  outcome: "ok" | "unavailable" | "denied" | "method-not-found" | "error";
  timestamp: number;
}

export async function resolveHostCall(
  manager: ModuleHostManager,
  registry: ModuleRegistry,
  payload: HostCallPayload,
  audit?: (event: HostCallAuditEvent) => void,
): Promise<HostCallReply> {
  const logOutcome = (outcome: HostCallAuditEvent["outcome"]): void => {
    audit?.({
      moduleId: payload?.moduleId ?? "",
      capabilityId: payload?.capabilityId ?? "",
      method: payload?.method ?? "",
      outcome,
      timestamp: Date.now(),
    });
  };
  if (
    !payload ||
    typeof payload.moduleId !== "string" ||
    typeof payload.capabilityId !== "string" ||
    typeof payload.method !== "string"
  ) {
    logOutcome("error");
    return {
      kind: "error",
      code: "HOST_CALL_FAILED",
      message:
        "modules:host-call requires { moduleId, capabilityId, method, args }",
    };
  }

  const reg = findRegistered(registry, payload.moduleId);
  if (!reg) {
    logOutcome("unavailable");
    return {
      kind: "error",
      code: "MODULE_UNAVAILABLE",
      message: `Module "${payload.moduleId}" is not registered.`,
    };
  }

  const granted = reg.manifest.permissions ?? [];
  const impl = manager.capabilities.resolve<Record<string, unknown>>(
    payload.capabilityId,
    granted,
  );
  if (!impl) {
    logOutcome("denied");
    return {
      kind: "error",
      code: "HOST_CAPABILITY_NOT_FOUND_OR_DENIED",
      message: `Capability "${payload.capabilityId}" not found or not granted to "${payload.moduleId}"`,
    };
  }

  const fn = impl[payload.method];
  if (typeof fn !== "function") {
    logOutcome("method-not-found");
    return {
      kind: "error",
      code: "HOST_METHOD_NOT_FOUND",
      message: `Method "${payload.method}" not found on capability "${payload.capabilityId}"`,
    };
  }

  try {
    const args = Array.isArray(payload.args) ? payload.args : [];
    const result = await (fn as (...a: unknown[]) => unknown).apply(impl, args);
    logOutcome("ok");
    return { kind: "ok", result };
  } catch (err) {
    logOutcome("error");
    return {
      kind: "error",
      code: "HOST_CALL_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function findRegistered(
  registry: ModuleRegistry,
  moduleId: string,
): RegisteredModule | undefined {
  return registry.getAllManifests().find((r) => r.manifest.id === moduleId);
}

/**
 * Pure resolution for `modules:call-tool` — a panel invoking one of its
 * own module's subprocess tools. The moduleId comes from the sender's
 * panel registration (caller-supplied), not from the renderer payload, so
 * a panel can't ask another module to run a tool on its behalf.
 *
 * Reuses the `callModuleTool` helper from `modules-ipc.ts` so the
 * MCP-side `modules/call` dispatch and the panel-side `modules:call-tool`
 * funnel through the same acquire → sendRequest → release flow.
 *
 * Destructive-tool gate (P0, Phase 7 review): tools declared with
 * `destructiveHint: true` in the manifest REQUIRE `payload.confirmed ===
 * true`. The MCP-proxy side (`src/mcp/module-proxy.ts`) applies the
 * equivalent gate via `permissionsAccepted[toolName]`. Without this,
 * a panel XSS or a misbehaving in-panel button could silently
 * uninstall apps / wipe device data.
 */
export async function resolveCallTool(
  manager: ModuleHostManager,
  registry: ModuleRegistry,
  moduleId: string,
  payload: CallToolPayload | null,
): Promise<CallToolReply> {
  if (!payload || typeof payload.tool !== "string") {
    return {
      kind: "error",
      code: "E_MODULE_CALL_FAILED",
      message: "modules:call-tool requires { tool, args? }",
    };
  }

  const reg = registry.getAllManifests().find((r) => r.manifest.id === moduleId);
  const toolDecl = reg?.manifest.contributes?.mcp?.tools?.find((t) => {
    // Match both the prefixed wire name and the bare name — panels
    // typically pass the bare form (`"uninstall-app"`), tests may
    // pass either.
    return t.name === payload.tool || t.name === `${moduleId}__${payload.tool}`;
  });
  if (toolDecl?.destructiveHint === true && payload.confirmed !== true) {
    return {
      kind: "error",
      code: "E_DESTRUCTIVE_REQUIRES_CONFIRM",
      message: `Tool "${payload.tool}" is marked destructiveHint: true. Re-invoke with { confirmed: true } after walking a user-visible confirmation.`,
    };
  }

  return callModuleTool(
    { manager, registry },
    {
      moduleId,
      tool: payload.tool,
      args: payload.args ?? {},
      ...(payload.callTimeoutMs !== undefined
        ? { callTimeoutMs: payload.callTimeoutMs }
        : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Panel-activation logic — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Caches the last-known bounds per panel so a window resize can reapply
 * the container rect without needing a fresh renderer round-trip.
 */
export interface PanelBoundsCache {
  get(key: string): PanelBounds | undefined;
  set(key: string, bounds: PanelBounds): void;
  delete(key: string): void;
}

export function createBoundsCache(): PanelBoundsCache {
  return new Map<string, PanelBounds>();
}

export interface ActivatePanelDeps {
  bridge: PanelBridge;
  registry: ModuleRegistry;
  bounds: PanelBoundsCache;
}

export function activatePanel(
  deps: ActivatePanelDeps,
  payload: ActivatePanelPayload,
): { ok: true } | { ok: false; error: string } {
  const reg = findRegistered(deps.registry, payload.moduleId);
  if (!reg) {
    return { ok: false, error: `Module "${payload.moduleId}" not registered` };
  }
  const contribution: ElectronPanelContribution | undefined =
    reg.manifest.contributes?.electron?.panels?.find(
      (p) => p.id === payload.panelId,
    );
  if (!contribution) {
    return {
      ok: false,
      error: `Module "${payload.moduleId}" has no panel "${payload.panelId}"`,
    };
  }

  deps.bridge.register(payload.moduleId, contribution);
  const key = `${payload.moduleId}:${payload.panelId}`;
  deps.bounds.set(key, payload.bounds);
  deps.bridge.show(payload.moduleId, payload.panelId);
  return { ok: true };
}

export function deactivatePanel(
  deps: { bridge: PanelBridge },
  payload: DeactivatePanelPayload,
): { ok: true } {
  deps.bridge.hide(payload.moduleId, payload.panelId);
  return { ok: true };
}

export function setPanelBounds(
  deps: { bridge: PanelBridge; bounds: PanelBoundsCache },
  payload: SetPanelBoundsPayload,
): { ok: true } {
  const key = `${payload.moduleId}:${payload.panelId}`;
  deps.bounds.set(key, payload.bounds);
  deps.bridge.applyBounds();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Registrar-facing types — the Electron-bound register lives in a sibling
// file (`modules-panels-register.ts`) so this module stays test-friendly.
// ---------------------------------------------------------------------------

export interface ModulesPanelsIpcDeps {
  bridge: PanelBridge;
  manager: ModuleHostManager;
  registry: ModuleRegistry;
  bounds: PanelBoundsCache;
  /**
   * Optional sink for host-call audit events. Every `modules:host-call`
   * — ok, denied, method-not-found, or error — fires exactly once. Used
   * by the Electron wiring to forward to the service-bus log channel.
   */
  auditHostCall?: (event: HostCallAuditEvent) => void;
}

export interface ModulesPanelsIpcHandle {
  dispose: () => void;
  getActiveBounds: () => PanelBounds | undefined;
}
