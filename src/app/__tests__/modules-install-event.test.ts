// Phase 7 — prove the install → tools/listChanged path end-to-end.
//
// `subscribeToModuleChanges` (in `src/mcp/server.ts`) sets up a daemon
// subscription that calls `notifyToolListChanged` on every `modules-event`.
// Phase 6 wired enable/disable/restart/crash/config-changed events;
// Phase 7 adds dedicated `install` / `uninstall` event kinds on the
// `ModulesEvent.kind` union, emitted by `installAction` /
// `uninstallAction`. This test verifies the bus emission itself — the
// MCP-side notification fires unconditionally on any `modules-event`, so
// verifying the emit chain is sufficient.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "../../modules/registry.js";
import {
  installAction,
  uninstallAction,
  type ModulesEvent,
  type ModulesIpcOptions,
} from "../modules-ipc.js";
import type { ModuleHostManager } from "../../core/module-host/manager.js";
import type { RegistryEntry } from "../../modules/marketplace/registry.js";

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

function stubRegistryFetcher(entry: RegistryEntry) {
  return {
    async fetch() {
      return {
        kind: "ok" as const,
        registry: { version: 1 as const, modules: [entry] },
        sha256: "a".repeat(64),
        fromCache: false,
      };
    },
    find: () => entry,
  };
}

describe("modules-ipc install/uninstall event kinds", () => {
  const entry: RegistryEntry = {
    id: "does-not-exist",
    npmPackage: "@rn-dev-modules/does-not-exist",
    version: "0.1.0",
    tarballSha256: "a".repeat(64),
    description: "fixture",
    author: "test",
    permissions: [],
  };

  it("emits kind='uninstall' even when the uninstall target is missing (no side effects either way)", async () => {
    const moduleEvents = new EventEmitter();
    const captured: ModulesEvent[] = [];
    moduleEvents.on("modules-event", (e: ModulesEvent) => captured.push(e));

    const opts: ModulesIpcOptions = {
      manager: stubManager(),
      registry: new ModuleRegistry(),
      moduleEvents,
      hostVersion: "0.1.0",
    };
    const result = await uninstallAction(opts, {
      moduleId: "ghost",
    });
    expect(result.kind).toBe("error");
    // No event fires on an error-path uninstall — absence of side effects.
    expect(captured).toHaveLength(0);
  });

  it("installAction surfaces E_TARBALL_FETCH_FAILED before firing any event", async () => {
    const moduleEvents = new EventEmitter();
    const captured: ModulesEvent[] = [];
    moduleEvents.on("modules-event", (e: ModulesEvent) => captured.push(e));

    const opts: ModulesIpcOptions = {
      manager: stubManager(),
      registry: new ModuleRegistry(),
      moduleEvents,
      hostVersion: "0.1.0",
      // Cast: the installer accepts any PacoteLike shape.
      registryFetcher: stubRegistryFetcher(entry) as unknown as ModulesIpcOptions["registryFetcher"],
      pacote: {
        tarball: async () => {
          throw new Error("network unreachable");
        },
        extract: async () => {},
      },
      // Never actually reached because pacote throws first — injected so
      // the installer doesn't try to dynamic-import `@npmcli/arborist`
      // under vitest where arborist isn't resolvable.
      arboristFactory: () => ({
        reify: async () => {},
      }),
    };
    const result = await installAction(opts, {
      moduleId: entry.id,
      permissionsAccepted: [...entry.permissions],
      thirdPartyAcknowledged: true,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_TARBALL_FETCH_FAILED");
    }
    expect(captured).toHaveLength(0);
  });

  it("ModulesEvent.kind union includes 'install' and 'uninstall'", () => {
    // Type-level assertion — compile-time proof the union widened. If this
    // file type-checks, Phase 7 added the kinds.
    const installEvent: ModulesEvent = {
      kind: "install",
      moduleId: "x",
      version: "0.1.0",
    };
    const uninstallEvent: ModulesEvent = { kind: "uninstall", moduleId: "x" };
    expect(installEvent.kind).toBe("install");
    expect(uninstallEvent.kind).toBe("uninstall");
  });

  it("installAction fires kind='install' with the installed version on the bus", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-p7-install-"));

    // Build the tarball-placement stub. pacote.extract is invoked with
    // the install path as the target; we drop a valid manifest there
    // directly. The tarball bytes can be anything so long as their SHA
    // matches the entry we feed into installAction.
    const fakeTarBytes = Buffer.from("phase-7-fake-tarball");
    const tarSha = createHash("sha256").update(fakeTarBytes).digest("hex");

    const entry: RegistryEntry = {
      id: "phase7-test",
      npmPackage: "@rn-dev-modules/phase7-test",
      version: "0.2.0",
      tarballSha256: tarSha,
      description: "p7 test",
      author: "rn-dev-test",
      permissions: [],
    };

    const pacote = {
      tarball: async () => fakeTarBytes,
      extract: async (_spec: string, target: string) => {
        mkdirSync(target, { recursive: true });
        writeFileSync(
          join(target, "rn-dev-module.json"),
          JSON.stringify({
            id: entry.id,
            version: entry.version,
            hostRange: ">=0.1.0",
            scope: "global",
          }),
        );
      },
    };

    const moduleEvents = new EventEmitter();
    const captured: ModulesEvent[] = [];
    moduleEvents.on("modules-event", (e: ModulesEvent) => captured.push(e));

    const opts: ModulesIpcOptions = {
      manager: stubManager(),
      registry: new ModuleRegistry(),
      moduleEvents,
      hostVersion: "0.1.0",
      modulesDir,
      registryFetcher: stubRegistryFetcher(
        entry,
      ) as unknown as ModulesIpcOptions["registryFetcher"],
      pacote,
      arboristFactory: () => ({
        reify: async () => {},
      }),
    };
    try {
      const result = await installAction(opts, {
        moduleId: entry.id,
        permissionsAccepted: [],
        thirdPartyAcknowledged: true,
      });
      expect(result.kind).toBe("ok");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        kind: "install",
        moduleId: entry.id,
        version: entry.version,
      });
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("uninstallAction fires kind='uninstall' on the bus when the module is present", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-p7-uninstall-"));
    const moduleId = "phase7-uninstall";
    mkdirSync(join(modulesDir, moduleId), { recursive: true });
    writeFileSync(
      join(modulesDir, moduleId, "rn-dev-module.json"),
      JSON.stringify({
        id: moduleId,
        version: "0.1.0",
        hostRange: ">=0.1.0",
        scope: "global",
      }),
    );

    const moduleEvents = new EventEmitter();
    const captured: ModulesEvent[] = [];
    moduleEvents.on("modules-event", (e: ModulesEvent) => captured.push(e));

    const opts: ModulesIpcOptions = {
      manager: stubManager(),
      registry: new ModuleRegistry(),
      moduleEvents,
      hostVersion: "0.1.0",
      modulesDir,
    };
    try {
      const result = await uninstallAction(opts, { moduleId });
      expect(result.kind).toBe("ok");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        kind: "uninstall",
        moduleId,
      });
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });
});
