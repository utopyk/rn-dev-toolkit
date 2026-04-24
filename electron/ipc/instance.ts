import { ipcMain } from 'electron';
import path from 'path';
import { ProfileStore } from '../../src/core/profile.js';
import { getCurrentBranch } from '../../src/core/project.js';
import { listDevices } from '../../src/core/device.js';
import {
  instances,
  state,
  send,
  appendLog,
  toSummary,
  findFreePort,
  type InstanceState,
} from './state.js';

// Phase 13.4.1 — one daemon = one worktree = one session. A second
// instance against the same daemon is not supported in this release;
// the multi-session story lands with Phase 13.5 ref-counted
// `DaemonSession.release()` semantics. `instances:create` still
// materializes the renderer-side instance record (the wizard flow
// needs it) but surfaces a loud warning that a restart is required
// before services attach.
const MULTI_INSTANCE_NOT_SUPPORTED_MSG =
  'This release supports one active instance per project. ' +
  'Restart the app to attach services to the newly-created profile.';

export function registerInstanceHandlers() {
  ipcMain.handle('instances:list', async () => {
    return Array.from(instances.values()).map(toSummary);
  });

  ipcMain.handle('instances:create', async (_, data) => {
    if (!state.projectRoot) return { ok: false, error: 'No project root' };

    let profileData;
    if (typeof data === 'string') {
      // data is a profile name — load it from disk
      const profileStore = new ProfileStore(path.join(state.projectRoot, '.rn-dev', 'profiles'));
      profileData = profileStore.load(data);
      if (!profileData) return { ok: false, error: `Profile "${data}" not found` };
    } else {
      // data is raw profile object (from wizard)
      profileData = data;
    }

    const worktreePath = profileData.worktree ?? null;
    const worktreeName = worktreePath ? path.basename(worktreePath) : 'main';
    // Always auto-allocate a free port to avoid conflicts between instances
    const port = findFreePort();
    const id = `${worktreeName}-${port}`;

    // Don't create duplicates
    if (instances.has(id)) {
      return { ok: false, error: `Instance ${id} already exists` };
    }

    const branch = profileData.branch ?? await getCurrentBranch(state.projectRoot) ?? 'main';

    // Determine device info
    let deviceName = 'No device';
    let deviceIcon = '💻';
    let deviceId: string | null = null;

    if (profileData.devices) {
      const iosDeviceId = profileData.devices.ios;
      const androidDeviceId = profileData.devices.android;
      deviceId = iosDeviceId ?? androidDeviceId ?? null;

      if (deviceId) {
        try {
          const platform = profileData.platform ?? 'ios';
          const deviceList = await listDevices(platform);
          const foundDevice = deviceList.find(d => d.id === deviceId);
          if (foundDevice) {
            deviceName = foundDevice.name;
            deviceIcon = foundDevice.isPhysical ? '📱' : '💻';
          }
        } catch {
          // Keep defaults
        }
      }
    }

    const instance: InstanceState = {
      id,
      worktree: worktreePath,
      worktreeName,
      branch,
      port,
      deviceId,
      deviceName,
      deviceIcon,
      platform: profileData.platform ?? 'ios',
      mode: profileData.mode ?? 'dirty',
      metro: null,
      devtools: null,
      devtoolsStarted: false,
      builder: null,
      serviceLog: [],
      metroLog: [],
      metroStatus: 'starting',
    };

    instances.set(id, instance);
    state.activeInstanceId = id;

    // Notify renderer of the new instance
    send('instance:created', toSummary(instance));

    // Phase 13.4.1: no in-process startInstanceServices — services live
    // in the daemon and only the first `startRealServices` call on boot
    // opens a session for the default profile. Return `ok: false` so
    // the wizard treats this as a failure the user has to resolve (app
    // restart) — returning `ok: true` would silently pretend services
    // attached. Arch P1 on PR #20.
    appendLog(instance, 'service', MULTI_INSTANCE_NOT_SUPPORTED_MSG);
    send('instance:log', {
      instanceId: id,
      text: MULTI_INSTANCE_NOT_SUPPORTED_MSG,
    });

    return {
      ok: false,
      code: 'MULTI_INSTANCE_NOT_SUPPORTED' as const,
      error: MULTI_INSTANCE_NOT_SUPPORTED_MSG,
      instance: toSummary(instance),
    };
  });

  ipcMain.handle('instances:remove', async (_, instanceId: string) => {
    const instance = instances.get(instanceId);
    if (!instance) return { ok: false, error: 'Instance not found' };

    // Phase 13.4.1 — `instance.metro` / `.devtools` / `.builder` are
    // always null (no in-process services are ever attached); the
    // daemon owns every runtime service. The pre-flip teardown branches
    // that called `.dispose()` / `.stop()` here were dead code. If the
    // instance being removed was the active one that `startRealServices`
    // opened a daemon session for, the session stays alive — teardown
    // is the user's choice via app quit (Phase 13.5 grows ref-counted
    // `DaemonSession.release()` for the multi-instance story).
    instances.delete(instanceId);

    if (state.activeInstanceId === instanceId) {
      const remaining = Array.from(instances.keys());
      state.activeInstanceId = remaining.length > 0 ? remaining[0] : null;
    }

    send('instance:removed', instanceId);
    return { ok: true, newActiveId: state.activeInstanceId };
  });

  ipcMain.handle('instances:setActive', async (_, instanceId: string) => {
    if (instances.has(instanceId)) {
      state.activeInstanceId = instanceId;
      return { ok: true };
    }
    return { ok: false, error: 'Instance not found' };
  });

  ipcMain.handle('instances:getActive', async () => {
    return state.activeInstanceId;
  });

  ipcMain.handle('instances:getLogs', async (_, instanceId: string) => {
    const instance = instances.get(instanceId);
    if (!instance) return { serviceLines: [], metroLines: [] };
    return {
      serviceLines: [...instance.serviceLog],
      metroLines: [...instance.metroLog],
    };
  });

  // ── Retry a specific step for an instance ──
  // Phase 13.4.1 — step retry is not yet wired through the daemon.
  // preflight / clean / watchman / metro / build retries want to drive
  // individual steps on a session that's already running, which the
  // daemon's current `session/start` + `metro/reload` + `builder/build`
  // surface doesn't model directly. Phase 13.5 grows the daemon-side
  // session API to take targeted retry requests; until then, ask the
  // user to fully restart the session.
  ipcMain.handle('instance:retryStep', async (_, data: { instanceId: string; stepId: string }) => {
    const { instanceId, stepId } = data;
    const instance = instances.get(instanceId);
    if (!instance) return { ok: false, error: 'Instance not found' };
    const msg = `Step retry (${stepId}) is not wired to the daemon yet — restart the app to re-run the full boot sequence.`;
    appendLog(instance, 'service', msg);
    send('instance:log', { instanceId: instance.id, text: msg });
    return { ok: false, error: msg };
  });
}
