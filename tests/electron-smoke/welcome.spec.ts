import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Real-Electron coverage for the project picker (WelcomeScreen). The rest
// of the smoke suite pins RN_DEV_PROJECT_ROOT, which commits a project and
// skips the picker entirely. This spec deliberately launches with NO
// committed project (env unset + an isolated empty recents store) and
// asserts the picker renders instead of the app silently auto-opening a
// project — the gap this feature closes.
//
// In uncommitted mode main.ts returns before startRealServices, so no
// daemon is spawned: teardown is just app.close() + tmp cleanup.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURE_SRC = join(HERE, "fixtures", "smoke-rn");

interface Handle {
  app: ElectronApplication;
  page: Page;
  tmpdir: string;
}

async function launchUncommitted(): Promise<Handle> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "rn-dev-welcome-"));
  cpSync(FIXTURE_SRC, tmpRoot, { recursive: true });
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
      RN_DEV_DAEMON_BOOT_MODE: "fake",
      RN_DEV_SMOKE: "1",
      // Isolated, empty recents store → no committed lastProject → picker.
      RN_DEV_PROJECTS_PATH: join(tmpRoot, "electron-projects.json"),
      // Crucially NOT setting RN_DEV_PROJECT_ROOT: that override would
      // commit a project and skip the picker. Strip any inherited value.
      RN_DEV_PROJECT_ROOT: undefined,
    },
    timeout: 30_000,
  });
  app.process().stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[electron-stderr] ${chunk.toString()}`);
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  return { app, page, tmpdir: tmpRoot };
}

async function teardown(handle: Handle): Promise<void> {
  await handle.app.close().catch(() => {
    /* Electron sometimes refuses clean close under harness */
  });
  try {
    rmSync(handle.tmpdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

test("with no committed project, the GUI shows the project picker", async () => {
  const handle = await launchUncommitted();
  try {
    const { page } = handle;
    // The picker's heading + Open-folder affordance must render — proves
    // main.ts did NOT silently auto-open a project and the renderer gated
    // on project:state.
    await expect(
      page.getByText("Pick a React Native project to start"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Open a folder/ })).toBeVisible();
    // The launch dir is an RN project, so the picker offers it as a
    // one-click "Use" suggestion (project:list + detection wired).
    await expect(page.getByRole("button", { name: "Use" })).toBeVisible();
  } finally {
    await teardown(handle);
  }
});
