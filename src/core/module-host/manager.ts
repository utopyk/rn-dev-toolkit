import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import type { RegisteredModule } from "../../modules/registry.js";
import { ModuleConfigStore } from "../../modules/config-store.js";
import { buildSpawnCommand, wrapChild, type SpawnHandle } from "../spawn-utils.js";
import { CapabilityRegistry } from "./capabilities.js";
import { attachHostRpc } from "./host-rpc.js";
import { ModuleInstance, type ModuleInstanceState } from "./instance.js";
import { ModuleLockfile } from "./lockfile.js";
import {
  ActivationTimeoutError,
  ModuleRpc,
  performInitialize,
  type InitializeResult,
} from "./rpc.js";
import { Supervisor } from "./supervisor.js";

// Re-exported so existing callers keep importing `SpawnHandle` from this
// module — the canonical declaration now lives in `../spawn-utils.ts`.
export type { SpawnHandle };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModuleSpawner {
  spawn(manifest: RegisteredModule["manifest"], modulePath: string): SpawnHandle;
}

export interface ModuleHostManagerOptions {
  /** Host version passed to each module's `initialize`. */
  hostVersion: string;
  /** Default capability registry bound into every module context. */
  capabilities?: CapabilityRegistry;
  /** Test-injectable process spawner. Defaults to NodeSpawner. */
  spawner?: ModuleSpawner;
  /** Per-module handshake timeout. Default 3000ms (Phase 3 cold-start SLO). */
  initializeTimeoutMs?: number;
  /**
   * Idle-shutdown delay for `global`-scope modules after last release. Only
   * `global` scope refcounts; `per-worktree` / `workspace` modules stop
   * immediately on explicit shutdown.
   */
  idleShutdownMs?: number;
  /**
   * Per-module persistent config store. Defaults to a fresh
   * `ModuleConfigStore()` pointing at `~/.rn-dev/modules/`. Tests inject
   * their own store to isolate filesystem state.
   */
  configStore?: ModuleConfigStore;
}

export interface ManagedModule {
  instance: ModuleInstance;
  manifest: RegisteredModule["manifest"];
  rpc: ModuleRpc;
  pid: number;
  initialize: InitializeResult;
}

// ---------------------------------------------------------------------------
// Default spawner — detached Node subprocess, process-group kill on POSIX.
// ---------------------------------------------------------------------------

export class NodeSpawner implements ModuleSpawner {
  spawn(
    _manifest: RegisteredModule["manifest"],
    modulePath: string,
  ): SpawnHandle {
    // Resolve modulePath (a directory) to its entry script via
    // package.json#main. Without this Node still finds and runs the
    // entry, but `process.argv[1]` carries the directory path — which
    // breaks the conventional `import.meta.url === pathToFileURL(argv[1])`
    // entry check that modules use to gate `runModule()`. Symptom of
    // the bug: subprocess starts, opens stdio, never responds to
    // `initialize`, MODULE_ACTIVATION_TIMEOUT after 3s. Resolving
    // here means argv[1] always matches the file `import.meta.url`
    // points at.
    const entry = resolveModuleEntry(modulePath);
    const { command, args } = buildSpawnCommand({
      command: "node",
      args: [entry],
    });
    // cwd is the module's package root (where node_modules + dist
    // live). Production passes a directory as modulePath; some tests
    // (manager.integration.test.ts) pass the entry script directly.
    // Resolve `cwd` from whichever shape we got — directory ↦ itself,
    // file ↦ its dirname. spawn() throws ENOTDIR when cwd points at
    // a non-directory, so feeding it a file would break the
    // production case for fixtures.
    const cwdDir = isDirectory(modulePath) ? modulePath : dirnameOf(modulePath);
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwdDir,
      // POSIX: start a new process group so we can kill the whole group and
      // reap stray grandchildren spawned by the module.
      // Windows: detached creates a new process group too, but we don't rely
      // on -pid kill there — v1 is POSIX-only.
      detached: process.platform !== "win32",
    });
    return wrapChild(child);
  }
}

