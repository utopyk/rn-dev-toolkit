import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonSupervisor, type SessionBootFn } from "../supervisor.js";
import { generateSessionId } from "../../core/identifiers.js";
import type { IpcServer } from "../../core/ipc.js";
import type {
  BootSessionServicesOptions,
  SessionServices,
} from "../../core/session/boot.js";
import type { Profile } from "../../core/types.js";
import type { ValidatedProfile } from "../profile-guard.js";
import type { MetroManager } from "../../core/metro.js";
import type { DevToolsManager } from "../../core/devtools.js";
import type { Builder } from "../../core/builder.js";
import type { FileWatcher } from "../../core/watcher.js";
import { ModuleHostManager } from "../../core/module-host/manager.js";
import { CapabilityRegistry } from "../../core/module-host/capabilities.js";
import { MetroLogsStore } from "../../core/metro-logs/buffer.js";
import { ReduxStore } from "../../core/redux/buffer.js";
import { DeviceLogsStore } from "../../core/device-logs/buffer.js";
import { TapManager } from "../../core/device-logs/tap-manager.js";
import { HookManager } from "../../core/hooks/manager.js";
import { getDefaultAuditLog } from "../../core/audit-log.js";
import type { RegisteredModule } from "../../modules/registry.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";

// Phase D4 — integration layer (real-process, not real-boot).
//
// This is the integration-real-process layer between unit tests and
// the real-boot probe (D7). Two unit-test layers already exist:
//   1. ModuleHostManager unit tests (`refcount-cross-session.test.ts`,
//      `refcount-same-session-reacquire.test.ts`) — real echo
//      subprocess via the manager directly, but no supervisor.
//   2. Supervisor cleanup unit test (`supervisor-module-cleanup.test.ts`)
//      — supervisor's release walk against a synthetic `release()`
//      fake, ordering pinned, but no real subprocess.
//
// This third layer wires BOTH together: a real `ModuleHostManager`
// (which spawns the real echo fixture subprocess via Node's `spawn()`)
// behind a `DaemonSupervisor` whose `bootFn` returns a SessionServices
// with the real moduleHost and minimal fakes for everything else.
//
// The test then:
//   - acquires the module subprocess via the real manager
//     (`recordAcquire` populates `services.acquiredModules`),
//   - calls `supervisor.stopSession(sessionId)`,
//   - asserts the real subprocess PID is reaped within bounded time.
//
// What this catches that the unit layers cannot:
//   - The reference-share between `entry.acquiredModules` and
//     `services.acquiredModules` (a typo there silently breaks the
//     release walk under fake-boot, since fake-boot's
//     `acquiredModules` stays empty regardless).
//   - The actual SIGTERM → poll → SIGKILL ladder inside
//     `ModuleHostManager.stopEntry` firing in response to the
//     release walk's refcount drop.
//
// What this still doesn't catch (deferred to D7):
//   - The daemon process itself (this test runs in-process, not a
//     spawned daemon).
//   - The wire layer between MCP/Electron/TUI clients and the daemon
//     (D2 specs already cover the per-client `session/stop` wire).
//   - Real Metro / devtools / Builder teardown ordering.

const FIXTURE_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "echo-module",
);
const FIXTURE_ENTRY = join(FIXTURE_DIR, "index.js");

function registeredPerWorktreeEcho(scopeUnit: string): RegisteredModule {
  const manifest: ModuleManifest = {
    id: "echo",
    version: "0.1.0",
    hostRange: ">=0.1.0",
    scope: "per-worktree",
    contributes: {
      mcp: {
        tools: [
          { name: "echo__ping", description: "Ping", inputSchema: {} },
        ],
      },
    },
  };
  return {
    manifest,
    modulePath: FIXTURE_ENTRY,
    scopeUnit,
    state: "inert",
    isBuiltIn: false,
  };
}

function makeProfile(
  projectRoot: string,
  name: string,
  metroPort: number,
): ValidatedProfile {
  const profile: Profile = {
    name,
    isDefault: false,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "quick",
    metroPort,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot,
  };
  return profile as ValidatedProfile;
}

interface RealHostHarness {
  bootFn: SessionBootFn;
  /** Returns the live ModuleHostManager for the matching sessionId. */
  managerFor: (sessionId: string) => ModuleHostManager | undefined;
}

/**
 * Build a `SessionBootFn` whose returned `SessionServices` carries a
 * REAL `ModuleHostManager` wired with the production `recordAcquire`
 * hook. Everything else (metro, devtools, builder, hookManager) stays
 * as minimal fakes — this test isolates the D4 cleanup path; the
 * other services have their own real-process layers.
 */
