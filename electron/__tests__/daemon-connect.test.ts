import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../test/helpers/spawnTestDaemon.js";
import { connectElectronToDaemon } from "../daemon-connect.js";
import { serviceBus } from "../../src/app/service-bus.js";
import type { Profile } from "../../src/core/types.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const CLI_ENTRY = resolve(REPO_ROOT, "src", "index.tsx");

// Phase 13.4.1 — replaces the coverage that lived in
// module-system-bootstrap.test.ts before Electron stopped running an
// in-process module system. Asserts that `connectElectronToDaemon`
// publishes every adapter the flipped ipcMain handlers subscribe to
// on the serviceBus. Everything else the handlers need — manager,
// registry, moduleEvents bus — went away with the bootstrap deletion.

function fakeProfile(worktree: string): Profile {
  return {
    name: "test",
    isDefault: true,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "quick",
    metroPort: 8081,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot: worktree,
  };
}

describe("connectElectronToDaemon", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) {
      await h.stop();
    }
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("publishes metro, devtools, builder, watcher, modulesClient, worktreeKey on serviceBus", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    // Attach listeners BEFORE calling connectElectronToDaemon so we
    // catch the synchronous emit that happens after `connectToDaemonSession`
    // resolves. The listeners attach once each.
    const published: Record<string, unknown> = {};
    const topics = [
      "metro",
      "devtools",
      "builder",
      "watcher",
      "modulesClient",
      "worktreeKey",
    ] as const;
    for (const topic of topics) {
      serviceBus.once(topic, (value: unknown) => {
        published[topic] = value;
      });
    }

    // Inject the CLI entry because the vitest harness looks like
    // `app.isPackaged` to Electron — `resolveDaemonEntry` would otherwise
    // throw (Phase 13.4 P1: packaged Electron support lands in 13.5).
    const session = await connectElectronToDaemon({
      projectRoot: worktree,
      profile: fakeProfile(worktree),
      daemonEntry: CLI_ENTRY,
    });

    try {
      for (const topic of topics) {
        expect(published[topic]).toBeDefined();
      }
      // Same references — serviceBus hands through the session adapters
      // verbatim. Electron handlers resolve deps through these refs, so a
      // divergence here is a silent "handlers fire against a stale adapter"
      // hazard.
      expect(published.metro).toBe(session.metro);
      expect(published.devtools).toBe(session.devtools);
      expect(published.builder).toBe(session.builder);
      expect(published.watcher).toBe(session.watcher);
      expect(published.modulesClient).toBe(session.modules);
      expect(published.worktreeKey).toBe(session.worktreeKey);
    } finally {
      session.disconnect();
    }
  }, 15_000);
});
