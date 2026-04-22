// Electron-bound registrar for module-panel IPC. Separated from
// `modules-panels.ts` so the pure logic there can be imported in vitest
// without triggering `import { ipcMain } from "electron"` at module load
// time.

import { ipcMain } from "electron";
import {
  activatePanel,
  deactivatePanel,
  listPanels,
  resolveHostCall,
  setPanelBounds,
  type ActivatePanelPayload,
  type DeactivatePanelPayload,
  type HostCallPayload,
  type ModulesPanelsIpcDeps,
  type ModulesPanelsIpcHandle,
  type SetPanelBoundsPayload,
} from "./modules-panels.js";
import { listRows } from "../../src/app/modules-ipc.js";
import type { PanelSenderRegistry } from "../panel-sender-registry.js";

/**
 * Installs the Electron `ipcMain.handle` channels for module panels. Each
 * channel delegates to the pure helpers in `modules-panels.ts` so the
 * glue is thin enough that an integration regression is the common
 * failure mode, not a logic bug.
 *
 * Channels are registered eagerly — deps are looked up per call via
 * `getDeps()` so the renderer can safely invoke `modules:list-panels`
 * before `startRealServices` finishes publishing `moduleHost` +
 * `moduleRegistry`. Missing deps return safe no-op defaults instead of
 * "No handler registered" errors.
 */
export function registerModulesPanelsIpc(
  getDeps: () => ModulesPanelsIpcDeps | null,
  getSenderRegistry?: () => PanelSenderRegistry | null,
): ModulesPanelsIpcHandle {
  let activeKey: string | null = null;

  ipcMain.handle("modules:list-panels", () => {
    const deps = getDeps();
    if (!deps) return { modules: [] };
    return listPanels(deps.registry);
  });

  // Phase 5c — full module rows for the Marketplace renderer panel.
  // Projects through the same `rowFor` as the daemon's `modules/list`
  // MCP action so one RegisteredModule → one row shape regardless of
  // transport (unix socket vs Electron IPC).
  ipcMain.handle("modules:list", () => {
    const deps = getDeps();
    if (!deps) return { modules: [] };
    return {
      modules: listRows({ manager: deps.manager, registry: deps.registry }),
    };
  });

  ipcMain.handle(
    "modules:activate-panel",
    (event, payload: ActivatePanelPayload) => {
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
      const result = activatePanel(deps, payload);
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

  ipcMain.handle("modules:host-call", (event, payload: HostCallPayload) => {
    const deps = getDeps();
    if (!deps) {
      return {
        kind: "error" as const,
        code: "MODULE_UNAVAILABLE" as const,
        message: "modules-panels: services not ready yet",
      };
    }
    // Phase 5b hardening — bind _event.sender to the moduleId the panel
    // was spawned against. A panel that tries to invoke host-call with a
    // different moduleId gets the same `MODULE_UNAVAILABLE` that an
    // unknown moduleId would return (no "can't probe" signal).
    const senderReg = getSenderRegistry?.();
    if (senderReg && !senderReg.canAddress(event.sender, payload.moduleId)) {
      if (deps.auditHostCall) {
        deps.auditHostCall({
          moduleId: payload.moduleId,
          capabilityId: payload.capabilityId,
          method: payload.method,
          outcome: "denied",
          timestamp: Date.now(),
        });
      }
      return {
        kind: "error" as const,
        code: "MODULE_UNAVAILABLE" as const,
        message: "modules:host-call rejected: sender is not bound to the requested module",
      };
    }
    return resolveHostCall(
      deps.manager,
      deps.registry,
      payload,
      deps.auditHostCall,
    );
  });

  return {
    dispose: () => {
      ipcMain.removeHandler("modules:list-panels");
      ipcMain.removeHandler("modules:list");
      ipcMain.removeHandler("modules:activate-panel");
      ipcMain.removeHandler("modules:deactivate-panel");
      ipcMain.removeHandler("modules:set-panel-bounds");
      ipcMain.removeHandler("modules:host-call");
    },
    getActiveBounds: () => {
      const deps = getDeps();
      return activeKey && deps ? deps.bounds.get(activeKey) : undefined;
    },
  };
}
