import { ipcMain } from 'electron';
import { DevToolsManager } from '../../src/core/devtools.js';
import { instances, state, send, type InstanceState } from './state.js';

// ── DevTools (devtools-network module) — lazy-bound CDP proxy ──
//
// The renderer calls `devtools-network:proxy-port` when its view mounts;
// that call lazily starts the per-instance DevToolsManager. The returned
// `{ proxyPort, sessionNonce }` is spliced into Fusebox's `ws=` URL so the
// webview connects through our transparent proxy. Status + captured entries
// are queried on demand; live updates are pushed via `devtools-network:change`.

function getInstanceByPort(port: number): InstanceState | null {
  for (const inst of instances.values()) if (inst.port === port) return inst;
  return null;
}

function devtoolsWorktreeKey(inst: InstanceState): string {
  return state.artifactStore?.worktreeHash(inst.worktree) ?? inst.id;
}

// Start the manager once per instance and wire its events to IPC. Idempotent.
async function ensureDevtoolsStarted(
  inst: InstanceState
): Promise<{ proxyPort: number; sessionNonce: string } | null> {
  if (!inst.metro) return null;
  if (!inst.devtools) {
    inst.devtools = new DevToolsManager(inst.metro, {});
    inst.devtools.on('delta', (payload: unknown) => {
      send('devtools-network:change', {
        instanceId: inst.id,
        port: inst.port,
        kind: 'delta',
        payload,
      });
    });
    inst.devtools.on('status', (payload: unknown) => {
      send('devtools-network:change', {
        instanceId: inst.id,
        port: inst.port,
        kind: 'status',
        payload,
      });
    });
  }
  if (!inst.devtoolsStarted) {
    const info = await inst.devtools.start(devtoolsWorktreeKey(inst));
    inst.devtoolsStarted = true;
    return info;
  }
  const status = inst.devtools.status(devtoolsWorktreeKey(inst));
  if (status.proxyPort === null || status.sessionNonce === null) return null;
  return { proxyPort: status.proxyPort, sessionNonce: status.sessionNonce };
}

export function registerDevtoolsHandlers() {
  ipcMain.handle('devtools-network:proxy-port', async (_, port: number) => {
    const inst = getInstanceByPort(port);
    if (!inst) return null;
    try {
      return await ensureDevtoolsStarted(inst);
    } catch {
      return null;
    }
  });

  ipcMain.handle('devtools-network:status', async (_, port: number) => {
    const inst = getInstanceByPort(port);
    if (!inst?.devtools) return null;
    return inst.devtools.status(devtoolsWorktreeKey(inst));
  });

  ipcMain.handle('devtools-network:list', async (_, port: number, filter?: unknown) => {
    const inst = getInstanceByPort(port);
    if (!inst?.devtools) return null;
    return inst.devtools.listNetwork(devtoolsWorktreeKey(inst), filter as any);
  });

  ipcMain.handle('devtools-network:get', async (_, port: number, requestId: string) => {
    const inst = getInstanceByPort(port);
    if (!inst?.devtools) return null;
    return inst.devtools.getNetwork(devtoolsWorktreeKey(inst), requestId);
  });

  ipcMain.handle('devtools-network:select-target', async (_, port: number, targetId: string) => {
    const inst = getInstanceByPort(port);
    if (!inst?.devtools) return { ok: false, error: 'DevTools not started' };
    try {
      await inst.devtools.selectTarget(devtoolsWorktreeKey(inst), targetId);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'selectTarget failed' };
    }
  });

  ipcMain.handle('devtools-network:clear', async (_, port: number) => {
    const inst = getInstanceByPort(port);
    if (!inst?.devtools) return { ok: false };
    inst.devtools.clear(devtoolsWorktreeKey(inst));
    return { ok: true };
  });

  // Full restart: used by the renderer's "Reconnect" button when the manager
  // landed in `no-target` and the user wants to rediscover targets.
  ipcMain.handle('devtools-network:restart', async (_, port: number) => {
    const inst = getInstanceByPort(port);
    if (!inst) return null;
    if (inst.devtools) {
      try { await inst.devtools.dispose(); } catch { /* best-effort */ }
      inst.devtools = null;
      inst.devtoolsStarted = false;
    }
    try {
      return await ensureDevtoolsStarted(inst);
    } catch {
      return null;
    }
  });
}
