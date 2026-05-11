import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ArtifactStore } from "../artifact.js";
import { MetroManager, METRO_STARTUP_BANNERS, isMetroStartupBanner } from "../metro.js";
import type { MetroInstance } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rn-dev-cli-metro-"));
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock child_process — provide spawn and execFile (used by metro.ts)
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const mockProcess = {
    pid: 12345,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
  };
  return {
    ...actual,
    spawn: vi.fn(() => mockProcess),
    execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
      cb(null, "", "");
    }),
  };
});

// Mock net module: isPortFree uses net.createServer
vi.mock("net", () => {
  return {
    createServer: vi.fn(() => ({
      listen: vi.fn((_port: number, cb: () => void) => {
        cb();
        return {
          once: vi.fn((_event: string, cb: () => void) => {
            cb();
          }),
          close: vi.fn((cb?: () => void) => cb?.()),
        };
      }),
      once: vi.fn(),
      close: vi.fn((cb?: () => void) => cb?.()),
    })),
  };
});

// ---------------------------------------------------------------------------
// MetroManager
// ---------------------------------------------------------------------------

describe("isMetroStartupBanner — Metro 0.83 quick-mode regression", () => {
  it("recognises the RN 0.83 banner ('Starting dev server on …')", () => {
    expect(isMetroStartupBanner("  Starting dev server on http://localhost:8099")).toBe(true);
  });

  it("recognises every legacy RN banner", () => {
    for (const m of [
      "Metro waiting on tcp://localhost:8081",
      "Metro is running",
      "Welcome to Metro",
      "Dev server ready",
    ]) {
      expect(isMetroStartupBanner(m)).toBe(true);
    }
  });

  it("rejects unrelated stdout lines", () => {
    expect(isMetroStartupBanner("BUNDLE  ./index.js")).toBe(false);
    expect(isMetroStartupBanner("info Welcome to React Native v0.83")).toBe(false);
    expect(isMetroStartupBanner("")).toBe(false);
  });

  it("STARTUP_BANNERS includes the RN 0.83 marker so future regressions surface", () => {
    expect([...METRO_STARTUP_BANNERS]).toContain("Starting dev server on");
  });
});

