// `session/pre` — the hook slot that fires BEFORE Metro starts.
//
// Why it exists: `enumerateEnvs` lands the wizard's env pick in
// `profile.env.APP_ENV` and the project rewrites `.env` from it, but
// `.env` is inlined at babel transform time and is NOT part of Metro's
// transform cache key. A project doing that switch from `build/pre` was
// structurally too late — Metro had already transformed and cached the
// previous env's values, which is how a production build shipped a
// staging JS bundle on 2026-09-14. See
// docs/sessions/2026-09-15-staging-bundle-on-prod-build.md.
//
// Pinned here:
//   1. `session/pre` actually fires — the fixture's hook subprocess runs
//      and writes its sentinel, with the right RN_DEV_HOOK_TARGET.
//   2. It fires BEFORE Metro. Ordering is read off the `session/log`
//      stream rather than `hooks/fired`, because `session/pre` fires
//      during boot and a late subscriber misses the hook events, whereas
//      `opts.emit` lines reach the subscriber that triggered the boot.
//   3. Module-owned slots still work despite the project config now
//      being walked before any module provider is declared. Loading it
//      that early orphans every `build/*` registration until step 13's
//      `declareProvider` reanimates them — so a live `build/pre` is the
//      regression guard for that reanimation.

import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
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
  const path = mkdtempSync(join(tmpdir(), "rn-dev-session-pre-"));
  cpSync(FIXTURE_SRC, path, { recursive: true });
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function fixtureProfile(worktree: string): Profile {
  return {
    name: "session-pre",
    isDefault: true,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "quick",
    metroPort: 8097,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot: worktree,
  } as Profile;
}

function logLines(events: IpcMessage[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const p = e.payload as
      | { kind?: string; data?: { message?: unknown } }
      | undefined;
    if (p?.kind === "session/log" && typeof p.data?.message === "string") {
      out.push(p.data.message);
    }
  }
  return out;
}

async function pollFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe("session/pre hook", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) await h.stop();
    for (const c of cleanups.splice(0)) c();
  });

  it("fires before Metro, and leaves module-owned slots live", async () => {
    const { path: worktree, cleanup } = makeFixtureWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    // This subscribe is what boots the session, so it is attached for the
    // whole boot and sees the `session/log` lines emitted during it.
    const events: IpcMessage[] = [];
    const profile = fixtureProfile(worktree);
    const sub = await daemon.client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-session-pre",
        payload: { profile },
      },
      { onEvent: (evt) => events.push(evt) },
    );

    try {
      // 1. The hook ran.
      const sentinel = join(worktree, ".hook-fired-session-pre");
      expect(
        await pollFor(() => existsSync(sentinel), 5_000),
        "session/pre sentinel should be written during boot",
      ).toBe(true);
      const body = JSON.parse(readFileSync(sentinel, "utf-8")) as {
        target: string;
      };
      expect(body.target).toBe("session/pre");

      // 2. It ran before Metro.
      await pollFor(
        () => logLines(events).some((l) => l.includes("Starting Metro")),
        5_000,
      );
      const lines = logLines(events);
      const preIdx = lines.findIndex((l) => l.includes("session/pre hooks"));
      const metroIdx = lines.findIndex((l) => l.includes("Starting Metro"));
      expect(preIdx, "session/pre phase line should be logged").toBeGreaterThan(
        -1,
      );
      expect(metroIdx, "Metro start line should be logged").toBeGreaterThan(-1);
      expect(
        preIdx,
        `session/pre must be logged before Metro starts (got pre=${preIdx}, metro=${metroIdx})`,
      ).toBeLessThan(metroIdx);

      // 3. A module-owned slot still fires. The project config is now
      //    walked before any module provider is declared, so this only
      //    passes if `declareProvider` reanimated the orphaned
      //    registration at step 13.
      const buildResp = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-after-session-pre",
        payload: {
          projectRoot: worktree,
          platform: "ios",
          port: 8097,
          variant: "debug",
        },
      });
      expect((buildResp.payload as { ok: boolean }).ok).toBe(true);
      expect(
        await pollFor(
          () => existsSync(join(worktree, ".h2-hook-fired-pre")),
          5_000,
        ),
        "build/pre must still fire after the early config walk",
      ).toBe(true);
    } finally {
      sub.close();
    }
  }, 20_000);
});
