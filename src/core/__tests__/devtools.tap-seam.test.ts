/**
 * DomainTap seam validation.
 *
 * Pre-Phase-3 architectural gate. The plan's "Console subtool is purely
 * additive" success metric (plan §Success Metrics) is only real if
 * registering a second tap requires zero changes to `proxy.ts` or the
 * DevToolsManager core lifecycle code. These tests prove that by:
 *
 *   1. Registering a `StubConsoleTap` via `DevToolsManager.registerTap`.
 *   2. Asserting events are dispatched by domain prefix — Console events
 *      reach ConsoleTap only; Network events reach NetworkTap only.
 *   3. Asserting enable commands from BOTH taps are flushed upstream on
 *      attach.
 *   4. Asserting both taps receive `detach()` on manager stop.
 *   5. Asserting session-boundary propagation touches every tap's ring.
 *
 * `proxy.ts` is intentionally imported nowhere in this file — the seam
 * validation exercises only the manager's public API, mirroring how a real
 * third-party tap author would plug in.
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
import type {
  AnyDomainTap,
  CdpCommand,
  CdpEvent,
  RingBuffer,
  TapDispatch,
} from "../devtools/domain-tap.js";
import { createRingBuffer } from "../devtools/domain-tap.js";

// ---------------------------------------------------------------------------
// StubConsoleTap — the fixture that proves the seam
// ---------------------------------------------------------------------------

interface ConsoleStubEntry {
  id: string;
  method: string;
}

class StubConsoleTap implements AnyDomainTap {
  readonly domain = "Console";
  readonly enableCommands: readonly CdpCommand[] = [
    { method: "Console.enable" },
    { method: "Runtime.enable" }, // multi-command enable — exercised too
  ];
  readonly ring: RingBuffer<ConsoleStubEntry>;

  events: CdpEvent[] = [];
  attachCount = 0;
  detachCount = 0;
  dispatch: TapDispatch | null = null;

  constructor() {
    this.ring = createRingBuffer<ConsoleStubEntry>(10);
  }

  attach(dispatch: TapDispatch): void {
    this.attachCount += 1;
    this.dispatch = dispatch;
  }

  detach(): void {
    this.detachCount += 1;
    this.dispatch = null;
  }

  handleEvent(evt: CdpEvent): void {
    this.events.push(evt);
    this.ring.upsert(`${this.events.length}`, (_prev, _seq, _ver) => ({
      id: `${this.events.length}`,
      method: evt.method,
    }));
  }
}

// ---------------------------------------------------------------------------
// Metro fixtures — copied (intentionally) from devtools.test.ts so changes
// there don't silently break this seam test.
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
    else instances.delete(k);
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
  receivedFromProxy: string[];
  teardown(): Promise<void>;
}

async function startMetroEnv(
  target: (port: number, wsPath: string) => object[]
): Promise<MetroEnv> {
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => ws.once("listening", () => r()));
  const wsAddr = ws.address() as AddressInfo;
  const inspectorPath = `/inspector/debug?device=dev&page=1`;
  let live: WsSocket | null = null;
  const receivedFromProxy: string[] = [];
  ws.on("connection", (sock) => {
    live = sock;
    sock.on("message", (data) => {
      receivedFromProxy.push(data.toString("utf8"));
    });
  });
  const send = (frame: string) => {
    if (live && live.readyState === 1) live.send(frame);
  };

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
    receivedFromProxy,
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

describe("DomainTap seam (pre-Phase-3 architectural gate)", () => {
  let env: MetroEnv;
  let metro: MetroFake;
  let mgr: DevToolsManager;
  let stub: StubConsoleTap;

  beforeEach(async () => {
    env = await startMetroEnv((wsPort, wsPath) => [
      {
        id: "abc",
        type: "node",
        title: "App",
        webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}${wsPath}`,
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
    stub = new StubConsoleTap();
    mgr.registerTap(() => stub);
  });

  afterEach(async () => {
    await mgr.stopAll();
    await env.teardown();
  });

  it("registered stub tap is attached on start()", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    expect(stub.attachCount).toBe(1);
  });

  it("flushes enable commands from every registered tap", async () => {
    await mgr.start(sid("w1"));
    await waitMs(50);
    // Upstream should have received Network.enable (built-in) AND
    // Console.enable + Runtime.enable (stub). We assert on presence, not
    // order — enable commands are fire-and-forget.
    const methods = env.receivedFromProxy
      .map((raw) => {
        try {
          return (JSON.parse(raw) as { method?: string }).method;
        } catch {
          return undefined;
        }
      })
      .filter((m): m is string => typeof m === "string");
    expect(methods).toContain("Network.enable");
    expect(methods).toContain("Console.enable");
    expect(methods).toContain("Runtime.enable");
  });

  it("dispatches Console events only to the Console tap", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    env.send(
      JSON.stringify({
        method: "Console.messageAdded",
        params: { message: { level: "log", text: "hello" } },
      })
    );
    await waitMs(30);
    expect(stub.events.map((e) => e.method)).toEqual(["Console.messageAdded"]);
    // NetworkTap's ring must stay empty — it never saw the Console event.
    expect(mgr.listNetwork(sid("w1")).entries).toHaveLength(0);
  });

  it("dispatches Network events only to the Network tap", async () => {
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
    expect(mgr.listNetwork(sid("w1")).entries).toHaveLength(1);
    expect(stub.events).toHaveLength(0);
  });

  it("propagates metro-restart session boundary to every tap's ring", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    // Seed one entry in each tap so we can see the epoch bump clearly.
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
    env.send(
      JSON.stringify({
        method: "Console.messageAdded",
        params: { message: { text: "hi" } },
      })
    );
    await waitMs(30);
    const networkEpochBefore = mgr.status(sid("w1")).meta.bufferEpoch;
    const stubEpochBefore = stub.ring.state.bufferEpoch;

    metro.emit("status", { sessionId: sid("w1"), worktreeKey: "w1", status: "stopped" });

    const networkEpochAfter = mgr.status(sid("w1")).meta.bufferEpoch;
    expect(networkEpochAfter).toBe(networkEpochBefore + 1);
    expect(stub.ring.state.bufferEpoch).toBe(stubEpochBefore + 1);
    expect(stub.ring.state.sessionBoundary?.reason).toBe("metro-restart");
  });

  it("detaches every registered tap on stop()", async () => {
    await mgr.start(sid("w1"));
    await waitMs(30);
    await mgr.stop(sid("w1"));
    expect(stub.detachCount).toBeGreaterThanOrEqual(1);
  });

  it("stub tap without Network.* handler doesn't break Network capture", async () => {
    // Regression guard: the manager must not assume taps handle every event.
    // NetworkTap should still populate its ring even when a second tap is
    // registered and receives an unrelated event right before.
    await mgr.start(sid("w1"));
    await waitMs(30);
    env.send(
      JSON.stringify({
        method: "Console.messageAdded",
        params: { message: { text: "first" } },
      })
    );
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
    expect(mgr.listNetwork(sid("w1")).entries.map((e) => e.requestId)).toEqual(["r1"]);
    expect(stub.events.map((e) => e.method)).toEqual(["Console.messageAdded"]);
  });
});
