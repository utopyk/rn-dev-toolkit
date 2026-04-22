import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PreflightConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rn-dev-cli-preflight-"));
}

// ---------------------------------------------------------------------------
// Mock exec-async (the async shell helpers preflight.ts depends on) and
// net before importing the module under test. The old tests mocked
// `child_process.execSync`, but preflight.ts was refactored to use
// `execAsync` / `execAsyncSafe` from `exec-async.ts` in commit 5a76b27
// — the execSync mock was never hit, which is why the node-version
// tests silently tried to spawn the real `node -v`.
// ---------------------------------------------------------------------------

vi.mock("../exec-async.js", () => ({
  execAsync: vi.fn(),
  execAsyncSafe: vi.fn(),
  execShellAsync: vi.fn(),
}));

vi.mock("net", () => ({
  createServer: vi.fn(),
}));

import { execAsync } from "../exec-async.js";
import * as net from "net";
import {
  PreflightEngine,
  createDefaultPreflightEngine,
} from "../preflight.js";

// ---------------------------------------------------------------------------
// PreflightEngine — core behaviours
// ---------------------------------------------------------------------------

describe("PreflightEngine", () => {
  let engine: PreflightEngine;

  beforeEach(() => {
    engine = new PreflightEngine();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // register / getChecksForPlatform
  // -------------------------------------------------------------------------

  describe("register() / getChecksForPlatform()", () => {
    it("registers a check and makes it retrievable", () => {
      engine.register({
        id: "test-check",
        name: "Test Check",
        severity: "error",
        platform: "all",
        check: async () => ({ passed: true, message: "ok" }),
      });

      const checks = engine.getChecksForPlatform("ios");
      expect(checks).toHaveLength(1);
      expect(checks[0].id).toBe("test-check");
    });

    it("getChecksForPlatform('ios') returns ios + all checks", () => {
      engine.register({
        id: "ios-only",
        name: "iOS Only",
        severity: "error",
        platform: "ios",
        check: async () => ({ passed: true, message: "ok" }),
      });
      engine.register({
        id: "android-only",
        name: "Android Only",
        severity: "error",
        platform: "android",
        check: async () => ({ passed: true, message: "ok" }),
      });
      engine.register({
        id: "all-platforms",
        name: "All Platforms",
        severity: "warning",
        platform: "all",
        check: async () => ({ passed: true, message: "ok" }),
      });

      const checks = engine.getChecksForPlatform("ios");
      const ids = checks.map((c) => c.id);
      expect(ids).toContain("ios-only");
      expect(ids).toContain("all-platforms");
      expect(ids).not.toContain("android-only");
    });

    it("getChecksForPlatform('android') returns android + all checks", () => {
      engine.register({
        id: "ios-only",
        name: "iOS Only",
        severity: "error",
        platform: "ios",
        check: async () => ({ passed: true, message: "ok" }),
      });
      engine.register({
        id: "android-only",
        name: "Android Only",
        severity: "error",
        platform: "android",
        check: async () => ({ passed: true, message: "ok" }),
      });
      engine.register({
        id: "all-platforms",
        name: "All Platforms",
        severity: "warning",
        platform: "all",
        check: async () => ({ passed: true, message: "ok" }),
      });

      const checks = engine.getChecksForPlatform("android");
      const ids = checks.map((c) => c.id);
      expect(ids).toContain("android-only");
      expect(ids).toContain("all-platforms");
      expect(ids).not.toContain("ios-only");
    });

    it("getChecksForPlatform('both') returns all checks", () => {
      engine.register({
        id: "ios-only",
        name: "iOS Only",
        severity: "error",
        platform: "ios",
        check: async () => ({ passed: true, message: "ok" }),
      });
      engine.register({
        id: "android-only",
        name: "Android Only",
        severity: "error",
        platform: "android",
        check: async () => ({ passed: true, message: "ok" }),
      });
      engine.register({
        id: "all-platforms",
        name: "All Platforms",
        severity: "warning",
        platform: "all",
        check: async () => ({ passed: true, message: "ok" }),
      });

      const checks = engine.getChecksForPlatform("both");
      const ids = checks.map((c) => c.id);
      expect(ids).toContain("ios-only");
      expect(ids).toContain("android-only");
      expect(ids).toContain("all-platforms");
    });
  });

  // -------------------------------------------------------------------------
  // filterByConfig
  // -------------------------------------------------------------------------

  describe("filterByConfig()", () => {
    it("returns only checks whose id is in config.checks", () => {
      const checks = [
        {
          id: "check-a",
          name: "A",
          severity: "error" as const,
          platform: "all" as const,
          check: async () => ({ passed: true, message: "ok" }),
        },
        {
          id: "check-b",
          name: "B",
          severity: "error" as const,
          platform: "all" as const,
          check: async () => ({ passed: true, message: "ok" }),
        },
        {
          id: "check-c",
          name: "C",
          severity: "warning" as const,
          platform: "all" as const,
          check: async () => ({ passed: true, message: "ok" }),
        },
      ];

      const config: PreflightConfig = {
        checks: ["check-a", "check-c"],
        frequency: "always",
      };

      const filtered = engine.filterByConfig(checks, config);
      const ids = filtered.map((c) => c.id);
      expect(filtered).toHaveLength(2);
      expect(ids).toContain("check-a");
      expect(ids).toContain("check-c");
      expect(ids).not.toContain("check-b");
    });

    it("returns empty array when config.checks is empty", () => {
      const checks = [
        {
          id: "check-a",
          name: "A",
          severity: "error" as const,
          platform: "all" as const,
          check: async () => ({ passed: true, message: "ok" }),
        },
      ];

      const config: PreflightConfig = { checks: [], frequency: "always" };
      expect(engine.filterByConfig(checks, config)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // runAll
  // -------------------------------------------------------------------------

  describe("runAll()", () => {
    it("runs all applicable checks and returns results keyed by check id", async () => {
      engine.register({
        id: "check-pass",
        name: "Pass",
        severity: "error",
        platform: "all",
        check: async () => ({ passed: true, message: "all good" }),
      });
      engine.register({
        id: "check-fail",
        name: "Fail",
        severity: "warning",
        platform: "all",
        check: async () => ({ passed: false, message: "something wrong" }),
      });

      const config: PreflightConfig = {
        checks: ["check-pass", "check-fail"],
        frequency: "always",
      };

      const results = await engine.runAll("ios", config);
      expect(results.size).toBe(2);
      expect(results.get("check-pass")?.passed).toBe(true);
      expect(results.get("check-fail")?.passed).toBe(false);
    });

    it("only runs checks matching the platform and config", async () => {
      const checkFn = vi.fn(async () => ({ passed: true, message: "ok" }));

      engine.register({
        id: "android-check",
        name: "Android Check",
        severity: "error",
        platform: "android",
        check: checkFn,
      });
      engine.register({
        id: "ios-check",
        name: "iOS Check",
        severity: "error",
        platform: "ios",
        check: async () => ({ passed: true, message: "ok" }),
      });

      const config: PreflightConfig = {
        checks: ["android-check", "ios-check"],
        frequency: "always",
      };

      // Running for iOS — android-check should not execute
      await engine.runAll("ios", config);
      expect(checkFn).not.toHaveBeenCalled();
    });

    it("returns an empty map when no checks match", async () => {
      engine.register({
        id: "android-check",
        name: "Android Check",
        severity: "error",
        platform: "android",
        check: async () => ({ passed: true, message: "ok" }),
      });

      const config: PreflightConfig = {
        checks: ["android-check"],
        frequency: "always",
      };

      const results = await engine.runAll("ios", config);
      expect(results.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // fix
  // -------------------------------------------------------------------------

  describe("fix()", () => {
    it("calls the check's fix function and returns true on success", async () => {
      const fixFn = vi.fn(async () => true);

      engine.register({
        id: "fixable-check",
        name: "Fixable Check",
        severity: "error",
        platform: "all",
        check: async () => ({ passed: false, message: "broken" }),
        fix: fixFn,
      });

      const result = await engine.fix("fixable-check");
      expect(fixFn).toHaveBeenCalledOnce();
      expect(result).toBe(true);
    });

    it("returns false when check has no fix function", async () => {
      engine.register({
        id: "unfixable-check",
        name: "Unfixable Check",
        severity: "error",
        platform: "all",
        check: async () => ({ passed: false, message: "broken" }),
      });

      const result = await engine.fix("unfixable-check");
      expect(result).toBe(false);
    });

    it("returns false when check id does not exist", async () => {
      const result = await engine.fix("nonexistent-id");
      expect(result).toBe(false);
    });

    it("returns false when fix function returns false", async () => {
      engine.register({
        id: "failing-fix",
        name: "Failing Fix",
        severity: "error",
        platform: "all",
        check: async () => ({ passed: false, message: "broken" }),
        fix: async () => false,
      });

      const result = await engine.fix("failing-fix");
      expect(result).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// createDefaultPreflightEngine — built-in checks
// ---------------------------------------------------------------------------

describe("createDefaultPreflightEngine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("registers all 15 built-in checks", () => {
    const engine = createDefaultPreflightEngine(tmpDir);
    const allChecks = engine.getChecksForPlatform("both");
    expect(allChecks).toHaveLength(15);
  });

  it("registers all expected check ids", () => {
    const engine = createDefaultPreflightEngine(tmpDir);
    const allChecks = engine.getChecksForPlatform("both");
    const ids = allChecks.map((c) => c.id);

    const expectedIds = [
      "node-version",
      "ruby-version",
      "java-home",
      "android-home",
      "android-sdk-licenses",
      "xcode-cli-tools",
      "cocoapods-installed",
      "podfile-lock-sync",
      "watchman",
      "metro-port",
      "node-modules-sync",
      "env-file",
      "patch-package",
    ];

    for (const id of expectedIds) {
      expect(ids).toContain(id);
    }
  });

  it("ios platform returns ios + all checks (not android-only)", () => {
    const engine = createDefaultPreflightEngine(tmpDir);
    const iosChecks = engine.getChecksForPlatform("ios");
    const ids = iosChecks.map((c) => c.id);

    // iOS-specific checks should be present
    expect(ids).toContain("xcode-cli-tools");
    expect(ids).toContain("cocoapods-installed");
    expect(ids).toContain("podfile-lock-sync");

    // Android-specific checks should NOT be present
    expect(ids).not.toContain("java-home");
    expect(ids).not.toContain("android-home");
    expect(ids).not.toContain("android-sdk-licenses");
  });

  it("android platform returns android + all checks (not ios-only)", () => {
    const engine = createDefaultPreflightEngine(tmpDir);
    const androidChecks = engine.getChecksForPlatform("android");
    const ids = androidChecks.map((c) => c.id);

    // Android-specific checks should be present
    expect(ids).toContain("java-home");
    expect(ids).toContain("android-home");
    expect(ids).toContain("android-sdk-licenses");

    // iOS-specific checks should NOT be present
    expect(ids).not.toContain("xcode-cli-tools");
    expect(ids).not.toContain("cocoapods-installed");
    expect(ids).not.toContain("podfile-lock-sync");
  });

  // -------------------------------------------------------------------------
  // node-version check
  // -------------------------------------------------------------------------

  describe("node-version check", () => {
    it("passes when node version matches .nvmrc", async () => {
      writeFileSync(join(tmpDir, ".nvmrc"), "18.19.0\n");
      vi.mocked(execAsync).mockResolvedValue("v18.19.0\n");

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const nodeCheck = checks.find((c) => c.id === "node-version")!;

      const result = await nodeCheck.check();
      expect(result.passed).toBe(true);
    });

    it("fails when node version does not match .nvmrc", async () => {
      writeFileSync(join(tmpDir, ".nvmrc"), "18.19.0\n");
      vi.mocked(execAsync).mockResolvedValue("v20.0.0\n");

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const nodeCheck = checks.find((c) => c.id === "node-version")!;

      const result = await nodeCheck.check();
      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/version/i);
    });

    it("passes when no version file is present (no constraint)", async () => {
      // No .nvmrc, no .node-version, no engines in package.json
      vi.mocked(execAsync).mockResolvedValue("v18.19.0\n");

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const nodeCheck = checks.find((c) => c.id === "node-version")!;

      const result = await nodeCheck.check();
      expect(result.passed).toBe(true);
    });

    it("passes when node version matches .node-version file", async () => {
      writeFileSync(join(tmpDir, ".node-version"), "20.11.0\n");
      vi.mocked(execAsync).mockResolvedValue("v20.11.0\n");

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const nodeCheck = checks.find((c) => c.id === "node-version")!;

      const result = await nodeCheck.check();
      expect(result.passed).toBe(true);
    });

    it("returns failed gracefully when node is not installed", async () => {
      vi.mocked(execAsync).mockRejectedValue(
        new Error("command not found: node"),
      );

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const nodeCheck = checks.find((c) => c.id === "node-version")!;

      const result = await nodeCheck.check();
      expect(result.passed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // metro-port check
  // -------------------------------------------------------------------------

  describe("metro-port check", () => {
    it("passes when the metro port is free", async () => {
      const mockServer = {
        listen: vi.fn((_port: number, cb: () => void) => {
          cb();
          return mockServer;
        }),
        close: vi.fn((cb?: () => void) => {
          if (cb) cb();
          return mockServer;
        }),
        on: vi.fn().mockReturnThis(),
      };
      vi.mocked(net.createServer).mockReturnValue(mockServer as unknown as ReturnType<typeof net.createServer>);

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const portCheck = checks.find((c) => c.id === "metro-port")!;

      const result = await portCheck.check();
      expect(result.passed).toBe(true);
      expect(result.message).toMatch(/free|available/i);
    });

    it("fails when the metro port is occupied", async () => {
      const mockServer = {
        listen: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event: string, cb: (err: Error) => void) => {
          if (event === "error") {
            cb(Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
          }
          return mockServer;
        }),
      };
      vi.mocked(net.createServer).mockReturnValue(mockServer as unknown as ReturnType<typeof net.createServer>);

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const portCheck = checks.find((c) => c.id === "metro-port")!;

      const result = await portCheck.check();
      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/occupied|in use|port/i);
    });
  });

  // -------------------------------------------------------------------------
  // node-modules-sync check
  // -------------------------------------------------------------------------

  describe("node-modules-sync check", () => {
    it("passes when lockfile does not exist (no constraint)", async () => {
      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const check = checks.find((c) => c.id === "node-modules-sync")!;

      const result = await check.check();
      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // env-file check
  // -------------------------------------------------------------------------

  describe("env-file check", () => {
    it("passes when react-native-config is not in deps", async () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "my-app", dependencies: {} })
      );

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const check = checks.find((c) => c.id === "env-file")!;

      const result = await check.check();
      expect(result.passed).toBe(true);
    });

    it("fails when react-native-config is in deps but .env is missing", async () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "my-app",
          dependencies: { "react-native-config": "^1.0.0" },
        })
      );

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const check = checks.find((c) => c.id === "env-file")!;

      const result = await check.check();
      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/\.env/i);
    });

    it("passes when react-native-config is in deps and .env exists", async () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "my-app",
          dependencies: { "react-native-config": "^1.0.0" },
        })
      );
      writeFileSync(join(tmpDir, ".env"), "API_URL=https://example.com\n");

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const check = checks.find((c) => c.id === "env-file")!;

      const result = await check.check();
      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // patch-package check
  // -------------------------------------------------------------------------

  describe("patch-package check", () => {
    it("passes when patch-package is not in deps", async () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "my-app", dependencies: {} })
      );

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const check = checks.find((c) => c.id === "patch-package")!;

      const result = await check.check();
      expect(result.passed).toBe(true);
    });

    it("passes when patch-package is in deps but no .patch files exist", async () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "my-app",
          dependencies: { "patch-package": "^8.0.0" },
        })
      );
      mkdirSync(join(tmpDir, "patches"));

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const check = checks.find((c) => c.id === "patch-package")!;

      const result = await check.check();
      expect(result.passed).toBe(true);
    });

    it("checks patch files when patch-package is in deps and patches/ has .patch files", async () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "my-app",
          dependencies: { "patch-package": "^8.0.0" },
        })
      );
      mkdirSync(join(tmpDir, "patches"));
      writeFileSync(join(tmpDir, "patches", "some-dep+1.0.0.patch"), "--- a\n+++ b\n");

      // Simulate a patch-check failure via the async exec wrapper
      vi.mocked(execAsync).mockImplementation(async (cmd: string) => {
        if (String(cmd).includes("patch")) {
          throw new Error("patch not applied");
        }
        return "";
      });

      const engine = createDefaultPreflightEngine(tmpDir);
      const checks = engine.getChecksForPlatform("both");
      const check = checks.find((c) => c.id === "patch-package")!;

      // Should not throw regardless of outcome
      const result = await check.check();
      expect(result).toHaveProperty("passed");
      expect(result).toHaveProperty("message");
    });
  });
});
