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
  type InstanceState,
} from './state.js';

// Phase 13.5 — `MULTI_INSTANCE_NOT_SUPPORTED` retired. The daemon now
// supports multiple ref-counted attachers via session/release; what
// Electron rejects below is specifically the "same Electron process,
// second instance with a *different* profile" case, because Electron
// only carries one DaemonSession in main-process state. The
// daemon-side gate is `E_PROFILE_MISMATCH` from supervisor.attach() —
// we surface that directly rather than the old "restart the app"
// guidance, which masked the real reason. Cross-profile multi-attach
// in the same Electron is Phase 13.6+ work (it needs main-process
// state to hold N sessions).

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
      serviceLog: [],
      metroLog: [],
      metroStatus: 'starting',
    };

    instances.set(id, instance);
    state.activeInstanceId = id;

    // Notify renderer of the new instance
    send('instance:created', toSummary(instance));

    // No active daemon session yet (e.g. wizard from a fresh launch
    // with no matching default profile)? Attach one for THIS profile so
    // Settings/Marketplace/etc. work without an app restart. The
    // attached session publishes on serviceBus.modulesClient, which
    // wakes any in-flight `awaitModulesClient` rejection caused by an
    // earlier `abortModulesClient` call.
    if (!state.daemonSession) {
      try {
        // The wizard doesn't include `projectRoot` in its profile
        // payload (it's the same one for every profile in this
        // launch); fill it in from state so the daemon's profile-
        // guard doesn't reject with `E_PROFILE_PATH_NOT_STRING`.
        const sessionProfile: Profile = {
          ...profileData,
          projectRoot: state.projectRoot,
        };
        const session = await attachDaemonSession(sessionProfile, state.projectRoot);
        // Mirror startRealServices's wiring step (services.ts:373-375).
        // Without this, Metro starts but its log lines never reach the
        // renderer's `instance:metro` channel — the user sees "Daemon
        // session attached" and then silence.
        wireInstanceEvents(instance, session);
        // Auto-build for non-quick modes — same parity with the TUI
        // start-flow as `startRealServices` enforces. The wizard-path
        // attach (this branch) hits this when the user creates the
        // first instance from the wizard; without it, dirty/clean/
        // ultra-clean profiles silently skip the build.
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

    // Same-profile second instance: the daemon already has a live
    // session for this profile, so we just track the new Electron-side
    // instance record without opening a second daemon session. The
    // existing `state.daemonSession` keeps publishing events that the
    // renderer can route to either instance.
    const activeProfileName = state.daemonSessionProfileName;
    const incomingProfileName = profileData.name;
    if (
      activeProfileName !== null &&
      incomingProfileName !== undefined &&
      activeProfileName === incomingProfileName
    ) {
      const msg = `Sharing daemon session "${activeProfileName}" with new instance.`;
      appendLog(instance, 'service', msg);
      send('instance:log', { instanceId: id, text: msg });
      return { ok: true, instance: toSummary(instance) };
    }

    // Different-profile second instance: the daemon would reject the
    // attach with E_PROFILE_MISMATCH; we surface that directly. Single-
    // Electron-process multi-profile is a Phase 13.6+ story.
    const mismatchMsg =
      `Daemon already running a different profile in this project. ` +
      `Cross-profile multi-attach in one Electron app isn't supported yet — ` +
      `restart the app to switch profiles.`;
    appendLog(instance, 'service', mismatchMsg);
    send('instance:log', {
      instanceId: id,
      text: mismatchMsg,
    });

    return {
      ok: false,
      code: 'PROFILE_MISMATCH' as const,
      error: mismatchMsg,
      instance: toSummary(instance),
    };
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
    // Two-phase teardown now:
    //   1. UI-side: remove the tab immediately so the user sees their
    //      action take effect, no matter how long the daemon takes.
    //   2. Daemon-side: fire session/stop without awaiting the response.
    //      `supervisor.stop()` will run as soon as the current boot
    //      finishes its in-flight phase (or immediately if it's already
    //      `running`). Resources tear down in the background.
    //
    // Trade-off: if the daemon is mid-clean, Metro doesn't stop until
    // that clean phase ends. That's better than freezing the UI for
    // ten minutes — and far better than the pre-fix behavior of leaking
    // Metro entirely. A future refactor can make clean cancelable
    // (AbortSignal through CleanManager) so stop is truly immediate.
    if (state.daemonSession && state.activeInstanceId === instanceId) {
      const session = state.daemonSession;
      // Clear the references first so a follow-up `instances:create`
      // doesn't try to share a session that's tearing down.
      state.daemonSession = null;
      state.daemonSessionProfileName = null;
      // Fire-and-forget. Errors land in the audit / daemon log but
      // don't block the UI.
      void session.client
        .send({
          type: 'command',
          action: 'session/stop',
          id: `electron-close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // Best-effort log via send() — the instance might already be
          // deleted from the renderer at this point, which is fine; the
          // log line is for the daemon stderr trail.
          send('instance:log', { instanceId, text: `⚠ Background session/stop failed: ${message}` });
        });
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
