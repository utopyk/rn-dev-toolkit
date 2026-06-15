import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import path from 'path';
import { setupIpcBridge, startRealServices } from './ipc/index.js';
import { setElectronQuitting } from './ipc/services.js';
import { SessionsWatcher } from './ipc/sessions.js';
import { state } from './ipc/state.js';
import { detectProjectRoot } from '../src/core/project.js';
import { getLastProject } from '../src/core/recent-projects.js';
import { serviceBus } from '../src/app/service-bus.js';

const isDev = !app.isPackaged;

/**
 * Resolve which RN project this window binds to, or null to show the
 * project picker. The root is a boot-time constant (threaded into the IPC
 * bridge + daemon connect), so a window opens exactly one project;
 * switching relaunches the window — see electron/ipc/project.ts.
 *
 * Precedence:
 *   1. `RN_DEV_PROJECT_ROOT` — explicit override. The Playwright smoke
 *      suite points Electron at a tmpdir fixture; always committed.
 *   2. The last project the user explicitly opened, if it still resolves
 *      to a real RN project on disk.
 *   3. Nothing committed → null → WelcomeScreen. We no longer silently
 *      auto-detect-and-open: that was the gap where a user couldn't tell
 *      which project was active or how to change it.
 */
function resolveCommittedProjectRoot(): string | null {
  const override = process.env.RN_DEV_PROJECT_ROOT;
  if (override) return override;
  const last = getLastProject();
  if (last && existsSync(last) && detectProjectRoot(last)) return last;
  return null;
}

let mainWindow: BrowserWindow | null = null;

// Polls the shared daemon's sessions/list and auto-surfaces sessions
// started by other clients (MCP/CLI) as read-only observe tabs.
const sessionsWatcher = new SessionsWatcher();

// Phase 13.4.1 — the daemon-client session is the ONLY path. Electron
// main connects to (or cold-spawns) the per-worktree daemon after the
// renderer finishes loading; every ipcMain handler resolves its deps
// through the serviceBus adapters `connectElectronToDaemon` publishes.
// The 13.4 env-gated opt-in (`RN_DEV_ELECTRON_DAEMON_CLIENT=1`) is
// gone — the in-process duplicate it guarded against (services.ts
// double-Metro) went away with the services.ts collapse.
//
// Phase E1 — active sessions live in `state.sessions` (Map keyed by
// SessionId in electron/ipc/state.ts). `attachDaemonSession` registers
// one record per connect. Main iterates the Map on window-quit to
// `disconnect()` all of them.

