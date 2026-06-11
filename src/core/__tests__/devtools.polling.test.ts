/**
 * `/json` polling + preemption detection (Phase 3 Track C).
 *
 * Covers the two Phase 3 polish items that close known Phase 2 gaps:
 *
 *   1. Periodic `/json` polling — detects new targets and Hermes reloads
 *      without requiring the user to hit "Reconnect". Tests drive the
 *      poll manually by calling `manager.pollTargets(state)` instead of
 *      waiting for the interval timer, which keeps them fast.
 *
 *   2. Preemption detection — on unexpected upstream close, poll `/json`
 *      immediately: if the target is still listed, mark `'preempted'`
 *      (shared-device contention); otherwise `'no-target'` (Hermes
 *      reloaded / target disappeared).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { MetroManager } from "../metro.js";
import type { MetroInstance } from "../types.js";
import { asSessionId, type SessionId } from "../identifiers.js";
import { DevToolsManager } from "../devtools.js";

function sid(s: string): SessionId {
  return asSessionId(s);
}

// ---------------------------------------------------------------------------
// Fixture — mutable target list so tests can simulate Hermes reloads,
// new targets appearing, and target disappearance.
// ---------------------------------------------------------------------------

interface MetroFake extends EventEmitter {
  getInstance(sessionId: SessionId): MetroInstance | undefined;
  setInstance(sessionId: SessionId, instance: MetroInstance | undefined): void;
}

function makeMetroFake(): MetroFake {
  const bus = new EventEmitter() as MetroFake;
  const instances = new Map<string, MetroInstance>();
  bus.getInstance = (k) => instances.get(k as string);
  bus.setInstance = (k, i) => {
    if (i) instances.set(k as string, i);
    else instances.delete(k as string);
  };
  return bus;
}

interface MutableEnv {
  http: HttpServer;
  ws: WebSocketServer;
  metroPort: number;
  /** Replace the `/json` response. */
  setTargets(targets: object[]): void;
  /** Close every upstream WS client — simulates Hermes dropping us. */
  closeUpstream(): void;
  teardown(): Promise<void>;
}

