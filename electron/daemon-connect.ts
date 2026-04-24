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
 * daemon from Electron. Electron's `process.argv[1]` points at the
 * packaged `main.js`, not this repo's `src/index.tsx`; omitting this
 * fails with "CLI entry does not exist on disk".
 *
 * Dev path (this file → dist/electron/daemon-connect.js):
 *   dirname(import.meta.url) = <repo>/dist/electron
 *   go up two levels + join src/index.tsx.
 *
 * Packaged path (asar) is NOT wired in Phase 13.4 — callers get a
 * loud throw rather than a silent ENOENT from `spawnDetachedDaemon`.
 * A packaged-build entry point lands with the installer work in
 * Phase 13.5. Kieran + Security P1 on PR #18 (silent ENOENT was
 * the anti-pattern flagged against Martin's "fail fast with clear
 * messages" rule).
 */
function resolveDaemonEntry(): string {
  if (app.isPackaged) {
    throw new Error(
      "resolveDaemonEntry: packaged Electron is not supported in Phase 13.4. " +
        "Run via `bun run electron` until the packaged-build daemon entry is " +
        "wired in Phase 13.5.",
    );
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const resolved = path.resolve(here, "..", "..", "src", "index.tsx");
  if (!existsSync(resolved)) {
    throw new Error(
      `resolveDaemonEntry: CLI entry not found at ${resolved} — unexpected layout (symlinked repo, non-standard dist path, stale build?).`,
    );
  }
  return resolved;
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
  serviceBus.setWorktreeKey(session.worktreeKey);

  return session;
}
