import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dispatchModulesAction } from "../modules-ipc.js";
import { ModuleRegistry } from "../../modules/registry.js";
import { ModuleHostManager } from "../../core/module-host/manager.js";
import { ModuleConfigStore } from "../../modules/config-store.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";
import type { IpcMessage } from "../../core/ipc.js";
import type { SpawnHandle, ModuleSpawner } from "../../core/module-host/manager.js";
import { PassThrough } from "node:stream";
import { disabledFlagPath, isDisabled } from "../../modules/disabled-flag.js";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node.js";

// ---------------------------------------------------------------------------
// Fake spawner — in-process "module" lives in the test with RPC over
// PassThrough streams. Mirrors the real subprocess handshake shape.
// ---------------------------------------------------------------------------

function fakeSpawner(): ModuleSpawner {
  return {
    spawn: () => fakeChild(),
  };
}

function fakeChild(): SpawnHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // In-process "module" reading from stdin, writing to stdout.
  const reader = new StreamMessageReader(stdin);
  const writer = new StreamMessageWriter(stdout);
  const conn = createMessageConnection(reader, writer);
  conn.onRequest("initialize", () => ({
    moduleId: "fake",
    toolCount: 1,
  }));
  conn.onRequest("tool/ping", (params) => ({
    pong: true,
    echoed: params,
  }));
  conn.onRequest("tool/explode", () => {
    throw new Error("tool runtime error");
  });
  conn.listen();

  const exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  return {
    pid: Math.floor(Math.random() * 100000) + 1,
    stdin,
    stdout,
    stderr,
    kill(_signal) {
      conn.dispose();
      for (const l of exitListeners) l(0, null);
      return true;
    },
    onExit(l) {
      exitListeners.push(l);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(
  overrides: Partial<ModuleManifest> = {},
): ModuleManifest {
  return {
    id: "sample",
    version: "0.1.0",
    hostRange: ">=0.1.0",
    scope: "per-worktree",
    ...overrides,
  };
}

interface Harness {
  registry: ModuleRegistry;
  manager: ModuleHostManager;
  teardown: () => Promise<void>;
}

async function setup(
  manifests: ModuleManifest[] = [makeManifest()],
): Promise<Harness> {
  const registry = new ModuleRegistry();
  for (const manifest of manifests) {
    registry.registerManifest({
      manifest,
      modulePath: `/fake/${manifest.id}`,
      scopeUnit: manifest.scope === "global" ? "global" : "wt-1",
      state: "inert",
      isBuiltIn: false,
    });
  }
  const manager = new ModuleHostManager({
    hostVersion: "0.1.0",
    spawner: fakeSpawner(),
    initializeTimeoutMs: 500,
  });
  return {
    registry,
    manager,
    teardown: () => manager.shutdownAll(),
  };
}

let active: Harness | null = null;

afterEach(async () => {
  await active?.teardown();
  active = null;
});

function makeMsg(
  action: string,
  payload: Record<string, unknown> = {},
): IpcMessage {
  return {
    type: "command",
    action,
    payload,
    id: "test-" + Math.random(),
  };
}

// ---------------------------------------------------------------------------
// modules/list
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — modules/list", () => {
  it("returns a row per registered manifest with state='inert' before acquire", async () => {
    active = await setup([
      makeManifest({ id: "first" }),
      makeManifest({ id: "second", scope: "global" }),
    ]);
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/list"),
    )) as { modules: Array<{ id: string; state: string; scope: string }> };
    expect(result.modules).toHaveLength(2);
    expect(result.modules.map((m) => m.id).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(result.modules.every((m) => m.state === "inert")).toBe(true);
  });

  it("reports 'active' after a consumer acquires the module", async () => {
    active = await setup([makeManifest({ id: "alive" })]);
    const reg = active.registry.getManifest("alive", "wt-1");
    if (!reg) throw new Error("fixture missing");
    await active.manager.acquire(reg, "consumer-x");

    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/list"),
    )) as { modules: Array<{ id: string; state: string }> };

    expect(result.modules[0]?.state).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// modules/status
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — modules/status", () => {
  it("returns null when the module id is unknown", async () => {
    active = await setup();
    const result = await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/status", { moduleId: "ghost" }),
    );
    expect(result).toBeNull();
  });

  it("reports state + last-crash reason for a known module", async () => {
    active = await setup([makeManifest({ id: "watched" })]);
    const reg = active.registry.getManifest("watched", "wt-1");
    if (!reg) throw new Error("fixture missing");
    await active.manager.acquire(reg, "c");

    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/status", { moduleId: "watched", scopeUnit: "wt-1" }),
    )) as {
      id: string;
      state: string;
      scope: string;
      lastCrashReason: string | null;
    };

    expect(result.id).toBe("watched");
    expect(result.state).toBe("active");
    expect(result.lastCrashReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// modules/restart
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — modules/restart", () => {
  it("returns an error when the module is not registered", async () => {
    active = await setup();
    const result = await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/restart", { moduleId: "ghost", scopeUnit: "wt-1" }),
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/unknown/i) });
  });

  it("tears down a running module and re-acquires it (fresh pid)", async () => {
    active = await setup([makeManifest({ id: "cycled" })]);
    const reg = active.registry.getManifest("cycled", "wt-1");
    if (!reg) throw new Error("fixture missing");
    const firstHandle = await active.manager.acquire(reg, "c1");
    const firstPid = firstHandle.pid;

    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/restart", { moduleId: "cycled", scopeUnit: "wt-1" }),
    )) as { status: string; pid?: number };

    expect(result.status).toBe("restarted");
    expect(result.pid).toBeDefined();
    expect(result.pid).not.toBe(firstPid);
  });
});

