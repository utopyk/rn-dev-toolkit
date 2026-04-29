import { ipcMain } from 'electron';
import { serviceBus } from '../../src/app/service-bus.js';
import type { DevToolsClient } from '../../src/app/client/devtools-adapter.js';
import { instances, send } from './state.js';

// ── DevTools (devtools-network module) — daemon-client proxy ──
//
// Phase 13.4 flipped Metro/Builder/Watcher/ModuleHost to daemon-client
// adapters but left this file untouched, so it kept constructing an
// in-process `DevToolsManager` against `inst.metro` (which is always
// null after Phase 13.4.1). After Bug 5: every handler resolves through
// the `serviceBus.devtools` topic — same shape as `electron/ipc/metro.ts`.
//
// The renderer (`renderer/views/DevToolsView.tsx`) calls four channels:
// `proxy-port` to lazily start + return the CDP proxy address,
// `status` for the target list + selected target,
// `select-target` to swap the upstream WS,
// `restart` to dispose + re-start (rediscovers targets when the app
// finally connects). Push events arrive on `devtools-network:change`.
//
// Event fan-out: one daemon = one DevToolsClient = one session. Events
// are scoped to the daemon's worktree, NOT to a particular Electron
// instance — the renderer filters by `port` (which still 1:1 maps to
// the daemon's Metro instance). `instanceId` was deliberately dropped
// from the payload (Architecture P1-1 on PR #26) because in the same-
// profile multi-instance case it would conflate views: both instances
// share the same daemon, so stamping each fan-out with one instance's
// id would mislead. When Phase 13.5 grows worktree-scoped events that
// need a discriminator beyond `port`, switch to `worktreeKey` here.

let devtoolsClient: DevToolsClient | null = null;
let detachClient: (() => void) | null = null;

serviceBus.on('devtools', (client: DevToolsClient) => {
  if (detachClient) detachClient();
  devtoolsClient = client;

  const onDelta = (payload: unknown) => fanChange('delta', payload);
  const onStatus = (payload: unknown) => fanChange('status', payload);
  client.on('delta', onDelta);
  client.on('status', onStatus);
  detachClient = () => {
    client.off('delta', onDelta);
    client.off('status', onStatus);
  };
});

function fanChange(kind: 'delta' | 'status', payload: unknown): void {
  // One emit per known instance — the renderer filters on `port`. We
  // could collapse to a single broadcast and let the renderer handle
  // routing, but per-instance emits keep `appendInstanceLog`-style
  // call sites consistent with the rest of `electron/ipc/`.
  for (const inst of instances.values()) {
    send('devtools-network:change', {
      port: inst.port,
      kind,
      payload,
    });
  }
}

export function registerDevtoolsHandlers() {
  ipcMain.handle('devtools-network:proxy-port', async () => {
    if (!devtoolsClient) return null;
    try {
      const status = await devtoolsClient.status();
      if (status.proxyPort === null || status.sessionNonce === null) {
        return null;
      }
      return { proxyPort: status.proxyPort, sessionNonce: status.sessionNonce };
    } catch (err) {
      console.error('[devtools-network:proxy-port] failed:', err);
      return null;
    }
  });

  ipcMain.handle('devtools-network:status', async () => {
    if (!devtoolsClient) return null;
    try {
      return await devtoolsClient.status();
    } catch (err) {
      console.error('[devtools-network:status] failed:', err);
      return null;
    }
  });

  ipcMain.handle('devtools-network:select-target', async (_, _port: number, targetId: string) => {
    if (!devtoolsClient) return { ok: false, error: 'DevTools not started' };
    try {
      await devtoolsClient.selectTarget(targetId);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'selectTarget failed';
      console.error('[devtools-network:select-target] failed:', err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('devtools-network:restart', async () => {
    if (!devtoolsClient) return null;
    try {
      return await devtoolsClient.restart();
    } catch (err) {
      // Logged loudly because this is the silent-failure mode that hid a
      // missing DAEMON_VERSION bump during Bug 5 verification — the
      // renderer surfaced "Cannot restart DevTools proxy for Metro on
      // port N" with no clue that the running daemon's RPC table didn't
      // know `devtools/restart` yet.
      console.error('[devtools-network:restart] failed:', err);
      return null;
    }
  });
}
