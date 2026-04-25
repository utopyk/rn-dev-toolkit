import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../../app/client/session.js";
import type { Profile } from "../../core/types.js";

// Phase 13.4.1 follow-up — fake-boot now registers the four built-in
// modules on the daemon's ModuleRegistry so smoke + integration tests
// see modules/list returning the production-shape rows. Without this
// the Marketplace + Settings panels regressed to "No modules
// registered" / "Loading config…" forever even on a healthy daemon
// because fake-boot was leaving the registry empty.

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

describe("fake-boot: built-in modules registered", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) {
      await h.stop();
    }
    for (const c of cleanups.splice(0)) c();
  });

  it("modules/list returns marketplace + settings + dev-space + lint-test under fake boot", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const session = await connectToDaemonSession(worktree, fakeProfile(worktree));
    try {
      const resp = await daemon.client.send({
        type: "command",
        action: "modules/list",
        id: "list-1",
      });
      const payload = resp.payload as { modules?: Array<{ id: string }> };
      const ids = (payload.modules ?? []).map((m) => m.id).sort();
      expect(ids).toEqual(["dev-space", "lint-test", "marketplace", "settings"]);
    } finally {
      session.disconnect();
    }
  }, 15_000);
});
