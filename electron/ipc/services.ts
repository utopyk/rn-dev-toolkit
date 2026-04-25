// Electron-UX wrapper around the daemon client. Phase 13.4.1 collapsed
// the 514 LOC of in-process orchestration that pre-dated Phase 13 —
// preflight, clean, watchman, port-kill, Metro start, simulator boot,
// builder run — all of which now live in the daemon's session boot
// (`bootSessionServices`) and its client RPCs (`metro/*`, `builder/*`,
// `watcher/*`).
//
// What stays Electron-side:
//   - Package-manager conflict prompt. Interactive, needs the renderer's
//     `instance:prompt` + `prompt:respond:*` IPC round-trip. Settled
//     BEFORE `connectElectronToDaemon` so the profile we hand the
//     daemon is already consistent.
//   - Code-signing detection + fix prompt. Same reason.
//   - Electron instance bookkeeping (`instances` map, `activeInstanceId`)
//     so the renderer has the grouping concept it was built against.
//
// What gets forwarded from daemon adapters to the renderer:
//   - metro.on('log')        → `instance:metro`
//   - builder.on('line')     → `instance:build:line`
//   - builder.on('done')     → `instance:build:done`
//   - builder.on('progress') → `instance:build:progress`
//
// Section-based UX (`instance:section:start|end`) went away with the
// in-process orchestration. The renderer gracefully degrades; Phase
// 13.5 can reintroduce section events if the daemon starts emitting
// them on `session/log`.

import { ipcMain } from 'electron';
import path, { join } from 'path';
import { existsSync } from 'fs';
import { ArtifactStore } from '../../src/core/artifact.js';
import { ProfileStore } from '../../src/core/profile.js';
import { getCurrentBranch } from '../../src/core/project.js';
import { listDevices } from '../../src/core/device.js';
import { detectAllPackageManagers, detectPackageManager } from '../../src/core/clean.js';
import { connectElectronToDaemon } from '../daemon-connect.js';
import { serviceBus } from '../../src/app/service-bus.js';
import type { DaemonSession } from '../../src/app/client/session.js';
import type { Profile } from '../../src/core/types.js';
import { instances, state, send, appendLog, toSummary, findFreePort, type InstanceState } from './state.js';

/**
 * Settle the profile's package manager choice. When multiple lockfiles
 * exist (yarn.lock + package-lock.json + bun.lockb, etc.) and the
 * profile doesn't already pin one, prompt the renderer + persist the
 * choice to the profile. Side effects: deletes the non-chosen lockfiles
 * so the daemon's install step doesn't get confused. Called BEFORE
 * `connectElectronToDaemon` so the profile the daemon sees is consistent.
 */
