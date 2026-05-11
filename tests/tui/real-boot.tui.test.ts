/**
 * Real-boot probe — third layer of TUI test parity (parity with
 * `REAL_BOOT_SMOKE=1` Electron + `PROBE=1` MCP/Electron probes).
 *
 * Spawns the production TUI against the user's real acme project,
 * not a synthetic fixture. The default profile is dirty mode + iPhone
 * 15, so this exercises:
 *   - daemon spawn + connect against a real RN project
 *   - bootSessionServices in real-boot mode
 *   - triggerBuildsIfNeeded → builder/build → react-native run-ios
 *   - xcodebuild output flowing through builder/* events to the
 *     daemon → BuilderClient → DevSpaceView log panel
 *
 * Captures stdout, strips ANSI, asserts build-progress markers
 * appear within a generous timeout. Real builds take 10+ min the
 * first time; the timeout matches the Electron probe budget.
 *
 * Gated by REAL_BOOT_TUI=1 (parallel to REAL_BOOT_SMOKE) OR
 * PROBE=1 (parallel to the MCP/Electron probes).
 */
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const ENTRY = join(REPO_ROOT, "src", "index.tsx");

const ACME =
  process.env.PROBE_ACME ?? join(homedir(), "Documents", "GitHub", "acme-mobile-app");

const ENABLED = process.env.REAL_BOOT_TUI === "1" || process.env.PROBE === "1";

function stripAnsi(input: string): string {
  let out = input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  out = out.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  out = out.replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "");
  out = out.replace(/\x1b[=>NOMcDEHM78]/g, "");
  return out;
}

function resolveBunBinary(): string {
  const home = homedir();
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

function killExistingDaemon(projectRoot: string): void {
  // Pre-flight: stale daemon from a prior run will fight for the
  // socket / Metro port. The Electron probes do the same dance.
  const sock = join(projectRoot, ".rn-dev", "sock");
  const pidFile = join(projectRoot, ".rn-dev", "pid");

  if (existsSync(pidFile)) {
    try {
      const pid = Number(readFileSync(pidFile, "utf-8").trim());
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      }
    } catch { /* malformed pid file — fall through */ }
  }
  for (const f of [sock, pidFile]) {
    try { rmSync(f, { force: true }); } catch { /* nothing to remove */ }
  }
  // Free Metro's default port too (the user's profile pins :8099).
  try {
    execSync("lsof -P -i :8099 -a -t -sTCP:LISTEN | xargs -r kill -9", { stdio: "ignore" });
  } catch { /* nothing on :8099 */ }
}

describe("Real-boot probe — TUI against acme (gated REAL_BOOT_TUI=1 or PROBE=1)", () => {
  it.skipIf(!ENABLED)(
    "spawns the TUI, default profile triggers a real build, build progress lines surface in stdout",
    async () => {
      if (!existsSync(ACME)) {
        throw new Error(
          `acme fixture not found at ${ACME}. Set PROBE_ACME to override or skip this test.`,
        );
      }

      // Capture probe output in a known location for post-mortem.
      const captureDir = join(ACME, ".rn-dev", "probe-real-build-tui");
      mkdirSync(captureDir, { recursive: true });
      const capturePath = join(captureDir, `run-${Date.now()}.log`);

      killExistingDaemon(ACME);

      const proc = Bun.spawn({
        cmd: [BUN, "run", ENTRY, "start"],
        cwd: ACME,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // Force real-boot — opposite of fake-boot. Anything reading
          // RN_DEV_DAEMON_BOOT_MODE in the daemon honours this.
          RN_DEV_DAEMON_BOOT_MODE: "real",
        },
      });

      const decoder = new TextDecoder();
      let accumulated = "";
      const buildMarkers: string[] = [];
      const errorMarkers: string[] = [];

      const startTs = Date.now();
      const deadline = startTs + 20 * 60_000; // 20 min — real xcodebuild + pod install + device install

      const reader = proc.stdout.getReader();
      const stderrReader = proc.stderr.getReader();
      const drain = async (r: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
        for (;;) {
          const result = await Promise.race([
            r.read(),
            new Promise<{ value: undefined; done: false }>((res) =>
              setTimeout(() => res({ value: undefined, done: false }), 250),
            ),
          ]);
          if (result.done) return;
          if (result.value) {
            const chunk = decoder.decode(result.value, { stream: true });
            accumulated += chunk;
            const stripped = stripAnsi(chunk);
            if (
              /Building for ios|run-ios|xcodebuild|info Building|info Installing|info Launching|Successfully installed/i.test(
                stripped,
              )
            ) {
              buildMarkers.push(stripped.replace(/\s+/g, " ").trim().slice(0, 200));
            }
            if (
              /error: |Failed to build|exited with error code|No matching profiles|Code Sign error|Couldn't find any device/i.test(
                stripped,
              )
            ) {
              errorMarkers.push(stripped.replace(/\s+/g, " ").trim().slice(0, 400));
            }
          }
          if (Date.now() >= deadline || buildMarkers.length >= 1) return;
        }
      };

      // Drain both streams in parallel; resolve when either finds a
      // build marker or hits the deadline.
      await Promise.race([
        drain(reader),
        drain(stderrReader),
        new Promise<void>((r) => setTimeout(r, 20 * 60_000)),
      ]);

      // Persist captured output for post-mortem (stripped — easier
      // to read than raw ANSI).
      writeFileSync(capturePath, stripAnsi(accumulated));

      proc.kill();
      await proc.exited;
      // Best-effort daemon cleanup so the next probe run starts fresh.
      killExistingDaemon(ACME);

      const elapsedSec = Math.round((Date.now() - startTs) / 1000);
      console.log(`[real-boot probe] elapsed ${elapsedSec}s, build markers: ${buildMarkers.length}, error markers: ${errorMarkers.length}`);
      console.log(`[real-boot probe] capture saved to ${capturePath}`);

      if (buildMarkers.length === 0) {
        throw new Error(
          `Real-boot TUI probe: no build-progress markers in ${elapsedSec}s.\n` +
          `  Capture: ${capturePath}\n` +
          (errorMarkers.length > 0 ? `  First error: ${errorMarkers[0]}\n` : "") +
          `  Last 1k chars (stripped):\n${stripAnsi(accumulated).slice(-1000)}`,
        );
      }

      expect(buildMarkers.length).toBeGreaterThan(0);
    },
    25 * 60_000, // 25 min hard cap — slightly above the 20 min internal deadline
  );
});
