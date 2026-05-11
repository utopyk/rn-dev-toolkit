import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphanHooks } from "../hook-orphan-sweep.js";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";

let tmpRoot = "";

function writeLock(
  pgid: number,
  daemonPid: number,
  target = "session/init",
): string {
  const path = join(tmpRoot, `${pgid}.lock`);
  writeFileSync(
    path,
    JSON.stringify({ daemonPid, target, ts: Date.now() }),
    "utf-8",
  );
  return path;
}

beforeEach(() => {
  // realpath here so paths line up on macOS where /var/folders/* is a
  // symlink to /private/var/folders/* (lesson from path-resolver tests).
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "hook-orphan-")));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("sweepOrphanHooks — empty + non-existent inputs", () => {
  it("returns the zero result when the hooks dir does not exist", () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
    expect(result).toEqual({ scanned: 0, killed: 0, cleared: [] });
  });

  it("returns the zero result for an empty hooks dir", () => {
    const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
    expect(result).toEqual({ scanned: 0, killed: 0, cleared: [] });
  });
});

describe("sweepOrphanHooks — owner alive", () => {
  it("leaves a lockfile alone when the recorded daemon is still alive", () => {
    // Use the test process itself as the alive owner.
    const lock = writeLock(99999, process.pid);
    const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
    expect(result.scanned).toBe(1);
    expect(result.killed).toBe(0);
    expect(result.cleared).toEqual([]);
    expect(existsSync(lock)).toBe(true);
  });
});

describe("sweepOrphanHooks — orphaned (owner dead)", () => {
  it("unlinks the lockfile when the recorded daemonPid is gone", async () => {
    // Spawn a no-op child so we know a real, currently-alive pid; let
    // it exit, then use the corpse pid as the recorded daemonPid.
    const corpse = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const corpsePid = corpse.pid!;
    expect(typeof corpsePid).toBe("number");
    await new Promise<void>((resolve) =>
      corpse.once("exit", () => resolve()),
    );

    // Spawn a sleeping child that we'll claim is the hook subprocess.
    // It has its own process group (detached), so process.kill(-pgid)
    // would reach it — but the orphan sweep should also unlink the
    // lockfile regardless of kill outcome.
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore",
    });
    sleeper.unref();
    const pgid = sleeper.pid!;
    try {
      const lock = writeLock(pgid, corpsePid);
      const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
      expect(result.scanned).toBe(1);
      expect(result.cleared).toContain(pgid);
      expect(existsSync(lock)).toBe(false);
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* already reaped by the sweep */
      }
      try {
        process.kill(pgid, "SIGKILL");
      } catch {
        /* already reaped */
      }
    }
  });
});

