import { BrowserWindow } from 'electron';
import path from 'node:path';
import { serviceBus } from '../../src/app/service-bus.js';
import type { ModuleHostClient } from '../../src/app/client/module-host-adapter.js';
import type { SessionId } from '../../src/core/identifiers.js';
import { getDefaultAuditLog, type AuditEntry } from '../../src/core/audit-log.js';
import {
  state,
  send,
  getActiveSessionRecord,
  getSessionRecordForInstance,
} from './state.js';

// Phase 8 — AuditLog is a process-wide singleton so the four audit sinks
// below (panel-bridge, host-call, config-set, install/uninstall) can
// reach it without every registrar threading it in. The three
// `registerModule*Handlers` functions are invoked from inside
// `setupIpcBridge` but live at module scope, so they can't close over a
// local variable there — the previous attempt put `auditLog` inside
// `setupIpcBridge` and tripped the P0 caught in the Phase 8 review
// (`ReferenceError: auditLog is not defined` at every audit callback,
// silently swallowed by `void`). Module scope makes the closure chain
// explicit + visible to every reader.
const auditLog = getDefaultAuditLog();
import { registerInstanceHandlers } from './instance.js';
import { registerMetroHandlers } from './metro.js';
import { registerToolsHandlers } from './tools.js';
import { registerProfileHandlers } from './profile.js';
import { registerProjectHandlers } from './project.js';
import { registerWizardHandlers } from './wizard.js';
import { registerDevtoolsHandlers } from './devtools.js';
import { installPanelBridge } from '../panel-bridge-electron.js';
import { electronAssetsDir } from '../paths.js';
import { PanelSenderRegistry } from '../panel-sender-registry.js';
import { createBoundsCache, type ModulesPanelsIpcDeps } from './modules-panels.js';
import { registerModulesPanelsIpc } from './modules-panels-register.js';
import type { ModulesConfigIpcDeps } from './modules-config.js';
import { registerModulesConfigIpc } from './modules-config-register.js';
import {
  registerModulesInstallIpc,
  type ModulesInstallIpcDeps,
} from './modules-install-register.js';

// Phase 5b hardening — one PanelSenderRegistry per Electron process.
// The main BrowserWindow's webContents is trusted as "host"; panel
// factory registers each new WebContentsView against its moduleId.
// ipcMain handlers consult this via _event.sender to reject spoofed
// moduleId payloads.
const senderRegistry = new PanelSenderRegistry();

// Phase E3 — per-session ModuleHostClient cache. Handlers that need a
// live `ModuleHostClient` (modules-config / modules-install /
// modules-panels) await `awaitModulesClient(instanceId?)`, which resolves
// the client bound to that instance's session. Pre-E this was a
// singleton: every new session clobbered the previous client, so the
// renderer's second tab silently routed module RPCs to the first tab's
// session (the very contamination memory `feedback_parallel_instance_requirement`
// flags as a blocker).
//
// Back-compat: callers that don't pass an instanceId fall back to the
// active session. Single-session deployments (one tab open) behave
// identically to the pre-E singleton path.
const MODULES_CLIENT_TIMEOUT_MS = 30_000;
const modulesClients = new Map<SessionId, ModuleHostClient>();
const pendingClientPromises = new Map<SessionId, Promise<ModuleHostClient>>();
// Pre-session-bound waiters: callers that await before ANY session has
// minted its SessionId. They resolve with the FIRST published client.
let pendingFirstClientPromise: Promise<ModuleHostClient> | null = null;

// Latest `abortModulesClient` reason. Cached so a Settings/Marketplace
// tab that mounts AFTER the abort fires gets the same fast rejection
// the in-flight handlers got. Cleared whenever a real `setModulesClient`
// arrives so a subsequent successful boot resets the failure mode.
let currentAbortReason: string | null = null;
serviceBus.on('modulesClientAborted', ({ reason }: { reason: string }) => {
  currentAbortReason = reason;
});

function resolveSessionForInstance(instanceId?: string): SessionId | null {
  if (instanceId) {
    const record = getSessionRecordForInstance(instanceId);
    if (record) return record.sessionId;
  }
  const active = getActiveSessionRecord();
  return active?.sessionId ?? null;
}

