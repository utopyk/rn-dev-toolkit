// Electron-bound registrar for module-panel IPC. Separated from
// `modules-panels.ts` so the pure logic there can be imported in vitest
// without triggering `import { ipcMain } from "electron"` at module load
// time.
//
// Phase 13.4.1 — data-plane channels (list, list-panels, call-tool,
// host-call) route through the daemon client. Panel-lifecycle channels
// (activate/deactivate/set-panel-bounds) stay Electron-side — they drive
// WebContentsView operations against the local window — but pre-fetch
// the manifest contribution + moduleRoot from the daemon via
// `modules/resolve-panel`.

import { ipcMain } from "electron";
import {
  activatePanel,
  deactivatePanel,
  setPanelBounds,
  type ActivatePanelPayload,
  type CallToolPayload,
  type DeactivatePanelPayload,
  type HostCallPayload,
  type ModulesPanelsIpcDeps,
  type ModulesPanelsIpcHandle,
  type SetPanelBoundsPayload,
} from "./modules-panels.js";
import type { PanelSenderRegistry } from "../panel-sender-registry.js";

/**
 * Installs the Electron `ipcMain.handle` channels for module panels. Each
 * channel delegates to the pure helpers in `modules-panels.ts` (for
 * local WebContentsView ops) or the daemon client on `deps.modulesClient`
 * (for manifest / capability data).
 *
 * Channels register eagerly; deps are looked up per call via `getDeps()`
 * so the renderer can safely invoke `modules:list-panels` before
 * `connectElectronToDaemon` finishes publishing `modulesClient`. Missing
 * deps return safe no-op defaults instead of "No handler registered"
 * errors.
 */
