import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rn-dev-cli-clean-"));
}

function writeFile(dir: string, relativePath: string, content = ""): void {
  const fullPath = join(dir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

// ---------------------------------------------------------------------------
// Mocks — set up before imports so vitest hoisting works
// ---------------------------------------------------------------------------

// `clean.ts` uses the async shell helpers from `exec-async.ts` (post the
// `5a76b27` execSync → Bun.spawn refactor). Mock those so the Xcode
// process-probe tests don't actually spawn `pgrep` / `killall`.
vi.mock("../exec-async.js", () => ({
  execAsyncSafe: vi.fn(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  })),
  execShellAsync: vi.fn(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are declared)
// ---------------------------------------------------------------------------

import {
  CleanManager,
  detectPackageManager,
  isXcodeRunning,
  killXcode,
} from "../clean.js";
import type { CleanStep } from "../clean.js";
import type { Platform, RunMode } from "../types.js";

// ---------------------------------------------------------------------------
// detectPackageManager
// ---------------------------------------------------------------------------

describe("detectPackageManager", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns "yarn" when yarn.lock exists', () => {
    writeFile(root, "yarn.lock", "# yarn lockfile v1");
    expect(detectPackageManager(root)).toBe("yarn");
  });

  it('returns "pnpm" when pnpm-lock.yaml exists', () => {
    writeFile(root, "pnpm-lock.yaml", "lockfileVersion: 5.4");
    expect(detectPackageManager(root)).toBe("pnpm");
  });

  it('returns "npm" when neither yarn.lock nor pnpm-lock.yaml exist', () => {
    expect(detectPackageManager(root)).toBe("npm");
  });

  it('returns "yarn" over "pnpm" when both lockfiles exist', () => {
    writeFile(root, "yarn.lock", "# yarn lockfile v1");
    writeFile(root, "pnpm-lock.yaml", "lockfileVersion: 5.4");
    expect(detectPackageManager(root)).toBe("yarn");
  });
});

// ---------------------------------------------------------------------------
// CleanManager — getStepsForMode
// ---------------------------------------------------------------------------

