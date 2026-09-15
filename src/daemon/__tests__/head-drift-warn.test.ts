import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";

// Bug 2026-08-20: two agents sharing one checkout of acme-mobile-app.
// Agent B ran `git checkout <branch>` under Agent A's live Metro
// session; neither client saw a signal for ~10 minutes, at which point
// Agent A's TS run turned up a phantom "missing import" error. The
// supervisor now watches `.git/HEAD` and pushes a warn `session/log`
// line into every live session's event stream — visible in each tab.

describe("supervisor HEAD-drift warning", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) await h.stop();
    for (const c of cleanups.splice(0)) c();
  });

  function makeProfile(worktree: string, name: string, port: number) {
    return {
      name,
      isDefault: true,
      worktree: null as string | null,
      branch: "main",
      platform: "ios",
      mode: "quick",
      metroPort: port,
      devices: {},
      buildVariant: "debug",
      preflight: { checks: [], frequency: "once" },
      onSave: [],
      env: {},
      projectRoot: worktree,
    };
  }

  it("emits a warn `session/log` on every live session when HEAD changes", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const git = (cmd: string) =>
      execSync(cmd, { cwd: worktree, stdio: "pipe" });
    git("git init -q -b feat/upload-center-diagnostics");
    git("git config user.email test@rn-dev.local");
    git("git config user.name rn-dev-test");
    writeFileSync(join(worktree, "seed.txt"), "seed\n");
    git("git add seed.txt");
    git('git commit -q -m "seed"');

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const subA = await daemon.client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-A",
        payload: { profile: makeProfile(worktree, "alpha", 8081) },
      },
      {
        onEvent: (evt) => {
          const p = (evt as { payload?: unknown }).payload;
          if (
            p &&
            typeof p === "object" &&
            (p as Record<string, unknown>).kind === "session/log" &&
            typeof (p as { data?: { message?: unknown } }).data?.message ===
              "string" &&
            (p as { data: { level?: string } }).data.level === "warn"
          ) {
            receivedA.push(
              (p as { data: { message: string } }).data.message,
            );
          }
        },
      },
    );
    try {
      const subB = await daemon.client.subscribe(
        {
          type: "command",
          action: "events/subscribe",
          id: "sub-B",
          payload: { profile: makeProfile(worktree, "beta", 8082) },
        },
        {
          onEvent: (evt) => {
            const p = (evt as { payload?: unknown }).payload;
            if (
              p &&
              typeof p === "object" &&
              (p as Record<string, unknown>).kind === "session/log" &&
              typeof (p as { data?: { message?: unknown } }).data?.message ===
                "string" &&
              (p as { data: { level?: string } }).data.level === "warn"
            ) {
              receivedB.push(
                (p as { data: { message: string } }).data.message,
              );
            }
          },
        },
      );
      try {
        const hit = (msgs: string[]) =>
          msgs.some(
            (m) =>
              m.includes("feat/upload-center-diagnostics") &&
              m.includes("fix/android-sent-images-white-rect"),
          );

        // Give the watcher a moment to attach after both sessions boot.
        await new Promise((r) => setTimeout(r, 200));
        git("git checkout -q -b fix/android-sent-images-white-rect");

        // Was `await setTimeout(800)` then assert. Under a full suite run
        // that clock loses: fs.watch delivery measured p50 750ms (vs 74ms
        // idle) on 2026-09-15, with some events lost outright. Poll for
        // both subscribers instead — returns the moment they land, and a
        // timeout here now means the fan-out is genuinely broken.
        const deadline = Date.now() + 12_000;
        while (!(hit(receivedA) && hit(receivedB))) {
          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 25));
        }

        expect(hit(receivedA)).toBe(true);
        expect(hit(receivedB)).toBe(true);
      } finally {
        subB.close();
      }
    } finally {
      subA.close();
    }
  }, 20_000);
});
