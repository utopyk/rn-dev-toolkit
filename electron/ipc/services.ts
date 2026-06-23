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
import {
  attachAgentSessionAsObserver,
  findRunnableSessionForProfile,
  peekDaemonSessions,
} from './sessions.js';
import { serviceBus } from '../../src/app/service-bus.js';
import { triggerBuildsIfNeeded } from '../../src/app/auto-build.js';
import type { DaemonSession } from '../../src/app/client/session.js';
import type { Profile } from '../../src/core/types.js';
import type { SessionId } from '../../src/core/identifiers.js';
import {
  instances,
  state,
  send,
  appendLog,
  toSummary,
  findFreePort,
  getSessionRecordForInstance,
  type InstanceState,
  type SessionRecord,
} from './state.js';

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
 * switch to Automatic. **Default is to KEEP Manual signing** — many
 * projects (acme is the canonical case) have Manual signing wired
 * intentionally with proper distribution certs, and our auto-flip
 * destroys that configuration.
 *
 * Pre-fix this prompt offered "Switch to Automatic" as the FIRST
 * option (so the muscle-memory click breaks signing). Post-fix the
 * order is reversed: Skip is the safe default; Switch is the
 * remediation for projects that DON'T have certs locally. The action
 * label is also more honest ("Rewrite project.pbxproj") so the user
 * sees what's about to happen.
 *
 * The right long-term fix is the `build/discover-bundles` hook —
 * the mobile app declares its `signingStyle` per bundle, and this
 * prompt skips the projects that have Manual signing on purpose. See
 * docs/plans/2026-05-05-build-bundle-hook-design.md.
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

    emit(`ℹ Manual code signing detected (${manualMatches.length} targets) — keeping as-is. Run "Switch to Automatic" only if local builds fail with a missing-cert error.`);
    const signingResponse = await new Promise<string>((resolve) => {
      const promptId = `signing-${instance.id}-${Date.now()}`;
      send('instance:prompt', {
        instanceId: instance.id,
        promptId,
        title: 'Code Signing — Manual',
        message:
          `This project uses Manual code signing. Most projects with Manual ` +
          `signing have their distribution certificates set up correctly — ` +
          `keep it as-is unless local builds fail with a "no matching ` +
          `provisioning profile" error.\n\nIf you do need Automatic, this ` +
          `will rewrite project.pbxproj on disk (committed file). The change ` +
          `is reversible via git.`,
        // Skip first = the safe default. Pre-fix Switch was first and
        // cost the user their pbxproj.
        options: [
          { value: 'skip', label: '✔ Keep Manual signing (recommended)' },
          { value: 'fix', label: 'Rewrite project.pbxproj → Automatic signing' },
        ],
      });
      ipcMain.handle(`prompt:respond:${promptId}`, async (_, data) => {
        resolve(data.value);
        return { ok: true };
      });
      // Default-on-timeout is now 'skip' (was 'skip' previously too,
      // pinning here to make the safe default explicit).
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
      emit('  ✔ Switched to Automatic signing (project.pbxproj modified — review with git diff)');
    } else {
      emit('  ✔ Keeping Manual signing');
    }
    break;
  }
}