async function startMutableEnv(initial: object[]): Promise<MutableEnv> {
  let currentTargets: object[] = initial;
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => ws.once("listening", () => r()));
  const wsAddr = ws.address() as AddressInfo;
  const inspectorPath = `/inspector/debug?device=dev&page=1`;
  ws.on("connection", () => {
    /* accept */
  });

  const http = createHttpServer((req, res) => {
    if (req.url === "/json") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          currentTargets.map((t) => ({
            ...t,
            webSocketDebuggerUrl: `ws://127.0.0.1:${wsAddr.port}${inspectorPath}`,
          }))
        )
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const metroPort = (http.address() as AddressInfo).port;

  const closeUpstream = (): void => {
    for (const c of ws.clients) c.close();
  };

  return {
    http,
    ws,
    metroPort,
    setTargets(targets) {
      currentTargets = targets;
    },
    closeUpstream,
    async teardown() {
      try {
        ws.clients.forEach((c) => c.terminate());
      } catch {
        // ignore
      }
      await new Promise<void>((r) => ws.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Internal accessor — polling is a per-worktree method, but the
// WorktreeState isn't exported. Tests reach into the manager via a small
// cast so they can trigger polls deterministically without waiting on
// the interval timer.
function pollNow(mgr: DevToolsManager, sessionId: SessionId): Promise<void> {
  const state = (mgr as unknown as {
    instances: Map<SessionId, unknown>;
  }).instances.get(sessionId);
  if (!state) throw new Error(`no state for session ${sessionId}`);
  return (mgr as unknown as {
    pollTargets: (s: unknown) => Promise<void>;
  }).pollTargets(state);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DevToolsManager `/json` polling + preemption", () => {
  let env: MutableEnv;
  let metro: MetroFake;
  let mgr: DevToolsManager;

  beforeEach(async () => {
    env = await startMutableEnv([
      { id: "abc", type: "node", title: "App" },
    ]);
    metro = makeMetroFake();
    metro.setInstance(sid("w1"), {
      sessionId: sid("w1"),
      worktree: "w1",
      port: env.metroPort,
      pid: 1,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });
    // Disable the interval timer — tests drive polls manually.
    mgr = new DevToolsManager(metro as unknown as MetroManager, {
      deltaFlushIntervalMs: 30,
      pollIntervalMs: 0,
    });
    await mgr.start(sid("w1"));
    await waitMs(30);
  });

  afterEach(async () => {
    await mgr.stopAll();
    await env.teardown();
  });

  it("pollTargets picks up a new target that appeared after start()", async () => {
    env.setTargets([
      { id: "abc", type: "node", title: "App" },
      { id: "def", type: "node", title: "AppNew" },
    ]);
    const before = mgr.status(sid("w1")).targets.length;
    expect(before).toBe(1);

    await pollNow(mgr, sid("w1"));

    const after = mgr.status(sid("w1")).targets.map((t) => t.id).sort();
    expect(after).toEqual(["abc", "def"]);
  });

  it("pollTargets detects when the selected target disappears (Hermes reload)", async () => {
    // Selected target goes away — simulate Hermes reload from our POV.
    env.setTargets([{ id: "other", type: "node", title: "Different" }]);

    await pollNow(mgr, sid("w1"));

    const status = mgr.status(sid("w1"));
    // `'connected'` was downgraded to `'no-target'` because our selected
    // target vanished from /json.
    expect(status.meta.proxyStatus).toBe("no-target");
    expect(status.targets.map((t) => t.id)).toEqual(["other"]);
  });

  it("pollTargets does NOT override 'preempted' status (preemption is stronger)", async () => {
    // Force preempted state first.
    env.closeUpstream();
    await waitMs(200);
    expect(mgr.status(sid("w1")).meta.proxyStatus).toBe("preempted");

    // Polling shouldn't revert preemption to no-target or connected — the
    // preemption signal means the target is there but held by someone
    // else. The user (or a reconnect action) decides when to try again.
    await pollNow(mgr, sid("w1"));

    expect(mgr.status(sid("w1")).meta.proxyStatus).toBe("preempted");
  });

  it("pollTargets emits a 'status' event when targets change", async () => {
    const events: unknown[] = [];
    mgr.on("status", (p) => events.push(p));

    env.setTargets([
      { id: "abc", type: "node", title: "App" },
      { id: "def", type: "node", title: "NewOne" },
    ]);

    await pollNow(mgr, sid("w1"));

    expect(events.length).toBeGreaterThan(0);
  });

  it("pollTargets does NOT emit 'status' when nothing changed", async () => {
    const events: unknown[] = [];
    mgr.on("status", (p) => events.push(p));

    await pollNow(mgr, sid("w1"));

    // Targets unchanged, selected target still listed → nothing to emit.
    expect(events).toHaveLength(0);
  });
});

describe("DevToolsManager preemption detection (immediate /json re-poll)", () => {
  let env: MutableEnv;
  let metro: MetroFake;
  let mgr: DevToolsManager;

  beforeEach(async () => {
    env = await startMutableEnv([
      { id: "abc", type: "node", title: "App" },
    ]);
    metro = makeMetroFake();
    metro.setInstance(sid("w1"), {
      sessionId: sid("w1"),
      worktree: "w1",
      port: env.metroPort,
      pid: 1,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });
    mgr = new DevToolsManager(metro as unknown as MetroManager, {
      deltaFlushIntervalMs: 30,
      pollIntervalMs: 0,
    });
    await mgr.start(sid("w1"));
    await waitMs(30);
  });

  afterEach(async () => {
    await mgr.stopAll();
    await env.teardown();
  });

  it("upstream close with target still listed → 'preempted'", async () => {
    // Target stays listed in /json. Upstream close means something else
    // kicked us off — classic shared-device contention.
    env.closeUpstream();
    await waitMs(200);
    expect(mgr.status(sid("w1")).meta.proxyStatus).toBe("preempted");
  });

  it("upstream close with target gone from /json → 'no-target'", async () => {
    // Hermes reloaded / target gone. Different recovery path — NOT a
    // preemption.
    env.setTargets([]);
    env.closeUpstream();
    await waitMs(200);
    expect(mgr.status(sid("w1")).meta.proxyStatus).toBe("no-target");
  });
});

// ---------------------------------------------------------------------------
// Same-target reconnect — the iOS suspend/resume shape (2026-06-11 acme
// battle-test). The device suspends the app (upstream ws closes, target
// delisted from /json), then resume re-registers the IDENTICAL
// device-hash/page id. Pre-fix this landed in a permanent `no-target`:
// auto-arm requires `selectedTargetId === null`, and select-target's
// same-id shortcut flushed enables into the dead socket.
// ---------------------------------------------------------------------------

describe("DevToolsManager same-target reconnect (iOS suspend/resume)", () => {
  let env: MutableEnv;
  let metro: MetroFake;
  let mgr: DevToolsManager;

  beforeEach(async () => {
    env = await startMutableEnv([
      { id: "abc", type: "node", title: "App" },
    ]);
    metro = makeMetroFake();
    metro.setInstance(sid("w1"), {
      sessionId: sid("w1"),
      worktree: "w1",
      port: env.metroPort,
      pid: 1,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });
    mgr = new DevToolsManager(metro as unknown as MetroManager, {
      deltaFlushIntervalMs: 30,
      pollIntervalMs: 0,
    });
    await mgr.start(sid("w1"));
    await waitMs(30);
  });

  afterEach(async () => {
    await mgr.stopAll();
    await env.teardown();
  });

  /** Drive the session into the suspend posture: target delisted +
   *  upstream closed → `no-target` with the stale selection retained. */
  async function suspendApp(): Promise<void> {
    env.setTargets([]);
    env.closeUpstream();
    await waitMs(200);
    expect(mgr.status(sid("w1")).meta.proxyStatus).toBe("no-target");
    expect(mgr.status(sid("w1")).meta.selectedTargetId).toBe("abc");
  }

  it("pollTargets re-dials when the selected target reappears under the same id", async () => {
    await suspendApp();

    // Resume: the same target id re-registers.
    env.setTargets([{ id: "abc", type: "node", title: "App" }]);
    await pollNow(mgr, sid("w1"));
    // attachProxyToTarget runs async off the poll tick — give the ws
    // round-trip a moment.
    await waitMs(300);

    const status = mgr.status(sid("w1"));
    expect(status.meta.proxyStatus).toBe("connected");
    expect(status.meta.selectedTargetId).toBe("abc");
  });

  it("selectTarget with the same id over a dead upstream does a full re-dial", async () => {
    await suspendApp();
    env.setTargets([{ id: "abc", type: "node", title: "App" }]);
    // Refresh `state.targets` (selectTarget validates against it). The
    // poll's recovery branch may or may not win the race first — either
    // way, a same-id re-select must leave the session connected.
    // Pre-fix it silently no-op'd against the dead socket.
    await pollNow(mgr, sid("w1")).catch(() => undefined);
    await waitMs(300);

    await mgr.selectTarget(sid("w1"), "abc");
    await waitMs(200);

    expect(mgr.status(sid("w1")).meta.proxyStatus).toBe("connected");
  });

  it("reconnect does NOT fire while 'preempted' (another frontend owns the target)", async () => {
    // Upstream closes but the target stays listed → preempted.
    env.closeUpstream();
    await waitMs(200);
    expect(mgr.status(sid("w1")).meta.proxyStatus).toBe("preempted");

    // Polling must not auto-redial a preempted target — that would fight
    // the other frontend for the slot.
    await pollNow(mgr, sid("w1"));
    await waitMs(200);
    expect(mgr.status(sid("w1")).meta.proxyStatus).toBe("preempted");
  });
});
