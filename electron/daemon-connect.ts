// Electron ↔ daemon client wiring. Phase 13.4.
//
// Replaces the direct in-process `MetroManager` / `DevToolsManager` /
// `Builder` / `FileWatcher` construction that `electron/ipc/services.ts`
// used to do. After this, Electron is a client of the per-worktree
// daemon: the daemon owns service lifecycle; this module threads the
// adapters returned by `connectToDaemonSession` onto the serviceBus
// so existing ipcMain handlers (metro, tools, devtools) can consume
// them without caring that they're now remote.
//
// Note — this is the metro / devtools / builder / watcher half of the
// flip. The module-system half (panel bridge, modules:call-tool,
// modules:host-call) coexists with `electron/module-system-bootstrap.ts`
// for now: its in-process `ModuleHostManager` + `ModuleRegistry` stay
// on the Electron side so panel-bridge keeps routing subprocess calls
// against a real manager. Full deduplication with the daemon-side
// module host lands in Phase 13.4.1 / 13.5 once `modules/host-call`
// exists as a daemon RPC and the panel bridge grows a socket-hop.

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import {
  connectToDaemonSession,
  type DaemonSession,
} from "../src/app/client/session.js";
import { serviceBus } from "../src/app/service-bus.js";
import type { Profile } from "../src/core/types.js";

/**
 * Locate the rn-dev CLI entry so `connectToDaemon` can cold-spawn a
 * daemon from Electron. Two valid source layouts in dev:
 *   - **tsx-driven** (`bun run dev:gui` / `npm run dev:electron` /
 *     Playwright smoke): main.ts + this file run from
 *     `<repo>/electron/`. CLI entry is at `<repo>/src/index.tsx`
 *     (one directory up).
 *   - **compiled** (`bun run build`): bundle output sits at
 *     `<repo>/dist/electron/daemon-connect.js`. CLI entry is at
 *     `<repo>/src/index.tsx` (two directories up).
 * The previous single-path heuristic only handled the compiled
 * layout; Phase 13.4.1 dropping the env gate exposed the dev-path
 * gap as "CLI entry does not exist on disk" the moment the daemon
 * client became the only path. Probe both, fail loudly only after
 * neither resolves.
 *
 * Packaged Electron (`app.isPackaged`) still throws — installer
 * work in Phase 13.5 wires the asar layout.
 */
function resolveDaemonEntry(): string {
  if (app.isPackaged) {
    throw new Error(
      "resolveDaemonEntry: packaged Electron is not supported yet. " +
        "Run via `bun run electron` / `npm run dev:gui` until the " +
        "packaged-build daemon entry is wired in Phase 13.5.",
    );
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Dev: <repo>/electron/daemon-connect.ts → <repo>/src/index.tsx
    path.resolve(here, "..", "src", "index.tsx"),
    // Compiled: <repo>/dist/electron/daemon-connect.js → <repo>/src/index.tsx
    path.resolve(here, "..", "..", "src", "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `resolveDaemonEntry: CLI entry not found. Tried:\n  ${candidates.join(
      "\n  ",
    )}\nUnexpected layout (symlinked repo, non-standard dist path, stale build?).`,
  );
}

export interface ConnectElectronToDaemonOptions {
  projectRoot: string;
  profile: Profile;
  /**
   * Override the CLI entry resolver. Tests inject this so they don't
   * accidentally cold-spawn a daemon off the dev entry. Production
   * callers should leave undefined — `resolveDaemonEntry` handles
   * dev + packaged layouts.
   */
  daemonEntry?: string;
}

/**
 * Connect Electron to the per-worktree daemon and publish the returned
 * adapter refs on the serviceBus. Returns the live `DaemonSession` so
 * the caller can drive `disconnect()` (window close) or `stop()` (app
 * quit — though Electron should prefer `disconnect()`: other clients
 * like MCP + CLI may still be attached).
 *
 * Shape matches the TUI's `connectAndWire` in `src/app/start-flow.ts`
 * deliberately — keeping the two sites symmetrical means a second
 * reviewer can A/B them without squinting at two different patterns.
 */
export async function connectElectronToDaemon(
  opts: ConnectElectronToDaemonOptions,
): Promise<DaemonSession> {
  const session = await connectToDaemonSession(opts.projectRoot, opts.profile, {
    daemonEntry: opts.daemonEntry ?? resolveDaemonEntry(),
  });

  serviceBus.setMetro(session.metro);
  serviceBus.setDevTools(session.devtools);
  serviceBus.setBuilder(session.builder);
  serviceBus.setWatcher(session.watcher);
  // Phase 13.4.1 — the `modules` field on DaemonSession is the
  // client-side RPC surface every flipped ipcMain handler consumes
  // (install / uninstall / config / panels / host-call / marketplace).
  // Publishing it here keeps the "connectElectronToDaemon fans every
  // adapter onto the bus" symmetry with the other four services.
  serviceBus.setModulesClient(session.modules);
  serviceBus.setWorktreeKey(session.worktreeKey);

  return session;
}