function makeRealHostBoot(): RealHostHarness {
  const managers = new Map<string, ModuleHostManager>();

  const bootFn: SessionBootFn = async (bootOpts: BootSessionServicesOptions) => {
    // Mirror production: allocate the acquiredModules array up front,
    // construct ModuleHostManager closing over it via recordAcquire.
    const acquiredModules: Array<{
      moduleId: string;
      scopeUnit: string;
      consumerId: string;
    }> = [];
    const capabilities = new CapabilityRegistry();
    capabilities.register("log", {}, { allowReserved: true });
    const moduleHost = new ModuleHostManager({
      hostVersion: "0.1.0",
      capabilities,
      initializeTimeoutMs: 3000,
      recordAcquire: (moduleId, scopeUnit, consumerId) => {
        acquiredModules.push({ moduleId, scopeUnit, consumerId });
      },
    });
    managers.set(bootOpts.sessionId, moduleHost);

    const services: SessionServices = {
      sessionId: bootOpts.sessionId,
      metro: new EventEmitter() as unknown as MetroManager,
      devtools: new EventEmitter() as unknown as DevToolsManager,
      builder: new EventEmitter() as unknown as Builder,
      watcher: null as FileWatcher | null,
      moduleHost,
      moduleRegistry: bootOpts.moduleRegistry,
      worktreeKey: bootOpts.artifactStore.worktreeHash(bootOpts.profile.worktree),
      metroLogsStore: new MetroLogsStore(),
      reduxStore: new ReduxStore(),
      deviceLogsStore: new DeviceLogsStore(),
      deviceLogsTapManager: new TapManager(new DeviceLogsStore()),
      capabilities,
      moduleEvents: new EventEmitter(),
      hookManager: new HookManager({
        auditLog: getDefaultAuditLog(),
        daemonPid: process.pid,
      }),
      validatedProfile: bootOpts.profile as never,
      bootTrace: [],
      acquiredModules,
      dispose: async () => {
        // Production `bootSessionServices.dispose()` does NOT call
        // moduleHost teardown — the supervisor's release walk owns
        // that path. Mirror the contract here so the test asserts
        // the release walk (and ONLY the release walk) is what
        // tears down the subprocess.
      },
    };
    return services;
  };

  return { bootFn, managerFor: (sid) => managers.get(sid) };
}

const fakeIpc = {} as IpcServer;

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("DaemonSupervisor — D4 cleanup with real module subprocess", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supervisor-d4-real-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("supervisor.stopSession reaps a real module subprocess via the release walk", async () => {
    const harness = makeRealHostBoot();
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: harness.bootFn,
    });

    const sid = generateSessionId();
    await sup.startSession(sid, makeProfile(tmpRoot, "alpha", 8101));
    await waitFor(() => sup.getSessionState(sid)?.status === "running", 2_000);

    // Acquire the real echo subprocess. This goes through the real
    // ModuleHostManager.acquire → spawn → handshake → recordAcquire,
    // populating services.acquiredModules which is the same array
    // entry.acquiredModules now points at (via the reference-share
    // assignment in supervisor.bootAsync).
    const moduleHost = harness.managerFor(sid)!;
    const managed = await moduleHost.acquire(
      registeredPerWorktreeEcho("wt-real"),
      sid,
    );
    const pid = managed.pid;
    expect(isAlive(pid)).toBe(true);

    // Sanity: the supervisor's entry SHOULD now see the acquire on
    // its acquiredModules array (reference-shared with services).
    const entry = sup.getSessionEntry(sid)!;
    expect(entry.acquiredModules).toHaveLength(1);
    expect(entry.acquiredModules[0]).toMatchObject({
      moduleId: "echo",
      scopeUnit: "wt-real",
      consumerId: sid,
    });

    // Trigger session/stop. The release walk should drop the refcount
    // to zero, ModuleHostManager.stopEntry should SIGTERM the child,
    // and the subprocess should exit within the 1s grace before the
    // SIGKILL escalation.
    await sup.stopSession(sid);

    // The release walk awaits each release individually; per-worktree
    // scope stops immediately on rc=0. Give the OS a beat to reap.
    await waitFor(() => !isAlive(pid), 2_000);
    expect(isAlive(pid)).toBe(false);
    expect(moduleHost.size).toBe(0);
  });

  it("supervisor.stopSession reaps every outstanding acquire when a session holds multiple modules", async () => {
    // Production reality: each session boots its own
    // `ModuleHostManager` (createModuleSystem runs per-boot), so the
    // cross-session refcount across a SHARED manager isn't a real
    // production scenario — it's the manager-internal refcount
    // already pinned by `refcount-cross-session.test.ts`.
    //
    // What IS a real production scenario: one session opens N
    // distinct (moduleId, scopeUnit) subprocesses and the session
    // stops while every one is still held. The release walk MUST
    // reap all N — not just the first or the last — and the
    // ModuleHostManager.stopEntry SIGTERM ladder must fire for each.
    // This is plan § F2's "consumer-set leak" bug class: a missing
    // release leaks the subprocess past the session's lifetime.
    const harness = makeRealHostBoot();
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: harness.bootFn,
    });

    const sid = generateSessionId();
    await sup.startSession(sid, makeProfile(tmpRoot, "alpha", 8102));
    await waitFor(() => sup.getSessionState(sid)?.status === "running", 2_000);

    const moduleHost = harness.managerFor(sid)!;
    // Two distinct (moduleId, scopeUnit) keys — different scopeUnits
    // route to independent subprocesses per `per-worktree` semantics.
    const regA = registeredPerWorktreeEcho("wt-multi-a");
    const regB = registeredPerWorktreeEcho("wt-multi-b");

    const managedA = await moduleHost.acquire(regA, sid);
    const managedB = await moduleHost.acquire(regB, sid);
    expect(managedA.pid).not.toBe(managedB.pid);
    expect(isAlive(managedA.pid)).toBe(true);
    expect(isAlive(managedB.pid)).toBe(true);
    expect(moduleHost.size).toBe(2);

    const entry = sup.getSessionEntry(sid)!;
    expect(entry.acquiredModules).toHaveLength(2);

    await sup.stopSession(sid);

    // BOTH subprocesses must die — not just one. A buggy release walk
    // that bailed on the first iteration (e.g. an exception eaten
    // mid-loop without best-effort semantics) would leak one PID.
    await waitFor(
      () => !isAlive(managedA.pid) && !isAlive(managedB.pid),
      2_000,
    );
    expect(isAlive(managedA.pid)).toBe(false);
    expect(isAlive(managedB.pid)).toBe(false);
    expect(moduleHost.size).toBe(0);
  });
});
