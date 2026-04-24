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
//   - modules:host-call          → preload → daemon CapabilityRegistry
//
// Phase 13.4.1 — data-plane resolution (list, host-call, call-tool)
// happens through the daemon client in `modules-panels-register.ts`.
// The helpers here own the local WebContentsView lifecycle only:
// activate / deactivate / bounds. `activatePanel` takes the resolved
// panel contribution (already fetched via `modules/resolve-panel`) and
// hands it to the panel-bridge — no manifest lookup required locally.

import type { ElectronPanelContribution } from "@rn-dev/module-sdk";
import type { ModuleHostClient } from "../../src/app/client/module-host-adapter.js";
import type { PanelBridge, PanelBounds } from "../panel-bridge.js";
import type {
  ModuleCallSuccess,
  ModuleCallError,
} from "../../src/app/modules-ipc.js";

// ---------------------------------------------------------------------------
// Wire-format types
// ---------------------------------------------------------------------------

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

/**
 * Payload for `modules:call-tool` — panels invoking their own subprocess
 * tools. Different from `modules:host-call` (which resolves against the
 * daemon's CapabilityRegistry for cross-module capabilities). `moduleId`
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
   * for a `destructiveHint: true` tool. The daemon-side `modules/call`
   * dispatcher rejects destructive tools without this token. Matches the
   * Phase 7 destructive-tool gate the MCP-side proxy enforces via
   * `permissionsAccepted[tool]`.
   */
  confirmed?: boolean;
}

export type CallToolReply = ModuleCallSuccess | ModuleCallError;

// ---------------------------------------------------------------------------
// Panel-activation logic — pure, exported for unit tests
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

/**
 * Resolved panel contribution fields the bridge needs to build a
 * WebContentsView. Aliases the SDK type so the Electron handler layer
 * and the panel-bridge (`electron/panel-bridge.ts:20`) agree on a
 * single wire shape. Simplicity P1 on PR #20 — the previous local
 * duplicate drifted from the SDK definition's `readonly`/`optional`
 * semantics.
 */
export type ResolvedPanelContribution = ElectronPanelContribution;

export interface ActivatePanelDeps {
  bridge: PanelBridge;
  bounds: PanelBoundsCache;
}

export function activatePanel(
  deps: ActivatePanelDeps,
  payload: ActivatePanelPayload,
  contribution: ResolvedPanelContribution,
): { ok: true } | { ok: false; error: string } {
  if (contribution.id !== payload.panelId) {
    return {
      ok: false,
      error: `Resolved panel id "${contribution.id}" does not match requested "${payload.panelId}"`,
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
  modulesClient: ModuleHostClient;
  bounds: PanelBoundsCache;
  /**
   * Populated by the `modules:activate-panel` handler. Electron's
   * panel-bridge resolves `moduleRoot(id)` synchronously during
   * `register()`, so we pre-fetch the moduleRoot via the daemon's
   * `modules/resolve-panel` RPC and cache it here before calling
   * register. The installPanelBridge wiring in ipc/index.ts reads
   * from this map.
   */
  moduleRoots: Map<string, string>;
}

export interface ModulesPanelsIpcHandle {
  dispose: () => void;
  getActiveBounds: () => PanelBounds | undefined;
}
