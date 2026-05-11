import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Shared launch + teardown helper for the long-session real-e2e suite.
// Mirrors the smoke harness in `tests/electron-smoke/smoke.spec.ts` but
// returns a richer handle: the real-e2e tests need both stderr capture
// and the daemon's pid file path so they can assert process liveness +
// scan stderr for `subscribe.send: connection already closed`.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SMOKE_FIXTURE_SRC = join(REPO_ROOT, "tests", "electron-smoke", "fixtures", "smoke-rn");

export interface RealE2eHandle {
  app: ElectronApplication;
  page: Page;
  tmpdir: string;
  /** Captured stderr from Electron main + spawned daemon. */
  getStderr: () => string;
  /** Captured stdout. */
  getStdout: () => string;
  /** True if this handle points at a user's real project (NOT a tmp fixture).
   * Teardown handles the two cases differently — real-project teardown
   * preserves the project tree and only removes the smoke artifacts. */
  realMode: boolean;
}

export interface LaunchOptions {
  metroPort?: number;
  /** Extra .rn-dev/profiles/*.json entries to write before launch. Each
   * gets a UUID-ish filename to avoid collisions. */
  extraProfiles?: Array<{
    name: string;
    metroPort: number;
    branch?: string;
  }>;
  /**
   * Point Electron at an existing real RN project (e.g. acme-mobile-app)
   * instead of the synthetic fixture. Skips fixture copy + fake-boot —
   * the daemon spawns real Metro against the real project. Use sparingly:
   * each test mutates `<projectRoot>/.rn-dev/` and writes a profile to
   * the user's actual project tree.
   */
  realProjectRoot?: string;
  /** Required when realProjectRoot is set. */
  realProjectPackageManager?: "npm" | "pnpm" | "yarn" | "bun";
}

export async function launchRealE2e(opts: LaunchOptions = {}): Promise<RealE2eHandle> {
  // Decide between synthetic fixture and a real project root. Real-project
  // mode is opt-in (`realProjectRoot` set); the test owns all clean-up of
  // the profile we write into the real `.rn-dev/profiles/` dir.
  const realMode = typeof opts.realProjectRoot === "string";
  const tmpRoot = realMode
    ? opts.realProjectRoot!
    : mkdtempSync(join(tmpdir(), "rn-dev-real-e2e-"));
  if (!realMode) {
    cpSync(SMOKE_FIXTURE_SRC, tmpRoot, { recursive: true });
  }

  const profilesDir = join(tmpRoot, ".rn-dev", "profiles");
  mkdirSync(profilesDir, { recursive: true });

  const metroPort = opts.metroPort ?? 8099;
  // In real-project mode the smoke profile has to match the project's
  // ACTUAL git branch (else `findDefault(null, branch)` returns null
  // and main.ts falls back to the wizard, bypassing the daemon flip).
  const branchForProfile = realMode
    ? execSync("git rev-parse --abbrev-ref HEAD", { cwd: tmpRoot })
        .toString()
        .trim()
    : "main";
  writeFileSync(
    join(profilesDir, "default.json"),
    JSON.stringify(
      {
        name: "default",
        isDefault: true,
        worktree: null,
        branch: branchForProfile,
        platform: "ios",
        mode: "quick",
        metroPort,
        devices: {},
        buildVariant: "debug",
        preflight: { checks: [], frequency: "once" },
        onSave: [],
        env: {},
        projectRoot: tmpRoot,
        ...(realMode && opts.realProjectPackageManager
          ? { packageManager: opts.realProjectPackageManager }
          : {}),
      },
      null,
      2,
    ),
  );

  for (const extra of opts.extraProfiles ?? []) {
    writeFileSync(
      join(profilesDir, `${extra.name}.json`),
      JSON.stringify(
        {
          name: extra.name,
          isDefault: false,
          worktree: null,
          branch: extra.branch ?? "main",
          platform: "ios",
          mode: "quick",
          metroPort: extra.metroPort,
          devices: {},
          buildVariant: "debug",
          preflight: { checks: [], frequency: "once" },
          onSave: [],
          env: {},
          projectRoot: tmpRoot,
        },
        null,
        2,
      ),
    );
  }

  const userDataDir = join(tmpRoot, ".electron-user-data");
  mkdirSync(userDataDir, { recursive: true });

  const app = await electron.launch({
    args: [
      join(REPO_ROOT, "electron", "launcher.cjs"),
      `--user-data-dir=${userDataDir}`,
    ],
    cwd: tmpRoot,
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      // Fake-boot keeps Metro/Builder/Watcher stubbed in synthetic-fixture
      // mode; in real-project mode we drop the override so the daemon spawns
      // real Metro against the user's actual project. Real-project mode is
      // strictly opt-in via `realProjectRoot`.
      ...(realMode ? {} : { RN_DEV_DAEMON_BOOT_MODE: "fake" }),
      RN_DEV_PROJECT_ROOT: tmpRoot,
      RN_DEV_SMOKE: "1",
    },
    timeout: 30_000,
  });

  let stderr = "";
  let stdout = "";
  app.process().stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(`[electron-stderr] ${text}`);
  });
  app.process().stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(`[electron-stdout] ${text}`);
  });

  const page = await app.firstWindow({ timeout: 30_000 });
  return {
    app,
    page,
    tmpdir: tmpRoot,
    getStderr: () => stderr,
    getStdout: () => stdout,
    realMode,
  };
}

export async function teardownRealE2e(handle: RealE2eHandle): Promise<void> {
  // Pre-fix `app.close()` left the spawned daemon (a detached process
  // group leader, not Electron's child) running forever — every
  // `npm run test:real-e2e` accumulated 2 leaked
  // `bun … daemon /var/folders/.../rn-dev-real-e2e-*` processes.
  // Same class as Bug F. Read the pid BEFORE app.close + rmSync so
  // the SIGKILL fallback has something to target.
  const pid = readDaemonPidFromWorktree(handle.tmpdir);
  await handle.app.close().catch(() => {
    /* Electron sometimes refuses clean close under harness */
  });
  if (pid !== null) {
    await terminateDaemonPid(pid);
  }
  if (handle.realMode) {
    // DO NOT rmSync the user's real project tree. Only remove the
    // artifacts this harness wrote: the smoke profile + the local
    // userDataDir + the daemon's sock/pid lockfile.
    try {
      rmSync(join(handle.tmpdir, ".rn-dev", "profiles", "default.json"), {
        force: true,
      });
      rmSync(join(handle.tmpdir, ".rn-dev", "sock"), { force: true });
      rmSync(join(handle.tmpdir, ".rn-dev", "pid"), { force: true });
      rmSync(join(handle.tmpdir, ".electron-user-data"), {
        recursive: true,
        force: true,
      });
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    rmSync(handle.tmpdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Read the pid recorded by the daemon's lockfile at
 * `<worktree>/.rn-dev/pid`. Returns null if missing/unparseable —
 * either the daemon never started, or it crashed before writing.
 * Pid file format set by `ModuleLockfile.acquire`.
 */
function readDaemonPidFromWorktree(worktree: string): number | null {
  const pidPath = join(worktree, ".rn-dev", "pid");
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateDaemonPid(pid: number): Promise<void> {
  if (!processIsAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* best-effort */
  }
  // Poll up to 1.5s for graceful exit before SIGKILL.
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (processIsAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* best-effort */
    }
  }
}
