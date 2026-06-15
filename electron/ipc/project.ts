import { app, dialog, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { detectProjectRoot } from '../../src/core/project.js';
import {
  listRecentProjects,
  recordOpenedProject,
} from '../../src/core/recent-projects.js';
import { state } from './state.js';
import { setElectronQuitting } from './services.js';

// ---------------------------------------------------------------------------
// project:* IPC — the explicit "which RN project is this window bound to"
// surface that backs renderer/views/WelcomeScreen.
// ---------------------------------------------------------------------------
//
// Before this, the project root was chosen silently at boot from the
// launch directory (electron/main.ts), with no UI to see or change it. These
// handlers let the renderer:
//   - `project:state`      — read the committed project (or know there is none)
//   - `project:list`       — list recents + a one-click "detected here" hint
//   - `project:openDialog` — pick a folder via the native OS dialog + validate
//   - `project:open`       — commit a project and relaunch the window into it
//
// Switching projects relaunches the window rather than re-threading the root
// live: the project root is a boot-time constant wired into the IPC bridge,
// the daemon connection, and the sessions watcher, so a clean re-exec is far
// simpler and safer than tearing all of that down in place.

/**
 * Local convenience: a fallback project to suggest when launch-dir detection
 * finds nothing. Surfaced only as a one-click hint in the picker (never
 * auto-opened) and silently omitted when the path doesn't exist, so it's a
 * no-op on machines that don't have it.
 */
const FALLBACK_SUGGESTION = '/Users/martincouso/Documents/GitHub/acme-mobile-app';

interface ProjectRef {
  path: string;
  name: string;
}

interface RecentProjectView extends ProjectRef {
  lastOpenedAt: string;
  /** False when the directory no longer exists — the picker greys it out. */
  exists: boolean;
}

function toRef(projectRoot: string): ProjectRef {
  return { path: projectRoot, name: basename(projectRoot) };
}

/**
 * A non-committing suggestion for "the project you're probably here for":
 * the RN project containing the launch directory, else the local fallback if
 * it exists. Null when neither resolves.
 */
function detectSuggestion(): ProjectRef | null {
  const fromCwd = detectProjectRoot(process.cwd());
  if (fromCwd) return toRef(fromCwd);
  if (existsSync(FALLBACK_SUGGESTION)) {
    const root = detectProjectRoot(FALLBACK_SUGGESTION);
    if (root) return toRef(root);
  }
  return null;
}

/**
 * Relaunch the Electron app into a freshly-committed project. Best-effort
 * disconnect of any live daemon sessions first (the daemon refcount-releases
 * on socket drop regardless), set the quitting flag so the drop doesn't fire
 * a spurious "Daemon disconnected" warning, then re-exec.
 */
function relaunchApp(): void {
  setElectronQuitting(true);
  for (const record of state.sessions.values()) {
    try {
      record.daemonSession.disconnect();
    } catch {
      /* best-effort on relaunch */
    }
  }
  state.sessions.clear();
  app.relaunch();
  app.exit(0);
}

export function registerProjectHandlers() {
  // The committed project for this window, or null when the picker should
  // show. `committed` mirrors `state.projectRoot` — main.ts only sets it
  // when it resolved a committed root at boot.
  ipcMain.handle('project:state', async () => {
    const projectRoot = state.projectRoot;
    return {
      projectRoot: projectRoot ?? null,
      name: projectRoot ? basename(projectRoot) : null,
      committed: projectRoot != null,
    };
  });

  // Everything the WelcomeScreen renders: the current project, the recents
  // list (with existence annotated), and a one-click detected suggestion.
  ipcMain.handle('project:list', async () => {
    const current = state.projectRoot ? toRef(state.projectRoot) : null;
    const recents: RecentProjectView[] = listRecentProjects().map((r) => ({
      path: r.path,
      name: r.name,
      lastOpenedAt: r.lastOpenedAt,
      exists: existsSync(r.path),
    }));
    return { current, recents, detected: detectSuggestion() };
  });

  // Open the native folder picker and validate the choice as an RN project.
  // Does NOT commit — the renderer calls `project:open` with the returned
  // path so the commit + relaunch path is shared with the recents/detected
  // entries.
  ipcMain.handle('project:openDialog', async () => {
    const opts = {
      title: 'Select a React Native project',
      properties: ['openDirectory' as const],
      buttonLabel: 'Open project',
    };
    // `showOpenDialog` overloads on its first arg — passing `undefined`
    // doesn't satisfy the modal-parent overload, so branch explicitly.
    const result = state.mainWindow
      ? await dialog.showOpenDialog(state.mainWindow, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const picked = result.filePaths[0];
    const root = detectProjectRoot(picked);
    if (!root) {
      return {
        ok: false,
        error:
          'That folder is not a React Native project. Pick the app folder whose package.json lists react-native.',
      };
    }
    return { ok: true, path: root, name: basename(root) };
  });

  // Commit a project and relaunch the window into it. Validates first so a
  // stale recent (deleted folder) surfaces an error instead of relaunching
  // into a broken root.
  ipcMain.handle('project:open', async (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return { ok: false, error: 'No project path was provided.' };
    }
    const root = detectProjectRoot(rawPath);
    if (!root) {
      return {
        ok: false,
        error:
          'That folder is not a React Native project (no react-native dependency in its package.json). It may have moved or been deleted.',
      };
    }
    recordOpenedProject(root);
    // Delay so this reply flushes before the re-exec — the WelcomeScreen
    // shows a "Switching project…" state on `ok: true`.
    setTimeout(() => relaunchApp(), 50);
    return { ok: true, path: root, name: basename(root) };
  });
}
