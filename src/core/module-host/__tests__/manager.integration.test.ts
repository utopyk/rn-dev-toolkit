import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ModuleHostManager } from "../manager.js";
import { CapabilityRegistry } from "../capabilities.js";
import type { RegisteredModule } from "../../../modules/registry.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";

// ---------------------------------------------------------------------------
// Fixture setup — uses the real echo module at test/fixtures/echo-module.
// ---------------------------------------------------------------------------

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

function registeredEchoModule(
  overrides: Partial<ModuleManifest> = {},
): RegisteredModule {
  const manifest: ModuleManifest = {
    id: "echo",
    version: "0.1.0",
    hostRange: ">=0.1.0",
    scope: "global",
    contributes: {
      mcp: {
        tools: [
          {
            name: "echo__ping",
            description: "Ping",
            inputSchema: {},
          },
        ],
      },
    },
    ...overrides,
  };
  return {
    manifest,
    modulePath: FIXTURE_ENTRY,
    scopeUnit: manifest.scope === "global" ? "global" : "wt-1",
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
  overrides: {
    idleShutdownMs?: number;
    capabilities?: CapabilityRegistry;
  } = {},
): ModuleHostManager {
  const capabilities = overrides.capabilities ?? new CapabilityRegistry();
  if (!overrides.capabilities) {
    capabilities.register("log", {});
  }
  const manager = new ModuleHostManager({
    hostVersion: "0.1.0",
    capabilities,
    initializeTimeoutMs: 3000,
    idleShutdownMs: overrides.idleShutdownMs ?? 60_000,
  });
  tearDownTasks.push(() => manager.shutdownAll());
  return manager;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("ModuleHostManager — integration (real subprocess)", () => {
  it("spawns a module subprocess, completes the handshake, and reports 'active'", async () => {
    const manager = makeManager();
    const managed = await manager.acquire(registeredEchoModule(), "test-1");

    expect(managed.instance.state).toBe("active");
    expect(managed.pid).toBeGreaterThan(0);
    expect(managed.initialize.moduleId).toBe("echo");
    expect(managed.initialize["echoedHostVersion"]).toBe("0.1.0");
  });

  it("round-trips a plain RPC request against the live subprocess", async () => {
    const manager = makeManager();
    const managed = await manager.acquire(registeredEchoModule(), "test-2");

    const result = await managed.rpc.sendRequest<
      { payload: string },
      { payload: string }
    >("echo", { payload: "hello" });
    expect(result).toEqual({ payload: "hello" });
  });

  it("refcounts `global`-scope consumers and reuses a single subprocess", async () => {
    const manager = makeManager();
    const reg = registeredEchoModule();

    const first = await manager.acquire(reg, "consumer-A");
    const second = await manager.acquire(reg, "consumer-B");

    expect(first.pid).toBe(second.pid);
    expect(manager.size).toBe(1);
  });

  it("shutdown() transitions the module through STOPPING → idle and kills the child", async () => {
    const manager = makeManager();
    const managed = await manager.acquire(registeredEchoModule(), "test-3");
    const pid = managed.pid;

    // Sanity: PID exists
    expect(isAlive(pid)).toBe(true);

    await manager.shutdown("echo", "global");

    // Give the OS a beat to reap the process
    await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(pid)).toBe(false);
    expect(manager.stateOf("echo", "global")).toBe(null);
  });

  it("releases drive idle-shutdown for global-scope modules after last consumer leaves", async () => {
    const manager = makeManager({ idleShutdownMs: 50 });
    const reg = registeredEchoModule();

    await manager.acquire(reg, "c1");
    await manager.acquire(reg, "c2");
    expect(manager.size).toBe(1);

    await manager.release("echo", "global", "c1");
    // One consumer left — subprocess stays up.
    await new Promise((r) => setTimeout(r, 120));
    expect(manager.size).toBe(1);

    await manager.release("echo", "global", "c2");
    // Idle-shutdown timer should fire within ~50ms
    await new Promise((r) => setTimeout(r, 250));
    expect(manager.size).toBe(0);
  });

  it("routes `ctx.host.capability(id).method(args)` from subprocess back to the daemon CapabilityRegistry", async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register("math", {
      add: (a: number, b: number) => a + b,
    });
    capabilities.register(
      "secret",
      { read: () => "classified" },
      { requiredPermission: "secret:read" },
    );
    const manager = makeManager({ capabilities });
    const managed = await manager.acquire(
      registeredEchoModule({ permissions: [] }),
      "probe",
    );

    const granted = await managed.rpc.sendRequest<
      { id: string; method: string; args: unknown[] },
      { found: boolean; methodFound?: boolean; result?: unknown }
    >("tool/probe-host", { id: "math", method: "add", args: [3, 4] });
    expect(granted).toEqual({ found: true, methodFound: true, result: 7 });

    const denied = await managed.rpc.sendRequest<
      { id: string; method: string; args: unknown[] },
      { found: boolean }
    >("tool/probe-host", { id: "secret", method: "read", args: [] });
    expect(denied.found).toBe(false);
  });

  it("shutdownAll() kills every managed subprocess (orphan prevention)", async () => {
    const manager = makeManager();
    const first = await manager.acquire(registeredEchoModule(), "c1");
    const second = await manager.acquire(
      registeredEchoModule({ id: "echo", scope: "per-worktree" }),
      "c2",
    );

    // Second entry uses per-worktree scope → stored under echo:wt-1 key
    expect(manager.size).toBe(2);

    await manager.shutdownAll();

    await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(first.pid)).toBe(false);
    expect(isAlive(second.pid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
