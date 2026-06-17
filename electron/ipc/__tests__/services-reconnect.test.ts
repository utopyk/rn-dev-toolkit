import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// GUI daemon auto-reconnect (parity with the MCP server, src/mcp/server.ts
// 5ba82d1). Before this, an unexpected daemon disconnect left the GUI's
// own session dropped with only a "⚠ Daemon disconnected" log — the user
// had to recreate the tab. surfaceDisconnect now self-heals owned
// sessions with bounded backoff. These tests lock the SAFETY contract:
// reconnect ONLY on an unexpected disconnect of a GUI-owned session, and
// NEVER for a user-removed tab, a quitting app, or an observe tab.

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: class {},
}));

const connectMock = vi.fn();
vi.mock('../../daemon-connect.js', () => ({
  connectElectronToDaemon: (...args: unknown[]) => connectMock(...args),
}));

import { attachDaemonSession, setElectronQuitting } from '../services.js';
import { state, instances, getSessionRecordForInstance, type InstanceState } from '../state.js';
import { asSessionId } from '../../../src/core/identifiers.js';
import type { Profile } from '../../../src/core/types.js';

let sessionCounter = 0;

function makeFakeSession() {
  const lifecycle = Object.assign(new EventEmitter(), { recentLogs: () => [] });
  return {
    metro: new EventEmitter(),
    devtools: new EventEmitter(),
    builder: new EventEmitter(),
    watcher: new EventEmitter(),
    modules: new EventEmitter(),
    lifecycle,
    sessionId: asSessionId(`sess-${++sessionCounter}`),
    client: { send: vi.fn(async () => ({ payload: {} })) },
    disconnect: vi.fn(),
    release: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

function makeProfile(): Profile {
  return {
    name: 'p', isDefault: true, worktree: null, branch: 'main', platform: 'ios',
    mode: 'quick', metroPort: 8081, devices: {}, buildVariant: 'debug',
    preflight: { checks: [], frequency: 'once' }, onSave: [], env: {},
    projectRoot: '/proj',
  } as Profile;
}

function makeInstance(id: string, observed = false): InstanceState {
  return {
    id, worktree: null, worktreeName: 'main', branch: 'main', port: 8081,
    deviceId: null, deviceName: '', deviceIcon: '📱', platform: 'ios',
    mode: 'quick', serviceLog: [], metroLog: [], metroStatus: 'running', observed,
  } as InstanceState;
}

async function flush(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('attachDaemonSession — GUI auto-reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectMock.mockReset();
    connectMock.mockImplementation(async () => makeFakeSession());
    instances.clear();
    state.sessions.clear();
    state.activeSessionId = null;
    state.activeInstanceId = null;
    state.mainWindow = null;
    setElectronQuitting(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    setElectronQuitting(false);
  });

  it('reconnects an owned session after an UNEXPECTED disconnect (tab persists, fresh session)', async () => {
    const inst = makeInstance('w-8081');
    instances.set(inst.id, inst);
    const rec = await attachDaemonSession({ projectRoot: '/proj', instanceId: inst.id, profile: makeProfile() });
    expect(connectMock).toHaveBeenCalledTimes(1);
    const firstSessionId = rec.sessionId;

    // Unexpected socket death — record is still in state.sessions.
    (rec.daemonSession as unknown as { metro: EventEmitter }).metro.emit('disconnected', new Error('socket closed'));

    // First backoff tick is 1s.
    await flush(1100);

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(instances.has('w-8081')).toBe(true); // tab persisted
    const fresh = getSessionRecordForInstance('w-8081');
    expect(fresh).toBeTruthy();
    expect(fresh!.sessionId).not.toBe(firstSessionId); // a NEW session
    expect(state.activeSessionId).toBe(fresh!.sessionId);
  });

  it('does NOT reconnect when the user removed the tab (record pre-deleted)', async () => {
    const inst = makeInstance('w-8081');
    instances.set(inst.id, inst);
    const rec = await attachDaemonSession({ projectRoot: '/proj', instanceId: inst.id, profile: makeProfile() });

    // instances:remove pre-deletes the record before session/stop; mirror that.
    state.sessions.delete(rec.sessionId);
    (rec.daemonSession as unknown as { metro: EventEmitter }).metro.emit('disconnected', new Error('stopped'));

    await flush(2000);
    expect(connectMock).toHaveBeenCalledTimes(1); // no resurrection
  });

  it('does NOT reconnect while the app is quitting', async () => {
    const inst = makeInstance('w-8081');
    instances.set(inst.id, inst);
    const rec = await attachDaemonSession({ projectRoot: '/proj', instanceId: inst.id, profile: makeProfile() });

    setElectronQuitting(true);
    (rec.daemonSession as unknown as { metro: EventEmitter }).metro.emit('disconnected', new Error('quit'));

    await flush(2000);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT reconnect an OBSERVE tab — it removes the tab instead', async () => {
    const inst = makeInstance('agent-x', true);
    instances.set(inst.id, inst);
    const rec = await attachDaemonSession({
      projectRoot: '/proj',
      instanceId: inst.id,
      observe: { sessionId: asSessionId('agent-sess') },
    });

    (rec.daemonSession as unknown as { metro: EventEmitter }).metro.emit('disconnected');

    await flush(2000);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(instances.has('agent-x')).toBe(false); // observe tab removed, not reconnected
  });

  it('retries with backoff while the daemon stays down, then succeeds when it returns', async () => {
    const inst = makeInstance('w-8081');
    instances.set(inst.id, inst);
    const rec = await attachDaemonSession({ projectRoot: '/proj', instanceId: inst.id, profile: makeProfile() });

    // Daemon stays down for the first two retries (1s, 2s), then recovers.
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    (rec.daemonSession as unknown as { metro: EventEmitter }).metro.emit('disconnected', new Error('down'));

    await flush(1100); // attempt 1 → fails
    expect(getSessionRecordForInstance('w-8081')).toBeNull();
    await flush(2100); // attempt 2 → fails
    expect(getSessionRecordForInstance('w-8081')).toBeNull();
    await flush(5100); // attempt 3 → succeeds (default impl)
    expect(getSessionRecordForInstance('w-8081')).toBeTruthy();
  });
});
