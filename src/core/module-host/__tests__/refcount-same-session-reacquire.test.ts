import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { ModuleHostManager } from "../manager.js";
import { CapabilityRegistry } from "../capabilities.js";
import type { RegisteredModule } from "../../../modules/registry.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";

// Phase D4 — same-session re-acquire idempotence. One consumerId
// re-acquiring the same (moduleId, scopeUnit) is a no-op on the
// refcount side: `Set.add()` is idempotent for the consumer holder,
// and the `recordAcquire` hook MUST skip the duplicate so the
// supervisor's `acquiredModules` array never accrues a stale entry
// that would leak release calls on stopEntry.

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
    scopeUnit: "wt-1",
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

describe("ModuleHostManager — same-session re-acquire (D4)", () => {
  it("re-acquire by the same consumerId is a no-op on the refcount AND skips recordAcquire", async () => {
    const events: Array<{ consumerId: string }> = [];
    const manager = makeManager((_m, _s, consumerId) => {
      events.push({ consumerId });
    });
    const reg = registeredPerWorktreeEcho();

    const first = await manager.acquire(reg, "session-A");
    const second = await manager.acquire(reg, "session-A");

    // Same subprocess returned both times; recordAcquire fired ONCE
    // (the absent→present transition). A buggy implementation that
    // fires on every acquire would have len=2 here and would leak a
    // duplicate entry into the supervisor's release walk.
    expect(first.pid).toBe(second.pid);
    expect(events).toEqual([{ consumerId: "session-A" }]);
    expect(manager.size).toBe(1);

    const pid = first.pid;
    expect(isAlive(pid)).toBe(true);

    // Single release drops the holder set to empty → per-worktree
    // scope tears down immediately. If the double-acquire had
    // decremented twice the subprocess would survive past this
    // release.
    await manager.release("echo", "wt-1", "session-A");
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.size).toBe(0);
    expect(isAlive(pid)).toBe(false);
  });
});
