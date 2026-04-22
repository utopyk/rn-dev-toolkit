// Electron-bound registrar for module-config IPC. Separated from
// `modules-config.ts` so the pure logic there can be imported in vitest
// without triggering `import { ipcMain } from "electron"` at module load.
//
// Channels are registered eagerly — deps are looked up per call via
// `getDeps()` so the renderer can safely invoke `modules:config-get`
// before `startRealServices` finishes publishing `moduleHost` +
// `moduleRegistry` + `moduleEventsBus`. Missing deps return a clear
// error rather than "No handler registered".

import { ipcMain } from "electron";
import {
  handleConfigGet,
  handleConfigSet,
  type ConfigGetPayload,
  type ConfigSetPayload,
  type ModulesConfigIpcDeps,
} from "./modules-config.js";
import type { PanelSenderRegistry } from "../panel-sender-registry.js";

export interface ModulesConfigIpcHandle {
  dispose: () => void;
}

export function registerModulesConfigIpc(
  getDeps: () => ModulesConfigIpcDeps | null,
  getSenderRegistry?: () => PanelSenderRegistry | null,
): ModulesConfigIpcHandle {
  ipcMain.handle("modules:config-get", (event, payload: ConfigGetPayload) => {
    const deps = getDeps();
    if (!deps) {
      return {
        kind: "error" as const,
        code: "E_CONFIG_SERVICES_PENDING" as const,
        message: "modules-config: services not ready yet",
      };
    }
    // Phase 5b hardening — panel senders may only address their own
    // moduleId. Host UI (main BrowserWindow) can address any.
    const senderReg = getSenderRegistry?.();
    if (senderReg && !senderReg.canAddress(event.sender, payload.moduleId)) {
      return {
        kind: "error" as const,
        code: "E_CONFIG_SENDER_MISMATCH" as const,
        message:
          "modules:config-get rejected: sender is not bound to the requested module",
      };
    }
    return handleConfigGet(deps, payload);
  });

  ipcMain.handle("modules:config-set", (event, payload: ConfigSetPayload) => {
    const deps = getDeps();
    if (!deps) {
      return {
        kind: "error" as const,
        code: "E_CONFIG_SERVICES_PENDING" as const,
        message: "modules-config: services not ready yet",
      };
    }
    const senderReg = getSenderRegistry?.();
    if (senderReg && !senderReg.canAddress(event.sender, payload.moduleId)) {
      return {
        kind: "error" as const,
        code: "E_CONFIG_SENDER_MISMATCH" as const,
        message:
          "modules:config-set rejected: sender is not bound to the requested module",
      };
    }
    return handleConfigSet(deps, payload);
  });

  return {
    dispose: () => {
      ipcMain.removeHandler("modules:config-get");
      ipcMain.removeHandler("modules:config-set");
    },
  };
}
