import { EventEmitter } from "node:events";
import * as http from "node:http";
import path from "path";
import fs from "fs";
import * as net from "net";
import { spawn, execFile } from "child_process";
import type { ArtifactStore } from "./artifact.js";
import type { MetroInstance } from "./types.js";

/**
 * Resolve react-native binary: prefer local .bin, fall back to npx.
 * Returns [command, ...prefixArgs] to spread before the actual args.
 */
function resolveRnBin(projectRoot: string): [string, ...string[]] {
  const localBin = path.join(projectRoot, "node_modules", ".bin", "react-native");
  if (fs.existsSync(localBin)) {
    return [localBin];
  }
  // Fallback to npx
  return ["npx", "react-native"];
}

/**
 * Markers that indicate Metro has finished its startup phase and is ready
 * to serve bundles. The list grows over time as RN versions ship new
 * wording — RN 0.83 prints "Starting dev server on http://localhost:PORT"
 * which the pre-2026-05-06 list missed, leaving `instance.status` stuck
 * in "starting" forever and silently no-oping every code path that
 * gates on "running" (`reload()`, `devMenu()`, MCP `metro/reload`,
 * Electron's auto-build trigger). User-reported under quick mode as
 * "I can't reload — connection to Metro fails."
 *
 * Exported for unit testing — keep this in sync with whatever Metro
 * actually emits as its first ready-to-serve line.
 */
export const METRO_STARTUP_BANNERS = [
  "Metro waiting on",
  "Metro is running",
  "Welcome to Metro",
  "Dev server ready",
  // RN 0.83+ — surfaced in 2026-05-06 user report.
  "Starting dev server on",
] as const;

/** Predicate form. Pure — exported for unit testing. */
export function isMetroStartupBanner(line: string): boolean {
  return METRO_STARTUP_BANNERS.some((marker) => line.includes(marker));
}

// ---------------------------------------------------------------------------
// MetroManager
// ---------------------------------------------------------------------------

/**
 * Manages multiple Metro bundler instances, one per worktree.
 *
 * Emits:
 *   'log'    — { worktreeKey, line, stream: 'stdout' | 'stderr' }
 *   'status' — { worktreeKey, status, error?: string }
 */
export class MetroManager extends EventEmitter {
  private instances: Map<string, MetroInstance> = new Map();

  constructor(
    private artifacts: ArtifactStore,
    private portRange: [number, number] = [8081, 8099]
  ) {
    super();
  }

  /** Read-only view of the configured port range, for callers that need to
   *  search for a free port within the same window (e.g. boot fallback). */
  get portRangeReadable(): readonly [number, number] {
    return this.portRange;
  }

  // -------------------------------------------------------------------------
  // Port management
  // -------------------------------------------------------------------------

  /**
   * Allocate a port for the given worktree key.
   *
   * Strategy:
   *   1. Check artifact for a persisted port — reuse it if found.
   *   2. Otherwise find the first port in portRange not used by a running instance.
   *   3. Persist the chosen port in the artifact.
   *
   * Throws if no ports are available in the configured range.
   */
  allocatePort(worktreeKey: string): number {
    const artifact = this.artifacts.load(worktreeKey);

    if (artifact?.metroPort != null) {
      return artifact.metroPort;
    }

    const [min, max] = this.portRange;
    const usedPorts = new Set<number>();
    for (const instance of this.instances.values()) {
      usedPorts.add(instance.port);
    }

    for (let port = min; port <= max; port++) {
      if (!usedPorts.has(port)) {
        this.artifacts.save(worktreeKey, { metroPort: port });
        return port;
      }
    }

    throw new Error(
      `No ports available in range [${min}, ${max}]. All ports are in use.`
    );
  }

  /**
   * Returns true if the given port is not currently bound on this machine.
   * Uses a temporary TCP server to probe — if it listens successfully, the
   * port is free.
   */
  isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once("error", () => {
        resolve(false);
      });

