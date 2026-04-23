// Phase 8 — prove the rescan action diffs disk vs registry + fires the
// expected modules-events. The MCP side's `subscribeToModuleChanges`
// already forwards any `modules-event` as `notifications/tools/list_changed`,
// so verifying the bus emission is sufficient.

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "../../modules/registry.js";
import {
  rescanAction,
  type ModulesEvent,
  type ModulesIpcOptions,
} from "../modules-ipc.js";
import type { ModuleHostManager } from "../../core/module-host/manager.js";

function stubManager(): ModuleHostManager {
  return {
    async shutdown() {},
    async acquire() {
      throw new Error("not used");
    },
    async release() {},
    configStore: {
      get: () => ({}),
      validate: () => ({ valid: true, errors: [] }),
      write: () => {},
    },
    notifyConfigChanged: () => {},
    inspect: () => null,
    on: () => {},
    off: () => {},
  } as unknown as ModuleHostManager;
}

function writeManifest(dir: string, id: string, version = "0.1.0"): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(
    join(dir, id, "rn-dev-module.json"),
    JSON.stringify({
      id,
      version,
      hostRange: ">=0.1.0",
      scope: "global",
    }),
  );
}

describe("rescanAction", () => {
  function setupOpts(modulesDir: string, registry: ModuleRegistry) {
    const moduleEvents = new EventEmitter();
    const captured: ModulesEvent[] = [];
    moduleEvents.on("modules-event", (e: ModulesEvent) => captured.push(e));
    const opts: ModulesIpcOptions = {
      manager: stubManager(),
      registry,
      moduleEvents,
      hostVersion: "0.1.0",
      modulesDir,
    };
    return { opts, captured };
  }

  it("registers newly-appeared manifests + fires kind='install'", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-rescan-"));
    try {
      writeManifest(modulesDir, "newcomer");
      const registry = new ModuleRegistry();
      const { opts, captured } = setupOpts(modulesDir, registry);

      const result = await rescanAction(opts);
      expect(result.added).toEqual(["newcomer"]);
      expect(result.removed).toEqual([]);
      expect(result.updated).toEqual([]);
      expect(registry.getManifest("newcomer", "global")).toBeDefined();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ kind: "install", moduleId: "newcomer" });
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("unregisters vanished manifests + fires kind='uninstall'", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-rescan-"));
    try {
      // Pre-register a module that doesn't exist on disk.
      const registry = new ModuleRegistry();
      registry.registerManifest({
        manifest: {
          id: "gone",
          version: "0.1.0",
          hostRange: ">=0.1.0",
          scope: "global",
        },
        modulePath: join(modulesDir, "gone"),
        scopeUnit: "global",
        state: "inert",
        isBuiltIn: false,
      });

      const { opts, captured } = setupOpts(modulesDir, registry);
      const result = await rescanAction(opts);
      expect(result.removed).toEqual(["gone"]);
      expect(registry.getManifest("gone", "global")).toBeUndefined();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ kind: "uninstall", moduleId: "gone" });
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("detects version bumps as updated (fires uninstall + install pair)", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-rescan-"));
    try {
      writeManifest(modulesDir, "bumpy", "0.2.0");
      const registry = new ModuleRegistry();
      registry.registerManifest({
        manifest: {
          id: "bumpy",
          version: "0.1.0",
          hostRange: ">=0.1.0",
          scope: "global",
        },
        modulePath: join(modulesDir, "bumpy"),
        scopeUnit: "global",
        state: "inert",
        isBuiltIn: false,
      });

      const { opts, captured } = setupOpts(modulesDir, registry);
      const result = await rescanAction(opts);
      expect(result.updated).toEqual(["bumpy"]);
      expect(registry.getManifest("bumpy", "global")?.manifest.version).toBe(
        "0.2.0",
      );
      expect(captured.map((c) => c.kind)).toEqual(["uninstall", "install"]);
      expect(captured[1]).toMatchObject({
        kind: "install",
        moduleId: "bumpy",
        version: "0.2.0",
      });
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("no-op when registry already matches disk (no events)", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-rescan-"));
    try {
      writeManifest(modulesDir, "stable");
      const registry = new ModuleRegistry();
      registry.registerManifest({
        manifest: {
          id: "stable",
          version: "0.1.0",
          hostRange: ">=0.1.0",
          scope: "global",
        },
        modulePath: join(modulesDir, "stable"),
        scopeUnit: "global",
        state: "inert",
        isBuiltIn: false,
      });

      const { opts, captured } = setupOpts(modulesDir, registry);
      const result = await rescanAction(opts);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.updated).toEqual([]);
      expect(captured).toHaveLength(0);
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("surfaces invalid manifests in rejected[] without registering them", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-rescan-"));
    try {
      // Good manifest.
      writeManifest(modulesDir, "valid");
      // Bad: missing required `scope` field.
      mkdirSync(join(modulesDir, "broken"), { recursive: true });
      writeFileSync(
        join(modulesDir, "broken", "rn-dev-module.json"),
        JSON.stringify({ id: "broken", version: "0.1.0", hostRange: ">=0.1.0" }),
      );

      const registry = new ModuleRegistry();
      const { opts } = setupOpts(modulesDir, registry);
      const result = await rescanAction(opts);
      expect(result.added).toEqual(["valid"]);
      expect(result.rejected.length).toBeGreaterThan(0);
      expect(result.rejected[0]).toContain("broken");
      expect(registry.getManifest("broken", "global")).toBeUndefined();
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("skips built-in modules (they're not in ~/.rn-dev/modules/)", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-rescan-"));
    try {
      const registry = new ModuleRegistry();
      registry.registerBuiltIn({
        id: "settings",
        version: "0.1.0",
        hostRange: ">=0.1.0",
        scope: "global",
      });

      const { opts, captured } = setupOpts(modulesDir, registry);
      const result = await rescanAction(opts);
      // Built-in must NOT appear in removed[] — rescan only touches 3p.
      expect(result.removed).toEqual([]);
      expect(captured).toHaveLength(0);
      expect(registry.getManifest("settings", "global")).toBeDefined();
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });
});