// ---------------------------------------------------------------------------
// modules/call — the Phase 3b proxy path
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — modules/call", () => {
  it("returns MODULE_UNAVAILABLE when the module is not registered", async () => {
    active = await setup();
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/call", {
        moduleId: "ghost",
        tool: "noop",
        args: {},
      }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("MODULE_UNAVAILABLE");
  });

  it("rejects malformed requests without a moduleId or tool", async () => {
    active = await setup();
    const missingTool = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/call", { moduleId: "something", args: {} }),
    )) as { kind: string; code?: string };
    expect(missingTool.kind).toBe("error");
    expect(missingTool.code).toBe("E_MODULE_CALL_FAILED");
  });

  it("spawns + proxies the call + returns result on happy path", async () => {
    active = await setup([makeManifest({ id: "echo" })]);
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/call", {
        moduleId: "echo",
        scopeUnit: "wt-1",
        tool: "ping",
        args: { hello: "world" },
      }),
    )) as { kind: string; result?: { pong: boolean; echoed: unknown } };
    expect(result.kind).toBe("ok");
    expect(result.result?.pong).toBe(true);
    expect(result.result?.echoed).toEqual({ hello: "world" });
  });

  it("surfaces subprocess handler throws as E_MODULE_CALL_FAILED", async () => {
    active = await setup([makeManifest({ id: "echo" })]);
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/call", {
        moduleId: "echo",
        scopeUnit: "wt-1",
        tool: "explode",
        args: {},
      }),
    )) as { kind: string; code?: string; message?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("E_MODULE_CALL_FAILED");
    expect(result.message).toMatch(/tool runtime error/);
  });

  it("rejects calls to modules in FAILED state with MODULE_UNAVAILABLE", async () => {
    active = await setup([makeManifest({ id: "zombie" })]);
    const reg = active.registry.getManifest("zombie", "wt-1");
    if (!reg) throw new Error("fixture missing");
    // Drive the instance to FAILED by spawning then force-transitioning.
    const managed = await active.manager.acquire(reg, "c1");
    managed.instance.transitionTo("crashed", { reason: "x" });
    managed.instance.transitionTo("failed", { reason: "forced" });

    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/call", {
        moduleId: "zombie",
        scopeUnit: "wt-1",
        tool: "ping",
        args: {},
      }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("MODULE_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// modules/enable + modules/disable
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — modules/disable", () => {
  let modulesDir: string;

  beforeEach(() => {
    modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-modenable-"));
  });

  afterEach(() => {
    rmSync(modulesDir, { recursive: true, force: true });
  });

  function writeManifestOnDisk(id: string): void {
    const root = join(modulesDir, id);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "rn-dev-module.json"),
      JSON.stringify({
        id,
        version: "0.1.0",
        hostRange: ">=0.1.0",
        scope: "per-worktree",
      }),
    );
  }

  it("creates the disabled.flag and tears the subprocess down", async () => {
    active = await setup([makeManifest({ id: "togglable" })]);
    const reg = active.registry.getManifest("togglable", "wt-1");
    if (!reg) throw new Error("fixture missing");
    await active.manager.acquire(reg, "c1");

    const result = (await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        modulesDir,
      },
      makeMsg("modules/disable", {
        moduleId: "togglable",
        scopeUnit: "wt-1",
      }),
    )) as { status: string; alreadyDisabled: boolean };

    expect(result.status).toBe("disabled");
    expect(result.alreadyDisabled).toBe(false);
    expect(isDisabled("togglable", modulesDir)).toBe(true);
    expect(active.registry.getManifest("togglable", "wt-1")).toBeUndefined();
    // The manager entry should be gone as well.
    expect(active.manager.stateOf("togglable", "wt-1")).toBeNull();
  });

  it("is idempotent — disabling an already-disabled module reports it", async () => {
    writeManifestOnDisk("idem");
    active = await setup();

    await dispatchModulesAction(
      { registry: active.registry, manager: active.manager, modulesDir },
      makeMsg("modules/disable", { moduleId: "idem" }),
    );
    const second = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager, modulesDir },
      makeMsg("modules/disable", { moduleId: "idem" }),
    )) as { alreadyDisabled: boolean };
    expect(second.alreadyDisabled).toBe(true);
  });

  it("rejects payloads missing moduleId", async () => {
    active = await setup();
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager, modulesDir },
      makeMsg("modules/disable", {}),
    )) as { error?: string };
    expect(result.error).toMatch(/moduleId/);
  });
});