export function awaitModulesClient(instanceId?: string): Promise<ModuleHostClient> {
  const sessionId = resolveSessionForInstance(instanceId);
  if (sessionId) {
    const existing = modulesClients.get(sessionId);
    if (existing) return Promise.resolve(existing);
  }
  if (currentAbortReason) {
    return Promise.reject(new Error(currentAbortReason));
  }
  // Two waiting strategies:
  //   1. sessionId known but client not yet published — wait specifically
  //      for THAT session's client (avoids race where session-A's client
  //      lands first but the caller asked about session-B).
  //   2. sessionId not yet known (renderer mount fires before any
  //      attachDaemonSession completes) — wait for ANY first client.
  if (sessionId) {
    const pending = pendingClientPromises.get(sessionId);
    if (pending) return pending;
    const promise = new Promise<ModuleHostClient>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        serviceBus.off('modulesClient', onClient);
        serviceBus.off('modulesClientAborted', onAborted);
        pendingClientPromises.delete(sessionId);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `awaitModulesClient: daemon client did not publish within ${MODULES_CLIENT_TIMEOUT_MS}ms for session ${sessionId}`,
          ),
        );
      }, MODULES_CLIENT_TIMEOUT_MS);
      const onClient = (
        payload: { sessionId: SessionId | null; client: ModuleHostClient | null },
      ): void => {
        if (!payload.client || payload.sessionId !== sessionId) return;
        cleanup();
        resolve(payload.client);
      };
      const onAborted = ({ reason }: { reason: string }): void => {
        cleanup();
        reject(new Error(reason));
      };
      serviceBus.on('modulesClient', onClient);
      serviceBus.on('modulesClientAborted', onAborted);
    });
    pendingClientPromises.set(sessionId, promise);
    return promise;
  }
  if (pendingFirstClientPromise) return pendingFirstClientPromise;
  pendingFirstClientPromise = new Promise<ModuleHostClient>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      serviceBus.off('modulesClient', onClient);
      serviceBus.off('modulesClientAborted', onAborted);
      pendingFirstClientPromise = null;
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `awaitModulesClient: daemon client did not publish within ${MODULES_CLIENT_TIMEOUT_MS}ms`,
        ),
      );
    }, MODULES_CLIENT_TIMEOUT_MS);
    const onClient = (payload: { client: ModuleHostClient | null }): void => {
      if (!payload.client) return;
      cleanup();
      resolve(payload.client);
    };
    const onAborted = ({ reason }: { reason: string }): void => {
      cleanup();
      reject(new Error(reason));
    };
    serviceBus.on('modulesClient', onClient);
    serviceBus.on('modulesClientAborted', onAborted);
  });
  return pendingFirstClientPromise;
}

serviceBus.on('modulesClient', (payload: { sessionId: SessionId | null; client: ModuleHostClient | null }) => {
  if (payload.client && payload.sessionId) {
    modulesClients.set(payload.sessionId, payload.client);
    currentAbortReason = null;
  } else if (!payload.client) {
    // serviceBus.clearModulesClient() — clear all. Per-session disconnect
    // already removes ITS entry in services.ts surfaceDisconnect.
    if (payload.sessionId) {
      modulesClients.delete(payload.sessionId);
    } else {
      modulesClients.clear();
    }
  }
});

export { startRealServices } from './services.js';

/**
 * Register every ipcMain handler group for the rn-dev Electron host.
 * Split from the former monolithic electron/ipc-bridge.ts in Phase 0.5 of the
 * module-system work — each file under electron/ipc/ owns a single concern.
 */