/** Wait for Vite dev server to be ready, trying ports 5173-5180, with retries */
async function waitForVite(maxRetries = 30): Promise<number> {
  const http = require('http') as typeof import('http');

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (let port = 5173; port <= 5180; port++) {
      try {
        const ok = await new Promise<boolean>((resolve) => {
          const req = http.get(`http://localhost:${port}`, (res: any) => {
            res.destroy();
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(300, () => { req.destroy(); resolve(false); });
        });
        if (ok) return port;
      } catch {}
    }
    // Wait 500ms before retrying
    await new Promise(r => setTimeout(r, 500));
    if (attempt % 5 === 4) {
      console.log(`[electron] Waiting for Vite dev server... (attempt ${attempt + 1})`);
    }
  }

  console.log('[electron] Vite not found, falling back to port 5173');
  return 5173;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1b26',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,  // Enable <webview> for DevTools
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
    },
  });

  if (isDev) {
    // Wait for Vite to be ready before loading
    const vitePort = await waitForVite();
    console.log(`[electron] Loading Vite dev server on port ${vitePort}`);
    mainWindow.loadURL(`http://localhost:${vitePort}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Resolve which RN project this window binds to BEFORE setting up IPC so
  // wizard handlers work. See `resolveCommittedProjectRoot` for precedence.
  const cwd = process.cwd();
  console.log(`[electron] CWD: ${cwd}`);
  const committedRoot = resolveCommittedProjectRoot();
  console.log(
    committedRoot
      ? `[electron] Project root (committed): ${committedRoot}`
      : '[electron] No committed project — showing the project picker.',
  );

  // Pass the committed root to the IPC bridge so wizard handlers have it
  // immediately. When undefined, project:* handlers still register (the
  // picker needs them) but the per-project handlers no-op until a project
  // is committed via the WelcomeScreen.
  setupIpcBridge(mainWindow, committedRoot ?? undefined);

  if (!committedRoot) {
    // No project committed — the renderer shows WelcomeScreen. Fast-fail any
    // module IPC the renderer fires on mount (panel list + saved-theme load)
    // so it doesn't hang 30s on `awaitModulesClient` against a daemon we
    // never connect to. The picker itself doesn't depend on the daemon.
    serviceBus.abortModulesClient(
      'Select a project to start working. Open one from the welcome screen.',
    );
    return;
  }

  // Start watching the shared daemon for sessions started by OTHER
  // clients (an LLM over MCP, the CLI/TUI). Any session this Electron
  // process didn't create is auto-surfaced as a read-only 🤖 observe
  // tab. The watcher gates on a live daemon socket each tick, so
  // starting it before any session exists is safe — it no-ops until a
  // daemon is up. See electron/ipc/sessions.ts.
  sessionsWatcher.start();

  // Start real services after renderer has loaded. `startRealServices`
  // runs local UX helpers (pm-conflict + code-signing prompts) + the
  // Electron instance bookkeeping, then connects to the daemon —
  // everything runtime-level (preflight, clean, Metro, builder, watcher,
  // module host) lives in the daemon session the connect call opens.
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[electron] Renderer loaded, starting services...');
    setTimeout(() => {
      startRealServices(committedRoot)
        .then((session) => {
          if (session) {
            console.log(
              `[electron] Daemon client connected — worktreeKey=${session.worktreeKey}`,
            );
          } else {
            // No default profile in this worktree+branch — the renderer
            // will show the wizard. Tell every awaiting modules:* handler
            // to fail fast instead of timing out at 30s; the renderer
            // surfaces this string verbatim, so phrase it as a fix.
            // Once the wizard finishes, `instances:create` calls
            // `attachDaemonSession` which publishes a fresh
            // `serviceBus.modulesClient` event — that clears the cached
            // abort reason, so a follow-up Settings/Marketplace mount
            // works without a restart.
            const reason =
              'No default profile is configured for this project. Run the setup wizard to create one.';
            console.log(`[electron] ${reason}`);
            serviceBus.abortModulesClient(reason);
          }
        })
        .catch((err) => {
          console.error('[electron] Failed to start services:', err);
          const message = err instanceof Error ? err.message : String(err);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              'service:log',
              `✖ Service error: ${message}`,
            );
          }
          serviceBus.abortModulesClient(`Daemon connect failed: ${message}`);
        });
    }, 1000);
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Set the quitting flag BEFORE calling disconnect so an involuntary
  // socket drop in the same tick doesn't fire a spurious "Daemon
  // disconnected" warning at a window that's about to tear down.
  setElectronQuitting(true);

  // Stop polling the daemon for external sessions before tearing the
  // sessions down — otherwise a final tick could re-observe a session
  // we're about to disconnect.
  sessionsWatcher.stop();

  // Phase E1 — close every session's subscribe socket. The daemon's
  // per-socket auto-release decrements each session's refcount and
  // tears it down if Electron was the last attacher. Any other clients
  // (CLI, MCP) attached to the same daemon stay running. `stop()` here
  // would be wrong: it's the kill-for-everyone path regardless of refcount.
  for (const record of state.sessions.values()) {
    try {
      record.daemonSession.disconnect();
    } catch {
      /* best-effort on shutdown */
    }
  }
  state.sessions.clear();
  state.activeSessionId = null;
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export { mainWindow };