async function settlePackageManager(
  profile: Profile,
  profileStore: ProfileStore,
  instance: InstanceState,
  projectRoot: string,
): Promise<void> {
  if (profile.packageManager) return;
  const effectiveRoot = instance.worktree ?? projectRoot;
  const detected = detectAllPackageManagers(effectiveRoot);
  const active = detected.filter((d) => d.detected);
  if (active.length < 2) return;

  const emit = (text: string): void => {
    appendLog(instance, 'service', text);
    send('instance:log', { instanceId: instance.id, text });
  };
  emit('⚠ Multiple package managers detected:');
  for (const d of active) emit(`    • ${d.name} (${d.reason})`);

  const response = await new Promise<'npm' | 'yarn' | 'pnpm'>((resolve) => {
    const promptId = `pm-${instance.id}-${Date.now()}`;
    send('instance:prompt', {
      instanceId: instance.id,
      promptId,
      title: 'Package Manager Conflict',
      message:
        'Multiple package managers detected. Which one should be used?',
      options: active.map((d) => ({
        value: d.name,
        label: `${d.name} (${d.reason})`,
        cleanup:
          d.name === 'npm'
            ? 'Delete yarn.lock'
            : d.name === 'yarn'
              ? 'Delete package-lock.json'
              : d.name === 'pnpm'
                ? 'Delete package-lock.json & yarn.lock'
                : undefined,
      })),
    });
    ipcMain.handle(`prompt:respond:${promptId}`, async (_, data) => {
      resolve(data.value as 'npm' | 'yarn' | 'pnpm');
      return { ok: true };
    });
    setTimeout(() => {
      const autoDetected = detectPackageManager(effectiveRoot);
      emit(`  ⏳ No response — using auto-detected: ${autoDetected}`);
      resolve(autoDetected);
    }, 60_000);
  });

  emit(`  ✔ Using ${response}`);
  const fs = require('fs');
  if (response === 'npm' && existsSync(join(effectiveRoot, 'yarn.lock'))) {
    fs.unlinkSync(join(effectiveRoot, 'yarn.lock'));
    emit('  🗑 Deleted yarn.lock');
  } else if (response === 'yarn' && existsSync(join(effectiveRoot, 'package-lock.json'))) {
    fs.unlinkSync(join(effectiveRoot, 'package-lock.json'));
    emit('  🗑 Deleted package-lock.json');
  } else if (response === 'pnpm') {
    for (const f of ['yarn.lock', 'package-lock.json']) {
      if (existsSync(join(effectiveRoot, f))) {
        fs.unlinkSync(join(effectiveRoot, f));
        emit(`  🗑 Deleted ${f}`);
      }
    }
  }

  profile.packageManager = response;
  if (profile.name) {
    const existing = profileStore.load(profile.name);
    if (existing) {
      existing.packageManager = response;
      profileStore.save(existing);
    }
  }
}

/**
 * Detect Manual code signing on iOS projects + prompt the renderer to
 * switch to Automatic. The daemon's build flow will break on Manual
 * signing without the Fastlane-managed certificates; fixing it here
 * BEFORE `connectElectronToDaemon` keeps the prompt in the same UX
 * lane as the package-manager conflict.
 */
async function settleCodeSigning(
  instance: InstanceState,
  projectRoot: string,
): Promise<void> {
  if (instance.mode === 'quick') return;
  if (instance.platform !== 'ios' && instance.platform !== 'both') return;

  const effectiveRoot = instance.worktree ?? projectRoot;
  const iosDir = join(effectiveRoot, 'ios');
  let entries: string[];
  try {
    entries = require('fs').readdirSync(iosDir);
  } catch {
    return;
  }

  const emit = (text: string): void => {
    appendLog(instance, 'service', text);
    send('instance:log', { instanceId: instance.id, text });
  };

  for (const entry of entries) {
    if (!entry.endsWith('.xcodeproj')) continue;
    const pbxproj = join(iosDir, entry, 'project.pbxproj');
    if (!existsSync(pbxproj)) continue;
    const content = require('fs').readFileSync(pbxproj, 'utf8');
    const manualMatches = content.match(/CODE_SIGN_STYLE\s*=\s*Manual/g);
    if (!manualMatches || manualMatches.length === 0) break;

    emit(`⚠ Manual code signing detected (${manualMatches.length} targets)`);
    const signingResponse = await new Promise<string>((resolve) => {
      const promptId = `signing-${instance.id}-${Date.now()}`;
      send('instance:prompt', {
        instanceId: instance.id,
        promptId,
        title: 'Code Signing Conflict',
        message:
          `This project uses Manual code signing (set by CI/Fastlane). Local builds will fail without the CI certificates.\n\nSwitch to Automatic signing? This won't break CI — Fastlane overrides it at build time.`,
        options: [
          { value: 'fix', label: '✔ Switch to Automatic signing', cleanup: 'Safe — CI overrides this' },
          { value: 'skip', label: 'Skip — I have the certificates' },
        ],
      });
      ipcMain.handle(`prompt:respond:${promptId}`, async (_, data) => {
        resolve(data.value);
        return { ok: true };
      });
      setTimeout(() => resolve('skip'), 60_000);
    });

    if (signingResponse === 'fix') {
      const fixed = content
        .replace(/CODE_SIGN_STYLE\s*=\s*Manual/g, 'CODE_SIGN_STYLE = Automatic')
        .replace(/CODE_SIGN_IDENTITY\s*=\s*"[^"]*"/g, 'CODE_SIGN_IDENTITY = "Apple Development"')
        .replace(/CODE_SIGN_IDENTITY\s*=\s*[^;]+;/g, 'CODE_SIGN_IDENTITY = "Apple Development";')
        .replace(/PROVISIONING_PROFILE_SPECIFIER\s*=\s*"[^"]*"/g, 'PROVISIONING_PROFILE_SPECIFIER = ""')
        .replace(/PROVISIONING_PROFILE_SPECIFIER\s*=\s*[^;]+;/g, 'PROVISIONING_PROFILE_SPECIFIER = "";');
      require('fs').writeFileSync(pbxproj, fixed);
      emit('  ✔ Switched to Automatic signing');
    } else {
      emit('  ℹ Keeping Manual signing');
    }
    break;
  }
}