export function setupIpcBridge(window: BrowserWindow, initialProjectRoot?: string) {
  state.mainWindow = window;
  if (initialProjectRoot) {
    state.projectRoot = initialProjectRoot;
  }

  // Trust the main BrowserWindow's webContents as the host UI. READ
  // access is wildcard (Marketplace panel enumerates every module; the
  // modules:list surface needs cross-module reads). WRITE access is an
  // explicit allowlist — Phase 6 Security P1-1 caps renderer-XSS blast
  // radius. `settings` is the only host-writable module today; add more
  // here when a new host-native panel legitimately edits another
  // module's config.
  senderRegistry.trustHostSender(window.webContents);
  senderRegistry.allowHostWrite('settings');

  // Forward service bus events to renderer (legacy, for global logs)
  serviceBus.on('log', ({ text }: { text: string }) => send('service:log', text));

  // Phase 8 — every privileged host action funnels through the
  // HMAC-chained AuditLog. The service-log pane UX is preserved via a
  // single subscription that renders each audit entry as a human-
  // readable line; the structured record persists at `~/.rn-dev/audit.log`
  // and survives across daemon restarts (chain verifies post-hoc).
  //
  // The `appended` listener attaches HERE rather than at module load
  // because `send()` requires `state.mainWindow` to be set. Any audit
  // entry logged before `setupIpcBridge` runs (unusual — it runs before
  // any module-related IPC could fire) lands on disk but not in the
  // service-log pane. Not a correctness hazard; it's a late-subscriber
  // UX note the architecture reviewer flagged.
  auditLog.on('appended', (entry: AuditEntry) => {
    send('service:log', formatAuditEntry(entry));
  });

  // Phase 13.4.1 — forward module-system events to the renderer so the
  // sidebar rebuilds when a 3p module installs / crashes / toggles and
  // Settings + Marketplace panels live-update on `config-changed`. Pre-
  // flip this subscribed to `serviceBus.moduleEventsBus` which the
  // deleted `module-system-bootstrap.ts` used to publish; now we
  // subscribe to the `ModuleHostClient.on('modules-event', ...)` surface
  // the daemon client exposes. Kieran P0-1 on PR #20 — without this,
  // `modules:event` never fires post-flip and Settings + Marketplace
  // regress to empty states.
  //
  // The adapter's built-in `dispatch()` only covers the 3 supervisor-
  // level events (state-changed/crashed/failed) that ride the session's
  // events/subscribe stream. `subscribeToEvents()` opens a second
  // daemon subscription against `modules/subscribe` which carries the
  // full breadth (install/uninstall/enabled/disabled/restarted/
  // config-changed) that the renderer's Marketplace + Settings panels
  // rely on. Kieran P0-2.
  serviceBus.on('modulesClient', ({ client }: { client: ModuleHostClient | null }) => {
    if (!client) return;
    client.on('modules-event', (event) => send('modules:event', event));
    void client.subscribeToEvents().catch((err: unknown) => {
      // Best-effort — if the subscribe fails (daemon tears down the
      // socket mid-handshake, transient FS fault), renderer regresses
      // to state-changed/crashed/failed only until reconnect.
      console.error('[electron] modules/subscribe failed:', err);
    });
  });

  registerInstanceHandlers();
  registerMetroHandlers();
  registerToolsHandlers();
  registerProfileHandlers();
  registerProjectHandlers();
  registerWizardHandlers();
  registerDevtoolsHandlers();
  registerModulePanelsHandlers(window);
  registerModulesConfigHandlers();
  registerModulesInstallHandlers();
}

/**
 * Phase 4 (13.4.1 flipped) — install the module-panels bridge + its
 * ipcMain channels. Data-plane resolution (list, list-panels, host-call,
 * call-tool) routes through the daemon client; panel-lifecycle ops
 * (activate/deactivate/set-bounds) drive the local WebContentsView but
 * pre-fetch the manifest contribution + moduleRoot from the daemon via
 * `modules/resolve-panel`.
 *
 * The panel-bridge's `moduleRoot(id)` callback reads from a per-handler
 * cache (`moduleRoots`) populated by the `modules:activate-panel`
 * handler. The bridge's synchronous `register(moduleId, contribution)`
 * signature is preserved that way — the async RPC round-trip happens
 * upstream of the register call, never inside it.
 */