// Per-session single-flight is on SessionRecord.disconnectLogged
// (electron/ipc/state.ts). Pre-Phase-E this was a module-scope variable
// that was a singleton-by-coincidence — fine under one session,
// suppresses the second session's disconnect log under N (§ Deepening
// A7 in 2026-05-12-feat-multi-session-daemon-and-electron-plan.md).
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
 * Backoff schedule for GUI-owned session reconnect (parity with the MCP
 * server's auto-reconnect, src/mcp/server.ts). ~2.5 min total: a daemon
 * blip self-heals; a daemon that stays down stops retrying and the tab
 * is left for the user to recreate.
 */
const GUI_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000, 30_000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Phase E1 — connect to (or cold-spawn) the per-worktree daemon for
 * `profile`, publish every adapter on the serviceBus, wire per-session
 * disconnect listeners, and register a SessionRecord in `state.sessions`.
 * Used by `startRealServices` on boot AND by `instances:create` when
 * the user runs the setup wizard or asks for a new tab. Each call mints
 * a fresh daemon session — cross-profile or same-profile, the daemon
 * supports N concurrent sessions per worktree.
 *
 * Returns the SessionRecord so the caller can drive event wiring without
 * re-deriving the sessionId. The legacy `attachDaemonSession` name is
 * preserved (callers grep for it) but the body now multiplexes per session.
 */
export interface AttachDaemonSessionOptions {
  projectRoot: string;
  instanceId: string;
  /** Boot-or-join a profile (the GUI's own tabs). */
  profile?: Profile;
  /**
   * Observe-mode: attach read-only by id to an existing (agent/MCP)
   * session instead of booting a profile. Sets `observed: true` on the
   * record and uses the daemon's non-counting observer attach so the GUI
   * can never keep the agent's session alive. `worktreeKeyHint` (from
   * `sessions/list`) skips the ambiguous worktreeKey backfill.
   */
  observe?: { sessionId: SessionId; worktreeKeyHint?: string };
}

export async function attachDaemonSession(
  opts: AttachDaemonSessionOptions,
): Promise<SessionRecord> {
  const { projectRoot, instanceId, profile, observe } = opts;
  const observed = observe !== undefined;
  const session = await connectElectronToDaemon({
    projectRoot,
    profile: profile ?? null,
    ...(observe
      ? {
          attachSessionId: observe.sessionId,
          observer: true,
          ...(observe.worktreeKeyHint !== undefined
            ? { worktreeKeyHint: observe.worktreeKeyHint }
            : {}),
        }
      : {}),
  });
  const record: SessionRecord = {
    sessionId: session.sessionId,
    daemonSession: session,
    instanceId,
    profileName: profile?.name ?? null,
    attachedAt: Date.now(),
    disconnectLogged: false,
    observed,
  };
  state.sessions.set(session.sessionId, record);
  // First session also becomes the active one — `instances:setActive`
  // updates this when the user clicks a different tab.
  if (!state.activeSessionId) {
    state.activeSessionId = session.sessionId;
  }
  const surfaceDisconnect = (surface: string, err?: Error): void => {
    if (electronQuittingFlag) return;
    // Per-session single-flight: log once per session across the five
    // adapters, but a SECOND session's disconnect still logs cleanly.
    const current = state.sessions.get(session.sessionId);
    if (!current || current.disconnectLogged) return;
    current.disconnectLogged = true;

    state.sessions.delete(session.sessionId);
    if (state.activeSessionId === session.sessionId) {
      // Promote any surviving session; null when this was the last.
      const next = state.sessions.keys().next().value ?? null;
      state.activeSessionId = next;
    }

    if (current.observed) {
      // Observe tab: the agent's session went away (daemon died, or the
      // session was stopped and the socket finally dropped). Remove the
      // tab quietly — the SessionsWatcher poller is the primary teardown
      // signal; this is the backstop for a hard socket close. No scary
      // "daemon disconnected" line for a read-only view.
      instances.delete(instanceId);
      if (state.activeInstanceId === instanceId) {
        state.activeInstanceId = instances.keys().next().value ?? null;
      }
      send('instance:removed', instanceId);
      send('service:log', '👁 Agent session ended — observe tab closed.');
      return;
    }

    // Phase E1 — only clear the modules client when the LAST session
    // disconnects; per-session clients are tracked by sessionId on the
    // serviceBus consumer side. Pre-multi-session, a single disconnect
    // emptied the cache for everyone; under N, the surviving sessions
    // keep their clients live.
    if (state.sessions.size === 0) {
      serviceBus.clearModulesClient();
    }

    const message = err instanceof Error ? err.message : 'unknown';
    // A GUI-owned (non-observed) session whose record was still present
    // means an UNEXPECTED disconnect (daemon died / crashed / upgraded).
    // A user-closed tab pre-deletes its record in `instances:remove`, so
    // we never reach here for those. Self-heal — parity with the MCP
    // server (5ba82d1), which otherwise leaves the GUI as the only
    // client that needs a manual recreate after a daemon blip. Requires
    // the boot profile to re-attach; without it (shouldn't happen for
    // owned sessions) fall back to the old cosmetic notice.
    if (profile && !electronQuittingFlag) {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send(
          'service:log',
          `⚠ Daemon disconnected (${surface}): ${message} — reconnecting…`,
        );
      }
      void reconnectOwnedSession();
      return;
    }

    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send(
        'service:log',
        `⚠ Daemon disconnected (${surface}): ${message}`,
      );
    }
  };

  /**
   * Re-attach a GUI-owned session after an unexpected daemon disconnect,
   * reusing the SAME `instanceId` so the user's tab persists (the
   * InstanceState is never deleted on a non-observed disconnect). Boot-
   * or-join by the session's profile: `connectElectronToDaemon` cold-
   * spawns a fresh daemon if it's gone, or rejoins the running session if
   * only our socket dropped. Bounded backoff; bails if the user removed
   * the tab, the app is quitting, or another path already re-attached.
   */
  const reconnectOwnedSession = async (): Promise<void> => {
    if (!profile) return;
    for (const delayMs of GUI_RECONNECT_DELAYS_MS) {
      await delay(delayMs);
      if (electronQuittingFlag) return;
      const inst = instances.get(instanceId);
      if (!inst) return; // user removed the tab during the backoff
      if (getSessionRecordForInstance(instanceId)) return; // already reconnected
      try {
        const fresh = await attachDaemonSession({ projectRoot, instanceId, profile });
        const liveInst = instances.get(instanceId);
        if (!liveInst) {
          // Removed mid-attach — tear the just-made session back down.
          fresh.daemonSession.disconnect();
          return;
        }
        wireInstanceEvents(liveInst, fresh.daemonSession);
        send('service:log', `✓ Daemon reconnected (${liveInst.id}).`);
        send('instance:status', { instanceId: liveInst.id, ...toSummary(liveInst) });
        return;
      } catch {
        // Daemon still unreachable — keep backing off.
      }
    }
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send(
        'service:log',
        `⚠ Daemon reconnect for ${instanceId} gave up after retries — close and recreate the tab to try again.`,
      );
    }
  };

  session.metro.on('disconnected', (err) => surfaceDisconnect('metro', err));
  session.devtools.on('disconnected', (err) => surfaceDisconnect('devtools', err));
  session.builder.on('disconnected', (err) => surfaceDisconnect('builder', err));
  session.watcher.on('disconnected', (err) => surfaceDisconnect('watcher', err));
  session.modules.on('disconnected', (err) => surfaceDisconnect('modules', err));
  return record;
}