describe("MetroManager", () => {
  let tmpDir: string;
  let artifactsDir: string;
  let store: ArtifactStore;
  let manager: MetroManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    artifactsDir = join(tmpDir, "artifacts");
    store = new ArtifactStore(artifactsDir);
    manager = new MetroManager(store, [8081, 8085]);
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // allocatePort
  // -------------------------------------------------------------------------

  describe("allocatePort()", () => {
    it("returns persisted port from artifact when available", () => {
      store.save("wt-a", {
        worktree: "/some/path",
        worktreeHash: "abc123",
        metroPort: 8083,
        checksums: {},
      });

      const port = manager.allocatePort("wt-a");
      expect(port).toBe(8083);
    });

    it("assigns first free port in range when no artifact exists", () => {
      const port = manager.allocatePort("wt-new");
      expect(port).toBe(8081);
    });

    it("persists the allocated port in the artifact", () => {
      manager.allocatePort("wt-persist");
      const artifact = store.load("wt-persist");
      expect(artifact?.metroPort).toBe(8081);
    });

    it("skips ports already used by running instances", () => {
      // Register a running instance on port 8081
      (manager as unknown as { instances: Map<string, MetroInstance> }).instances.set(
        "wt-running",
        {
          worktree: "wt-running",
          port: 8081,
          pid: 99,
          status: "running",
          startedAt: new Date(),
          projectRoot: "/proj",
        }
      );

      const port = manager.allocatePort("wt-b");
      expect(port).toBe(8082);
    });

    it("throws when no ports are available in range", () => {
      // Fill all ports in range [8081, 8085] with running instances
      for (let p = 8081; p <= 8085; p++) {
        (manager as unknown as { instances: Map<string, MetroInstance> }).instances.set(
          `wt-${p}`,
          {
            worktree: `wt-${p}`,
            port: p,
            pid: p,
            status: "running",
            startedAt: new Date(),
            projectRoot: "/proj",
          }
        );
      }

      expect(() => manager.allocatePort("wt-overflow")).toThrow(
        /no ports available/i
      );
    });
  });

  // -------------------------------------------------------------------------
  // needsRebuild
  // -------------------------------------------------------------------------

  describe("needsRebuild()", () => {
    it("returns true when lastBuildPort differs from currentPort", () => {
      store.save("wt-rebuild", {
        worktree: "/path",
        worktreeHash: "abc",
        metroPort: 8081,
        checksums: {},
        lastBuildPort: 8082,
      });

      expect(manager.needsRebuild("wt-rebuild", 8081)).toBe(true);
    });

    it("returns false when lastBuildPort matches currentPort", () => {
      store.save("wt-same", {
        worktree: "/path",
        worktreeHash: "abc",
        metroPort: 8081,
        checksums: {},
        lastBuildPort: 8081,
      });

      expect(manager.needsRebuild("wt-same", 8081)).toBe(false);
    });

    it("returns true when no artifact exists", () => {
      expect(manager.needsRebuild("wt-none", 8081)).toBe(true);
    });

    it("returns true when artifact has no lastBuildPort", () => {
      store.save("wt-nolast", {
        worktree: "/path",
        worktreeHash: "abc",
        metroPort: 8081,
        checksums: {},
      });

      expect(manager.needsRebuild("wt-nolast", 8081)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getInstance / getAll
  // -------------------------------------------------------------------------

  describe("getInstance()", () => {
    it("returns null when no instance exists for key", () => {
      expect(manager.getInstance("wt-unknown")).toBeNull();
    });

    it("returns the instance after it has been registered", () => {
      const instance: MetroInstance = {
        worktree: "wt-x",
        port: 8081,
        pid: 1001,
        status: "running",
        startedAt: new Date(),
        projectRoot: "/proj/x",
      };
      (manager as unknown as { instances: Map<string, MetroInstance> }).instances.set(
        "wt-x",
        instance
      );

      expect(manager.getInstance("wt-x")).toBe(instance);
    });
  });

  describe("getAll()", () => {
    it("returns empty array when no instances exist", () => {
      expect(manager.getAll()).toEqual([]);
    });

    it("returns all registered instances", () => {
      const a: MetroInstance = {
        worktree: "wt-a",
        port: 8081,
        pid: 1,
        status: "running",
        startedAt: new Date(),
        projectRoot: "/a",
      };
      const b: MetroInstance = {
        worktree: "wt-b",
        port: 8082,
        pid: 2,
        status: "starting",
        startedAt: new Date(),
        projectRoot: "/b",
      };

      const instances = (manager as unknown as { instances: Map<string, MetroInstance> }).instances;
      instances.set("wt-a", a);
      instances.set("wt-b", b);

      const all = manager.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(a);
      expect(all).toContain(b);
    });
  });

  // -------------------------------------------------------------------------
  // start / stop — verify spawn args without running real Metro
  // -------------------------------------------------------------------------

  describe("start()", () => {
    it("spawns react-native start with the allocated port", async () => {
      const { spawn } = await import("child_process");
      const spawnMock = spawn as Mock;

      manager.start({
        worktreeKey: "wt-spawn",
        projectRoot: "/my/project",
        port: 8081,
      });

      expect(spawnMock).toHaveBeenCalledOnce();
      const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(cmd).toBe("npx");
      expect(args).toContain("react-native");
      expect(args).toContain("start");
      expect(args).toContain("--port");
      expect(args).toContain("8081");
    });

    it("adds --reset-cache flag when resetCache is true", async () => {
      const { spawn } = await import("child_process");
      const spawnMock = spawn as Mock;

      manager.start({
        worktreeKey: "wt-reset",
        projectRoot: "/my/project",
        port: 8081,
        resetCache: true,
      });

      const [, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(args).toContain("--reset-cache");
    });

    it("adds --verbose flag when verbose is true", async () => {
      const { spawn } = await import("child_process");
      const spawnMock = spawn as Mock;

      manager.start({
        worktreeKey: "wt-verbose",
        projectRoot: "/my/project",
        port: 8081,
        verbose: true,
      });

      const [, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(args).toContain("--verbose");
    });

    it("stores instance with status 'starting' after spawn", async () => {
      manager.start({
        worktreeKey: "wt-store",
        projectRoot: "/my/project",
        port: 8082,
      });

      const instance = manager.getInstance("wt-store");
      expect(instance).not.toBeNull();
      expect(instance!.status).toBe("starting");
      expect(instance!.port).toBe(8082);
      expect(instance!.pid).toBe(12345);
    });

    it("returns the MetroInstance", () => {
      const instance = manager.start({
        worktreeKey: "wt-ret",
        projectRoot: "/my/project",
        port: 8081,
      });

      expect(instance).toMatchObject({
        worktree: "wt-ret",
        port: 8081,
        status: "starting",
      });
    });
  });

  describe("stop()", () => {
    it("returns false when no instance exists", () => {
      expect(manager.stop("wt-missing")).toBe(false);
    });

    it("returns true and removes instance when it exists", () => {
      manager.start({
        worktreeKey: "wt-stop",
        projectRoot: "/proj",
        port: 8081,
      });

      expect(manager.getInstance("wt-stop")).not.toBeNull();

      const result = manager.stop("wt-stop");
      expect(result).toBe(true);
      expect(manager.getInstance("wt-stop")).toBeNull();
    });
  });

  describe("stopAll()", () => {
    it("stops all running instances", () => {
      manager.start({ worktreeKey: "wt-1", projectRoot: "/p1", port: 8081 });
      manager.start({ worktreeKey: "wt-2", projectRoot: "/p2", port: 8082 });

      expect(manager.getAll()).toHaveLength(2);

      manager.stopAll();

      expect(manager.getAll()).toHaveLength(0);
    });
  });
});
