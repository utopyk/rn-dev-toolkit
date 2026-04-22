import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node.js";
import {
  dispatchModulesAction,
  registerModulesIpc,
  type ModulesEvent,
} from "../modules-ipc.js";
import { IpcClient, IpcServer, type IpcMessage } from "../../core/ipc.js";
import { ModuleRegistry } from "../../modules/registry.js";
import {
  ModuleHostManager,
  type ModuleSpawner,
  type SpawnHandle,
} from "../../core/module-host/manager.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";

// ---------------------------------------------------------------------------
// Fake module subprocess that satisfies the handshake + tool/ping.
// ---------------------------------------------------------------------------

function fakeChild(): SpawnHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const reader = new StreamMessageReader(stdin);
  const writer = new StreamMessageWriter(stdout);
  const conn = createMessageConnection(reader, writer);
  conn.onRequest("initialize", () => ({ moduleId: "fake", toolCount: 1 }));
  conn.onRequest("tool/ping", () => ({ pong: true }));
  conn.listen();

  const exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  return {
    pid: Math.floor(Math.random() * 100000) + 1,
    stdin,
    stdout,
    stderr,
    kill: () => {
      conn.dispose();
      for (const l of exitListeners) l(0, null);
      return true;
    },
    onExit: (l) => exitListeners.push(l),
  };
}

function fakeSpawner(): ModuleSpawner {
  return { spawn: () => fakeChild() };
}

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

// ---------------------------------------------------------------------------
// Dispatcher-level: emission into a supplied EventEmitter.
// ---------------------------------------------------------------------------

