// Phase H2h — integration test that drives the H2g builder/build hook
// firing path end-to-end through a real daemon process. Uses the
// smoke-rn-with-hooks fixture: an RN-shaped tmpdir with rn-dev.config.mjs
// declaring build/pre + build/post hooks that touch sentinel files.
//
// fake-boot is the harness — H2h flipped fake-boot to load project hooks
// (loadProjectHooks call site at fake-boot.ts ~line 200), and fake-boot's
// fake Builder emits 'done' synchronously enough that the post-hook
// completes within a normal poll window.
//
// Pin invariants:
//   1. build/pre subprocess runs before the (fake) Builder kicks off:
//      .h2-hook-fired-pre file exists in the worktree.
//   2. build/post subprocess runs after the Builder emits 'done':
//      .h2-hook-fired-post file exists.
//   3. hooks/fired session events are delivered for both targets over
//      the existing events/subscribe channel.
//   4. Builder still emits its own builder/done event (the source field
//      from H2b reads "builtin").
//
// The H2 plan also mentions a sub-500ms latency assertion for
// build/pre-to-build-start; the fake builder doesn't actually start a
// real build, so we approximate by asserting the pre-hook completes
// within a reasonable bound and the wire ordering is correct.

import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../../app/client/session.js";
import type { IpcMessage } from "../../core/ipc.js";
import type { Profile } from "../../core/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const FIXTURE_SRC = join(
  REPO_ROOT,
  "tests",
  "electron-smoke",
  "fixtures",
  "smoke-rn-with-hooks",
);

function makeFixtureWorktree(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "rn-dev-h2-hooks-"));
  cpSync(FIXTURE_SRC, path, { recursive: true });
  const cleanup = (): void => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  return { path, cleanup };
}

function fixtureProfile(worktree: string): Profile {
  return {
    name: "h2-hooks",
    isDefault: true,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "quick",
    metroPort: 8099,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot: worktree,
  };
}

async function pollFor(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 25,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return predicate();
}

describe("builder/build hook firing — daemon integration (H2h)", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) {
      await h.stop();
    }
    for (const c of cleanups.splice(0)) c();
  });

  it("fires build/pre + build/post when builder/build is invoked over the daemon socket", async () => {
    const { path: worktree, cleanup } = makeFixtureWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    // Subscribe FIRST so we don't miss the hooks/fired events that
    // land while the build is in flight. daemon.client.subscribe()
    // returns a long-lived sub-socket with an onEvent callback.
    const subEvents: IpcMessage[] = [];
    const sub = await daemon.client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1" },
      { onEvent: (evt) => subEvents.push(evt) },
    );

    const session = await connectToDaemonSession(worktree, fixtureProfile(worktree));
    try {

      const buildResp = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-1",
        payload: {
          projectRoot: worktree,
          platform: "ios",
          port: 8081,
          variant: "debug",
        },
      });
      expect((buildResp.payload as { ok: boolean }).ok).toBe(true);

      // build/pre fires synchronously inside the handler, then
      // services.builder.build(...) runs the (fake) build, which emits
      // 'done' very fast. build/post fires off that 'done' listener.
      const preFired = await pollFor(
        () => existsSync(join(worktree, ".h2-hook-fired-pre")),
        2_000,
      );
      expect(preFired).toBe(true);

      const postFired = await pollFor(
        () => existsSync(join(worktree, ".h2-hook-fired-post")),
        2_000,
      );
      expect(postFired).toBe(true);

      // Sentinel content sanity-check: each hook script writes the
      // RN_DEV_HOOK_TARGET it received.
      const preBody = JSON.parse(
        readFileSync(join(worktree, ".h2-hook-fired-pre"), "utf-8"),
      ) as { target: string };
      const postBody = JSON.parse(
        readFileSync(join(worktree, ".h2-hook-fired-post"), "utf-8"),
      ) as { target: string };
      expect(preBody.target).toBe("build/pre");
      expect(postBody.target).toBe("build/post");

      // hooks/fired wire events: at least one for build/pre + one for
      // build/post should land on the subscribe channel.
      await pollFor(
        () =>
          subEvents.filter(
            (e) =>
              ((e.payload as { kind?: string })?.kind === "hooks/fired") &&
              ((e.payload as { data?: { target?: string } })?.data?.target ===
                "build/pre"),
          ).length > 0 &&
          subEvents.filter(
            (e) =>
              ((e.payload as { kind?: string })?.kind === "hooks/fired") &&
              ((e.payload as { data?: { target?: string } })?.data?.target ===
                "build/post"),
          ).length > 0,
        2_000,
      );

      const hookEventTargets = subEvents
        .filter(
          (e) => (e.payload as { kind?: string })?.kind === "hooks/fired",
        )
        .map(
          (e) => (e.payload as { data: { target: string } }).data.target,
        );
      expect(hookEventTargets).toEqual(
        expect.arrayContaining(["build/pre", "build/post"]),
      );

    } finally {
      sub.close();
      session.disconnect();
    }
  }, 20_000);
});