function registerModulePanelsHandlers(window: BrowserWindow): void {
  const boundsCache = createBoundsCache();
  // Phase E3 — per-session moduleRoots so panel-bridge resolves paths
  // against the correct session's installed module tree. Each session
  // has its own ModuleHostManager with potentially different installed
  // versions of the same module.
  const moduleRootsBySession = new Map<SessionId, Map<string, string>>();
  function moduleRootsFor(sessionId: SessionId): Map<string, string> {
    let map = moduleRootsBySession.get(sessionId);
    if (!map) {
      map = new Map<string, string>();
      moduleRootsBySession.set(sessionId, map);
    }
    return map;
  }
  // Single panel-bridge per BrowserWindow — its lookups thread through
  // the active-session resolver. The previous single deps-cache made the
  // bridge implicitly session-bound (whichever attached first), which
  // surfaced session-A's manifest entries in session-B's panel view
  // after a tab switch.
  let bridge: ReturnType<typeof installPanelBridge> | null = null;

  const handle = registerModulesPanelsIpc(
    async () => {
      // Phase E3 — resolve the active session's client per-call. The
      // previous closure-cached singleton clobbered cross-session work
      // (session A's panels visible from session B). Active-session
      // resolution costs one Map lookup; cheap relative to the
      // round-trip the deps drive.
      const client = await awaitModulesClient();
      const record = getActiveSessionRecord();
      if (!record) {
        throw new Error(
          'modules-panels: no active session — daemon disconnected?',
        );
      }
      if (!bridge) {
        const preloadPath = path.join(electronAssetsDir, 'preload-module.js');
        bridge = installPanelBridge({
          window,
          preloadPath,
          moduleRoot: (id: string) => {
            // Resolve against the active session's roots — panel bridge
            // is shared, but the path it hands the WebContentsView must
            // match the currently-focused tab.
            const active = getActiveSessionRecord();
            if (!active) return '';
            return moduleRootsFor(active.sessionId).get(id) ?? '';
          },
          getBounds: () =>
            handle.getActiveBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
          auditLog: (event) => {
            void auditLog.append({
              kind: 'panel-bridge',
              moduleId: event.moduleId,
              outcome: 'ok',
              action: event.kind,
              panelId: event.panelId,
            });
          },
          senderRegistry,
        });
      }
      return {
        bridge,
        modulesClient: client,
        bounds: boundsCache,
        moduleRoots: moduleRootsFor(record.sessionId),
      } satisfies ModulesPanelsIpcDeps;
    },
    () => senderRegistry,
  );

  // Wake-up signal: when a session's modulesClient first publishes, tell
  // the renderer's sidebar to re-fetch its panel list. Pre-E this fired
  // once globally; under N sessions it fires per-session attach so each
  // tab's first mount sees up-to-date panels.
  serviceBus.on('modulesClient', ({ client }) => {
    if (!client) return;
    send('modules:event', { kind: 'ready', moduleId: '', scopeUnit: '' });
  });

  // Clear moduleRoots on uninstall / state-changed (module left `active`)
  // so the panel-bridge's `moduleRoot(id)` callback never hands out a
  // stale path after uninstall-then-reinstall. Sec P1-1 + Arch P1 on
  // PR #20. Scoped per session so an uninstall in session A doesn't
  // wipe session B's path cache.
  serviceBus.on('modulesClient', ({ sessionId, client }) => {
    if (!client || !sessionId) return;
    client.on('modules-event', (event: { kind?: string; moduleId?: string }) => {
      if (!event.moduleId) return;
      if (event.kind === 'uninstall' || event.kind === 'crashed' || event.kind === 'failed') {
        moduleRootsFor(sessionId).delete(event.moduleId);
      }
    });
  });
}

/**
 * Phase 5a (13.4.1 flipped) — install the module-config ipcMain channels.
 * Handlers register eagerly; deps fill in once `connectElectronToDaemon`
 * publishes `modulesClient` (the daemon-client RPC surface). The
 * in-process `moduleHost` / `moduleRegistry` / `moduleEventsBus` topics
 * are no longer consulted here — reads + writes both go through the
 * client's `configGet` / `configSet` round-trip. The service:log audit
 * sink stays Electron-side so the renderer's log pane keeps showing
 * config-set outcomes; the daemon runs its own HMAC-chained audit log.
 */
