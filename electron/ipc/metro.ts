import { ipcMain } from 'electron';
import { serviceBus } from '../../src/app/service-bus.js';
import type { MetroClient } from '../../src/app/client/metro-adapter.js';
import type { SessionId } from '../../src/core/identifiers.js';
import {
  instances,
  state,
  appendLog,
  send,
  getActiveSessionRecord,
  getSessionRecordForInstance,
} from './state.js';

// Phase E2 — per-session MetroClient map. The pre-E `metroClient: MetroClient
// | null` singleton was last-write-wins under N sessions: every
// attachDaemonSession call would publish on `serviceBus.metro` and the
// listener would clobber the previous client, so the OLDEST tab's reload
// would land on the NEWEST session.
//
// serviceBus payloads already carry sessionId (Phase D5); the consumer
// side just needs to multiplex by it.
const metroClients = new Map<SessionId, MetroClient>();

serviceBus.on('metro', ({ sessionId, metro }) => {
  metroClients.set(sessionId, metro);
  metro.on('disconnected', () => {
    // Only remove if THIS metro is the cached one — a daemon respawn
    // mid-session would otherwise drop the fresh entry.
    if (metroClients.get(sessionId) === metro) {
      metroClients.delete(sessionId);
    }
  });
});

/**
 * Resolve the MetroClient for a given instanceId. Renderer handlers
 * pass instanceId (the renderer's per-tab key); server resolves to
 * sessionId via SessionRecord. Falls back to the active session when
 * no instanceId is provided (legacy callers).
 */
function clientForInstance(instanceId?: string): MetroClient | null {
  if (instanceId) {
    const record = getSessionRecordForInstance(instanceId);
    if (record) return metroClients.get(record.sessionId) ?? null;
  }
  const active = getActiveSessionRecord();
  if (!active) return null;
  return metroClients.get(active.sessionId) ?? null;
}

export function registerMetroHandlers() {
  ipcMain.handle('metro:reload', async (_evt, instanceId?: string) => {
    const client = clientForInstance(instanceId);
    if (!client) {
      send('service:log', 'Metro not running');
      return;
    }
    await client.reload();
    const id = instanceId ?? state.activeInstanceId;
    const instance = id ? instances.get(id) : null;
    const msg = 'Reload signal sent';
    if (instance) {
      appendLog(instance, 'service', msg);
      send('instance:log', { instanceId: instance.id, text: msg });
    } else {
      send('service:log', msg);
    }
  });

  ipcMain.handle('metro:devMenu', async (_evt, instanceId?: string) => {
    const client = clientForInstance(instanceId);
    if (!client) {
      send('service:log', 'Metro not running');
      return;
    }
    await client.devMenu();
    const id = instanceId ?? state.activeInstanceId;
    const instance = id ? instances.get(id) : null;
    const msg = 'Dev menu signal sent';
    if (instance) {
      appendLog(instance, 'service', msg);
      send('instance:log', { instanceId: instance.id, text: msg });
    } else {
      send('service:log', msg);
    }
  });

  ipcMain.handle('metro:port', async (_evt, instanceId?: string) => {
    // Per session: the port lives on the daemon's Metro instance. Falls
    // back to the renderer's per-instance .port (assigned at create
    // time) when the daemon adapter hasn't published yet — happens
    // during the first ~200ms after instances:create.
    const client = clientForInstance(instanceId);
    const id = instanceId ?? state.activeInstanceId;
    if (!client) {
      return id ? instances.get(id)?.port ?? 8081 : 8081;
    }
    try {
      const inst = await client.getInstance();
      return inst?.port ?? 8081;
    } catch {
      return 8081;
    }
  });
}