describe("dispatchModulesAction — modules/enable", () => {
  let modulesDir: string;

  beforeEach(() => {
    modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-modenable-"));
  });

  afterEach(() => {
    rmSync(modulesDir, { recursive: true, force: true });
  });

  function writeManifestOnDisk(id: string): void {
    const root = join(modulesDir, id);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "rn-dev-module.json"),
      JSON.stringify({
        id,
        version: "0.1.0",
        hostRange: ">=0.1.0",
        scope: "per-worktree",
      }),
    );
  }

  it("removes the disabled.flag and loads the manifest when re-enabling", async () => {
    writeManifestOnDisk("resume");
    active = await setup();
    await dispatchModulesAction(
      { registry: active.registry, manager: active.manager, modulesDir },
      makeMsg("modules/disable", { moduleId: "resume" }),
    );
    expect(isDisabled("resume", modulesDir)).toBe(true);

    const result = (await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        modulesDir,
        hostVersion: "0.1.0",
        scopeUnit: "wt-1",
      },
      makeMsg("modules/enable", { moduleId: "resume" }),
    )) as { status: string; state: string | null };

    expect(result.status).toBe("enabled");
    expect(isDisabled("resume", modulesDir)).toBe(false);
    // The re-load registered the manifest in inert state.
    expect(active.registry.getManifest("resume", "wt-1")).toBeDefined();
    expect(result.state).toBe("inert");
  });

  it("rejects payloads missing moduleId", async () => {
    active = await setup();
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager, modulesDir },
      makeMsg("modules/enable", {}),
    )) as { error?: string };
    expect(result.error).toMatch(/moduleId/);
  });
});

