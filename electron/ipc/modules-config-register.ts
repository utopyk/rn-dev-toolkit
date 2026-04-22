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
    // Read path — host UI can read any moduleId (Marketplace panel
    // enumerates all states; Settings reads its own + potentially peers).
    // Panel senders are still constrained to their own moduleId.
    const senderReg = getSenderRegistry?.();
    if (senderReg && !senderReg.canRead(event.sender, payload.moduleId)) {
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
    // Write path — Phase 6 Security P1-1. Host UI can only write to
    // moduleIds in its allowlist (see allowHostWrite). A renderer XSS
    // on the host UI is capped at those modules instead of every
    // installed 3p module's config.
    const senderReg = getSenderRegistry?.();
    if (senderReg && !senderReg.canWrite(event.sender, payload.moduleId)) {
      return {
        kind: "error" as const,
        code: "E_CONFIG_SENDER_MISMATCH" as const,
        message:
          "modules:config-set rejected: sender is not permitted to write the requested module",
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