describe("sweepOrphanHooks — malformed inputs", () => {
  it("ignores non-numeric basenames", () => {
    writeFileSync(join(tmpRoot, "garbage.lock"), "{}", "utf-8");
    const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
    expect(result.scanned).toBe(0);
    // Filename invariant: a basename like `garbage.lock` is left alone
    // — we never want to trick ourselves into signaling pid 0.
    expect(existsSync(join(tmpRoot, "garbage.lock"))).toBe(true);
  });

  it("ignores zero and negative pgids in filenames", () => {
    writeFileSync(join(tmpRoot, "0.lock"), "{}", "utf-8");
    writeFileSync(join(tmpRoot, "-1.lock"), "{}", "utf-8");
    const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
    expect(result.scanned).toBe(0);
  });

  it("unlinks a corrupt-JSON lockfile and continues", () => {
    const lock = join(tmpRoot, "12345.lock");
    writeFileSync(lock, "this is not JSON", "utf-8");
    const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
    expect(result.scanned).toBe(1);
    expect(result.killed).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("unlinks a lockfile missing the daemonPid field", () => {
    const lock = join(tmpRoot, "12345.lock");
    writeFileSync(lock, JSON.stringify({ target: "x/y" }), "utf-8");
    const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
    expect(result.scanned).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("ignores subdirectories under the hooks root", () => {
    mkdirSync(join(tmpRoot, "sub"), { recursive: true });
    const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
    expect(result.scanned).toBe(0);
    expect(readdirSync(tmpRoot)).toContain("sub");
  });

  it("ignores files without the .lock suffix", () => {
    writeFileSync(join(tmpRoot, "12345.txt"), "{}", "utf-8");
    const result = sweepOrphanHooks({ hooksRoot: tmpRoot });
    expect(result.scanned).toBe(0);
  });
});

describe("hook orphan-sweep on daemon boot (integration)", () => {
  const liveHandles: TestDaemonHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    while (liveHandles.length > 0) {
      const h = liveHandles.pop()!;
      try {
        await h.stop();
      } catch {
        /* best-effort */
      }
    }
    while (cleanups.length > 0) {
      try {
        cleanups.pop()!();
      } catch {
        /* best-effort */
      }
    }
  });

  it("kills a stranded hook subprocess + unlinks its lockfile when a fresh daemon boots", async () => {
    // Stand up the orphan condition: a sleeping process that pretends
    // to be the previous daemon's hook subprocess, plus a lockfile
    // pointing at a now-dead daemonPid.
    const hooksRoot = realpathSync(mkdtempSync(join(tmpdir(), "hook-orphan-int-")));
    cleanups.push(() => rmSync(hooksRoot, { recursive: true, force: true }));

    // A real-but-dead pid for the daemonPid field. Spawn-and-exit lets
    // us record a pid that's guaranteed to be unrecycled within the
    // test window.
    const corpse = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const corpsePid = corpse.pid!;
    await new Promise<void>((resolve) =>
      corpse.once("exit", () => resolve()),
    );

    // Sleeping victim — its pid is the pgid that the sweep should
    // SIGKILL. detached: true so the child gets its own process
    // group; unref() so the test process doesn't wait on it.
    const sleeper = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60_000)"],
      { detached: true, stdio: "ignore" },
    );
    sleeper.unref();
    const sleeperPid = sleeper.pid!;
    expect(typeof sleeperPid).toBe("number");
    cleanups.push(() => {
      try {
        process.kill(-sleeperPid, "SIGKILL");
      } catch {
        /* swept */
      }
      try {
        process.kill(sleeperPid, "SIGKILL");
      } catch {
        /* swept */
      }
    });

    const lockPath = join(hooksRoot, `${sleeperPid}.lock`);
    writeFileSync(
      lockPath,
      JSON.stringify({
        daemonPid: corpsePid,
        target: "session/init",
        ts: Date.now(),
      }),
      "utf-8",
    );

    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: {
        RN_DEV_DAEMON_BOOT_MODE: "fake",
        RN_DEV_HOOKS_ROOT: hooksRoot,
      },
    });
    liveHandles.push(daemon);

    // Daemon boot calls sweepOrphanHooks before opening the socket;
    // by the time the socket exists (waitForSocket completed inside
    // spawnTestDaemon), the sweep has already run.
    expect(existsSync(lockPath)).toBe(false);

    // Sleeping victim should be dead. Allow a short window for the
    // SIGKILL to propagate even though it's already been issued.
    const deadline = Date.now() + 2_000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(sleeperPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          alive = false;
          break;
        }
        if (code === "EPERM") {
          // Permission denied — process exists but we can't signal.
          // Treat as "unswept" since the sweep should be running as
          // the same user.
          break;
        }
        break;
      }
    }
    expect(alive).toBe(false);

    // Daemon stdout includes the diagnostic line (the only operator
    // visibility we have for a successful sweep).
    expect(daemon.getStdout()).toMatch(
      new RegExp(`hook-orphan-sweep cleared 1 hook .*pgids: ${sleeperPid}`),
    );
  }, 15_000);

  it("leaves a lockfile alone when the recorded daemon is the test process (still alive)", async () => {
    const hooksRoot = realpathSync(mkdtempSync(join(tmpdir(), "hook-orphan-live-")));
    cleanups.push(() => rmSync(hooksRoot, { recursive: true, force: true }));

    // Fake "live" hook: the recorded daemonPid is process.pid, which
    // is alive, so the sweep should leave both the lockfile and the
    // sleeper process untouched. Use a sleeper pid we control.
    const sleeper = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60_000)"],
      { detached: true, stdio: "ignore" },
    );
    sleeper.unref();
    const sleeperPid = sleeper.pid!;
    cleanups.push(() => {
      try {
        process.kill(-sleeperPid, "SIGKILL");
      } catch {
        /* */
      }
      try {
        process.kill(sleeperPid, "SIGKILL");
      } catch {
        /* */
      }
    });

    const lockPath = join(hooksRoot, `${sleeperPid}.lock`);
    writeFileSync(
      lockPath,
      JSON.stringify({
        daemonPid: process.pid,
        target: "session/init",
        ts: Date.now(),
      }),
      "utf-8",
    );

    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: {
        RN_DEV_DAEMON_BOOT_MODE: "fake",
        RN_DEV_HOOKS_ROOT: hooksRoot,
      },
    });
    liveHandles.push(daemon);

    // Lockfile preserved — the recorded daemon (this test process) is
    // alive, so the sweep treats it as still-owned.
    expect(existsSync(lockPath)).toBe(true);
    expect(daemon.getStdout()).not.toMatch(/hook-orphan-sweep cleared/);

    // Sleeper still alive too.
    expect(() => process.kill(sleeperPid, 0)).not.toThrow();
  }, 15_000);
});

describe("sweepOrphanHooks — log callback", () => {
  it("calls log with a line per orphan kill", async () => {
    const corpse = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const corpsePid = corpse.pid!;
    await new Promise<void>((resolve) =>
      corpse.once("exit", () => resolve()),
    );

    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore",
    });
    sleeper.unref();
    const pgid = sleeper.pid!;
    try {
      writeLock(pgid, corpsePid, "session/init");
      const lines: string[] = [];
      const result = sweepOrphanHooks({
        hooksRoot: tmpRoot,
        log: (line) => lines.push(line),
      });
      expect(result.cleared).toContain(pgid);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain(`pgid=${pgid}`);
      expect(lines[0]).toContain("session/init");
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* swept */
      }
      try {
        process.kill(pgid, "SIGKILL");
      } catch {
        /* swept */
      }
    }
  });
});
