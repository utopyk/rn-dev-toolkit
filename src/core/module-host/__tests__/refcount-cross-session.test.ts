import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { ModuleHostManager } from "../manager.js";
import { CapabilityRegistry } from "../capabilities.js";
import type { RegisteredModule } from "../../../modules/registry.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";

// Phase D4 — ModuleHostManager refcount across multiple consumers.
//
// Note: in production today each session boots its own
// `ModuleHostManager` (createModuleSystem runs per-boot), so the
// "two sessions share a manager" architecture isn't currently
// reachable through the daemon — both consumers below live in the
// SAME manager instance. The unit-level invariant the test pins is
// still load-bearing: ModuleHostManager's `consumers: Set<string>`
// drops the subprocess only on rc=0, which is the precondition for
// any future shared-manager design and is the property the
// supervisor's D4 release walk relies on per-session.
//
// Walks the real echo fixture so the assertions also pin the
// spawn-down handshake under real `per-worktree` semantics
// (`global` would route through the idle-shutdown timer instead
// and obscure the refcount edge).

const FIXTURE_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "echo-module",
);
const FIXTURE_ENTRY = join(FIXTURE_DIR, "index.js");

function registeredPerWorktreeEcho(): RegisteredModule {
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
    scopeUnit: "wt-shared",
    state: "inert",
    isBuiltIn: false,
  };
}

let tearDownTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const task of tearDownTasks) {
    await task();
  }
  tearDownTasks = [];
});

function makeManager(
  recordAcquire?: (
    moduleId: string,
    scopeUnit: string,
    consumerId: string,
  ) => void,
): ModuleHostManager {
  const capabilities = new CapabilityRegistry();
  capabilities.register("log", {}, { allowReserved: true });
  const manager = new ModuleHostManager({
    hostVersion: "0.1.0",
    capabilities,
    initializeTimeoutMs: 3000,
    recordAcquire,
  });
  tearDownTasks.push(() => manager.shutdownAll());
  return manager;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ModuleHostManager — cross-session refcount (D4)", () => {
  it("two sessions sharing a (moduleId, scopeUnit) hold one subprocess; first release keeps it alive, second tears it down", async () => {
    const manager = makeManager();
    const reg = registeredPerWorktreeEcho();

    const managedA = await manager.acquire(reg, "session-A");
    const managedB = await manager.acquire(reg, "session-B");

    // Shared subprocess — same PID, single entry in the manager.
    expect(managedA.pid).toBe(managedB.pid);
    expect(manager.size).toBe(1);
    const sharedPid = managedA.pid;
    expect(isAlive(sharedPid)).toBe(true);

    // First session releases. The subprocess must SURVIVE: per-worktree
    // scope skips the idle-shutdown timer and stops immediately on
    // last release, so a buggy refcount that decrements past the
    // surviving consumer would tear the subprocess down here.
    await manager.release("echo", "wt-shared", "session-A");
    // Settle: the manager runs no async after a non-final release,
    // but give the OS a beat in case the buggy path KILLs anyway.
    await new Promise((r) => setTimeout(r, 100));
    expect(manager.size).toBe(1);
    expect(isAlive(sharedPid)).toBe(true);

    // Second session releases. Now refcount hits zero → stopEntry.
    await manager.release("echo", "wt-shared", "session-B");
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.size).toBe(0);
    expect(isAlive(sharedPid)).toBe(false);
  });

  it("recordAcquire fires once per session per acquire — no spawn churn between releases", async () => {
    const events: Array<{ moduleId: string; scopeUnit: string; consumerId: string }> = [];
    const manager = makeManager((moduleId, scopeUnit, consumerId) => {
      events.push({ moduleId, scopeUnit, consumerId });
    });
    const reg = registeredPerWorktreeEcho();

    await manager.acquire(reg, "session-A");
    await manager.acquire(reg, "session-B");

    expect(events).toEqual([
      { moduleId: "echo", scopeUnit: "wt-shared", consumerId: "session-A" },
      { moduleId: "echo", scopeUnit: "wt-shared", consumerId: "session-B" },
    ]);

    // First release does NOT re-spawn (the refcount path doesn't
    // touch recordAcquire). Asserts no spurious churn between
    // session A's release and session B's eventual release.
    await manager.release("echo", "wt-shared", "session-A");
    expect(events).toHaveLength(2);

    await manager.release("echo", "wt-shared", "session-B");
    expect(events).toHaveLength(2);
  });
});
