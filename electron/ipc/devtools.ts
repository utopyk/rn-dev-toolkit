import { ipcMain } from 'electron';
import { serviceBus } from '../../src/app/service-bus.js';
import type { DevToolsClient } from '../../src/app/client/devtools-adapter.js';
import type { SessionId } from '../../src/core/identifiers.js';
import {
  instances,
  send,
  getActiveSessionRecord,
  getSessionRecordForInstance,
} from './state.js';

// ── DevTools (devtools-network module) — daemon-client proxy ──
//
// Phase E2 — per-session DevToolsClient map. Each session has its own
// DevToolsClient backed by its own daemon-side `devtools-network`
// subprocess on its own ephemeral proxyPort. Pre-E this was a
// singleton-by-coincidence; under N sessions the singleton meant the
// renderer's "show CDP target list" panel always reflected whichever
// session attached LAST.
//
// Push events fan out per-instance: each session's `delta` / `status`
// emission triggers one `devtools-network:change` message scoped to
// THAT session's instance(s). The renderer filters by `port` (still
// 1:1 with the daemon's Metro instance per session).
const devtoolsClients = new Map<SessionId, DevToolsClient>();
const detachBySessionId = new Map<SessionId, () => void>();

serviceBus.on('devtools', ({ sessionId, devtools }) => {
  const prevDetach = detachBySessionId.get(sessionId);
  if (prevDetach) prevDetach();
  devtoolsClients.set(sessionId, devtools);

  const onDelta = (payload: unknown) => fanChange(sessionId, 'delta', payload);
  const onStatus = (payload: unknown) => fanChange(sessionId, 'status', payload);
  const onDisconnected = (): void => {
    if (devtoolsClients.get(sessionId) === devtools) {
      devtoolsClients.delete(sessionId);
      detachBySessionId.delete(sessionId);
    }
  };
  devtools.on('delta', onDelta);
  devtools.on('status', onStatus);
  devtools.on('disconnected', onDisconnected);
  detachBySessionId.set(sessionId, () => {
    devtools.off('delta', onDelta);
    devtools.off('status', onStatus);
    devtools.off('disconnected', onDisconnected);
  });
});

function fanChange(sessionId: SessionId, kind: 'delta' | 'status', payload: unknown): void {
  // Phase E2 — fan only to the instances bound to THIS session, not all
  // open tabs. The renderer's DevToolsView already filters by port, but
  // emitting to OTHER sessions' instances would surface session-A
  // traffic on session-B's panel — exactly the cross-tab contamination
  // memory `feedback_parallel_instance_requirement` calls out.
  for (const inst of instances.values()) {
    const record = getSessionRecordForInstance(inst.id);
    if (!record || record.sessionId !== sessionId) continue;
    send('devtools-network:change', {
      port: inst.port,
      kind,
      payload,
    });
  }
}

function clientForInstance(instanceId?: string): DevToolsClient | null {
  if (instanceId) {
    const record = getSessionRecordForInstance(instanceId);
    if (record) return devtoolsClients.get(record.sessionId) ?? null;
  }
  const active = getActiveSessionRecord();
  if (!active) return null;
  return devtoolsClients.get(active.sessionId) ?? null;
}

/**
 * Resolve the SessionRecord an instanceId (or the active tab) maps to.
 * Used to gate the *mutating* DevTools ops (`select-target`, `restart`)
 * for observed (read-only) sessions: both swap/restart the SHARED
 * per-session CDP proxy + selected target the agent's capture module is
 * reading, so a human observing must not perturb them. The renderer also
 * hides these controls for observe tabs; this is defense-in-depth.
 */
function isObservedInstance(instanceId?: string): boolean {
  if (instanceId) {
    const record = getSessionRecordForInstance(instanceId);
    if (record) return record.observed;
  }
  return getActiveSessionRecord()?.observed ?? false;
}

export function registerDevtoolsHandlers() {
  ipcMain.handle('devtools-network:proxy-port', async (_evt, instanceId?: string) => {
    const client = clientForInstance(instanceId);
    if (!client) return null;
    try {
      const status = await client.status();
      if (status.proxyPort === null || status.sessionNonce === null) {
        return null;
      }
      return { proxyPort: status.proxyPort, sessionNonce: status.sessionNonce };
    } catch (err) {
      console.error('[devtools-network:proxy-port] failed:', err);
      return null;
    }
  });

  ipcMain.handle('devtools-network:status', async (_evt, instanceId?: string) => {
    const client = clientForInstance(instanceId);
    if (!client) return null;
    try {
      return await client.status();
    } catch (err) {
      console.error('[devtools-network:status] failed:', err);
      return null;
    }
  });

  ipcMain.handle('devtools-network:select-target', async (_evt, arg1: unknown, arg2?: unknown) => {
    // Legacy renderer signature was `(port: number, targetId: string)`;
    // multi-session signature is `(instanceId: string, targetId: string)`.
    // Distinguish by arg1 type so both work during the renderer migration.
    let instanceId: string | undefined;
    let targetId: string;
    if (typeof arg1 === 'string' && typeof arg2 === 'string') {
      instanceId = arg1;
      targetId = arg2;
    } else if (typeof arg1 === 'number' && typeof arg2 === 'string') {
      targetId = arg2;
    } else if (typeof arg1 === 'string' && arg2 === undefined) {
      targetId = arg1;
    } else {
      return { ok: false, error: 'select-target: invalid arguments' };
    }
    if (isObservedInstance(instanceId)) {
      return {
        ok: false,
        error: 'Target selection is disabled while observing an agent session (read-only).',
      };
    }
    const client = clientForInstance(instanceId);
    if (!client) return { ok: false, error: 'DevTools not started' };
    try {
      await client.selectTarget(targetId);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'selectTarget failed';
      console.error('[devtools-network:select-target] failed:', err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('devtools-network:restart', async (_evt, instanceId?: string) => {
    if (isObservedInstance(instanceId)) {
      // Restart disposes + re-starts the shared per-session CDP proxy,
      // which would tear down the target the agent's capture is reading.
      // Read-only observers never restart it.
      console.warn('[devtools-network:restart] refused — observed (read-only) session');
      return null;
    }
    const client = clientForInstance(instanceId);
    if (!client) return null;
    try {
      return await client.restart();
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