      server.listen(port, () => {
        server.close(() => {
          resolve(true);
        });
      });
    });
  }

  /**
   * Find the PID of the process *listening* on `port`.
   *
   * `-sTCP:LISTEN` is critical: without it, lsof also reports any process
   * that has an outbound TCP connection *to* that port. That bites
   * `isMetroOnPort`'s caller — the http.get probe leaves a brief socket
   * connecting to the listener, and a follow-up `findProcessOnPort` would
   * pick up our own PID instead of the actual listener. Filtering to
   * LISTEN-state sockets keeps the result unambiguous.
   *
   * Returns null if no process is found or lsof is unavailable.
   */
  findProcessOnPort(port: number): Promise<number | null> {
    return new Promise((resolve) => {
      try {
        // `-a` ANDs the selectors (lsof OR's by default). `-iTCP:PORT`
        // matches TCP sockets on the port and `-sTCP:LISTEN` filters to
        // listening state. Without LISTEN, this also returns ephemeral
        // outbound connections to the port (e.g. our own `isMetroOnPort`
        // probe), and `parseInt` on the first PID picks the wrong one.
        execFile(
          "lsof",
          ["-a", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
          (err, stdout) => {
            if (err) {
              resolve(null);
              return;
            }
            const pid = parseInt(
              stdout.split("\n").find((l) => l.trim())?.trim() ?? "",
              10,
            );
            resolve(isNaN(pid) ? null : pid);
          },
        );
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Read a process's current working directory via `lsof -p <pid> -d cwd -Fn`.
   * Returns null if lsof fails or the process has no readable cwd.
   *
   * Used by the boot flow to decide whether the Metro on a busy port
   * belongs to *this* worktree (same cwd → kill+respawn) or to a
   * neighbouring branch/worktree (different cwd → pick a different port,
   * leave their Metro alone).
   *
   * macOS/Linux only — falls back to null on Windows where lsof is absent;
   * callers should treat null as "could not verify ownership" and bias
   * conservative (don't kill).
   */
  getProcessCwd(pid: number): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        // `-a` is critical: lsof ORs selection options by default, so
        // `lsof -p PID -d cwd` actually returns every process's cwd. The
        // `-a` flag ANDs the selectors so we only get pid PID's cwd entry.
        // `-Fn` makes parsing trivial (a `n<path>` line per match).
        execFile(
          "lsof",
          ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
          (err, stdout) => {
            if (err) {
              resolve(null);
              return;
            }
            const nLine = stdout
              .split("\n")
              .find((line) => line.startsWith("n"));
            resolve(nLine ? nLine.slice(1) : null);
          },
        );
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Find the first port in `[min, max]` that is both free on this host AND
   * not tracked by another instance in this manager. Throws if no port in
   * the range is available.
   *
   * Differs from `allocatePort` in that it *probes the actual socket* per
   * port rather than just consulting `this.instances`. Used when the
   * profile's preferred port is held by a different worktree's Metro and
   * we need to fall back to a free one.
   */
  async findFreePortInRange(min: number, max: number): Promise<number> {
    const tracked = new Set<number>();
    for (const inst of this.instances.values()) tracked.add(inst.port);
    for (let port = min; port <= max; port++) {
      if (tracked.has(port)) continue;
      if (await this.isPortFree(port)) return port;
    }
    throw new Error(
      `No ports available in range [${min}, ${max}]. All ports are busy or tracked.`,
    );
  }

  /**
   * Kill the process on `port` with the given signal (default SIGTERM).
   * Returns true if a process was found and signalled, false otherwise.
   *
   * Does NOT wait for the process to exit or for the socket to release —
   * SIGTERM lets React Native CLI's graceful shutdown run, which can take
   * 2–5 seconds. Callers must follow up with `waitForPortFree` rather than
   * a fixed sleep, otherwise a fresh `metro.start` races the still-bound
   * socket and Metro's `earlyPortCheck` throws EADDRINUSE.
   */
  async killProcessOnPort(
    port: number,
    signal: NodeJS.Signals = "SIGTERM",
  ): Promise<boolean> {
    const pid = await this.findProcessOnPort(port);
    if (pid == null) {
      return false;
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Poll `isPortFree(port)` every `pollIntervalMs` until it returns true or
   * `timeoutMs` elapses. Returns the final probe result.
   *
   * Required after `killProcessOnPort` because SIGTERM's effect is async:
   * the signal is delivered immediately, but RN CLI's shutdown handler
   * keeps the socket bound while it flushes log streams and closes
   * WebSocket clients (typically 2–5s). Sleeping a fixed duration races
   * that grace; polling matches the actual port state.
   */
  async waitForPortFree(
    port: number,
    timeoutMs = 5000,
    pollIntervalMs = 100,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isPortFree(port)) return true;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return this.isPortFree(port);
  }

  /**
   * Probe whether a healthy Metro is serving on `port` by hitting `/status`.
   * Metro answers with the literal text `packager-status:running` — a
   * long-standing Metro idiom used by `react-native-cli` and Expo's CLI for
   * the same purpose.
   *
   * Used by the boot flow to distinguish "the user's existing Metro that we
   * should kill+respawn" from "some unrelated process on this port that we
   * must NOT kill" (Jenkins, a coworker's service, anything). Times out at
   * 3s — Metro answers /status synchronously off its main loop, so longer
   * waits only stall on dead sockets.
   */
  isMetroOnPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/status", timeout: 3000 },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            resolve(body.includes("packager-status:running"));
          });
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Instance lifecycle
  // -------------------------------------------------------------------------

  /**
   * Spawn a Metro bundler for the given worktree.
   *
   * Runs `npx react-native start --port PORT` as a detached child process so
   * Metro continues running even if the TUI exits.
   *
   * Log lines from stdout/stderr are emitted as 'log' events so the TUI can
   * subscribe without MetroManager needing to buffer them.
   */
  start(options: {
    worktreeKey: string;
    projectRoot: string;
    port?: number;
    resetCache?: boolean;
    verbose?: boolean;
    env?: Record<string, string>;
  }): MetroInstance {
    const {
      worktreeKey,
      projectRoot,
      port: explicitPort,
      resetCache = false,
      verbose = false,
      env,
    } = options;

    const port = explicitPort ?? this.allocatePort(worktreeKey);

    const args = ["start", "--port", String(port)];
    if (resetCache) {
      args.push("--reset-cache");
    }
    if (verbose) {
      args.push("--verbose");
    }

    // Use Node's child_process.spawn for compatibility with both Bun and Node/Electron
    const [cmd, ...cmdPrefix] = resolveRnBin(projectRoot);
    const proc = spawn(cmd, [...cmdPrefix, ...args], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...env,
      },
    });

    const instance: MetroInstance = {
      worktree: worktreeKey,
      port,
      pid: proc.pid ?? 0,
      status: "starting",
      startedAt: new Date(),
      projectRoot,
    };

    this.instances.set(worktreeKey, instance);

    // Read a Node stream line by line — non-blocking
    const attachStream = (stream: NodeJS.ReadableStream | null, streamName: "stdout" | "stderr") => {
      if (!stream) return;
      let buffer = "";
      stream.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            if (
              streamName === "stdout" &&
              isMetroStartupBanner(line) &&
              instance.status === "starting"
            ) {
              instance.status = "running";
              this.emit("status", { worktreeKey, status: "running" });
            }
            this.emit("log", { worktreeKey, line, stream: streamName });
          }
        }
      });
    };

    attachStream(proc.stdout, "stdout");
    attachStream(proc.stderr, "stderr");

    // HTTP fallback — if a future RN version drops/renames every
    // recognized stdout banner, the stdout-pattern check would silently
    // leave status in `starting`. Probe Metro's `/status` endpoint
    // every 1s; the first 200 OK flips status to running. Capped at
    // 60 attempts (≈60s) so a stuck startup doesn't poll forever.
    // Idempotent — once `instance.status === "running"`, the probe
    // is a cheap no-op until cleared by the polling guard.
    let probeAttempts = 0;
    const startupProbe = setInterval(() => {
      probeAttempts++;
      const current = this.instances.get(worktreeKey);
      if (!current || current.status !== "starting" || probeAttempts > 60) {
        clearInterval(startupProbe);
        return;
      }
      try {
        const http = require("http") as typeof import("http");
        const req = http.request(
          { hostname: "localhost", port, path: "/status", method: "GET", timeout: 800 },
          (res) => {
            if (res.statusCode === 200 && instance.status === "starting") {
              instance.status = "running";
              this.emit("status", { worktreeKey, status: "running" });
              clearInterval(startupProbe);
            }
            res.resume();
          },
        );
        req.on("error", () => undefined);
        req.on("timeout", () => req.destroy());
        req.end();
      } catch {
        // best-effort — if http isn't available, the stdout marker path is the only signal.
      }
    }, 1_000);
    proc.on("exit", () => clearInterval(startupProbe));

    // Handle process exit
    proc.on("exit", (code) => {
      const current = this.instances.get(worktreeKey);
      if (current) {
        const exitCode = code ?? 1;
        const newStatus = exitCode === 0 ? "stopped" : "error";
        current.status = newStatus;
        const payload: { worktreeKey: string; status: string; error?: string } =
          { worktreeKey, status: newStatus };
        if (exitCode !== 0) {
          payload.error = `Metro exited with code ${exitCode}`;
        }
        this.emit("status", payload);
      }
    });

    return instance;
  }

  /**
   * Stop the Metro instance for `worktreeKey` by sending SIGTERM.
   * Returns true if an instance was found and signalled, false otherwise.
   */
  stop(worktreeKey: string): boolean {
    const instance = this.instances.get(worktreeKey);
    if (!instance) {
      return false;
    }

    try {
      // Kill entire process tree
      process.kill(-instance.pid, "SIGKILL");
    } catch {
      try {
        process.kill(instance.pid, "SIGKILL");
      } catch {
        // Process may have already exited
      }
    }

    instance.status = "stopped";
    this.instances.delete(worktreeKey);
    this.emit("status", { worktreeKey, status: "stopped" });
    return true;
  }

  /** Stop all running Metro instances. */
  stopAll(): void {
    for (const key of [...this.instances.keys()]) {
      this.stop(key);
    }
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  getInstance(worktreeKey: string): MetroInstance | null {
    return this.instances.get(worktreeKey) ?? null;
  }

  getAll(): MetroInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Send a reload signal to the Metro instance's connected device.
   * Uses the Metro dev server's /reload endpoint.
   */
  reload(worktreeKey: string): boolean {
    const instance = this.instances.get(worktreeKey);
    if (!instance || instance.status !== "running") return false;
    try {
      const http = require("http") as typeof import("http");
      const req = http.request(
        { hostname: "localhost", port: instance.port, path: "/reload", method: "POST" },
        () => {}
      );
      req.on("error", () => {});
      req.end();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Open dev menu on the connected device.
   * Uses the Metro dev server's /open-debugger endpoint.
   */
  devMenu(worktreeKey: string): boolean {
    const instance = this.instances.get(worktreeKey);
    if (!instance || instance.status !== "running") return false;
    try {
      const http = require("http") as typeof import("http");
      const req = http.request(
        { hostname: "localhost", port: instance.port, path: "/open-debugger", method: "POST" },
        () => {}
      );
      req.on("error", () => {});
      req.end();
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Build requirement detection
  // -------------------------------------------------------------------------

  /**
   * Returns true if the native app needs to be rebuilt because the Metro port
   * has changed since the last build.
   *
   * A rebuild is needed when:
   *   - No artifact exists for the worktree, OR
   *   - The artifact has no `lastBuildPort`, OR
   *   - `lastBuildPort` differs from `currentPort`.
   */
  needsRebuild(worktreeKey: string, currentPort: number): boolean {
    const artifact = this.artifacts.load(worktreeKey);
    if (!artifact || artifact.lastBuildPort == null) {
      return true;
    }
    return artifact.lastBuildPort !== currentPort;
  }
}
