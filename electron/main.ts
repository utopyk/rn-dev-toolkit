import { app, BrowserWindow } from 'electron';
import path from 'path';
import { setupIpcBridge, startRealServices } from './ipc/index.js';
import { setElectronQuitting } from './ipc/services.js';
import { state } from './ipc/state.js';
import { detectProjectRoot } from '../src/core/project.js';
import { serviceBus } from '../src/app/service-bus.js';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

// Phase 13.4.1 — the daemon-client session is the ONLY path. Electron
// main connects to (or cold-spawns) the per-worktree daemon after the
// renderer finishes loading; every ipcMain handler resolves its deps
// through the serviceBus adapters `connectElectronToDaemon` publishes.
// The 13.4 env-gated opt-in (`RN_DEV_ELECTRON_DAEMON_CLIENT=1`) is
// gone — the in-process duplicate it guarded against (services.ts
// double-Metro) went away with the services.ts collapse.
//
// The active session lives at `state.daemonSession` (electron/ipc/state.ts);
// `attachDaemonSession` populates it. Main reads it on window-quit
// to drive `disconnect()`.

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

  // Detect the RN project root BEFORE setting up IPC so wizard handlers work.
  // `RN_DEV_PROJECT_ROOT` env override skips detection — used by the
  // Playwright smoke suite to point Electron at a tmpdir fixture without
  // depending on detectProjectRoot's auto-discovery walk.
  const cwd = process.cwd();
  console.log(`[electron] CWD: ${cwd}`);
  const projectRoot = process.env.RN_DEV_PROJECT_ROOT
    ?? await detectProjectRoot(cwd)
    ?? await detectProjectRoot('/Users/martincouso/Documents/Projects/movie-nights-club')
    ?? cwd;
  console.log(`[electron] Project root: ${projectRoot}`);

  // Pass projectRoot to IPC bridge so wizard handlers have it immediately
  setupIpcBridge(mainWindow, projectRoot);

  // Start real services after renderer has loaded. `startRealServices`
  // runs local UX helpers (pm-conflict + code-signing prompts) + the
  // Electron instance bookkeeping, then connects to the daemon —
  // everything runtime-level (preflight, clean, Metro, builder, watcher,
  // module host) lives in the daemon session the connect call opens.
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[electron] Renderer loaded, starting services...');
    setTimeout(() => {
      startRealServices(projectRoot)
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

  // Phase 13.5 — close the subscribe socket; the daemon's socket-close
  // auto-release decrements its session refcount and tears the session
  // down if Electron was the last attacher. Any other clients (CLI,
  // MCP) attached to the same daemon stay running. `stop()` here would
  // be wrong: it's the kill-for-everyone path regardless of refcount.
  if (state.daemonSession) {
    const session = state.daemonSession;
    state.daemonSession = null;
    state.daemonSessionProfileName = null;
    try {
      session.disconnect();
    } catch {
      /* best-effort on shutdown */
    }
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export { mainWindow };