describe("dispatchModulesAction — emits modules-event on enable/disable/restart", () => {
  let active: ModuleHostManager | null = null;

  afterEach(async () => {
    await active?.shutdownAll();
    active = null;
  });

  it("emits { kind: 'disabled' } when a live module is disabled", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-modsub-"));
    try {
      const registry = new ModuleRegistry();
      registry.registerManifest({
        manifest: makeManifest({ id: "live" }),
        modulePath: "/fake/live",
        scopeUnit: "wt-1",
        state: "inert",
        isBuiltIn: false,
      });
      const manager = new ModuleHostManager({
        hostVersion: "0.1.0",
        spawner: fakeSpawner(),
        initializeTimeoutMs: 500,
      });
      active = manager;

      const reg = registry.getManifest("live", "wt-1");
      if (!reg) throw new Error("fixture missing");
      await manager.acquire(reg, "consumer");

      const moduleEvents = new EventEmitter();
      const seen: ModulesEvent[] = [];
      moduleEvents.on("modules-event", (e: ModulesEvent) => seen.push(e));

      await dispatchModulesAction(
        { registry, manager, modulesDir, moduleEvents },
        {
          type: "command",
          action: "modules/disable",
          payload: { moduleId: "live", scopeUnit: "wt-1" },
          id: "t-1",
        },
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        kind: "disabled",
        moduleId: "live",
        scopeUnit: "wt-1",
      });
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("emits { kind: 'enabled' } after loading a previously-disabled manifest", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-modsub-"));
    try {
      const id = "resume";
      const modRoot = join(modulesDir, id);
      mkdirSync(modRoot, { recursive: true });
      writeFileSync(
        join(modRoot, "rn-dev-module.json"),
        JSON.stringify({
          id,
          version: "0.1.0",
          hostRange: ">=0.1.0",
          scope: "per-worktree",
        }),
      );
      const registry = new ModuleRegistry();
      const manager = new ModuleHostManager({
        hostVersion: "0.1.0",
        spawner: fakeSpawner(),
        initializeTimeoutMs: 500,
      });
      active = manager;

      // Disable first to populate the flag.
      await dispatchModulesAction(
        { registry, manager, modulesDir },
        {
          type: "command",
          action: "modules/disable",
          payload: { moduleId: id },
          id: "t-disable",
        },
      );

      const moduleEvents = new EventEmitter();
      const seen: ModulesEvent[] = [];
      moduleEvents.on("modules-event", (e: ModulesEvent) => seen.push(e));

      await dispatchModulesAction(
        {
          registry,
          manager,
          modulesDir,
          moduleEvents,
          hostVersion: "0.1.0",
          scopeUnit: "wt-1",
        },
        {
          type: "command",
          action: "modules/enable",
          payload: { moduleId: id },
          id: "t-enable",
        },
      );

      expect(seen.some((e) => e.kind === "enabled" && e.moduleId === id)).toBe(
        true,
      );
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("emits { kind: 'restarted' } after a successful modules/restart", async () => {
    const registry = new ModuleRegistry();
    registry.registerManifest({
      manifest: makeManifest({ id: "cycled" }),
      modulePath: "/fake/cycled",
      scopeUnit: "wt-1",
      state: "inert",
      isBuiltIn: false,
    });
    const manager = new ModuleHostManager({
      hostVersion: "0.1.0",
      spawner: fakeSpawner(),
      initializeTimeoutMs: 500,
    });
    active = manager;
    const reg = registry.getManifest("cycled", "wt-1");
    if (!reg) throw new Error("fixture missing");
    await manager.acquire(reg, "c1");

    const moduleEvents = new EventEmitter();
    const seen: ModulesEvent[] = [];
    moduleEvents.on("modules-event", (e: ModulesEvent) => seen.push(e));

    const result = (await dispatchModulesAction(
      { registry, manager, moduleEvents },
      {
        type: "command",
        action: "modules/restart",
        payload: { moduleId: "cycled", scopeUnit: "wt-1" },
        id: "t-restart",
      },
    )) as { status: string };

    expect(result.status).toBe("restarted");
    expect(seen.some((e) => e.kind === "restarted" && e.moduleId === "cycled")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: registerModulesIpc + IpcClient.subscribe
// ---------------------------------------------------------------------------

describe("registerModulesIpc + modules/subscribe end-to-end", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: IpcServer;
  let client: IpcClient;
  let manager: ModuleHostManager | null = null;
  let handle: { unregister: () => void; moduleEvents: EventEmitter } | null =
    null;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rn-dev-sub-ipc-"));
    socketPath = join(tmpDir, "rnd.sock");
    server = new IpcServer(socketPath);
    await server.start();
    client = new IpcClient(socketPath);
  });

  afterEach(async () => {
    handle?.unregister();
    handle = null;
    await manager?.shutdownAll();
    manager = null;
    await server.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("delivers a subscribe confirmation then streams events on enable/disable", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-sub-mod-"));
    try {
      const id = "broadcast";
      const modRoot = join(modulesDir, id);
      mkdirSync(modRoot, { recursive: true });
      writeFileSync(
        join(modRoot, "rn-dev-module.json"),
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

      const events: IpcMessage[] = [];
      const sub = await client.subscribe(
        {
          type: "command",
          action: "modules/subscribe",
          payload: {},
          id: "sub-1",
        },
        {
          onEvent: (evt) => events.push(evt),
        },
      );

      expect(sub.initial.payload).toEqual({ subscribed: true });

      // Disable should fire an event.
      await client.send({
        type: "command",
        action: "modules/disable",
        payload: { moduleId: id },
        id: "op-disable",
      });
      await waitFor(() => events.some((e) => isKind(e, "disabled")), 1_000);

      // Enable (loads the manifest fresh) should fire another.
      await client.send({
        type: "command",
        action: "modules/enable",
        payload: { moduleId: id },
        id: "op-enable",
      });
      await waitFor(() => events.some((e) => isKind(e, "enabled")), 1_000);

      sub.close();

      const kinds = events
        .map((e) => (e.payload as ModulesEvent).kind)
        .filter((k) => k === "disabled" || k === "enabled");
      expect(kinds).toContain("disabled");
      expect(kinds).toContain("enabled");
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("stops delivering events after the client closes the subscription", async () => {
    const registry = new ModuleRegistry();
    registry.registerManifest({
      manifest: makeManifest({ id: "cycled" }),
      modulePath: "/fake/cycled",
      scopeUnit: "wt-1",
      state: "inert",
      isBuiltIn: false,
    });
    manager = new ModuleHostManager({
      hostVersion: "0.1.0",
      spawner: fakeSpawner(),
      initializeTimeoutMs: 500,
    });
    handle = registerModulesIpc(server, { manager, registry });
    const reg = registry.getManifest("cycled", "wt-1");
    if (!reg) throw new Error("fixture missing");
    await manager.acquire(reg, "c1");

    const events: IpcMessage[] = [];
    const sub = await client.subscribe(
      {
        type: "command",
        action: "modules/subscribe",
        payload: {},
        id: "sub-close",
      },
      { onEvent: (e) => events.push(e) },
    );

    sub.close();
    await new Promise((r) => setTimeout(r, 50));

    // The dispatcher-level emit still fires on the local bus, but the
    // subscribe handler should have detached — no new IPC message arrives.
    await client.send({
      type: "command",
      action: "modules/restart",
      payload: { moduleId: "cycled", scopeUnit: "wt-1" },
      id: "op-restart",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(events.every((e) => !isKind(e, "restarted"))).toBe(true);
  });
});

function isKind(evt: IpcMessage, kind: ModulesEvent["kind"]): boolean {
  return (
    evt.action === "modules/event" &&
    (evt.payload as ModulesEvent | undefined)?.kind === kind
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate did not hold within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