function isDirectory(p: string): boolean {
  try {
    return require("node:fs").statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function dirnameOf(p: string): string {
  return require("node:path").dirname(p);
}

/**
 * Resolve the module subprocess entry from `<modulePath>/package.json#main`.
 * Falls back to `dist/index.js` (the convention every shipped module
 * follows) when package.json is missing or unreadable — keeps the
 * spawner working for modules that ship pre-built tarballs without a
 * full package.json.
 */
function resolveModuleEntry(modulePath: string): string {
  // If modulePath is a file (e.g. test fixtures pass the entry script
  // directly), use it as-is. Production passes a directory containing
  // package.json + dist/.
  let entry: string;
  if (!isDirectory(modulePath)) {
    entry = modulePath;
  } else {
    const fallback = join(modulePath, "dist", "index.js");
    try {
      const pkgPath = join(modulePath, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { main?: string };
      entry =
        typeof pkg.main === "string" && pkg.main.length > 0
          ? pathResolve(modulePath, pkg.main)
          : fallback;
    } catch {
      entry = fallback;
    }
  }

  // Realpath the entry so the spawn-time `argv[1]` matches the
  // `import.meta.url` Node sets after symlink resolution. Without this,
  // dev installs that symlink ~/.rn-dev/modules/<id> → workspace path
  // (or any setup with /private/var, ~/Library, iCloud Drive symlinks)
  // hit the entry-detection bug where the module's own
  // `import.meta.url === pathToFileURL(process.argv[1]).href` check
  // fails — argv[1] is the symlink, import.meta.url is the realpath —
  // so `runModule()` never runs and host-call times out with
  // MODULE_ACTIVATION_TIMEOUT after 3s. realpathSync.native throws on
  // missing entries; fall back so the existing path still surfaces a
  // useful error downstream.
  try {
    return realpathSync.native(entry);
  } catch {
    return entry;
  }
}

// ---------------------------------------------------------------------------
// ModuleHostManager
// ---------------------------------------------------------------------------

interface InternalEntry {
  managed: ManagedModule;
  child: SpawnHandle;
  supervisor: Supervisor;
  lockfile: ModuleLockfile | null;
  consumers: Set<string>;
  idleTimer: NodeJS.Timeout | null;
  /** Resolved module path from the RegisteredModule. */
  modulePath: string;
  /** Full RegisteredModule snapshot — used for respawn. */
  registered: RegisteredModule;
}

/**
 * Per-daemon manager of module subprocesses. Owns the (id, scopeUnit) ->
 * live-subprocess map, refcounts `global`-scope consumers, wires the
 * Supervisor for crash-loop detection, and installs shutdown hooks so
 * module children die with the daemon.
 *
 * Events:
 *   'state-changed' { moduleId, scopeUnit, from, to }
 *   'crashed'       { moduleId, scopeUnit, reason }
 *   'failed'        { moduleId, scopeUnit, reason }
 *   'log'           { moduleId, scopeUnit, level, message }
 */
export class ModuleHostManager extends EventEmitter {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly spawner: ModuleSpawner;
  /**
   * Shared capability registry. Exposed so Electron main-process IPC
   * handlers (e.g. `modules:host-call` from module panel preloads) can
   * resolve against the same registry the subprocesses see via `host/call`
   * RPC — single source of truth for permission gating.
   */
  public readonly capabilities: CapabilityRegistry;
  /**
   * Per-module config store. `public readonly` so `registerModulesIpc` and
   * the Electron IPC layer resolve against the same on-disk state —
   * matches the Phase 4 `capabilities` single-source-of-truth pattern.
   */
  public readonly configStore: ModuleConfigStore;
  private readonly hostVersion: string;
  private readonly initializeTimeoutMs: number;
  private readonly idleShutdownMs: number;
  private shuttingDown = false;

  // Retained so shutdownAll() can de-register them.
  private readonly processExitHandler = () => {
    void this.shutdownAll();
  };
  private readonly processSignalHandler = (signal: NodeJS.Signals) => {
    void this.shutdownAll().finally(() => {
      // Re-emit the signal so Node's default handler runs.
      process.kill(process.pid, signal);
    });
  };

  constructor(options: ModuleHostManagerOptions) {
    super();
    this.spawner = options.spawner ?? new NodeSpawner();
    this.capabilities = options.capabilities ?? new CapabilityRegistry();
    this.configStore = options.configStore ?? new ModuleConfigStore();
    this.hostVersion = options.hostVersion;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 3000;
    this.idleShutdownMs = options.idleShutdownMs ?? 60_000;

    process.on("exit", this.processExitHandler);
    process.on("SIGINT", this.processSignalHandler);
    process.on("SIGTERM", this.processSignalHandler);
  }

  /**
   * Spawn (or reuse) the subprocess backing `registered` and track this
   * consumer in the refcount set. Returns the managed handle once the
   * module is in `active` state.
   */
  async acquire(
    registered: RegisteredModule,
    consumerId: string,
  ): Promise<ManagedModule> {
    if (registered.kind === "built-in-privileged") {
      throw new Error(
        `E_BUILT_IN_NOT_SPAWNABLE: module "${registered.manifest.id}" is a built-in-privileged module — it runs in-process and cannot be spawned via ModuleHostManager.acquire().`,
      );
    }
    const key = ModuleHostManager.keyFor(registered);
    const existing = this.entries.get(key);
    if (existing) {
      existing.consumers.add(consumerId);
      this.cancelIdleTimer(existing);
      return existing.managed;
    }

    const entry = await this.spawnEntry(registered);
    entry.consumers.add(consumerId);
    this.entries.set(key, entry);
    return entry.managed;
  }

  async release(
    moduleId: string,
    scopeUnit: string,
    consumerId: string,
  ): Promise<void> {
    const key = `${moduleId}:${scopeUnit}`;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.consumers.delete(consumerId);

    if (entry.consumers.size === 0) {
      if (entry.registered.manifest.scope === "global") {
        this.scheduleIdleShutdown(entry);
      } else {
        await this.stopEntry(entry);
      }
    }
  }

  async shutdown(moduleId: string, scopeUnit: string): Promise<void> {
    const key = `${moduleId}:${scopeUnit}`;
    const entry = this.entries.get(key);
    if (!entry) return;
    await this.stopEntry(entry);
  }

  async shutdownAll(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const entries = [...this.entries.values()];
    await Promise.all(entries.map((e) => this.stopEntry(e)));
    process.off("exit", this.processExitHandler);
    process.off("SIGINT", this.processSignalHandler);
    process.off("SIGTERM", this.processSignalHandler);
  }

  get size(): number {
    return this.entries.size;
  }

  stateOf(
    moduleId: string,
    scopeUnit: string,
  ): ModuleInstanceState | null {
    return this.entries.get(`${moduleId}:${scopeUnit}`)?.managed.instance
      .state ?? null;
  }

  /**
   * Read-only snapshot of a live managed module — state, pid, last-crash
   * reason. Returns `null` when the (id, scope) pair is not currently
   * managed. Used by IPC handlers that report to MCP / Electron consumers.
   */
  inspect(
    moduleId: string,
    scopeUnit: string,
  ): {
    state: ModuleInstanceState;
    pid: number;
    lastCrashReason: string | null;
  } | null {
    const entry = this.entries.get(`${moduleId}:${scopeUnit}`);
    if (!entry) return null;
    return {
      state: entry.managed.instance.state,
      pid: entry.managed.pid,
      lastCrashReason: entry.managed.instance.lastCrashReason,
    };
  }

  /**
   * Push a live config update to a running subprocess. Caller is
   * responsible for having written the new blob to disk first — the manager
   * just ferries the notification. No-op when the (id, scope) pair is not
   * currently managed; cold-start modules will pick up the new config via
   * the next `initialize` handshake.
   */
  notifyConfigChanged(
    moduleId: string,
    scopeUnit: string,
    config: Record<string, unknown>,
  ): boolean {
    const entry = this.entries.get(`${moduleId}:${scopeUnit}`);
    if (!entry) return false;
    entry.managed.rpc.sendNotification("config/changed", config);
    return true;
  }

  // -------------------------------------------------------------------------
  // Internal — spawn/handshake
  // -------------------------------------------------------------------------

  private async spawnEntry(
    registered: RegisteredModule,
  ): Promise<InternalEntry> {
    const { manifest, modulePath, scopeUnit } = registered;

    const instance = new ModuleInstance({
      moduleId: manifest.id,
      scopeUnit,
    });

    // Re-emit instance events to the manager bus so external observers see
    // a unified stream keyed by (moduleId, scopeUnit).
    instance.on("state-changed", (p) => {
      this.emit("state-changed", {
        moduleId: manifest.id,
        scopeUnit,
        ...p,
      });
    });
    instance.on("crashed", (p) => {
      this.emit("crashed", { moduleId: manifest.id, scopeUnit, ...p });
    });
    instance.on("failed", (p) => {
      this.emit("failed", { moduleId: manifest.id, scopeUnit, ...p });
    });

    instance.transitionTo("spawning");

    let child: SpawnHandle;
    try {
      child = this.spawner.spawn(manifest, modulePath);
    } catch (err) {
      instance.transitionTo("crashed", {
        reason: err instanceof Error ? err.message : "spawn failed",
      });
      throw err;
    }

    // Forward module stderr to the manager bus as `log` events so consumers
    // (MCP, Electron) can display them.
    child.stderr.on("data", (chunk: Buffer) => {
      this.emit("log", {
        moduleId: manifest.id,
        scopeUnit,
        level: "error",
        message: chunk.toString("utf-8").trimEnd(),
      });
    });

    const rpc = new ModuleRpc({
      readable: child.stdout,
      writable: child.stdin,
    });
    rpc.onNotification<{ level?: string; message?: string }>("log", (p) => {
      this.emit("log", {
        moduleId: manifest.id,
        scopeUnit,
        level: p?.level ?? "info",
        message: p?.message ?? "",
      });
    });
    // Register host/call BEFORE listen() so a subprocess that calls back
    // during its own `activate` (which runs inside `initialize`) reaches a
    // live handler — the host is still awaiting the initialize response but
    // vscode-jsonrpc is duplex and serves inbound requests concurrently.
    attachHostRpc(rpc, manifest, this.capabilities);
    rpc.listen();

    instance.transitionTo("handshaking");

    let initResult: InitializeResult;
    try {
      initResult = await performInitialize(rpc, {
        capabilities: this.capabilities.describeAll(),
        hostVersion: this.hostVersion,
        config: this.configStore.get(manifest.id),
        timeoutMs: this.initializeTimeoutMs,
      });
    } catch (err) {
      const reason =
        err instanceof ActivationTimeoutError
          ? err.message
          : err instanceof Error
            ? err.message
            : "handshake failed";
      instance.transitionTo("crashed", { reason });
      rpc.dispose();
      child.kill("SIGKILL");
      throw err;
    }

    instance.transitionTo("active");

    const lockfile =
      manifest.scope === "global"
        ? new ModuleLockfile(lockfilePathFor(manifest.id))
        : null;
    lockfile?.acquire({ pid: child.pid, uid: process.getuid?.() ?? 0 });

    const entry: InternalEntry = {
      managed: {
        instance,
        manifest,
        rpc,
        pid: child.pid,
        initialize: initResult,
      },
      child,
      supervisor: new Supervisor({
        instance,
        onRespawn: () => this.respawn(entry),
      }),
      lockfile,
      consumers: new Set(),
      idleTimer: null,
      modulePath,
      registered,
    };
    entry.supervisor.attach();

    child.onExit((code, signal) => {
      // Unexpected exit while we believed the module was running.
      const state = instance.state;
      if (
        state === "stopping" ||
        state === "idle" ||
        state === "failed"
      ) {
        return; // expected
      }
      const reason = signal
        ? `subprocess exited via signal ${signal}`
        : `subprocess exited with code ${code}`;
      try {
        instance.transitionTo("crashed", { reason });
      } catch {
        /* already in a non-crashable state */
      }
    });

    return entry;
  }

  private async respawn(entry: InternalEntry): Promise<void> {
    // Clean up the dead child + rpc.
    entry.managed.rpc.dispose();
    entry.child.kill("SIGKILL");
    entry.lockfile?.release();

    try {
      const next = await this.spawnEntry(entry.registered);
      // Swap in place so refcount set / idle timer carry over.
      next.consumers = entry.consumers;
      next.idleTimer = entry.idleTimer;
      this.entries.set(
        ModuleHostManager.keyFor(entry.registered),
        next,
      );
    } catch {
      // Spawn failed; state machine already reflects `crashed`. Supervisor
      // will either retry again or transition to `failed`.
    }
  }

  private async stopEntry(entry: InternalEntry): Promise<void> {
    entry.supervisor.detach();
    this.cancelIdleTimer(entry);
    const state = entry.managed.instance.state;
    // Only transition through STOPPING if we're in a state that allows it.
    if (state === "active" || state === "updating") {
      try {
        entry.managed.instance.transitionTo("stopping");
      } catch {
        /* ignore */
      }
    }

    entry.managed.rpc.dispose();
    entry.child.kill("SIGTERM");

    // Give the child 1s to exit gracefully before SIGKILL.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        entry.child.kill("SIGKILL");
        resolve();
      }, 1000);
      entry.child.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    entry.lockfile?.release();
    if (entry.managed.instance.state === "stopping") {
      try {
        entry.managed.instance.transitionTo("idle");
      } catch {
        /* ignore */
      }
    }
    this.entries.delete(ModuleHostManager.keyFor(entry.registered));
  }

  private scheduleIdleShutdown(entry: InternalEntry): void {
    this.cancelIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      void this.stopEntry(entry);
    }, this.idleShutdownMs);
    // Don't keep the daemon alive on a timer alone.
    entry.idleTimer.unref?.();
  }

  private cancelIdleTimer(entry: InternalEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  static keyFor(registered: RegisteredModule): string {
    return `${registered.manifest.id}:${registered.scopeUnit}`;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lockfilePathFor(moduleId: string): string {
  // Exported for future diagnostics; matches the path documented in the
  // Phase 0 handoff and in the plan's Phase 2 section.
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return `${home}/.rn-dev/modules/${moduleId}/.lock`;
}
