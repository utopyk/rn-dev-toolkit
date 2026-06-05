import { ipcMain } from 'electron';
import path from 'path';
import { ProfileStore } from '../../src/core/profile.js';
import { getCurrentBranch } from '../../src/core/project.js';
import { listDevices } from '../../src/core/device.js';
import { attachDaemonSession, wireInstanceEvents } from './services.js';
import { triggerBuildsIfNeeded } from '../../src/app/auto-build.js';
import type { Profile } from '../../src/core/types.js';
import {
  instances,
  state,
  send,
  appendLog,
  toSummary,
  findFreePort,
  getSessionRecordForInstance,
  countNonObservedSessions,
  MAX_SESSIONS,
  type InstanceState,
} from './state.js';

// Phase E1 — every instances:create call mints a fresh daemon session.
// The pre-E1 same-profile-sharing path AND the cross-profile rejection
// are both gone: the daemon's supervisor.attach() supports N concurrent
// sessions per worktree, so the renderer's `+ tab` flow is now a
// straight "open a new session." The cap is `MAX_SESSIONS` (4 per
// memory `feedback_parallel_instance_requirement`).
//
// Phase A8 of the plan (Deepening insights) called out a race: concurrent
// instances:create invocations could double-allocate ports + double-
// attach. Serialized below via `pendingCreate`.
let pendingCreate: Promise<unknown> | null = null;

