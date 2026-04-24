import { app, BrowserWindow } from 'electron';
import path from 'path';
import { setupIpcBridge, startRealServices } from './ipc/index.js';
import { detectProjectRoot, getCurrentBranch } from '../src/core/project.js';
import { ProfileStore } from '../src/core/profile.js';
import { connectElectronToDaemon } from './daemon-connect.js';
import type { DaemonSession } from '../src/app/client/session.js';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

// Phase 13.4 — the live daemon-client session for the current
// project. Populated once the renderer finishes loading so the
// daemon's Metro / DevTools / Builder / Watcher adapters are on
// the serviceBus before any ipcMain handler consults them.
// `null` until the renderer signals `did-finish-load`; the
// in-process `startRealServices` path still covers the module
// system + instance orchestration during the 13.4.1 transition.
let daemonSession: DaemonSession | null = null;

// The daemon-client path is OPT-IN in 13.4. Enabling it by default
// would collide with `startRealServices` on Metro's profile port —
// both paths spawn Metro against the same project root today. Flip
// this to `1` only when exercising the daemon-client path (e.g.
// running the 13.4.1 handler-flip branch locally). Collision-free
// coexistence is the first order of business for 13.4.1. Arch P0
// on PR #18.
const ELECTRON_DAEMON_CLIENT_ENABLED =
  process.env.RN_DEV_ELECTRON_DAEMON_CLIENT === "1";

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

  // Detect the RN project root BEFORE setting up IPC so wizard handlers work
  const cwd = process.cwd();
  console.log(`[electron] CWD: ${cwd}`);
  const projectRoot = await detectProjectRoot(cwd)
    ?? await detectProjectRoot('/Users/martincouso/Documents/Projects/movie-nights-club')
    ?? cwd;
  console.log(`[electron] Project root: ${projectRoot}`);

  // Pass projectRoot to IPC bridge so wizard handlers have it immediately
  setupIpcBridge(mainWindow, projectRoot);

  // Start real services after renderer has loaded
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[electron] Renderer loaded, starting services...');
    setTimeout(() => {
      startRealServices(projectRoot).then(() => {
        console.log('[electron] Services started successfully');
      }).catch((err) => {
        console.error('[electron] Failed to start services:', err);
        // Send the error to the renderer so user can see it
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('service:log', `✖ Service error: ${err.message ?? err}`);
        }
      });

      // Phase 13.4 — open a daemon-client session alongside the
      // in-process services when the opt-in flag is set. Default-off
      // because the daemon's own `bootSessionServices` spawns Metro
      // against the same profile port `startRealServices` does.
      // 13.4.1 either gates `startRealServices` off the daemon-client
      // path or collapses the in-process orchestration entirely.
      if (ELECTRON_DAEMON_CLIENT_ENABLED) {
        void connectDaemonClientBestEffort(projectRoot);
      } else {
        console.log(
          '[electron] daemon-client path disabled — set ' +
            'RN_DEV_ELECTRON_DAEMON_CLIENT=1 to enable (13.4.1).',
        );
      }
    }, 1000);
  });
}

async function connectDaemonClientBestEffort(projectRoot: string): Promise<void> {
  try {
    const profileStore = new ProfileStore(
      path.join(projectRoot, '.rn-dev', 'profiles'),
    );
    const branch = (await getCurrentBranch(projectRoot)) ?? 'main';
    const profile = profileStore.findDefault(null, branch);
    if (!profile) {
      console.log('[electron] No default profile — skipping daemon connect');
      return;
    }
    daemonSession = await connectElectronToDaemon({
      projectRoot,
      profile,
    });
    console.log(
      `[electron] Daemon client connected — worktreeKey=${daemonSession.worktreeKey}`,
    );

    // When the daemon drops unexpectedly, surface it in the service
    // log exactly once. Every adapter fires its own `disconnected`
    // event independently; we attach to all five so any listener
    // can see which surface drifted first in future diagnostics,
    // but a single-flight guard keeps the log noise bounded. Kieran
    // P0 on PR #18.
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
    };
    daemonSession.metro.on('disconnected', (err) => surfaceDisconnect('metro', err));
    daemonSession.devtools.on('disconnected', (err) => surfaceDisconnect('devtools', err));
    daemonSession.builder.on('disconnected', (err) => surfaceDisconnect('builder', err));
    daemonSession.watcher.on('disconnected', (err) => surfaceDisconnect('watcher', err));
    daemonSession.modules.on('disconnected', (err) => surfaceDisconnect('modules', err));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[electron] Daemon connect failed (non-fatal):', message);
  }
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