// ---------------------------------------------------------------------------
// modules/config/get + modules/config/set — Phase 5a
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — modules/config", () => {
  let modulesDir: string;
  let configStore: ModuleConfigStore;

  beforeEach(() => {
    modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-config-ipc-"));
    configStore = new ModuleConfigStore({ modulesDir });
  });

  afterEach(() => {
    rmSync(modulesDir, { recursive: true, force: true });
  });

  function makeSchemaedManifest(): ModuleManifest {
    return makeManifest({
      id: "tunable",
      contributes: {
        config: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              greeting: { type: "string", minLength: 1 },
              count: { type: "integer", minimum: 0 },
            },
          },
        },
      } as ModuleManifest["contributes"],
    });
  }

  it("modules/config/get returns {} when nothing is persisted", async () => {
    active = await setup([makeSchemaedManifest()]);
    const result = (await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        configStore,
      },
      makeMsg("modules/config/get", {
        moduleId: "tunable",
        scopeUnit: "wt-1",
      }),
    )) as { moduleId: string; config: Record<string, unknown> };
    expect(result.moduleId).toBe("tunable");
    expect(result.config).toEqual({});
  });

  it("modules/config/set shallow-merges, validates, persists, and reports ok", async () => {
    active = await setup([makeSchemaedManifest()]);
    configStore.write("tunable", { greeting: "hi" });

    const result = (await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        configStore,
      },
      makeMsg("modules/config/set", {
        moduleId: "tunable",
        scopeUnit: "wt-1",
        patch: { count: 3 },
      }),
    )) as { kind: string; config?: Record<string, unknown> };

    expect(result.kind).toBe("ok");
    expect(result.config).toEqual({ greeting: "hi", count: 3 });
    // On-disk state matches.
    expect(configStore.get("tunable")).toEqual({ greeting: "hi", count: 3 });
  });

  it("modules/config/set returns E_CONFIG_VALIDATION when patch violates schema", async () => {
    active = await setup([makeSchemaedManifest()]);
    const result = (await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        configStore,
      },
      makeMsg("modules/config/set", {
        moduleId: "tunable",
        scopeUnit: "wt-1",
        patch: { count: -5 },
      }),
    )) as { kind: string; code?: string; message?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("E_CONFIG_VALIDATION");
    // Nothing persisted.
    expect(configStore.get("tunable")).toEqual({});
  });

  it("modules/config/set emits a config-changed event onto moduleEvents", async () => {
    active = await setup([makeSchemaedManifest()]);
    const moduleEvents = new EventEmitter();
    const received: Array<Record<string, unknown>> = [];
    moduleEvents.on("modules-event", (e: Record<string, unknown>) => {
      received.push(e);
    });

    await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        configStore,
        moduleEvents,
      },
      makeMsg("modules/config/set", {
        moduleId: "tunable",
        scopeUnit: "wt-1",
        patch: { greeting: "hello" },
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: "config-changed",
      moduleId: "tunable",
      scopeUnit: "wt-1",
      config: { greeting: "hello" },
    });
  });

  it("modules/config/set sends config/changed notification to a live subprocess", async () => {
    active = await setup([makeSchemaedManifest()]);
    const reg = active.registry.getManifest("tunable", "wt-1");
    if (!reg) throw new Error("fixture missing");
    const managed = await active.manager.acquire(reg, "c1");
    const sendSpy = vi.spyOn(managed.rpc, "sendNotification");

    await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        configStore,
      },
      makeMsg("modules/config/set", {
        moduleId: "tunable",
        scopeUnit: "wt-1",
        patch: { greeting: "ping" },
      }),
    );

    expect(sendSpy).toHaveBeenCalledWith("config/changed", {
      greeting: "ping",
    });
  });

  it("modules/config/set returns E_CONFIG_MODULE_UNKNOWN for unregistered ids", async () => {
    active = await setup([makeSchemaedManifest()]);
    const result = (await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        configStore,
      },
      makeMsg("modules/config/set", {
        moduleId: "ghost",
        patch: { greeting: "x" },
      }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("E_CONFIG_MODULE_UNKNOWN");
  });

  it("modules/config/set rejects patches containing undefined values", async () => {
    active = await setup([makeSchemaedManifest()]);
    const result = (await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        configStore,
      },
      makeMsg("modules/config/set", {
        moduleId: "tunable",
        scopeUnit: "wt-1",
        // `undefined` round-trips through IPC as a dropped key in real
        // traffic, but direct dispatch passes it through. Without the
        // guard, JSON.stringify would silently drop the entry and the
        // caller would get a persisted blob with fewer keys than intended.
        patch: { greeting: undefined as unknown as string },
      }),
    )) as { kind: string; code?: string; message?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("E_CONFIG_BAD_PATCH");
    expect(result.message).toMatch(/undefined/i);
  });

  it("modules/config/set rejects non-object patches with E_CONFIG_BAD_PATCH", async () => {
    active = await setup([makeSchemaedManifest()]);
    const result = (await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        configStore,
      },
      makeMsg("modules/config/set", {
        moduleId: "tunable",
        patch: "not an object" as unknown as Record<string, unknown>,
      }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("E_CONFIG_BAD_PATCH");
  });

  it("modules/config without a schema accepts any patch", async () => {
    active = await setup([makeManifest({ id: "schemaless" })]);
    const result = (await dispatchModulesAction(
      {
        registry: active.registry,
        manager: active.manager,
        configStore,
      },
      makeMsg("modules/config/set", {
        moduleId: "schemaless",
        scopeUnit: "wt-1",
        patch: { anything: { nested: "goes" } },
      }),
    )) as { kind: string; config?: Record<string, unknown> };
    expect(result.kind).toBe("ok");
    expect(result.config).toEqual({ anything: { nested: "goes" } });
  });
});

