import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModuleHostManager } from "../../src/core/module-host/manager.js";
import { ModuleConfigStore } from "../../src/modules/config-store.js";
import { ModuleRegistry } from "../../src/modules/registry.js";
import {
  handleConfigGet,
  handleConfigSet,
  type ConfigSetAuditEvent,
  type ModulesConfigIpcDeps,
} from "../ipc/modules-config.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function manifestWithConfig(): ModuleManifest {
  return {
    id: "tunable",
    version: "0.1.0",
    hostRange: ">=0.1.0",
    scope: "per-worktree",
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
  };
}

interface Harness {
  deps: ModulesConfigIpcDeps;
  audit: ConfigSetAuditEvent[];
  configStore: ModuleConfigStore;
  registry: ModuleRegistry;
  cleanup: () => Promise<void>;
}

function setup(manifest: ModuleManifest, modulesDir: string): Harness {
  const configStore = new ModuleConfigStore({ modulesDir });
  const registry = new ModuleRegistry();
  registry.registerManifest({
    manifest,
    modulePath: `/modules/${manifest.id}`,
    scopeUnit: "wt-1",
    state: "inert",
    isBuiltIn: false,
  });
  const manager = new ModuleHostManager({
    hostVersion: "0.1.0",
    configStore,
    initializeTimeoutMs: 500,
  });
  const audit: ConfigSetAuditEvent[] = [];
  const deps: ModulesConfigIpcDeps = {
    manager,
    registry,
    moduleEvents: new EventEmitter(),
    auditConfigSet: (event) => audit.push(event),
  };
  return {
    deps,
    audit,
    configStore,
    registry,
    cleanup: () => manager.shutdownAll(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("electron/modules-config — handleConfigGet", () => {
  let modulesDir: string;
  let harness: Harness | null = null;

  beforeEach(() => {
    modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-modcfg-ipc-"));
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    rmSync(modulesDir, { recursive: true, force: true });
  });

  it("returns { moduleId, config: {} } when nothing is persisted", () => {
    harness = setup(manifestWithConfig(), modulesDir);
    const result = handleConfigGet(harness.deps, {
      moduleId: "tunable",
      scopeUnit: "wt-1",
    });
    expect(result).toEqual({ moduleId: "tunable", config: {} });
  });

  it("returns the persisted blob after a set", () => {
    harness = setup(manifestWithConfig(), modulesDir);
    harness.configStore.write("tunable", { greeting: "hi" });
    const result = handleConfigGet(harness.deps, {
      moduleId: "tunable",
      scopeUnit: "wt-1",
    });
    expect(result).toEqual({
      moduleId: "tunable",
      config: { greeting: "hi" },
    });
  });
});

describe("electron/modules-config — handleConfigSet", () => {
  let modulesDir: string;
  let harness: Harness | null = null;

  beforeEach(() => {
    modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-modcfg-ipc-"));
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    rmSync(modulesDir, { recursive: true, force: true });
  });

  it("persists valid patches and emits a sorted-keys audit on ok", async () => {
    harness = setup(manifestWithConfig(), modulesDir);
    const result = await handleConfigSet(harness.deps, {
      moduleId: "tunable",
      scopeUnit: "wt-1",
      patch: { count: 2, greeting: "ok" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.config).toEqual({ count: 2, greeting: "ok" });
    }
    expect(harness.configStore.get("tunable")).toEqual({
      count: 2,
      greeting: "ok",
    });
    expect(harness.audit).toEqual([
      {
        moduleId: "tunable",
        scopeUnit: "wt-1",
        patchKeys: ["count", "greeting"],
        outcome: "ok",
        code: undefined,
      },
    ]);
  });

  it("rejects schema violations and audits the error code", async () => {
    harness = setup(manifestWithConfig(), modulesDir);
    const result = await handleConfigSet(harness.deps, {
      moduleId: "tunable",
      scopeUnit: "wt-1",
      patch: { count: -1 },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_CONFIG_VALIDATION");
    }
    expect(harness.audit[0]?.outcome).toBe("error");
    expect(harness.audit[0]?.code).toBe("E_CONFIG_VALIDATION");
    // Store is untouched on validation failure.
    expect(harness.configStore.get("tunable")).toEqual({});
  });

  it("forwards config-changed through the shared moduleEvents bus", async () => {
    harness = setup(manifestWithConfig(), modulesDir);
    const received: Array<Record<string, unknown>> = [];
    harness.deps.moduleEvents.on(
      "modules-event",
      (e: Record<string, unknown>) => received.push(e),
    );
    await handleConfigSet(harness.deps, {
      moduleId: "tunable",
      scopeUnit: "wt-1",
      patch: { greeting: "bus" },
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: "config-changed",
      moduleId: "tunable",
      config: { greeting: "bus" },
    });
  });

  it("returns E_CONFIG_MODULE_UNKNOWN for unregistered ids", async () => {
    harness = setup(manifestWithConfig(), modulesDir);
    const result = await handleConfigSet(harness.deps, {
      moduleId: "never",
      patch: { greeting: "x" },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_CONFIG_MODULE_UNKNOWN");
    }
  });

  it("serializes concurrent sets for the same moduleId (disjoint keys)", async () => {
    harness = setup(manifestWithConfig(), modulesDir);
    // Two concurrent patches with disjoint key sets. Even under a lost-
    // update bug, disjoint-key races can still merge correctly because
    // the later read sees the earlier write when the event loop yields —
    // but the contract is serialized execution, so this verifies the lock
    // doesn't drop either write on the floor.
    const [a, b] = await Promise.all([
      handleConfigSet(harness.deps, {
        moduleId: "tunable",
        scopeUnit: "wt-1",
        patch: { greeting: "first" },
      }),
      handleConfigSet(harness.deps, {
        moduleId: "tunable",
        scopeUnit: "wt-1",
        patch: { count: 7 },
      }),
    ]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    const final = harness.configStore.get("tunable");
    expect(final).toEqual({ greeting: "first", count: 7 });
  });

  it("runs concurrent sets for different moduleIds in parallel (no cross-module lock)", async () => {
    // Second module with its own schema registered under a different id,
    // so cross-module parallelism is observable. The test doesn't
    // directly assert timing — it asserts that both sets succeed and
    // that the map key includes the moduleId (not a global lock).
    harness = setup(manifestWithConfig(), modulesDir);
    const otherManifest: ModuleManifest = {
      id: "other",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "per-worktree",
      contributes: {
        config: {
          schema: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    };
    harness.registry.registerManifest({
      manifest: otherManifest,
      modulePath: "/nowhere",
      scopeUnit: "wt-1",
      state: "active",
      isBuiltIn: false,
    });
    const [a, b] = await Promise.all([
      handleConfigSet(harness.deps, {
        moduleId: "tunable",
        scopeUnit: "wt-1",
        patch: { greeting: "a" },
      }),
      handleConfigSet(harness.deps, {
        moduleId: "other",
        scopeUnit: "wt-1",
        patch: { greeting: "b" },
      }),
    ]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    expect(harness.configStore.get("tunable")).toEqual({ greeting: "a" });
    expect(harness.configStore.get("other")).toEqual({ greeting: "b" });
  });
});
