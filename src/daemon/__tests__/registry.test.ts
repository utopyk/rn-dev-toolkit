import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRegistryPath,
  findActiveDaemons,
  readRegistry,
  registerDaemon,
  unregisterDaemon,
  writeRegistry,
  type DaemonRegistration,
} from "../registry.js";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";

// Phase 13.5 — `~/.rn-dev/registry.json` is the side-channel MCP and
// other clients use to discover running daemons. These tests verify
// the file format, atomic write, stale-pid sweep, and roundtrip
// against a real spawned daemon.

describe("daemon registry (unit)", () => {
  let tmpRoot: string;
  let registryPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "registry-test-"));
    registryPath = join(tmpRoot, "registry.json");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("readRegistry returns empty registry when file missing", () => {
    const reg = readRegistry(registryPath);
    expect(reg.daemons).toEqual({});
  });

  it("readRegistry returns empty registry when file is malformed JSON", () => {
    writeFileSync(registryPath, "{not json", "utf-8");
    const reg = readRegistry(registryPath);
    expect(reg.daemons).toEqual({});
  });

  it("readRegistry drops malformed rows but keeps valid ones", () => {
    writeFileSync(
      registryPath,
      JSON.stringify({
        daemons: {
          "/good": {
            pid: process.pid,
            sockPath: "/tmp/sock",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
          "/bad-no-pid": { sockPath: "/tmp/x" },
          "/bad-wrong-types": { pid: "not-a-number", sockPath: 42 },
          "/bad-negative-pid": {
            pid: -1,
            sockPath: "/tmp/n",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
          "/bad-pid-1": {
            pid: 1,
            sockPath: "/tmp/n",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
          "/bad-empty-sock": {
            pid: process.pid,
            sockPath: "",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
          "/bad-unparseable-since": {
            pid: process.pid,
            sockPath: "/tmp/n",
            since: "not-a-date",
            hostVersion: "0.1.0",
          },
          "/bad-non-integer-pid": {
            pid: 1.5,
            sockPath: "/tmp/n",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
          "/bad-empty-version": {
            pid: process.pid,
            sockPath: "/tmp/n",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "",
          },
        },
      }),
      "utf-8",
    );
    const reg = readRegistry(registryPath);
    expect(Object.keys(reg.daemons)).toEqual(["/good"]);
  });

  it("writeRegistry produces 0o600 file mode", () => {
    writeRegistry(
      {
        daemons: {
          "/wt": {
            pid: process.pid,
            sockPath: "/tmp/sock",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
        },
      },
      registryPath,
    );
    const stat = statSync(registryPath);
    // Check the mode bits: should be 0o600 (owner rw only).
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("registerDaemon writes the entry + sweeps stale (dead-pid) entries", () => {
    // Seed a stale entry pointing at a pid that's almost certainly not
    // alive. pid=1 (init/launchd) IS alive on every machine, so we
    // pick a sky-high pid that's effectively never assigned.
    writeRegistry(
      {
        daemons: {
          "/stale-worktree": {
            pid: 999_999,
            sockPath: "/tmp/stale-sock",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
        },
      },
      registryPath,
    );

    registerDaemon(
      "/fresh-worktree",
      {
        pid: process.pid,
        sockPath: "/tmp/fresh-sock",
        since: "2026-04-25T01:00:00.000Z",
        hostVersion: "0.1.0",
      },
      registryPath,
    );

    const reg = readRegistry(registryPath);
    expect(reg.daemons["/stale-worktree"]).toBeUndefined();
    expect(reg.daemons["/fresh-worktree"]).toBeDefined();
    expect(reg.daemons["/fresh-worktree"]?.pid).toBe(process.pid);
  });

  it("registerDaemon overwrites on re-registration of the same worktree", () => {
    const first: DaemonRegistration = {
      pid: process.pid,
      sockPath: "/tmp/sock-a",
      since: "2026-04-25T00:00:00.000Z",
      hostVersion: "0.1.0",
    };
    const second: DaemonRegistration = {
      pid: process.pid,
      sockPath: "/tmp/sock-b",
      since: "2026-04-25T00:01:00.000Z",
      hostVersion: "0.1.0",
    };
    registerDaemon("/wt", first, registryPath);
    registerDaemon("/wt", second, registryPath);

    const reg = readRegistry(registryPath);
    expect(reg.daemons["/wt"]?.sockPath).toBe("/tmp/sock-b");
    expect(reg.daemons["/wt"]?.since).toBe("2026-04-25T00:01:00.000Z");
  });

  it("unregisterDaemon removes only the named worktree's entry", () => {
    writeRegistry(
      {
        daemons: {
          "/wt-a": {
            pid: process.pid,
            sockPath: "/tmp/sock-a",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
          "/wt-b": {
            pid: process.pid,
            sockPath: "/tmp/sock-b",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
        },
      },
      registryPath,
    );

    unregisterDaemon("/wt-a", registryPath);

    const reg = readRegistry(registryPath);
    expect(reg.daemons["/wt-a"]).toBeUndefined();
    expect(reg.daemons["/wt-b"]).toBeDefined();
  });

  it("unregisterDaemon is a no-op for a worktree not in the registry", () => {
    writeRegistry(
      {
        daemons: {
          "/wt": {
            pid: process.pid,
            sockPath: "/tmp/sock",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
        },
      },
      registryPath,
    );

    expect(() => unregisterDaemon("/never-registered", registryPath)).not.toThrow();

    const reg = readRegistry(registryPath);
    expect(reg.daemons["/wt"]).toBeDefined();
  });

  it("findActiveDaemons filters out dead pids", () => {
    writeRegistry(
      {
        daemons: {
          "/alive": {
            pid: process.pid,
            sockPath: "/tmp/alive",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
          "/dead": {
            pid: 999_999,
            sockPath: "/tmp/dead",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
        },
      },
      registryPath,
    );

    const active = findActiveDaemons(registryPath);
    expect(active.map((d) => d.worktree)).toEqual(["/alive"]);
    expect(active[0]?.pid).toBe(process.pid);
  });

  it("100 simulated crashes don't accumulate stale entries", () => {
    // Simulate 100 daemons that crashed without unregistering. Each
    // writes a fresh entry pointing at a different (dead) pid.
    for (let i = 0; i < 100; i++) {
      registerDaemon(
        `/crash-${i}`,
        {
          // Use pids that are very unlikely to be assigned. We mix in
          // process.pid for one entry to confirm that one survives.
          pid: i === 50 ? process.pid : 900_000 + i,
          sockPath: `/tmp/crash-${i}`,
          since: "2026-04-25T00:00:00.000Z",
          hostVersion: "0.1.0",
        },
        registryPath,
      );
    }

    // The next register call sweeps. After it, only the live entry +
    // the just-registered fresh entry should remain.
    registerDaemon(
      "/fresh",
      {
        pid: process.pid,
        sockPath: "/tmp/fresh",
        since: "2026-04-25T01:00:00.000Z",
        hostVersion: "0.1.0",
      },
      registryPath,
    );

    const reg = readRegistry(registryPath);
    const keys = Object.keys(reg.daemons);
    // The live entry from i=50 + the fresh one. Order isn't
    // guaranteed but cardinality is.
    expect(keys.sort()).toEqual(["/crash-50", "/fresh"]);
  });

  it("RN_DEV_REGISTRY_PATH overrides defaultRegistryPath", () => {
    const prev = process.env.RN_DEV_REGISTRY_PATH;
    process.env.RN_DEV_REGISTRY_PATH = registryPath;
    try {
      expect(defaultRegistryPath()).toBe(registryPath);
    } finally {
      if (prev === undefined) delete process.env.RN_DEV_REGISTRY_PATH;
      else process.env.RN_DEV_REGISTRY_PATH = prev;
    }
  });
});

describe("daemon registry roundtrip against a real daemon (integration)", () => {
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

  it("daemon registers on boot and unregisters on graceful shutdown", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const registryPath = join(worktree, "registry.json");

    const daemon = await spawnTestDaemon(worktree, {
      env: {
        RN_DEV_DAEMON_BOOT_MODE: "fake",
        RN_DEV_REGISTRY_PATH: registryPath,
      },
    });
    liveHandles.push(daemon);

    // spawnTestDaemon returns when the socket appears, but
    // registerDaemon races a tick or two behind that on the daemon
    // side. Poll for the registry entry rather than asserting eagerly.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (existsSync(registryPath)) {
        const reg = readRegistry(registryPath);
        if (reg.daemons[worktree]) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(registryPath)).toBe(true);
    const afterBoot = readRegistry(registryPath);
    expect(afterBoot.daemons[worktree]).toBeDefined();
    expect(afterBoot.daemons[worktree]?.pid).toBe(daemon.pid);
    expect(afterBoot.daemons[worktree]?.sockPath).toBe(daemon.sockPath);

    await daemon.stop();

    // After graceful shutdown the entry should be gone.
    const afterStop = readRegistry(registryPath);
    expect(afterStop.daemons[worktree]).toBeUndefined();
  }, 15_000);

  it("findActiveDaemons surfaces a live daemon and skips a stale entry", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const registryPath = join(worktree, "registry.json");

    // Seed a stale entry before booting the daemon. The daemon's
    // boot-time sweep should remove it; findActiveDaemons should
    // never see it.
    writeRegistry(
      {
        daemons: {
          "/stale": {
            pid: 999_999,
            sockPath: "/tmp/stale",
            since: "2026-04-25T00:00:00.000Z",
            hostVersion: "0.1.0",
          },
        },
      },
      registryPath,
    );

    const daemon = await spawnTestDaemon(worktree, {
      env: {
        RN_DEV_DAEMON_BOOT_MODE: "fake",
        RN_DEV_REGISTRY_PATH: registryPath,
      },
    });
    liveHandles.push(daemon);

    const active = findActiveDaemons(registryPath);
    expect(active.length).toBe(1);
    expect(active[0]?.worktree).toBe(worktree);
    expect(active[0]?.pid).toBe(daemon.pid);
  }, 15_000);
});
