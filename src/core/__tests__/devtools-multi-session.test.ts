/**
 * Phase D3 — DevToolsManager multi-session capability test.
 *
 * Pins the invariant that two `start()` calls with different
 * `sessionId`s coexist as two distinct `SessionState` entries on a
 * single manager. The MetroManager is also keyed by sessionId after
 * D3, so the lookup in `DevToolsManager.start` resolves each session's
 * own MetroInstance — even when the underlying worktreeKey is shared.
 *
 * Uses local HTTP fixtures in place of Metro so the assertion stays
 * fast + deterministic — same fixture shape as devtools.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { MetroManager } from "../metro.js";
import type { MetroInstance } from "../types.js";
import { asSessionId, type SessionId } from "../identifiers.js";
import { DevToolsManager } from "../devtools.js";

function sid(s: string): SessionId {
  return asSessionId(s);
}

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

interface MetroEnv {
  http: HttpServer;
  ws: WebSocketServer;
  metroPort: number;
  teardown(): Promise<void>;
}

async function startMetroEnv(): Promise<MetroEnv> {
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => ws.once("listening", () => r()));
  const wsAddr = ws.address() as AddressInfo;
  const wsPath = `/inspector/debug?device=dev&page=1`;

  const http = createHttpServer((req, res) => {
    if (req.url === "/json") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "abc",
            type: "node",
            title: "App",
            webSocketDebuggerUrl: `ws://127.0.0.1:${wsAddr.port}${wsPath}`,
          },
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const metroPort = (http.address() as AddressInfo).port;

  return {
    http,
    ws,
    metroPort,
    async teardown() {
      try {
        ws.clients.forEach((c) => c.terminate());
      } catch {
        /* best-effort */
      }
      await new Promise<void>((r) => ws.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

describe("DevToolsManager multi-session (Phase D3)", () => {
  let envA: MetroEnv;
  let envB: MetroEnv;
  let metro: MetroFake;
  let mgr: DevToolsManager;

  beforeEach(async () => {
    envA = await startMetroEnv();
    envB = await startMetroEnv();
    metro = makeMetroFake();
    mgr = new DevToolsManager(metro as unknown as MetroManager, {
      deltaFlushIntervalMs: 50,
      pollIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await mgr.stopAll();
    await envA.teardown();
    await envB.teardown();
  });

  it("two start() calls with different sessionIds + shared worktreeKey produce two distinct SessionStates", async () => {
    const sidA = sid("session-A");
    const sidB = sid("session-B");
    const wt = "shared-worktree-hash";

    metro.setInstance(sidA, {
      sessionId: sidA,
      worktree: wt,
      port: envA.metroPort,
      pid: 1,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });
    metro.setInstance(sidB, {
      sessionId: sidB,
      worktree: wt,
      port: envB.metroPort,
      pid: 2,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });

    const a = await mgr.start(sidA);
    const b = await mgr.start(sidB);

    // Two distinct proxy ports — each session got its own CdpProxy.
    expect(a.proxyPort).not.toBe(b.proxyPort);
    expect(a.sessionNonce).not.toBe(b.sessionNonce);

    // status() per-session reflects its own meta — both should be
    // 'connected' (each has its own upstream target).
    const statusA = mgr.status(sidA);
    const statusB = mgr.status(sidB);
    expect(statusA.proxyPort).toBe(a.proxyPort);
    expect(statusB.proxyPort).toBe(b.proxyPort);
    expect(statusA.meta.proxyStatus).toBe("connected");
    expect(statusB.meta.proxyStatus).toBe("connected");
  });

  it("stop(sessionId) tears down only the named session, leaving the sibling alive", async () => {
    const sidA = sid("alpha");
    const sidB = sid("beta");
    const wt = "wt-shared";

    metro.setInstance(sidA, {
      sessionId: sidA,
      worktree: wt,
      port: envA.metroPort,
      pid: 1,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });
    metro.setInstance(sidB, {
      sessionId: sidB,
      worktree: wt,
      port: envB.metroPort,
      pid: 2,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });

    await mgr.start(sidA);
    await mgr.start(sidB);

    await mgr.stop(sidB);
    // sidA still resolves; sidB no longer does.
    expect(mgr.status(sidA).proxyPort).not.toBeNull();
    expect(mgr.status(sidB).proxyPort).toBeNull();
  });

  it("delta events emit sessionId so subscribers can route to the right session", async () => {
    const sidA = sid("alpha");
    const sidB = sid("beta");

    metro.setInstance(sidA, {
      sessionId: sidA,
      worktree: "wt",
      port: envA.metroPort,
      pid: 1,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });
    metro.setInstance(sidB, {
      sessionId: sidB,
      worktree: "wt",
      port: envB.metroPort,
      pid: 2,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });

    const captured: Array<{ sessionId?: SessionId; worktreeKey?: string }> = [];
    mgr.on("status", (payload) => {
      captured.push(payload as { sessionId?: SessionId; worktreeKey?: string });
    });

    await mgr.start(sidA);
    await mgr.start(sidB);

    // Both sessionIds appear in the status fan-out — never crossed.
    const sids = new Set(captured.map((p) => p.sessionId));
    expect(sids.has(sidA)).toBe(true);
    expect(sids.has(sidB)).toBe(true);
  });
});
