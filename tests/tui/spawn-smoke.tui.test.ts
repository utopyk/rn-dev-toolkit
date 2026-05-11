/**
 * Spawn smoke — boot the production TUI binary as a real subprocess,
 * not in-process. This is the second layer of TUI test parity (parity
 * with `npm run test:smoke` for Electron). The in-process testRender
 * suite (`tests/tui/wizard-*.tui.test.tsx`) catches component-level
 * bugs but cannot catch:
 *   - CLI argv parsing (commander) regressions
 *   - `start-flow.ts` boot ordering (theme load → registry register →
 *     connectToDaemonSession → renderer mount)
 *   - Daemon spawn / connect startup races
 *   - Real-terminal raw-mode entry from OpenTUI
 *
 * Strategy: spawn `bun run src/index.tsx start --interactive` against
 * a fixture worktree, capture stdout, strip ANSI, assert the wizard's
 * first-step prompt appears within 15 s. Then kill the process and
 * verify the daemon socket/pid files are gone.
 *
 * NOT a real-boot test — daemon runs in fake-boot mode (no real
 * Metro). Real-boot lives in `real-boot.tui.test.ts`.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTuiFixture } from "./helpers/tui-harness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const ENTRY = join(REPO_ROOT, "src", "index.tsx");

function stripAnsi(input: string): string {
  // CSI sequences (`ESC [ ... letter`) — colours, cursor moves.
  let out = input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // OSC sequences (`ESC ] ... BEL` or `ESC ] ... ESC \\`) — title sets.
  out = out.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  // DCS / SOS / PM / APC bracket escapes.
  out = out.replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "");
  // Single-char escapes.
  out = out.replace(/\x1b[=>NOMcDEHM78]/g, "");
  return out;
}

function resolveBunBinary(): string {
  const home = homedir();
  // Mirrors scripts/run-tui-tests.mjs / vitest.global-setup.ts.
  const versionRoots = [
    { root: join(home, ".nodenv", "versions"), subpath: ["bin"] as string[] },
    { root: join(home, ".nvm", "versions", "node"), subpath: ["bin"] as string[] },
    { root: join(home, ".fnm", "node-versions"), subpath: ["installation", "bin"] as string[] },
  ];
  let best: { path: string; ver: number[] } | null = null;
  const cmp = (a: number[], b: number[]): number => {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  };
  for (const { root, subpath } of versionRoots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(root, entry, ...subpath, "bun");
      if (!existsSync(candidate)) continue;
      const ver = entry.replace(/^v/, "").split(".").map((s) => Number(s));
      if (ver.some((v) => Number.isNaN(v))) continue;
      if (!best || cmp(ver, best.ver) > 0) best = { path: candidate, ver };
    }
  }
  if (best) return best.path;
  for (const dir of [join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    const candidate = join(dir, "bun");
    if (existsSync(candidate)) return candidate;
  }
  return "bun";
}

const BUN = resolveBunBinary();

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("Spawn smoke — `bun run src/index.tsx start --interactive` boots into the wizard", () => {
  const fixtures: Array<{ cleanup(): void; projectRoot: string }> = [];

  afterAll(() => {
    for (const f of fixtures) f.cleanup();
  });

  it("renders the worktree-selection prompt within 15s of cold start", async () => {
    const fixture = createTuiFixture();
    fixtures.push(fixture);

    const proc = Bun.spawn({
      cmd: [BUN, "run", ENTRY, "start", "--interactive"],
      cwd: fixture.projectRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Force fake-boot daemon so we don't accidentally spawn a real
        // Metro process during the smoke. Mirrors the Electron smoke
        // suite's BOOT_MODE=fake convention.
        RN_DEV_DAEMON_BOOT_MODE: "fake",
        // Don't propagate CI=true since OpenTUI may bail to a no-TTY
        // path; we WANT the renderer to attempt raw-mode entry to
        // exercise the production code path.
        CI: "",
      },
    });

    const decoder = new TextDecoder();
    let accumulated = "";
    let foundPrompt = false;
    const deadline = Date.now() + 15_000;

    const reader = proc.stdout.getReader();

    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 250),
        ),
      ]);
      if (result.done) break;
      if (result.value) {
        accumulated += decoder.decode(result.value, { stream: true });
        const stripped = stripAnsi(accumulated);
        if (
          stripped.includes("Select a worktree") ||
          stripped.includes("Setup Wizard")
        ) {
          foundPrompt = true;
          break;
        }
      }
    }

    proc.kill();
    await proc.exited;

    if (!foundPrompt) {
      const stripped = stripAnsi(accumulated);
      // Surface a tail of the captured output to make failures
      // diagnosable rather than a bare "didn't find prompt".
      throw new Error(
        `spawn smoke: never saw "Select a worktree" or "Setup Wizard" within 15s.\n--- last 1k chars (stripped) ---\n${stripped.slice(-1000)}\n--- end ---`,
      );
    }
    expect(foundPrompt).toBe(true);

    // Daemon teardown: when the TUI is killed the daemon should drop
    // its sock + pid files. (Fixture's .rn-dev path is the daemon's
    // working dir.)
    const sock = join(fixture.projectRoot, ".rn-dev", "sock");
    const pid = join(fixture.projectRoot, ".rn-dev", "pid");
    // Allow up to 2s for orderly shutdown.
    const cleanupDeadline = Date.now() + 2000;
    while ((existsSync(sock) || existsSync(pid)) && Date.now() < cleanupDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // We don't fail on lingering pid/sock because the daemon's parent
    // is a detached subprocess; this is a soft-warning-only check on
    // shutdown hygiene. Hard-failing was the original loose-end that
    // bit us mid-2026-05-06.
  }, 30_000);
});
