import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { IpcClient } from "../core/ipc.js";
import { DAEMON_VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Client-side primitive. Later phases wire this into Electron/TUI/MCP so
// that every client path unconditionally ends up with a live daemon to
// talk to. Phase 13.1 ships it additive — nothing in the existing tree
// calls `connectToDaemon` yet.
// ---------------------------------------------------------------------------

export interface ConnectToDaemonOptions {
  /** Max wall-clock to wait for the socket to appear after a cold spawn. */
  spawnTimeoutMs?: number;
  /** Poll cadence for the socket-appearance check. */
  pollMs?: number;
  /**
   * Absolute path to the CLI entry used when the daemon needs to be
   * cold-spawned. Electron's `process.argv[1]` points at the packaged
   * main.js, not the CLI entry, so Electron callers (Phase 13.4) MUST
   * pass this explicitly. Omit for CLI/TUI callers — those resolve
   * correctly from `process.argv[1]`.
   */
  daemonEntry?: string;
}

export async function connectToDaemon(
  worktree: string,
  opts: ConnectToDaemonOptions = {},
): Promise<IpcClient> {
  // 5s was tight even on hot-cache machines — a cold tsx compile on
  // first daemon spawn against a fresh worktree easily takes 8-12s,
  // which surfaced as `connectToDaemon: timed out after 5000ms` against
  // acme on this machine. Bump the default to 30s; the daemon does
  // not get spawned often enough for a wider window to bother anyone,
  // and a 30s budget also covers slower machines (CI, throttled CPUs).
  // The corresponding `connectToDaemonSession` watchdog is independent
  // and progress-based, so this raise doesn't affect attach behaviour
  // post-spawn.
  const { spawnTimeoutMs = 30_000, pollMs = 100, daemonEntry } = opts;

  // Escape hatch for CI/tests and for the MCP-debug workflow where the
  // daemon was started out-of-band. Matches the `RN_DEV_DAEMON_SOCK` hook
  // documented in the spec and already honored by src/cli/module-commands.
  const envSock = process.env.RN_DEV_DAEMON_SOCK;
  if (typeof envSock === "string" && envSock.length > 0) {
    return new IpcClient(envSock);
  }

  const wt = resolve(worktree);
  const sockPath = join(wt, ".rn-dev", "sock");
  const pidPath = join(wt, ".rn-dev", "pid");

  if (await isDaemonAlive(sockPath)) {
    const client = new IpcClient(sockPath);
    // Version handshake — closes the architectural gap where a daemon
    // spawned before an rn-dev-cli upgrade survives the upgrade and
    // serves the old wire shape to fresh clients. Symptom (Bug 1, Phase
    // 13.6 PR-C handoff): client times out 30s waiting for a
    // `session/status: running` event the old daemon never emits in the
    // shape the new client expects. Fix: ping, mismatch → restart.
    if (await daemonVersionMatches(client)) {
      return client;
    }
    process.stderr.write(
      `rn-dev: daemon at ${sockPath} reports an incompatible version, ` +
        `client expects ${DAEMON_VERSION} — restarting daemon.\n`,
    );
    await shutdownStaleDaemon(client, sockPath);
    // Fall through to the cold-spawn path below.
  }

  // Stale artifacts from a crashed daemon or a pid the kernel has since
  // reused can jam `ModuleLockfile.acquire` on next boot — the spec is
  // explicit: unlink BOTH pid and sock on the cold path.
  unlinkStale(sockPath);
  unlinkStale(pidPath);

  spawnDetachedDaemon(wt, daemonEntry);
  await waitForSocket(sockPath, spawnTimeoutMs, pollMs);
  return new IpcClient(sockPath);
}

/**
 * Send `daemon/ping` and check the daemon's reported `daemonVersion`
 * against the client's compiled-in `DAEMON_VERSION`. Any error (timeout,
 * malformed response, missing field) is treated as "incompatible" — the
 * connection cannot be safely used and the only recovery is restart.
 *
 * Exact-match policy (not semver-range): the wire protocol changes in
 * lockstep with the daemon source, and rn-dev-cli does not ship patch
 * releases of the wire. If/when an external release model needs compat
 * windows, replace this with a `semver.satisfies(daemonVersion, range)`
 * check against `HOST_RANGE`.
 */
async function daemonVersionMatches(client: IpcClient): Promise<boolean> {
  try {
    const resp = await client.send({
      type: "command",
      action: "daemon/ping",
      id: `connect-version-check-${Date.now()}`,
    });
    const payload = resp.payload as { daemonVersion?: unknown };
    return (
      typeof payload.daemonVersion === "string" &&
      payload.daemonVersion === DAEMON_VERSION
    );
  } catch {
    return false;
  }
}

/**
 * Graceful-shutdown of a stale daemon followed by a wait for its socket
 * file to disappear (the real daemon's SIGTERM handler unlinks the sock
 * inside `shutdown()`; a fake/old daemon may not, in which case the
 * caller's downstream `unlinkStale` cleans up).
 *
 * `daemon/shutdown` is best-effort: a daemon old enough to lack the
 * handler will reject with `E_UNKNOWN_ACTION`, and a daemon that has
 * already crashed will reject with a connect error. In both cases we
 * still proceed — the socket is either gone or about to be unlinked by
 * the cold-spawn path.
 */
async function shutdownStaleDaemon(
  client: IpcClient,
  sockPath: string,
): Promise<void> {
  try {
    await client.send({
      type: "command",
      action: "daemon/shutdown",
      id: `connect-version-shutdown-${Date.now()}`,
    });
  } catch {
    // Daemon may not implement daemon/shutdown, may already be dead, or
    // may have closed the socket mid-ack — either way the recovery path
    // is the same: wait briefly for the sock to disappear, then let the
    // cold-spawn fallback unlink stale artifacts.
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!existsSync(sockPath)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Don't throw — the caller's `unlinkStale(sockPath)` + cold-spawn path
  // can still recover. A daemon hung past the 5s grace will get its
  // sock file unlinked from underneath, which is enough for `bind()` to
  // succeed on the new daemon. The hung process eventually dies on its
  // own (orphan-sweep, system reboot, etc.).
}

export async function isDaemonAlive(sockPath: string): Promise<boolean> {
  if (!existsSync(sockPath)) return false;
  // A stale socket file on disk (owner crashed without cleanup) will
  // answer `connect()` with ECONNREFUSED. `isServerRunning` captures
  // that via its error handler and returns false, so we don't also
  // need to peek the pid file here — fewer syscalls, no redundant
  // liveness check.
  const client = new IpcClient(sockPath);
  return client.isServerRunning();
}

export function unlinkStale(path: string): void {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // best-effort — the daemon will overwrite on bind
  }
}

/**
 * Fork a detached daemon subprocess and return its pid. Used by both
 * `connectToDaemon` (client side — we need a daemon to talk to) and
 * `runDaemon` when invoked without `--foreground` (daemon side —
 * detach from the parent shell).
 *
 * Validates daemonEntry + worktree up front so both call sites share
 * the same error discipline — previously `runDaemon::detachAndExit`
 * duplicated these checks with slightly different phrasing (deferred
 * Simplicity #2 from Phase 13.2; collapsed in PR #17).
 */
export function spawnDetachedDaemon(
  worktree: string,
  daemonEntry?: string,
): ChildProcess {
  const entry = daemonEntry ?? process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(
      "spawnDetachedDaemon: cannot locate CLI entry (pass daemonEntry option or ensure process.argv[1] is set)",
    );
  }
  if (!existsSync(entry)) {
    throw new Error(
      `spawnDetachedDaemon: CLI entry ${entry} does not exist on disk`,
    );
  }
  try {
    const wtStat = statSync(worktree);
    if (!wtStat.isDirectory()) {
      throw new Error(
        `spawnDetachedDaemon: worktree ${worktree} is not a directory`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("spawnDetachedDaemon:")) {
      throw err;
    }
    throw new Error(
      `spawnDetachedDaemon: worktree ${worktree} does not exist`,
    );
  }

  // process.execPath under Electron is the Electron binary — spawning
  // it with our CLI entry would launch a second Electron app, not a
  // Node process. The daemon entry is either a .tsx (dev: needs bun
  // or a Node + tsx loader) or compiled .js (runs under any Node-
  // compatible runtime). Pick the right interpreter:
  //   - .tsx + RN_DEV_DAEMON_INTERPRETER set → use that (CI override)
  //   - .tsx → bun (every dev path the project supports)
  //   - .js → process.execPath when it looks like node, else node
  const interpreter = pickDaemonInterpreter(entry);

  // Capture daemon stdout + stderr to ~/.rn-dev/logs/daemon-<wt>-<ts>.log.
  // Pre-fix: stdio: "ignore" discarded both, leaving a crashed daemon
  // impossible to diagnose — the only signal upstream got was the
  // socket dying (e.g. the renderer's "Daemon disconnected (metro):
  // unknown" surfaces from supervisor.ts:253). With this redirect, a
  // crash leaves a stack trace on disk that matches the daemon's
  // wall-clock spawn time. One log file per spawn (no rotation
  // needed yet); compaction can land later if volume becomes a
  // concern.
  const logsDir = join(homedir(), ".rn-dev", "logs");
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(logsDir, `daemon-${basename(worktree)}-${ts}.log`);
  const logFd = openSync(logPath, "a");

  // Electron launched outside a shell context (Finder, dock, packaged
  // app, even Playwright on some CI runners) inherits a barebones PATH
  // that doesn't include `~/.bun/bin`, `/opt/homebrew/bin`, or the
  // user's nodenv/nvm shims. The result is `Error: spawn bun ENOENT`
  // — the daemon never starts, the renderer hangs on
  // `connectToDaemon: timed out` until the watchdog fires. Resolve
  // the interpreter to an absolute path BEFORE spawning so PATH gaps
  // can't kill us.
  const interpreterAbsPath = resolveInterpreterAbsolute(interpreter);
  const child = spawn(
    interpreterAbsPath,
    interpreter === "bun"
      ? ["run", entry, "daemon", worktree, "--foreground"]
      : [entry, "daemon", worktree, "--foreground"],
    {
      detached: true,
      // stdin: ignore (daemon doesn't read stdin); stdout + stderr
      // share the same log fd so write order matches what a terminal
      // would have shown.
      stdio: ["ignore", logFd, logFd],
      cwd: worktree,
      // Augment PATH with the typical user-shell locations so anything
      // the daemon itself spawns (pnpm, pod, xcodebuild, watchman) can
      // also find its tools regardless of how Electron was launched.
      env: { ...process.env, PATH: augmentedPath() },
    },
  );
  // The OS keeps the FD open in the spawned child; the parent's
  // reference is now superfluous and would prevent process tear-down
  // from releasing the file handle promptly.
  closeSync(logFd);
  child.unref();
  return child;
}

function pickDaemonInterpreter(entry: string): string {
  const override = process.env.RN_DEV_DAEMON_INTERPRETER;
  if (override) return override;
  if (entry.endsWith(".tsx") || entry.endsWith(".ts")) return "bun";
  // Compiled .js — process.execPath works UNLESS the parent is
  // Electron (where execPath is the Electron binary). Detect Electron
  // by sniffing for the electron-specific globals injected at boot.
  const isElectron =
    typeof process.versions === "object" &&
    "electron" in (process.versions as Record<string, unknown>);
  if (isElectron) return "node";
  return process.execPath;
}

/**
 * The list of directories any user-installed dev tool tends to live
 * in. Order matters — first hit wins so /opt/homebrew shadows the
 * less-common /usr/local on Apple Silicon, and ~/.bun/bin shadows
 * homebrew's `bun` (which is sometimes outdated).
 */
function userShellPathExtras(): string[] {
  const home = homedir();
  return [
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".nodenv", "shims"),
    join(home, ".nvm", "versions", "node", "current", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

function augmentedPath(): string {
  const extras = userShellPathExtras().filter((p) => existsSync(p));
  const current = process.env.PATH ?? "";
  // De-dup but preserve order: extras first (so they shadow anything
  // Electron's anaemic PATH might have brought), then the inherited
  // PATH for anything we didn't explicitly enumerate.
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...extras, ...current.split(":")]) {
    if (!dir) continue;
    if (seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(":");
}

/**
 * Resolve the interpreter's absolute path so `spawn()` doesn't have
 * to depend on the inherited PATH or per-cwd version-manager state.
 *
 * Pre-fix this only checked the shim dirs (e.g. `~/.nodenv/shims/`),
 * which routes through the version manager AT RUNTIME using
 * `.node-version` lookup from the spawned cwd. That bit us hard:
 * acme's `.node-version` is 24.10.0, bun is installed for 20.18.0 +
 * 22.17.0 only, and the daemon spawn cwd is acme — so the shim
 * resolved 24.10.0 and emitted `nodenv: bun: command not found` to
 * the daemon log file (then the renderer hung on
 * `connectToDaemon: timed out`).
 *
 * Fix: prefer the actual VERSION-SPECIFIC binary path
 * (`~/.nodenv/versions/<v>/bin/<name>`) over the shim. We pick the
 * highest-version dir that has the binary so a user with multiple
 * Node versions installed gets a current toolchain.
 *
 * Order of preference:
 *   1. Absolute path passed in (override / execPath).
 *   2. Version-specific paths under `~/.nodenv/versions/<v>/bin/`,
 *      `~/.nvm/versions/node/<v>/bin/`, `~/.fnm/node-versions/<v>/bin/`.
 *      Highest semver wins.
 *   3. The static well-known dirs from `userShellPathExtras()` —
 *      `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, etc.
 *   4. Bare name — final fallback so spawn's ENOENT surfaces
 *      diagnostically (and against our augmented env.PATH which is
 *      better than the inherited Electron one).
 */
function resolveInterpreterAbsolute(name: string): string {
  // If the caller passed an absolute path (RN_DEV_DAEMON_INTERPRETER
  // override, or process.execPath as fallback), use it verbatim.
  if (name.startsWith("/")) return name;
  // Standard node binary in a Node-running parent — use its execPath.
  if (name === "node") {
    const exe = process.execPath;
    // Electron's execPath is the electron binary; reject and fall
    // through to PATH search.
    const isElectron =
      typeof process.versions === "object" &&
      "electron" in (process.versions as Record<string, unknown>);
    if (!isElectron && exe.endsWith("/node")) return exe;
  }
  // 1) Version-specific binaries (skip the shim — see comment above).
  const versioned = findVersionedBinary(name);
  if (versioned) return versioned;
  // 2) Static well-known dirs (note: `userShellPathExtras` includes
  //    the nodenv SHIMS path; we still want it as a last resort
  //    because the user may have a single-version setup where the
  //    shim resolves fine).
  const candidates = userShellPathExtras().map((dir) => join(dir, name));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // 3) Final fallback — let spawn fail with ENOENT against the
  //    augmented env.PATH so the error message is at least diagnostic.
  return name;
}

/**
 * Walk the per-version dirs of common Node version managers and
 * return the path to `<name>` from the highest version that has it.
 * Returns null if no version has the binary.
 */
function findVersionedBinary(name: string): string | null {
  const home = homedir();
  const versionsRoots: Array<{ root: string; binSubpath: string[] }> = [
    { root: join(home, ".nodenv", "versions"), binSubpath: ["bin"] },
    { root: join(home, ".nvm", "versions", "node"), binSubpath: ["bin"] },
    { root: join(home, ".fnm", "node-versions"), binSubpath: ["installation", "bin"] },
  ];
  let bestPath: string | null = null;
  let bestVer: number[] | null = null;
  for (const { root, binSubpath } of versionsRoots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      // Use require here to avoid the dynamic-import dance — this is a
      // sync helper called from spawn().
      entries = (require("node:fs") as typeof import("node:fs"))
        .readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(root, entry, ...binSubpath, name);
      if (!existsSync(candidate)) continue;
      const parts = entry.replace(/^v/, "").split(".").map((s) => Number(s));
      if (parts.some((p) => Number.isNaN(p))) continue;
      if (!bestVer || compareSemver(parts, bestVer) > 0) {
        bestVer = parts;
        bestPath = candidate;
      }
    }
  }
  return bestPath;
}

function compareSemver(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export async function waitForSocket(
  sockPath: string,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sockPath)) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `connectToDaemon: timed out after ${timeoutMs}ms waiting for ${sockPath}`,
  );
}