describe("CleanManager.getStepsForMode()", () => {
  let root: string;
  let manager: CleanManager;

  beforeEach(() => {
    root = makeTmpDir();
    manager = new CleanManager(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // --- dirty mode ---

  it("returns empty steps for dirty mode (ios)", () => {
    const steps = manager.getStepsForMode("dirty", "ios");
    expect(steps).toHaveLength(0);
  });

  it("returns empty steps for dirty mode (android)", () => {
    const steps = manager.getStepsForMode("dirty", "android");
    expect(steps).toHaveLength(0);
  });

  it("returns empty steps for dirty mode (both)", () => {
    const steps = manager.getStepsForMode("dirty", "both");
    expect(steps).toHaveLength(0);
  });

  // --- clean mode ---

  it("returns the expected clean steps for ios platform", () => {
    const steps = manager.getStepsForMode("clean", "ios");
    const names = steps.map((s: CleanStep) => s.name);
    // Shared steps
    expect(names).toContain("kill-watchman");
    expect(names).toContain("remove-node-modules");
    expect(names).toContain("clear-metro-cache");
    expect(names).toContain("install-dependencies");
    // iOS-specific
    expect(names).toContain("pod-install");
  });

  it("returns the expected clean steps for android platform (no pod-install)", () => {
    const steps = manager.getStepsForMode("clean", "android");
    const names = steps.map((s: CleanStep) => s.name);
    // Shared steps
    expect(names).toContain("kill-watchman");
    expect(names).toContain("remove-node-modules");
    expect(names).toContain("clear-metro-cache");
    expect(names).toContain("install-dependencies");
    // iOS-specific steps should be absent
    expect(names).not.toContain("pod-install");
  });

  it("returns the expected clean steps for both platforms", () => {
    const steps = manager.getStepsForMode("clean", "both");
    const names = steps.map((s: CleanStep) => s.name);
    expect(names).toContain("kill-watchman");
    expect(names).toContain("remove-node-modules");
    expect(names).toContain("clear-metro-cache");
    expect(names).toContain("install-dependencies");
    expect(names).toContain("pod-install");
  });

  // --- ultra-clean mode ---

  it("ultra-clean includes all clean steps plus additional steps for ios", () => {
    const cleanSteps = manager.getStepsForMode("clean", "ios");
    const ultraSteps = manager.getStepsForMode("ultra-clean", "ios");

    // ultra-clean must be a superset
    expect(ultraSteps.length).toBeGreaterThan(cleanSteps.length);

    // All clean step names should appear in ultra-clean
    const ultraNames = ultraSteps.map((s: CleanStep) => s.name);
    for (const step of cleanSteps) {
      expect(ultraNames).toContain(step.name);
    }

    // Additional ios-specific ultra-clean steps
    expect(ultraNames).toContain("pod-deintegrate");
    expect(ultraNames).toContain("remove-pods");
    expect(ultraNames).toContain("remove-derived-data");
    expect(ultraNames).toContain("uninstall-ios-app");
  });

  it("ultra-clean includes gradle steps for android platform", () => {
    const ultraSteps = manager.getStepsForMode("ultra-clean", "android");
    const names = ultraSteps.map((s: CleanStep) => s.name);

    expect(names).toContain("gradle-stop");
    expect(names).toContain("clean-gradle-caches");
    expect(names).toContain("uninstall-android-app");

    // iOS-only steps should not appear for android
    expect(names).not.toContain("pod-deintegrate");
    expect(names).not.toContain("remove-pods");
    expect(names).not.toContain("remove-derived-data");
    expect(names).not.toContain("uninstall-ios-app");
  });

  it("ultra-clean for both platform includes ios and android extra steps", () => {
    const ultraSteps = manager.getStepsForMode("ultra-clean", "both");
    const names = ultraSteps.map((s: CleanStep) => s.name);

    expect(names).toContain("pod-deintegrate");
    expect(names).toContain("remove-pods");
    expect(names).toContain("remove-derived-data");
    expect(names).toContain("uninstall-ios-app");
    expect(names).toContain("gradle-stop");
    expect(names).toContain("clean-gradle-caches");
    expect(names).toContain("uninstall-android-app");
  });

  // --- platform filtering ---

  it("excludes ios-only steps when platform is android", () => {
    const steps = manager.getStepsForMode("ultra-clean", "android");
    const names = steps.map((s: CleanStep) => s.name);
    expect(names).not.toContain("pod-install");
    expect(names).not.toContain("pod-deintegrate");
    expect(names).not.toContain("remove-pods");
    expect(names).not.toContain("remove-derived-data");
    expect(names).not.toContain("uninstall-ios-app");
  });

  it("excludes android-only steps when platform is ios", () => {
    const steps = manager.getStepsForMode("ultra-clean", "ios");
    const names = steps.map((s: CleanStep) => s.name);
    expect(names).not.toContain("gradle-stop");
    expect(names).not.toContain("clean-gradle-caches");
    expect(names).not.toContain("uninstall-android-app");
  });

  // --- step structure ---

  it("every step has required fields (name, description, action, platform, mode)", () => {
    const steps = manager.getStepsForMode("ultra-clean", "both");
    for (const step of steps) {
      expect(step).toHaveProperty("name");
      expect(step).toHaveProperty("description");
      expect(step).toHaveProperty("action");
      expect(step).toHaveProperty("platform");
      expect(step).toHaveProperty("mode");
      expect(typeof step.action).toBe("function");
      expect(Array.isArray(step.mode)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// CleanManager — execute
// ---------------------------------------------------------------------------

describe("CleanManager.execute()", () => {
  let root: string;
  let manager: CleanManager;

  beforeEach(() => {
    root = makeTmpDir();
    manager = new CleanManager(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty array for dirty mode", async () => {
    const results = await manager.execute("dirty", "ios");
    expect(results).toHaveLength(0);
  });

  it("calls onProgress callback before each step", async () => {
    // Spy on the step actions so they resolve immediately
    const progressCalls: Array<[string, string]> = [];
    const onProgress = (step: string, status: string) => {
      progressCalls.push([step, status]);
    };

    // Mock all step actions to resolve successfully
    const originalGetSteps = manager.getStepsForMode.bind(manager);
    vi.spyOn(manager, "getStepsForMode").mockImplementation(
      (mode: RunMode, platform: Platform) => {
        return originalGetSteps(mode, platform).map((step: CleanStep) => ({
          ...step,
          action: async () => ({ success: true, output: "ok" }),
        }));
      }
    );

    await manager.execute("clean", "android", onProgress);

    expect(progressCalls.length).toBeGreaterThan(0);
    // Each call should have a step name and status string
    for (const [stepName, status] of progressCalls) {
      expect(typeof stepName).toBe("string");
      expect(typeof status).toBe("string");
    }
  });

  it("returns a CleanResult for each step", async () => {
    vi.spyOn(manager, "getStepsForMode").mockReturnValue([
      {
        name: "test-step",
        description: "A test step",
        platform: "all",
        mode: ["clean"],
        action: async () => ({ success: true, output: "done" }),
      },
    ]);

    const results = await manager.execute("clean", "both");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      step: "test-step",
      success: true,
      output: "done",
    });
  });

  it("marks a step as failed but continues when a step fails", async () => {
    vi.spyOn(manager, "getStepsForMode").mockReturnValue([
      {
        name: "failing-step",
        description: "This will fail",
        platform: "all",
        mode: ["clean"],
        action: async () => ({ success: false, output: "error occurred" }),
      },
      {
        name: "next-step",
        description: "This runs after failure",
        platform: "all",
        mode: ["clean"],
        action: async () => ({ success: true, output: "ran anyway" }),
      },
    ]);

    const results = await manager.execute("clean", "both");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ step: "failing-step", success: false });
    expect(results[1]).toMatchObject({ step: "next-step", success: true });
  });

  it("captures exception from a step action and marks it failed", async () => {
    vi.spyOn(manager, "getStepsForMode").mockReturnValue([
      {
        name: "throwing-step",
        description: "This throws",
        platform: "all",
        mode: ["clean"],
        action: async () => {
          throw new Error("kaboom");
        },
      },
      {
        name: "after-throw",
        description: "Runs after throw",
        platform: "all",
        mode: ["clean"],
        action: async () => ({ success: true, output: "ok" }),
      },
    ]);

    const results = await manager.execute("clean", "both");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ step: "throwing-step", success: false });
    expect(results[0].output).toContain("kaboom");
    expect(results[1]).toMatchObject({ step: "after-throw", success: true });
  });
});

// ---------------------------------------------------------------------------
// isXcodeRunning / killXcode
// ---------------------------------------------------------------------------

describe("isXcodeRunning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when pgrep finds Xcode (non-empty output, exit 0)", async () => {
    const { execAsyncSafe } = await import("../exec-async.js");
    (execAsyncSafe as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "12345\n",
      stderr: "",
      exitCode: 0,
    });

    expect(await isXcodeRunning()).toBe(true);
  });

  it("returns false when pgrep rejects (no process found)", async () => {
    const { execAsyncSafe } = await import("../exec-async.js");
    (execAsyncSafe as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("exit code 1"),
    );

    expect(await isXcodeRunning()).toBe(false);
  });

  it("returns false when pgrep returns empty string", async () => {
    const { execAsyncSafe } = await import("../exec-async.js");
    (execAsyncSafe as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    expect(await isXcodeRunning()).toBe(false);
  });
});

describe("killXcode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when killall Xcode succeeds and Xcode is no longer running", async () => {
    const { execShellAsync, execAsyncSafe } = await import("../exec-async.js");
    (execShellAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    // First poll: Xcode is gone (empty stdout) — `killXcode` returns true
    // immediately via `isXcodeRunning()` returning false.
    (execAsyncSafe as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    expect(await killXcode()).toBe(true);
  });

  it("returns false when killall rejects", async () => {
    const { execShellAsync } = await import("../exec-async.js");
    (execShellAsync as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("no process found"),
    );

    expect(await killXcode()).toBe(false);
  });
});