/**
 * Wire daemon-adapter events to the renderer's `instance:*` channels.
 * Renderer keeps its per-instance rendering model without having to
 * learn about the daemon at all — the translation happens here.
 *
 * Exported so the wizard-path attach (`instance.ts::instances:create`)
 * can call it too. Pre-fix that handler called `attachDaemonSession`
 * but forgot the `wireInstanceEvents` follow-up, so Metro started but
 * its log lines never reached the renderer. Both attach sites must
 * call this; if a third one shows up, fold attach + wire into a single
 * helper rather than adding a third call site.
 */
export function wireInstanceEvents(instance: InstanceState, session: DaemonSession): void {
  // Bug 6 — surface the daemon's `bootSessionServices` progress
  // (preflight, install, watchman setup, port-kill, simulator boot —
  // every line `supervisor.ts` emits as `session/log`) on the
  // renderer's `instance:log` channel. Pre-fix the renderer only saw
  // Electron-local sources (the package-manager and code-signing
  // prompts above); the daemon-driven boot was invisible. See
  // `SessionClient` for why the snapshot+subscribe pattern is needed
  // (events fire during the connectToDaemonSession await).
  const forward = (evt: { message: string }): void => {
    const text = `[daemon] ${evt.message}`;
    appendLog(instance, 'service', text);
    send('instance:log', { instanceId: instance.id, text });
  };
  for (const evt of session.lifecycle.recentLogs()) forward(evt);
  session.lifecycle.on('log', forward);

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

  // Short-circuit: if an agent / MCP client already booted a session for
  // this default profile, attach as a read-only observer (🤖 tab) and
  // skip the primary-tab boot entirely. Without this, the GUI's own
  // `attachDaemonSession(profile)` AND the `SessionsWatcher`'s
  // independent observer attach both create tabs against the same one
  // session, producing the "two tabs at 8090" duplicate.
  const peeked = await peekDaemonSessions(targetProjectRoot);
  if (peeked) {
    const match = findRunnableSessionForProfile(peeked, defaultProfile.name);
    if (match) {
      const record = await attachAgentSessionAsObserver(targetProjectRoot, match);
      if (record) return record.daemonSession;
      // Attach failed (race: the session may have just vanished). Fall
      // through to the normal boot path and let it create a fresh one.
    }
  }

  const worktreePath = defaultProfile.worktree ?? null;
  const worktreeName = worktreePath ? path.basename(worktreePath) : 'main';
  // Phase E bug-fix — see instance.ts for the full rationale: the
  // renderer's instance.port must match the daemon's metroPort or the
  // DevTools panel + every port-displaying tooltip drift, and DevTools
  // dies with ERR_CONNECTION_REFUSED.
  const port = typeof defaultProfile.metroPort === 'number' && defaultProfile.metroPort > 0
    ? defaultProfile.metroPort
    : findFreePort();
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
    serviceLog: [],
    metroLog: [],
    metroStatus: 'starting',
    observed: false,
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
  const record = await attachDaemonSession({
    projectRoot: targetProjectRoot,
    instanceId: instance.id,
    profile: defaultProfile,
  });
  const session = record.daemonSession;

  wireInstanceEvents(instance, session);

  // Mirror the TUI start-flow's auto-build: dirty/clean/ultra-clean modes
  // expect a fresh build after Metro is up; quick mode skips it.
  // Without this call, the Electron GUI would silently never build —
  // the renderer's `instance:build:*` events would never fire and the
  // user's app would not get reinstalled on the device after a code
  // change.
  triggerBuildsIfNeeded(session, defaultProfile, targetProjectRoot);

  return session;
}