// ---------------------------------------------------------------------------
// Phase 5b — built-in-privileged modules are not spawnable through modules/call
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — built-in-privileged guard", () => {
  it("modules/call returns MODULE_UNAVAILABLE for built-in-privileged modules", async () => {
    active = await setup();
    // Register a built-in via the dedicated helper.
    active.registry.registerBuiltIn({
      id: "builtin-cap-only",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "global",
    });

    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/call", {
        moduleId: "builtin-cap-only",
        scopeUnit: "global",
        tool: "whatever",
        args: {},
      }),
    )) as { kind: string; code?: string; message?: string };

    expect(result.kind).toBe("error");
    expect(result.code).toBe("MODULE_UNAVAILABLE");
    expect(result.message).toMatch(/built-in-privileged/);
  });

  it("manager.acquire throws E_BUILT_IN_NOT_SPAWNABLE for built-ins", async () => {
    active = await setup();
    const reg = active.registry.registerBuiltIn({
      id: "builtin-unspawnable",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "global",
    });

    await expect(active.manager.acquire(reg, "c1")).rejects.toThrow(
      /E_BUILT_IN_NOT_SPAWNABLE/,
    );
  });
});

// ---------------------------------------------------------------------------
// modules/host-call — Phase 13.4.1 daemon RPC
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — modules/host-call", () => {
  it("returns MODULE_UNAVAILABLE when the module is not registered", async () => {
    active = await setup();
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/host-call", {
        moduleId: "ghost",
        capabilityId: "log",
        method: "info",
        args: [],
      }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("MODULE_UNAVAILABLE");
  });

  it("returns HOST_CALL_FAILED on malformed payload", async () => {
    active = await setup();
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/host-call", { capabilityId: "log" }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("HOST_CALL_FAILED");
  });

  it("returns HOST_CAPABILITY_NOT_FOUND_OR_DENIED when the capability is missing or the module lacks permission", async () => {
    active = await setup([makeManifest({ id: "no-perms", permissions: [] })]);
    active.manager.capabilities.register(
      "restricted",
      { ping: () => "pong" },
      { requiredPermission: "exec:adb" },
    );
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/host-call", {
        moduleId: "no-perms",
        capabilityId: "restricted",
        method: "ping",
        args: [],
      }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("HOST_CAPABILITY_NOT_FOUND_OR_DENIED");
  });

  it("returns HOST_METHOD_NOT_FOUND when the method does not exist on the capability", async () => {
    active = await setup([makeManifest({ id: "perms", permissions: [] })]);
    active.manager.capabilities.register("cap-no-perm", {
      existingMethod: () => true,
    });
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/host-call", {
        moduleId: "perms",
        capabilityId: "cap-no-perm",
        method: "nonExistent",
        args: [],
      }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("HOST_METHOD_NOT_FOUND");
  });

  it("invokes the capability method + returns ok with the result on happy path", async () => {
    active = await setup([makeManifest({ id: "caller", permissions: [] })]);
    active.manager.capabilities.register("echo-cap", {
      say: (...args: unknown[]) => ({ echoed: args }),
    });
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/host-call", {
        moduleId: "caller",
        capabilityId: "echo-cap",
        method: "say",
        args: ["hi", 42],
      }),
    )) as { kind: string; result?: { echoed: unknown[] } };
    expect(result.kind).toBe("ok");
    expect(result.result?.echoed).toEqual(["hi", 42]);
  });

  it("returns HOST_CALL_FAILED when the capability method throws", async () => {
    active = await setup([makeManifest({ id: "explodey", permissions: [] })]);
    active.manager.capabilities.register("boom", {
      detonate: () => {
        throw new Error("boom boom");
      },
    });
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/host-call", {
        moduleId: "explodey",
        capabilityId: "boom",
        method: "detonate",
        args: [],
      }),
    )) as { kind: string; code?: string; message?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("HOST_CALL_FAILED");
    expect(result.message).toMatch(/boom boom/);
  });
});