// Single-flight guard for the disconnect log. The daemon's five
// adapters each fire their own `disconnected` event when the socket
// drops; we want one user-visible log line, not five. Reset whenever
// a fresh session attaches.
let disconnectLoggedFor: DaemonSession | null = null;
let electronQuittingFlag = false;

/**
 * Surface daemon disconnect on a single adapter so the user gets one
 * log line + a fast-fail signal for any in-flight modules: handlers.
 * Exported so `electron/main.ts` can flip the quitting flag during
 * `window-all-closed` to suppress the cosmetic "daemon disconnected"
 * notice during a clean app quit.
 */
export function setElectronQuitting(flag: boolean): void {
  electronQuittingFlag = flag;
}

/**
 * Connect to (or cold-spawn) the per-worktree daemon for `profile`,
 * publish every adapter on the serviceBus, wire the disconnect-listener
 * dance, and remember the session in `state.daemonSession`. Used by
 * `startRealServices` on boot AND by `instances:create` when the user
 * completes the setup wizard from a no-default-profile launch — the
 * latter previously surfaced the misleading "restart required"
 * message even though attaching a session post-mount is mechanically
 * straightforward.
 */
export async function attachDaemonSession(
  profile: Profile,
  projectRoot: string,
): Promise<DaemonSession> {
  const session = await connectElectronToDaemon({ projectRoot, profile });
  state.daemonSession = session;
  state.daemonSessionProfileName = profile.name ?? null;
  // Reset the single-flight guard so the next disconnect actually logs.
  disconnectLoggedFor = session;
  const surfaceDisconnect = (surface: string, err?: Error): void => {
    if (electronQuittingFlag) return;
    if (disconnectLoggedFor !== session) return;
    disconnectLoggedFor = null;
    const message = err instanceof Error ? err.message : 'unknown';
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send(
        'service:log',
        `⚠ Daemon disconnected (${surface}): ${message}`,
      );
    }
    serviceBus.clearModulesClient();
    state.daemonSession = null;
    state.daemonSessionProfileName = null;
  };
  session.metro.on('disconnected', (err) => surfaceDisconnect('metro', err));
  session.devtools.on('disconnected', (err) => surfaceDisconnect('devtools', err));
  session.builder.on('disconnected', (err) => surfaceDisconnect('builder', err));
  session.watcher.on('disconnected', (err) => surfaceDisconnect('watcher', err));
  session.modules.on('disconnected', (err) => surfaceDisconnect('modules', err));
  return session;
}

/**
 * Wire daemon-adapter events to the renderer's `instance:*` channels.
 * Renderer keeps its per-instance rendering model without having to
 * learn about the daemon at all — the translation happens here.
 */
