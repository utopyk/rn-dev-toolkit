import { app, BrowserWindow } from 'electron';
import path from 'path';
import { setupIpcBridge, startRealServices } from './ipc/index.js';
import { detectProjectRoot } from '../src/core/project.js';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

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
    }, 1000);
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export { mainWindow };
