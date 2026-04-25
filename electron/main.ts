import { app, BrowserWindow } from 'electron';
import path from 'path';
import { setupIpcBridge, startRealServices } from './ipc/index.js';
import { detectProjectRoot } from '../src/core/project.js';
import type { DaemonSession } from '../src/app/client/session.js';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

// Phase 13.4.1 — the daemon-client session is the ONLY path. Electron
// main connects to (or cold-spawns) the per-worktree daemon after the
// renderer finishes loading; every ipcMain handler resolves its deps
// through the serviceBus adapters `connectElectronToDaemon` publishes.
// The 13.4 env-gated opt-in (`RN_DEV_ELECTRON_DAEMON_CLIENT=1`) is
// gone — the in-process duplicate it guarded against (services.ts
// double-Metro) went away with the services.ts collapse.
let daemonSession: DaemonSession | null = null;

// Suppresses the `disconnected` event that fires if the daemon socket
// drops in the same tick as a user-initiated window quit — cosmetic
// noise: the user is leaving, we don't need "⚠ Daemon disconnected"
// in a service log they're about to tear down. Flipped in
// `window-all-closed`. Security P1 on PR #18.
let electronQuitting = false;

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
          daemonSession = session;
          if (session) {
            wireDaemonDisconnectListener(session);
            console.log(
              `[electron] Daemon client connected — worktreeKey=${session.worktreeKey}`,
            );
          } else {
            console.log(
              '[electron] Services started without an active daemon session (no default profile — wizard will prompt).',
            );
          }
        })
        .catch((err) => {
          console.error('[electron] Failed to start services:', err);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              'service:log',
              `✖ Service error: ${err.message ?? err}`,
            );
          }
        });
    }, 1000);
  });
}

function wireDaemonDisconnectListener(session: DaemonSession): void {
  // When the daemon drops unexpectedly, surface it in the service
  // log exactly once AND invalidate every handler's cached adapter
  // ref so a subsequent reconnect can re-populate deps. Every adapter
  // fires its own `disconnected` event independently; we attach to
  // all five so any listener can see which surface drifted first in
  // future diagnostics, but a single-flight guard keeps the log noise
  // bounded. Kieran P0 on PR #18 + Arch P0 on PR #20.
  let disconnectLogged = false;
  const surfaceDisconnect = (surface: string, err?: Error): void => {
    if (electronQuitting) return;
    if (disconnectLogged) return;
    disconnectLogged = true;
    const message = err instanceof Error ? err.message : 'unknown';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        'service:log',
        `⚠ Daemon disconnected (${surface}): ${message}`,
      );
    }
    // Invalidate serviceBus-cached handler deps so the next session's
    // `setModulesClient(newClient)` fires registrars again.
    void import('../src/app/service-bus.js').then(({ serviceBus }) => {
      serviceBus.clearModulesClient();
    });
  };
  session.metro.on('disconnected', (err) => surfaceDisconnect('metro', err));
  session.devtools.on('disconnected', (err) => surfaceDisconnect('devtools', err));
  session.builder.on('disconnected', (err) => surfaceDisconnect('builder', err));
  session.watcher.on('disconnected', (err) => surfaceDisconnect('watcher', err));
  session.modules.on('disconnected', (err) => surfaceDisconnect('modules', err));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Set the quitting flag BEFORE calling disconnect so an involuntary
  // socket drop in the same tick doesn't fire a spurious "Daemon
  // disconnected" warning at a window that's about to tear down.
  electronQuitting = true;

  // Phase 13.4 — disconnect (don't stop) so any other client
  // attached to the same daemon (CLI, MCP) keeps working after the
  // Electron window goes away. `stop()` here would be wrong: it
  // tells the daemon to tear the session down for everyone.
  if (daemonSession) {
    try {
      daemonSession.disconnect();
    } catch {
      /* best-effort on shutdown */
    }
    daemonSession = null;
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export { mainWindow };
