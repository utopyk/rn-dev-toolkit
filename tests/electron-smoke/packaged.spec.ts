import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Packaged-app smoke — gated behind PACKAGED_SMOKE=1 (same pattern as
// REAL_BOOT_SMOKE) because it needs `npm run build:app` to have produced
// release/. The dev smoke suite proves the tsx + Vite path; this suite
// proves the OTHER launch path teammates get from the Dock icon:
//   - renderer served from the asar'd dist-renderer (file://, base './')
//   - preloads resolved via electronAssetsDir inside the bundle
//   - daemon cold-spawned from <resources>/daemon/index.js under bun
//     (pickDaemonInterpreter's Electron+.js branch)
// A regression in any of those ships a .app that opens to a blank window
// or hangs on "Loading modules" while every dev-path gate stays green.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURE_SRC = join(HERE, "fixtures", "smoke-rn");

const GATED = process.env.PACKAGED_SMOKE !== "1";

/**
 * The packaged binary for this platform/arch. Fail (not skip) when
 * PACKAGED_SMOKE=1 but the build output is missing — running the gate
 * against a stale or absent .app would report green without testing
 * anything.
 */
function packagedBinary(): string {
  const candidates = [
    join(REPO_ROOT, "release", "mac-arm64", "rn-dev.app", "Contents", "MacOS", "rn-dev"),
    join(REPO_ROOT, "release", "mac", "rn-dev.app", "Contents", "MacOS", "rn-dev"),
    join(REPO_ROOT, "release", "linux-unpacked", "rn-dev"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `PACKAGED_SMOKE=1 but no packaged binary found. Run \`npm run build:app\` first. Tried:\n  ${candidates.join("\n  ")}`,
  );
}

interface ElectronHandle {
  app: ElectronApplication;
  page: Page;
  tmpdir: string;
}

async function launchPackaged(): Promise<ElectronHandle> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "rn-dev-packaged-smoke-"));
  cpSync(FIXTURE_SRC, tmpRoot, { recursive: true });

  // Same default profile the dev smoke suite seeds — makes
  // startRealServices connect (cold-spawning the packaged daemon)
  // instead of stalling on the wizard.
  const profilesDir = join(tmpRoot, ".rn-dev", "profiles");
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(
    join(profilesDir, "default.json"),
    JSON.stringify(
      {
        name: "default",
        isDefault: true,
        worktree: null,
        branch: "main",
        platform: "ios",
        mode: "quick",
        metroPort: 8098,
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

  const userDataDir = join(tmpRoot, ".electron-user-data");
  mkdirSync(userDataDir, { recursive: true });

  const app = await electron.launch({
    executablePath: packagedBinary(),
    args: [`--user-data-dir=${userDataDir}`],
    cwd: tmpRoot,
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      RN_DEV_DAEMON_BOOT_MODE: "fake",
      RN_DEV_PROJECT_ROOT: tmpRoot,
      RN_DEV_SMOKE: "1",
    },
    timeout: 30_000,
  });
  app.process().stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[packaged-stderr] ${chunk.toString()}`);
  });
  app.process().stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[packaged-stdout] ${chunk.toString()}`);
  });

  const page = await app.firstWindow({ timeout: 30_000 });
  return { app, page, tmpdir: tmpRoot };
}

// Teardown mirrors the dev smoke suite: the daemon is a detached process
// group leader, not Electron's child, so app.close() alone leaks it.
async function teardownElectron(handle: ElectronHandle): Promise<void> {
  const pid = readDaemonPidFromWorktree(handle.tmpdir);
  await handle.app.close().catch(() => {
    /* Electron sometimes refuses clean close under harness */
  });
  if (pid !== null) await terminateDaemonPid(pid);
  try {
    rmSync(handle.tmpdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

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

test.describe("Packaged Electron smoke", () => {
  test.skip(GATED, "set PACKAGED_SMOKE=1 (and run `npm run build:app`) to enable");

  let handle: ElectronHandle | null = null;

  test.afterEach(async () => {
    if (handle) {
      await teardownElectron(handle);
      handle = null;
    }
  });

  test("packaged app mounts the renderer from disk with no console errors", async () => {
    handle = await launchPackaged();
    const errors: string[] = [];
    handle.page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await expect(handle.page.locator(".sidebar")).toBeVisible({ timeout: 30_000 });
    expect(errors, `renderer console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("packaged app cold-spawns the resources daemon: Marketplace lists built-ins", async () => {
    handle = await launchPackaged();
    await handle.page.getByRole("button", { name: /marketplace/i }).click();
    // Built-ins appearing proves the FULL packaged daemon chain: main.cjs
    // resolved <resources>/daemon/index.js, spawned it under bun, the
    // fake-boot session registered modules IPC, and the renderer got the
    // list back. "No modules registered" here = daemon spawn failed.
    await expect(handle.page.getByText(/no modules registered/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    const marketplaceTable = handle.page.locator("table.marketplace-table, .marketplace-view table");
    await expect(marketplaceTable).toBeVisible({ timeout: 5_000 });
    await expect(marketplaceTable).toContainText(/marketplace|settings|dev-space|lint-test/i);
  });
});