export function registerModulesPanelsIpc(
  getDeps: () => ModulesPanelsIpcDeps | null,
  getSenderRegistry?: () => PanelSenderRegistry | null,
): ModulesPanelsIpcHandle {
  let activeKey: string | null = null;

  ipcMain.handle("modules:list-panels", async () => {
    const deps = getDeps();
    if (!deps) return { modules: [] };
    return deps.modulesClient.listPanels();
  });

  // Phase 5c — full module rows for the Marketplace renderer panel.
  // Projects through the daemon's `modules/list` RPC so one
  // RegisteredModule → one row shape regardless of transport.
  ipcMain.handle("modules:list", async () => {
    const deps = getDeps();
    if (!deps) return { modules: [] };
    return deps.modulesClient.list();
  });

  ipcMain.handle(
    "modules:activate-panel",
    async (event, payload: ActivatePanelPayload) => {
      const deps = getDeps();
      if (!deps) return { ok: false, error: "modules-panels: services not ready yet" };
      // Panel lifecycle channels are driven by the host UI (main renderer),
      // not by module panels themselves — reject non-host senders.
      const senderReg = getSenderRegistry?.();
      if (senderReg && senderReg.resolve(event.sender)?.kind !== "host") {
        return {
          ok: false,
          error: "modules:activate-panel may only be invoked by the host UI",
        };
      }
      // Pre-fetch the manifest contribution + moduleRoot from the daemon.
      // The panel-bridge's `moduleRoot(id)` callback reads from a cache
      // we populate here so the bridge's synchronous `register(moduleId,
      // contribution)` signature is preserved — Electron is the only
      // consumer asking the panel-bridge to accept a moduleRoot, so the
      // caching hop stays local to this handler.
      const resolved = await deps.modulesClient.resolvePanel(
        payload.moduleId,
        payload.panelId,
      );
      if (resolved.kind === "error") {
        return { ok: false, error: resolved.message };
      }
      deps.moduleRoots.set(payload.moduleId, resolved.moduleRoot);
      const result = activatePanel(deps, payload, {
        id: resolved.contribution.id,
        title: resolved.contribution.title,
        icon: resolved.contribution.icon,
        webviewEntry: resolved.contribution.webviewEntry,
        hostApi: resolved.contribution.hostApi,
      });
      if (result.ok) {
        activeKey = `${payload.moduleId}:${payload.panelId}`;
      }
      return result;
    },
  );

  ipcMain.handle(
    "modules:deactivate-panel",
    (event, payload: DeactivatePanelPayload) => {
      const deps = getDeps();
      const key = `${payload.moduleId}:${payload.panelId}`;
      if (activeKey === key) activeKey = null;
      const senderReg = getSenderRegistry?.();
      if (senderReg && senderReg.resolve(event.sender)?.kind !== "host") {
        return {
          ok: false,
          error: "modules:deactivate-panel may only be invoked by the host UI",
        };
      }
      if (!deps) return { ok: true };
      return deactivatePanel(deps, payload);
    },
  );

  ipcMain.handle(
    "modules:set-panel-bounds",
    (event, payload: SetPanelBoundsPayload) => {
      const deps = getDeps();
      const senderReg = getSenderRegistry?.();
      if (senderReg && senderReg.resolve(event.sender)?.kind !== "host") {
        return {
          ok: false,
          error: "modules:set-panel-bounds may only be invoked by the host UI",
        };
      }
      if (!deps) return { ok: true };
      return setPanelBounds(deps, payload);
    },
  );

  // Phase 7 (13.4.1 flipped) — `modules:call-tool` lets a panel invoke one
  // of its OWN module's subprocess tools. Goes through the daemon's
  // `modules/call` dispatcher via `ModuleHostClient.call`. The destructive-
  // hint gate the daemon enforces still fires; panels must invoke with
  // `confirmed: true` to pass a destructive tool call through.
  ipcMain.handle(
    "modules:call-tool",
    async (event, payload: CallToolPayload) => {
      const deps = getDeps();
      if (!deps) {
        return {
          kind: "error" as const,
          code: "MODULE_UNAVAILABLE" as const,
          message: "modules-panels: services not ready yet",
        };
      }
      const senderReg = getSenderRegistry?.();
      const identity = senderReg?.resolve(event.sender);
      if (!identity || identity.kind !== "panel") {
        return {
          kind: "error" as const,
          code: "MODULE_UNAVAILABLE" as const,
          message:
            "modules:call-tool must be invoked from a module panel — the host UI cannot call module tools directly.",
        };
      }
      return deps.modulesClient.call({
        moduleId: identity.moduleId,
        tool: payload.tool,
        args: payload.args ?? {},
        ...(payload.callTimeoutMs !== undefined
          ? { callTimeoutMs: payload.callTimeoutMs }
          : {}),
      });
    },
  );

  ipcMain.handle(
    "modules:host-call",
    async (event, payload: HostCallPayload) => {
      const deps = getDeps();
      if (!deps) {
        return {
          kind: "error" as const,
          code: "MODULE_UNAVAILABLE" as const,
          message: "modules-panels: services not ready yet",
        };
      }
      // Phase 5b hardening — bind event.sender to the moduleId the panel
      // was spawned against. A panel that tries to invoke host-call with a
      // different moduleId gets the same `MODULE_UNAVAILABLE` that an
      // unknown moduleId would return (no "can't probe" signal). The
      // daemon's `hostCall` dispatcher emits the audit entry for the
      // permitted path; for the sender-mismatch rejection we don't write
      // to the audit log here — the daemon never sees the call, so the
      // Electron-side event is lost. Phase 13.5 threat-model work adds
      // a daemon-side sender-binding check that closes this gap (Sec
      // P1-4 on PR #20).
      const senderReg = getSenderRegistry?.();
      if (senderReg && !senderReg.canRead(event.sender, payload.moduleId)) {
        return {
          kind: "error" as const,
          code: "MODULE_UNAVAILABLE" as const,
          message: "modules:host-call rejected: sender is not bound to the requested module",
        };
      }
      return deps.modulesClient.hostCall({
        moduleId: payload.moduleId,
        capabilityId: payload.capabilityId,
        method: payload.method,
        args: payload.args,
      });
    },
  );

  return {
    dispose: () => {
      ipcMain.removeHandler("modules:list-panels");
      ipcMain.removeHandler("modules:list");
      ipcMain.removeHandler("modules:activate-panel");
      ipcMain.removeHandler("modules:deactivate-panel");
      ipcMain.removeHandler("modules:set-panel-bounds");
      ipcMain.removeHandler("modules:call-tool");
      ipcMain.removeHandler("modules:host-call");
    },
    getActiveBounds: () => {
      const deps = getDeps();
      return activeKey && deps ? deps.bounds.get(activeKey) : undefined;
    },
  };
}
