/**
 * DevToolsManager integration tests.
 *
 * Uses real HTTP + WebSocket fixtures in place of Metro / Fusebox. Mocks
 * MetroManager as an EventEmitter exposing `getInstance(worktreeKey)`.
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

// Phase D3: DevToolsManager now keys per-session, so the fake's
// getInstance lookup happens by SessionId, not worktreeKey. The
// tests in this file use the same "w1" string for both dimensions
// (single session per test) — the brand sugar keeps the typed
// arguments clean without changing test semantics.
function sid(s: string): SessionId {
  return asSessionId(s);
}

// ---------------------------------------------------------------------------
// Fixtures
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

interface MetroEnv {
  http: HttpServer;
  ws: WebSocketServer;
  metroPort: number;
  wsPort: number;
  inspectorPath: string;
  send(frame: string): void;
  teardown(): Promise<void>;
}

async function startMetroEnv(
  target: (port: number, wsPath: string) => object[]
): Promise<MetroEnv> {
  // Upstream WebSocket server (Metro /inspector/debug stand-in)
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => ws.once("listening", () => r()));
  const wsAddr = ws.address() as AddressInfo;
  const inspectorPath = `/inspector/debug?device=dev&page=1`;
  let live: import("ws").WebSocket | null = null;
  ws.on("connection", (sock) => {
    live = sock;
  });
  const send = (frame: string) => {
    if (live && live.readyState === 1) live.send(frame);
  };

  // HTTP server for /json
  const http = createHttpServer((req, res) => {
    if (req.url === "/json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(target(wsAddr.port, inspectorPath)));
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
    wsPort: wsAddr.port,
    inspectorPath,
    send,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DevToolsManager", () => {
  let env: MetroEnv;
  let metro: MetroFake;
  let mgr: DevToolsManager;

  beforeEach(async () => {
    env = await startMetroEnv((wsPort, wsPath) => [
      {
        id: "abc",
        type: "node",
        title: "My App",
        webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}${wsPath}`,
        devtoolsFrontendUrl: "/debugger-frontend/rn_fusebox.html?ws=...",
      },
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
    });
  });

  afterEach(async () => {
    await mgr.stopAll();
    await env.teardown();
  });

  it("start fetches /json, picks target, connects upstream", async () => {
    const { proxyPort, sessionNonce } = await mgr.start(sid("w1"));
    expect(proxyPort).toBeGreaterThan(0);
    expect(sessionNonce).toHaveLength(32);
    const status = mgr.status(sid("w1"));
    expect(status.meta.proxyStatus).toBe("connected");
    expect(status.meta.selectedTargetId).toBe("abc");
    expect(status.targets.map((t) => t.id)).toEqual(["abc"]);
  });

  it("dispatches Network events to the tap and populates ring", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    env.send(
      JSON.stringify({
        method: "Network.requestWillBeSent",
        params: {
          requestId: "r1",
          request: {
            url: "https://api.example/health",
            method: "GET",
            headers: { Authorization: "Bearer xyz" },
          },
          timestamp: 1,
        },
      })
    );
    await waitMs(30);
    const list = mgr.listNetwork(sid("w1"));
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]!.requestId).toBe("r1");
    expect(list.entries[0]!.requestHeaders.Authorization).toBe("[REDACTED]");
  });

  it("filter: urlRegex narrows results", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    for (const [id, url] of [
      ["r1", "https://api.example/a"],
      ["r2", "https://api.example/b"],
      ["r3", "https://other/c"],
    ]) {
      env.send(
        JSON.stringify({
          method: "Network.requestWillBeSent",
          params: {
            requestId: id,
            request: { url, method: "GET", headers: {} },
            timestamp: 1,
          },
        })
      );
    }
    await waitMs(30);
    const list = mgr.listNetwork(sid("w1"), { urlRegex: "example" });
    expect(list.entries.map((e) => e.requestId).sort()).toEqual(["r1", "r2"]);
  });

  it("cursor eviction sets cursorDropped", async () => {
    mgr = new DevToolsManager(metro as unknown as MetroManager, {
      ringCapacity: 2,
      deltaFlushIntervalMs: 30,
    });
    await mgr.start(sid("w1"));
    await waitMs(30);
    for (const id of ["r1", "r2", "r3"]) {
      env.send(
        JSON.stringify({
          method: "Network.requestWillBeSent",
          params: {
            requestId: id,
            request: { url: "https://x", method: "GET", headers: {} },
            timestamp: 1,
          },
        })
      );
    }
    await waitMs(50);
    const cursor = { bufferEpoch: 1, sequence: 0, __brand: "NetworkCursor" } as const;
    const list = mgr.listNetwork(sid("w1"), {
      since: cursor as never,
    });
    expect(list.cursorDropped).toBe(true);
    expect(list.entries.map((e) => e.requestId)).toEqual(["r2", "r3"]);
  });

  it("clear bumps bufferEpoch with reason 'clear'", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    env.send(
      JSON.stringify({
        method: "Network.requestWillBeSent",
        params: {
          requestId: "r1",
          request: { url: "https://x", method: "GET", headers: {} },
          timestamp: 1,
        },
      })
    );
    await waitMs(30);
    const before = mgr.status(sid("w1")).meta.bufferEpoch;
    mgr.clear(sid("w1"));
    const after = mgr.status(sid("w1"));
    expect(after.meta.bufferEpoch).toBe(before + 1);
    expect(after.meta.sessionBoundary?.reason).toBe("clear");
    expect(mgr.listNetwork(sid("w1")).entries).toHaveLength(0);
  });

  it("emits delta events (coalesced)", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    const deltas: unknown[] = [];
    mgr.on("delta", (d) => deltas.push(d));
    env.send(
      JSON.stringify({
        method: "Network.requestWillBeSent",
        params: {
          requestId: "r1",
          request: { url: "https://x", method: "GET", headers: {} },
          timestamp: 1,
        },
      })
    );
    await waitMs(100);
    expect(deltas.length).toBeGreaterThan(0);
    const d = deltas[0] as { addedIds: string[]; worktreeKey: string };
    expect(d.worktreeKey).toBe("w1");
    expect(d.addedIds).toEqual(["r1"]);
  });

  it("metro 'stopped' status bumps session boundary with reason 'metro-restart'", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    const before = mgr.status(sid("w1")).meta.bufferEpoch;
    metro.emit("status", { sessionId: sid("w1"), worktreeKey: "w1", status: "stopped" });
    const after = mgr.status(sid("w1"));
    expect(after.meta.bufferEpoch).toBe(before + 1);
    expect(after.meta.sessionBoundary?.reason).toBe("metro-restart");
    expect(after.meta.proxyStatus).toBe("no-target");
  });

  it("upstream close triggers RECONNECTING + preemption detection", async () => {
    // After the upstream close we poll /json; the Metro HTTP fixture is
    // still up and still lists the target, so the manager correctly
    // identifies this as a preemption scenario (someone else is holding
    // the upstream). The immediate `'disconnected'` flip happens first
    // but the preemption check races to replace it — accept either the
    // transient or the terminal.
    await mgr.start(sid("w1"));
    await waitMs(30);
    for (const c of env.ws.clients) c.close();
    await waitMs(200);
    expect(mgr.status(sid("w1")).meta.proxyStatus).toBe("preempted");
  });

  it("stop tears down proxy and removes state", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    await mgr.stop(sid("w1"));
    // After stop, status returns an empty meta (no-target) — state was deleted.
    const status = mgr.status(sid("w1"));
    expect(status.proxyPort).toBeNull();
    expect(status.sessionNonce).toBeNull();
  });

  it("cursor() returns a branded cursor at end-of-buffer", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    env.send(
      JSON.stringify({
        method: "Network.requestWillBeSent",
        params: {
          requestId: "r1",
          request: { url: "https://x", method: "GET", headers: {} },
          timestamp: 1,
        },
      })
    );
    await waitMs(30);
    const cursor = mgr.cursor(sid("w1"));
    expect(cursor).toBeTruthy();
    expect(cursor!.bufferEpoch).toBe(1);
    expect(cursor!.sequence).toBe(1);
  });

  it("no targets → proxy in 'no-target' state", async () => {
    await env.teardown();
    env = await startMetroEnv(() => []); // empty target list
    metro.setInstance(sid("w1"), {
      sessionId: sid("w1"),
      worktree: "w1",
      port: env.metroPort,
      pid: 1,
      status: "running",
      startedAt: new Date(),
      projectRoot: "/tmp",
    });
    await mgr.start(sid("w1"));
    const status = mgr.status(sid("w1"));
    expect(status.meta.proxyStatus).toBe("no-target");
    expect(status.targets).toEqual([]);
  });
});
