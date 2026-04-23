import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node.js";
import { subscribeToModuleChanges } from "../server.js";
import type { McpContext, McpFlags } from "../tools.js";
import { IpcClient, IpcServer } from "../../core/ipc.js";
import { registerModulesIpc } from "../../app/modules-ipc.js";
import { ModuleRegistry } from "../../modules/registry.js";
import {
  ModuleHostManager,
  type ModuleSpawner,
  type SpawnHandle,
} from "../../core/module-host/manager.js";

// ---------------------------------------------------------------------------
// Minimal fake subprocess so ModuleHostManager's acquire() can complete when
// the modules/disable path tries to shut it down. Our tests don't actually
// acquire — we just need a spawner that exists.
// ---------------------------------------------------------------------------

function fakeSpawner(): ModuleSpawner {
  return {
    spawn: (): SpawnHandle => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const conn = createMessageConnection(
        new StreamMessageReader(stdin),
        new StreamMessageWriter(stdout),
      );
      conn.onRequest("initialize", () => ({ moduleId: "x", toolCount: 0 }));
      conn.listen();
      const exits: Array<
        (code: number | null, signal: NodeJS.Signals | null) => void
      > = [];
      return {
        pid: 4242,
        stdin,
        stdout,
        stderr,
        kill: () => {
          conn.dispose();
          for (const l of exits) l(0, null);
          return true;
        },
        onExit: (l) => exits.push(l),
      };
    },
  };
}

function makeCtx(socketPath: string): McpContext {
  return {
    projectRoot: "/tmp",
    profileStore: {} as McpContext["profileStore"],
    artifactStore: {} as McpContext["artifactStore"],
    metro: null,
    preflightEngine: {} as McpContext["preflightEngine"],
    ipcClient: new IpcClient(socketPath),
    flags: flags(),
  };
}

function flags(): McpFlags {
  return {
    enabledModules: new Set(),
    disabledModules: new Set(),
    allowDestructiveTools: false,
  };
}

// ---------------------------------------------------------------------------
// Integration-ish test — spins up a real IpcServer with registerModulesIpc,
// subscribes via the exported helper, triggers an enable, and asserts
// notifyToolListChanged + refreshTools were each invoked exactly once.
// ---------------------------------------------------------------------------

describe("subscribeToModuleChanges", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: IpcServer;
  let manager: ModuleHostManager | null = null;
  let handle: ReturnType<typeof registerModulesIpc> | null = null;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rn-dev-sub-mcp-"));
    socketPath = join(tmpDir, "rnd.sock");
    server = new IpcServer(socketPath);
    await server.start();
  });

  afterEach(async () => {
    handle?.unregister();
    handle = null;
    await manager?.shutdownAll();
    manager = null;
    await server.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the context has no ipcClient", async () => {
    const ctx: McpContext = {
      projectRoot: "/tmp",
      profileStore: {} as McpContext["profileStore"],
      artifactStore: {} as McpContext["artifactStore"],
      metro: null,
      preflightEngine: {} as McpContext["preflightEngine"],
      ipcClient: null,
      flags: flags(),
    };
    const result = await subscribeToModuleChanges({
      ctx,
      flags: flags(),
      notifyToolListChanged: async () => {},
      refreshTools: async () => {},
    });
    expect(result).toBeNull();
  });

  it("returns null (silently) when no daemon is reachable", async () => {
    await server.stop();
    const ctx = makeCtx(socketPath);
    const result = await subscribeToModuleChanges({
      ctx,
      flags: flags(),
      notifyToolListChanged: async () => {},
      refreshTools: async () => {},
    });
    expect(result).toBeNull();
  });

  it("invokes refreshTools + notifyToolListChanged on each module event", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-sub-mod-"));
    try {
      const id = "notify-me";
      mkdirSync(join(modulesDir, id), { recursive: true });
      writeFileSync(
        join(modulesDir, id, "rn-dev-module.json"),
        JSON.stringify({
          id,
          version: "0.1.0",
          hostRange: ">=0.1.0",
          scope: "per-worktree",
        }),
      );

      const registry = new ModuleRegistry();
      manager = new ModuleHostManager({
        hostVersion: "0.1.0",
        spawner: fakeSpawner(),
        initializeTimeoutMs: 500,
      });
      handle = registerModulesIpc(server, {
        manager,
        registry,
        modulesDir,
        hostVersion: "0.1.0",
        scopeUnit: "wt-1",
      });

      const ctx = makeCtx(socketPath);
      let notifyCount = 0;
      let refreshCount = 0;

      const sub = await subscribeToModuleChanges({
        ctx,
        flags: flags(),
        notifyToolListChanged: async () => {
          notifyCount++;
        },
        refreshTools: async () => {
          refreshCount++;
        },
      });
      if (!sub) throw new Error("expected a subscription handle");

      const op = new IpcClient(socketPath);
      // Disable fires the first event.
      await op.send({
        type: "command",
        action: "modules/disable",
        payload: { moduleId: id },
        id: "op-d",
      });
      // Enable fires the second event.
      await op.send({
        type: "command",
        action: "modules/enable",
        payload: { moduleId: id },
        id: "op-e",
      });

      // Events travel asynchronously — wait for both to arrive.
      const deadline = Date.now() + 1_500;
      while (notifyCount < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(refreshCount).toBe(2);
      expect(notifyCount).toBe(2);

      sub.close();
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });
});
