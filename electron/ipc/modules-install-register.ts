// Electron ipcMain handlers for the Phase 6 install/uninstall flow.
//
// Wire protocol:
//   modules:install                → { moduleId, permissionsAccepted,
//                                        thirdPartyAcknowledged } → install reply
//   modules:uninstall              → { moduleId, keepData? }       → uninstall reply
//   marketplace:list               → ()                             → list reply
//   marketplace:info               → { moduleId }                   → info reply
//   modules:acknowledge-third-party → ()                            → { ok: true }
//
// All five pull deps via the eager-register / getDeps() closure pattern the
// panel-bridge + modules-config handlers already use, so the renderer can
// safely invoke the channels at mount time before `startRealServices`
// publishes moduleHost + moduleRegistry.

import { ipcMain } from "electron";
import type { EventEmitter } from "node:events";
import type { ModuleHostManager } from "../../src/core/module-host/manager.js";
import type { ModuleRegistry } from "../../src/modules/registry.js";
import {
  installAction,
  marketplaceInfo,
  marketplaceList,
  uninstallAction,
  type ModuleInstallRequest,
  type ModulesIpcOptions,
} from "../../src/app/modules-ipc.js";
import {
  acknowledgeThirdParty,
  hasAcknowledgedThirdParty,
} from "../../src/modules/marketplace/installer.js";
import type { PanelSenderRegistry } from "../panel-sender-registry.js";

/**
 * Sentinel moduleId the host UI must be granted `allowHostWrite(...)` for
 * before install/uninstall channels accept its invocations. Not a real
 * module — it's the "marketplace authority" principal the consent-dialog
 * UX owns. Kieran P1-1 (Phase 6 review): the install channels were
 * missing the sender gate that modules:config-set got, so a sandboxed
 * panel could trigger pacote-backed install flows.
 */
const MARKETPLACE_WRITE_PRINCIPAL = "marketplace" as const;

export interface ModulesInstallIpcDeps {
  manager: ModuleHostManager;
  registry: ModuleRegistry;
  moduleEvents: EventEmitter;
  /** Host version — threaded into the installer's hostRange validation. */
  hostVersion: string;
  /**
   * Called on every install/uninstall outcome. Electron registrar wires
   * this to `service:log` so the renderer's service-log pane sees what
   * happened — parity with modules-config's audit sink.
   */
  auditInstall?: (event: InstallAuditEvent) => void;
}

export interface InstallAuditEvent {
  kind: "install" | "uninstall";
  moduleId: string;
  outcome: "ok" | "error";
  code?: string;
  version?: string;
}

export interface ModulesInstallIpcHandle {
  dispose: () => void;
}

const PENDING_DEPS_REPLY = {
  kind: "error" as const,
  code: "E_INSTALL_SERVICES_PENDING" as const,
  message: "marketplace: services not ready yet",
};

const FORBIDDEN_REPLY = {
  kind: "error" as const,
  code: "E_SENDER_FORBIDDEN" as const,
  message:
    "modules:install/uninstall rejected: sender is not permitted to drive the marketplace. " +
    "The host UI must be granted allowHostWrite(\"marketplace\") before it can invoke these channels.",
};

export function registerModulesInstallIpc(
  getDeps: () => ModulesInstallIpcDeps | null,
  getSenderRegistry?: () => PanelSenderRegistry | null,
): ModulesInstallIpcHandle {
  ipcMain.handle(
    "modules:install",
    async (event, payload: ModuleInstallRequest) => {
      const deps = getDeps();
      if (!deps) return PENDING_DEPS_REPLY;
      const senderReg = getSenderRegistry?.();
      if (senderReg && !senderReg.canWrite(event.sender, MARKETPLACE_WRITE_PRINCIPAL)) {
        return FORBIDDEN_REPLY;
      }
      const opts = toIpcOptions(deps);
      const result = await installAction(opts, payload);
      deps.auditInstall?.({
        kind: "install",
        moduleId: payload?.moduleId ?? "",
        outcome: result.kind,
        ...(result.kind === "error" ? { code: result.code } : { version: result.version }),
      });
      return result;
    },
  );

  ipcMain.handle(
    "modules:uninstall",
    async (
      event,
      payload: { moduleId: string; scopeUnit?: string; keepData?: boolean },
    ) => {
      const deps = getDeps();
      if (!deps) return PENDING_DEPS_REPLY;
      const senderReg = getSenderRegistry?.();
      if (senderReg && !senderReg.canWrite(event.sender, MARKETPLACE_WRITE_PRINCIPAL)) {
        return FORBIDDEN_REPLY;
      }
      const opts = toIpcOptions(deps);
      const result = await uninstallAction(opts, payload);
      deps.auditInstall?.({
        kind: "uninstall",
        moduleId: payload?.moduleId ?? "",
        outcome: result.kind,
        ...(result.kind === "error" ? { code: result.code } : {}),
      });
      return result;
    },
  );

  ipcMain.handle("marketplace:list", async () => {
    const deps = getDeps();
    if (!deps) return PENDING_DEPS_REPLY;
    return marketplaceList(toIpcOptions(deps));
  });

  ipcMain.handle(
    "marketplace:info",
    async (_event, payload: { moduleId: string }) => {
      const deps = getDeps();
      if (!deps) return PENDING_DEPS_REPLY;
      return marketplaceInfo(toIpcOptions(deps), payload);
    },
  );

  // Two accessor handlers so the renderer's consent dialog can show the
  // ack gate conditionally (first-ever install only) without needing its
  // own filesystem read.
  ipcMain.handle("modules:acknowledge-third-party", () => {
    acknowledgeThirdParty();
    return { ok: true };
  });

  ipcMain.handle("modules:has-third-party-ack", () => {
    return { acknowledged: hasAcknowledgedThirdParty() };
  });

  return {
    dispose: () => {
      ipcMain.removeHandler("modules:install");
      ipcMain.removeHandler("modules:uninstall");
      ipcMain.removeHandler("marketplace:list");
      ipcMain.removeHandler("marketplace:info");
      ipcMain.removeHandler("modules:acknowledge-third-party");
      ipcMain.removeHandler("modules:has-third-party-ack");
    },
  };
}

function toIpcOptions(deps: ModulesInstallIpcDeps): ModulesIpcOptions {
  return {
    manager: deps.manager,
    registry: deps.registry,
    hostVersion: deps.hostVersion,
    moduleEvents: deps.moduleEvents,
  };
}