export function registerInstanceHandlers() {
  ipcMain.handle('instances:list', async () => {
    return Array.from(instances.values()).map(toSummary);
  });

  ipcMain.handle('instances:create', async (_, data) => {
    if (pendingCreate) {
      // Chain after any in-flight create so port allocation + session
      // attach don't interleave. The previous create's outcome doesn't
      // gate this one — we await its promise to settle, then run.
      try { await pendingCreate; } catch { /* prior create's error is its own to surface */ }
    }
    const work = doCreate(data);
    pendingCreate = work.finally(() => {
      if (pendingCreate === work) pendingCreate = null;
    });
    return work;
  });

  ipcMain.handle('instances:remove', async (_, instanceId: string) => {
    const instance = instances.get(instanceId);
    if (!instance) return { ok: false, error: 'Instance not found' };

    // User-reported (2026-05-06): closing a tab left Metro running.
    // First fix sent session/stop synchronously, but the daemon's
    // supervisor.stop() AWAITS any in-flight boot before tearing down
    // (src/daemon/supervisor.ts:378-385). Under ultra-clean mode the
    // boot's clean step can take 5-10 minutes, so the synchronous wait
    // froze the kill — second user report: "killing the tab still does
    // nothing in the ultra clean profile".
    //
    // Two-phase teardown:
    //   1. UI-side: remove the tab immediately so the user sees their
    //      action take effect, no matter how long the daemon takes.
    //   2. Daemon-side: fire session/stop (scoped to THIS session's id)
    //      without awaiting the response. `supervisor.stop()` will run
    //      as soon as the current boot finishes its in-flight phase
    //      (or immediately if it's already `running`).
    //
    // Phase E1: scoped to one session — other sessions keep running.
    const record = getSessionRecordForInstance(instanceId);
    if (record) {
      const { sessionId, daemonSession, observed } = record;
      // Clear before firing the (async) teardown so a follow-up
      // instances:create doesn't see a tearing-down record.
      state.sessions.delete(sessionId);
      if (state.activeSessionId === sessionId) {
        const next = state.sessions.keys().next().value ?? null;
        state.activeSessionId = next;
      }
      if (observed) {
        // Observe tab: detach our read-only observer socket ONLY. The
        // agent's session keeps running for everyone else — firing
        // `session/stop` here would be kill-for-everyone and yank the
        // session out from under the agent we're watching.
        // `disconnect()` is idempotent + safe if the daemon already died.
        daemonSession.disconnect();
      } else {
        void daemonSession.client
          .send({
            type: 'command',
            action: 'session/stop',
            id: `electron-close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            payload: { sessionId },
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            send('instance:log', { instanceId, text: `⚠ Background session/stop failed: ${message}` });
          });
      }
    }

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
      const record = getSessionRecordForInstance(instanceId);
      if (record) state.activeSessionId = record.sessionId;
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

async function doCreate(data: unknown): Promise<unknown> {
  if (!state.projectRoot) return { ok: false, error: 'No project root' };

  // Only count GUI-created sessions toward the human cap — auto-observed
  // agent/MCP tabs live in the same Map but must not block the user from
  // opening their own session.
  if (countNonObservedSessions() >= MAX_SESSIONS) {
    return {
      ok: false,
      code: 'E_SESSION_LIMIT_REACHED' as const,
      error: `Cannot create more than ${MAX_SESSIONS} concurrent sessions. Close an existing tab first.`,
    };
  }

  let profileData;
  if (typeof data === 'string') {
    const profileStore = new ProfileStore(path.join(state.projectRoot, '.rn-dev', 'profiles'));
    profileData = profileStore.load(data);
    if (!profileData) return { ok: false, error: `Profile "${data}" not found` };
  } else {
    profileData = data as {
      worktree?: string;
      branch?: string;
      platform?: 'ios' | 'android' | 'both';
      mode?: 'quick' | 'dirty' | 'clean' | 'ultra-clean';
      metroPort?: number;
      devices?: { ios?: string; android?: string };
      name?: string;
    };
  }

  const worktreePath = profileData.worktree ?? null;
  const worktreeName = worktreePath ? path.basename(worktreePath) : 'main';
  // Phase E bug-fix — use the profile's `metroPort` instead of
  // findFreePort's lowest-free scan. Pre-fix the renderer's instance
  // port ('8081' for tab 1, '8082' for tab 2 — whatever findFreePort
  // returned) drifted from the daemon's `react-native run-* --port X`
  // (X = profile.metroPort), so the renderer's DevToolsView tried to
  // load the React Native fusebox at `localhost:<renderer port>` and
  // got ERR_CONNECTION_REFUSED because Metro was actually on
  // `<profile.metroPort>`. Manifested as "DevTools unavailable" for
  // every tab whose profile's metroPort wasn't 8081. Same bug applied
  // for `metro:port` IPC + every tooltip that displays the port.
  //
  // Fallback to findFreePort only when the profile's metroPort is
  // missing or invalid — should never happen with wizard-written
  // profiles (metroPort is required in `Profile`).
  const port = typeof profileData.metroPort === 'number' && profileData.metroPort > 0
    ? profileData.metroPort
    : findFreePort();
  const id = `${worktreeName}-${port}`;

  if (instances.has(id)) {
    return { ok: false, error: `Instance ${id} already exists` };
  }

  const branch = profileData.branch ?? await getCurrentBranch(state.projectRoot) ?? 'main';

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
    serviceLog: [],
    metroLog: [],
    metroStatus: 'starting',
    observed: false,
  };

  instances.set(id, instance);
  state.activeInstanceId = id;

  send('instance:created', toSummary(instance));

  try {
    // The wizard doesn't include `projectRoot` in its profile payload
    // (it's the same one for every profile in this launch); fill it in
    // from state so the daemon's profile-guard doesn't reject with
    // `E_PROFILE_PATH_NOT_STRING`.
    const sessionProfile: Profile = {
      ...profileData,
      projectRoot: state.projectRoot,
    } as Profile;
    const record = await attachDaemonSession({
      projectRoot: state.projectRoot,
      instanceId: id,
      profile: sessionProfile,
    });
    const session = record.daemonSession;
    // Mirror startRealServices's wiring step (services.ts). Without
    // this, Metro starts but its log lines never reach the renderer's
    // `instance:metro` channel.
    wireInstanceEvents(instance, session);
    triggerBuildsIfNeeded(session, sessionProfile, state.projectRoot);
    const msg = `Daemon session attached for profile "${profileData.name ?? id}".`;
    appendLog(instance, 'service', msg);
    send('instance:log', { instanceId: id, text: msg });
    return { ok: true, instance: toSummary(instance) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const msg = `Failed to attach daemon session: ${message}`;
    appendLog(instance, 'service', msg);
    send('instance:log', { instanceId: id, text: msg });
    return {
      ok: false,
      code: 'DAEMON_ATTACH_FAILED' as const,
      error: msg,
      instance: toSummary(instance),
    };
  }
}