function registerModulesConfigHandlers(): void {
  // Phase E3 — resolve per-call against the active session. Each session
  // has its own ModuleHostClient and (since module installs are
  // per-worktree) its own visible config namespace. The audit sink is
  // session-agnostic so we can construct fresh deps each call without
  // worrying about closure-leaks on the auditLog reference.
  registerModulesConfigIpc(
    async (): Promise<ModulesConfigIpcDeps> => {
      const client = await awaitModulesClient();
      return {
        modulesClient: client,
        auditConfigSet: (event) => {
          void auditLog.append({
            kind: 'config-set',
            moduleId: event.moduleId,
            outcome: event.outcome === 'ok' ? 'ok' : 'error',
            patchKeys: event.patchKeys,
            ...(event.code ? { code: event.code } : {}),
            ...(event.scopeUnit ? { scopeUnit: event.scopeUnit } : {}),
          });
        },
      };
    },
    () => senderRegistry,
  );
}

/**
 * Phase 6 (13.4.1 flipped) — install/uninstall/marketplace ipcMain
 * handlers. Deps resolve to the daemon-client RPC surface (`modulesClient`)
 * published by `connectElectronToDaemon`. Kieran + Security P1 sender-
 * identity gate unchanged: a sandboxed panel still can't trigger
 * pacote-backed installs on the user's behalf — the marketplace write
 * principal is only granted to the host UI's webContents.
 */
function registerModulesInstallHandlers(): void {
  senderRegistry.allowHostWrite('marketplace');
  // Phase E3 — install/uninstall/marketplace queries route through the
  // active session's client. Module install is daemon-process-global
  // (writes to `~/.rn-dev/modules/`), but the dispatcher entry-point
  // still lives on the session's ModuleHostClient.
  registerModulesInstallIpc(
    async (): Promise<ModulesInstallIpcDeps> => {
      const client = await awaitModulesClient();
      return {
        modulesClient: client,
        auditInstall: (event) => {
          void auditLog.append({
            kind: event.kind,
            moduleId: event.moduleId,
            outcome: event.outcome === 'ok' ? 'ok' : 'error',
            ...(event.code ? { code: event.code } : {}),
            ...(event.version ? { version: event.version } : {}),
          });
        },
      };
    },
    () => senderRegistry,
  );
}

/**
 * Render a structured audit entry as a service-log line so the existing
 * log pane UX doesn't regress. Phase 13.4.1 — host-call entries now
 * originate from the daemon (Sec P1-2 on PR #20 dropped the duplicate
 * Electron-side append); since the renderer doesn't subscribe to the
 * daemon's audit-log stream, `host-call` entries visible to this
 * formatter are legacy pre-flip entries on the HMAC chain. Keep the
 * branch so `verify()`-style tooling doesn't choke.
 */
function formatAuditEntry(entry: AuditEntry): string {
  const tag = `[${entry.kind}]`;
  const codeSuffix = 'code' in entry && entry.code ? ` (${entry.code})` : '';
  switch (entry.kind) {
    case 'install':
    case 'uninstall': {
      const id = entry.moduleId || '(host)';
      const v = 'version' in entry && entry.version ? ` v${entry.version}` : '';
      return `${tag} ${id}${v} ${entry.outcome}${codeSuffix}`;
    }
    case 'host-call': {
      const id = entry.moduleId || '(host)';
      return `${tag} ${id}/${entry.capabilityId}.${entry.method} ${entry.outcome}`;
    }
    case 'config-set': {
      const id = entry.moduleId || '(host)';
      const scope = entry.scopeUnit ? `:${entry.scopeUnit}` : '';
      return `${tag} ${id}${scope} keys=[${entry.patchKeys.join(',')}] ${entry.outcome}${codeSuffix}`;
    }
    case 'panel-bridge': {
      const id = entry.moduleId || '(host)';
      return `${tag} ${entry.action} ${id}:${entry.panelId} ${entry.outcome}`;
    }
    case 'hook':
      return `${tag} ${entry.phase} ${entry.outcome}${codeSuffix}${entry.reason ? ` reason=${entry.reason}` : ''}`;
  }
}