function wireInstanceEvents(instance: InstanceState, session: DaemonSession): void {
  session.metro.on('log', (evt: { line: string }) => {
    appendLog(instance, 'metro', evt.line);
    send('instance:metro', { instanceId: instance.id, text: evt.line });
  });
  session.metro.on('status', (evt: { status: string }) => {
    instance.metroStatus = evt.status;
    send('instance:status', { instanceId: instance.id, ...toSummary(instance) });
  });
  session.builder.on('line', (evt: { text: string }) => {
    appendLog(instance, 'service', evt.text);
    send('instance:build:line', { instanceId: instance.id, text: evt.text });
  });
  session.builder.on('progress', (evt: { phase: string }) => {
    send('instance:build:progress', { instanceId: instance.id, phase: evt.phase });
  });
  session.builder.on('done', (evt: { success: boolean; errors: unknown[]; platform?: string }) => {
    send('instance:build:done', {
      instanceId: instance.id,
      success: evt.success,
      errors: evt.errors,
      platform: evt.platform,
    });
  });
}

/**
 * Start real core services for a project.
 * Called from main.ts after the window is ready.
 * Settles any interactive prompts, creates the first Electron instance
 * record from the default profile, opens a daemon-client session, and
 * wires adapter events to the renderer. Returns the live session so
 * main.ts can subscribe to `disconnected` events.
 */
export async function startRealServices(
  targetProjectRoot: string,
): Promise<DaemonSession | null> {
  state.projectRoot = targetProjectRoot;

  const rnDevDir = path.join(targetProjectRoot, '.rn-dev');
  state.artifactStore = new ArtifactStore(path.join(rnDevDir, 'artifacts'));
  const profileStore = new ProfileStore(path.join(rnDevDir, 'profiles'));

  const branch = (await getCurrentBranch(targetProjectRoot)) ?? 'main';
  const defaultProfile = profileStore.findDefault(null, branch);
  if (!defaultProfile) {
    // Renderer will show the wizard; no session yet.
    return null;
  }

  const worktreePath = defaultProfile.worktree ?? null;
  const worktreeName = worktreePath ? path.basename(worktreePath) : 'main';
  const port = findFreePort();
  const id = `${worktreeName}-${port}`;

  let deviceName = 'No device';
  let deviceIcon = '💻';
  let deviceId: string | null = null;
  if (defaultProfile.devices) {
    deviceId = defaultProfile.devices.ios ?? defaultProfile.devices.android ?? null;
    if (deviceId) {
      try {
        const deviceList = await listDevices(defaultProfile.platform);
        const foundDevice = deviceList.find((d) => d.id === deviceId);
        if (foundDevice) {
          deviceName = foundDevice.name;
          deviceIcon = foundDevice.isPhysical ? '📱' : '💻';
        }
      } catch {
        /* keep defaults */
      }
    }
  }

  const instance: InstanceState = {
    id,
    worktree: worktreePath,
    worktreeName,
    branch: defaultProfile.branch,
    port,
    deviceId,
    deviceName,
    deviceIcon,
    platform: defaultProfile.platform,
    mode: defaultProfile.mode,
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
  send('instance:created', toSummary(instance));

  // Interactive prompts BEFORE the daemon handshake — each may mutate
  // the profile on disk, and the daemon reads the current profile
  // when it boots its session services.
  await settlePackageManager(defaultProfile, profileStore, instance, targetProjectRoot);
  await settleCodeSigning(instance, targetProjectRoot);

  // Daemon connect — this spawns (or reuses) the per-worktree daemon,
  // starts its session, and publishes every adapter on the serviceBus.
  // The modules ipcMain handlers hanging off `serviceBus.modulesClient`
  // become live as soon as this resolves.
  const session = await attachDaemonSession(defaultProfile, targetProjectRoot);

  wireInstanceEvents(instance, session);
  return session;
}