// ---------------------------------------------------------------------------
// modules/list-panels — Phase 13.4.1 daemon RPC
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — modules/list-panels", () => {
  it("returns { modules: [] } when no module contributes an electron panel", async () => {
    active = await setup([makeManifest({ id: "no-panel" })]);
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/list-panels"),
    )) as { modules: unknown[] };
    expect(result.modules).toEqual([]);
  });

  it("returns one entry per module with Electron panel contributions", async () => {
    active = await setup([
      makeManifest({
        id: "with-panel",
        contributes: {
          electron: {
            panels: [
              {
                id: "main",
                title: "Main Panel",
                webviewEntry: "./dist/index.html",
                hostApi: ["log"],
              },
              {
                id: "settings",
                title: "Settings",
                icon: "⚙",
                webviewEntry: "./dist/settings.html",
                hostApi: ["log", "appInfo"],
              },
            ],
          },
        },
      }),
      makeManifest({ id: "no-panel" }),
    ]);
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/list-panels"),
    )) as {
      modules: Array<{
        moduleId: string;
        title: string;
        panels: Array<{ id: string; title: string; icon?: string; hostApi: string[] }>;
      }>;
    };
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.moduleId).toBe("with-panel");
    expect(result.modules[0]?.panels).toHaveLength(2);
    expect(result.modules[0]?.panels[0]).toMatchObject({
      id: "main",
      title: "Main Panel",
      hostApi: ["log"],
    });
    // webviewEntry is intentionally NOT projected into list-panels — callers
    // fetch it via modules/resolve-panel when they're ready to mount.
    expect("webviewEntry" in (result.modules[0]?.panels[0] ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// modules/resolve-panel — Phase 13.4.1 daemon RPC
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — modules/resolve-panel", () => {
  it("returns E_PANEL_BAD_REQUEST on malformed payload", async () => {
    active = await setup();
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/resolve-panel", { moduleId: "only-id" }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("E_PANEL_BAD_REQUEST");
  });

  it("returns E_PANEL_NOT_FOUND when the module is not registered", async () => {
    active = await setup();
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/resolve-panel", {
        moduleId: "ghost",
        panelId: "main",
      }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("E_PANEL_NOT_FOUND");
  });

  it("returns E_PANEL_NOT_FOUND when the panelId is not contributed", async () => {
    active = await setup([
      makeManifest({
        id: "has-panels",
        contributes: {
          electron: {
            panels: [
              {
                id: "real",
                title: "Real",
                webviewEntry: "./index.html",
                hostApi: [],
              },
            ],
          },
        },
      }),
    ]);
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/resolve-panel", {
        moduleId: "has-panels",
        panelId: "fake",
      }),
    )) as { kind: string; code?: string };
    expect(result.kind).toBe("error");
    expect(result.code).toBe("E_PANEL_NOT_FOUND");
  });

  it("returns contribution + moduleRoot on happy path", async () => {
    active = await setup([
      makeManifest({
        id: "happy",
        contributes: {
          electron: {
            panels: [
              {
                id: "main",
                title: "Main",
                icon: "🎯",
                webviewEntry: "./dist/panel.html",
                hostApi: ["log", "metro:logs"],
              },
            ],
          },
        },
      }),
    ]);
    const result = (await dispatchModulesAction(
      { registry: active.registry, manager: active.manager },
      makeMsg("modules/resolve-panel", {
        moduleId: "happy",
        panelId: "main",
      }),
    )) as {
      kind: string;
      moduleId?: string;
      moduleRoot?: string;
      contribution?: { id: string; title: string; webviewEntry: string; hostApi: string[] };
    };
    expect(result.kind).toBe("ok");
    expect(result.moduleId).toBe("happy");
    expect(result.moduleRoot).toBe("/fake/happy");
    expect(result.contribution).toMatchObject({
      id: "main",
      title: "Main",
      icon: "🎯",
      webviewEntry: "./dist/panel.html",
      hostApi: ["log", "metro:logs"],
    });
  });
});
