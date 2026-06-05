/**
 * Proxy transparency invariant tests.
 *
 * Spins up a real upstream `WebSocketServer` (acting as Metro's
 * /inspector/debug), a `CdpProxy` pointing at it, and a real downstream
 * `WebSocket` (acting as Fusebox). Asserts:
 *   - Frames forwarded byte-identically in both directions (Debugger, Runtime,
 *     Network, random JSON all pass through unchanged).
 *   - Events dispatched to `onEvent` callback.
 *   - Proxy-originated commands resolve from upstream responses.
 *   - Proxy ids (>= 1e9) are swallowed (never re-delivered to the tap as
 *     CDP events).
 *   - Upstream close propagates a code 1012 close to downstream.
 *   - Nonce mismatch rejected by server.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { CdpProxy } from "../devtools/proxy.js";
import type { CdpEvent } from "../devtools/domain-tap.js";

// ---------------------------------------------------------------------------
// Test fixture — upstream WebSocketServer acting as Metro
// ---------------------------------------------------------------------------

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function swallowError(ws: WebSocket): WebSocket {
  ws.on("error", () => {
    // Intentionally swallow — we're asserting on error events elsewhere.
  });
  return ws;
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off("error", onErr);
      resolve();
    };
    const onErr = (e: Error) => {
      ws.off("open", onOpen);
      reject(e);
    };
    ws.once("open", onOpen);
    ws.once("error", onErr);
  });
}

interface Fixture {
  upstreamServer: WebSocketServer;
  upstreamUrl: string;
  upstreamSockets: WebSocket[];
  messages: string[];
  teardown: () => Promise<void>;
}

async function startUpstream(): Promise<Fixture> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  const messages: string[] = [];
  server.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("error", () => {
      // swallow
    });
    ws.on("message", (data) => {
      messages.push(typeof data === "string" ? data : data.toString());
    });
  });
  return {
    upstreamServer: server,
    upstreamUrl: `ws://127.0.0.1:${port}`,
    upstreamSockets: sockets,
    messages,
    async teardown() {
      for (const s of sockets) {
        try {
          s.terminate();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function connectFusebox(
  port: number,
  nonce: string
): Promise<WebSocket> {
  const ws = swallowError(new WebSocket(`ws://127.0.0.1:${port}/proxy/${nonce}`));
  await waitForOpen(ws);
  return ws;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CdpProxy transparency", () => {
  let fx: Fixture;
  let proxies: CdpProxy[] = [];
  let fuseboxen: WebSocket[] = [];

  beforeEach(async () => {
    fx = await startUpstream();
  });

  afterEach(async () => {
    for (const ws of fuseboxen) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    fuseboxen = [];
    for (const p of proxies) {
      try {
        await p.stop();
      } catch {
        // ignore
      }
    }
    proxies = [];
    await fx.teardown();
  });

  async function startProxy(
    onEvent?: (e: CdpEvent) => void,
    onUpstreamClose?: (c: number, r: string) => void
  ): Promise<{ proxy: CdpProxy; port: number; nonce: string }> {
    const proxy = new CdpProxy({
      upstreamUrl: fx.upstreamUrl,
      onEvent,
      onUpstreamClose,
    });
    proxies.push(proxy);
    const { port, nonce } = await proxy.start();
    return { proxy, port, nonce };
  }

  async function attachFusebox(port: number, nonce: string): Promise<WebSocket> {
    const ws = await connectFusebox(port, nonce);
    fuseboxen.push(ws);
    // Allow upstream to connect
    await waitMs(50);
    return ws;
  }

  // ------------------------------------------------------------------------

  it("forwards downstream → upstream byte-identically", async () => {
    const { port, nonce } = await startProxy();
    const fusebox = await attachFusebox(port, nonce);

    const payloads = [
      '{"id":1,"method":"Network.enable"}',
      '{"id":2,"method":"Debugger.enable","params":{"maxScriptsCacheSize":10485760}}',
      '{"id":3,"method":"Runtime.enable"}',
    ];
    for (const p of payloads) fusebox.send(p);
    await waitMs(30);
    expect(fx.messages).toEqual(payloads);
  });

  it("forwards upstream → downstream byte-identically", async () => {
    const { port, nonce } = await startProxy();
    const fusebox = await attachFusebox(port, nonce);
    const received: string[] = [];
    fusebox.on("message", (d) => received.push(d.toString()));

    const upstream = fx.upstreamSockets[0]!;
    const events = [
      '{"method":"Debugger.scriptParsed","params":{"scriptId":"42","url":"foo.js"}}',
      '{"method":"Runtime.consoleAPICalled","params":{"type":"log","args":[]}}',
      '{"method":"Network.requestWillBeSent","params":{"requestId":"r1","request":{"url":"https://x","method":"GET","headers":{}},"timestamp":1}}',
    ];
    for (const e of events) upstream.send(e);
    await waitMs(30);
    expect(received).toEqual(events);
  });

  it("dispatches events to onEvent", async () => {
    const seen: CdpEvent[] = [];
    const { port, nonce } = await startProxy((e) => seen.push(e));
    await attachFusebox(port, nonce);

    const upstream = fx.upstreamSockets[0]!;
    upstream.send(
      '{"method":"Network.requestWillBeSent","params":{"requestId":"x","request":{"url":"https://y","method":"GET","headers":{}},"timestamp":1}}'
    );
    await waitMs(30);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("Network.requestWillBeSent");
  });

  it("sendCommand assigns proxy-id and resolves from upstream response", async () => {
    const { proxy, port, nonce } = await startProxy();
    await attachFusebox(port, nonce);

    const upstream = fx.upstreamSockets[0]!;
    upstream.on("message", (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.method === "Network.getResponseBody") {
        upstream.send(
          JSON.stringify({
            id: parsed.id,
            result: { body: "hello", base64Encoded: false },
          })
        );
      }
    });

    const res = await proxy.sendCommand({
      method: "Network.getResponseBody",
      params: { requestId: "r1" },
    });
    expect(res.result).toEqual({ body: "hello", base64Encoded: false });
    expect(res.id).toBeGreaterThanOrEqual(1_000_000_000);
  });

  it("swallows proxy-id responses — not delivered as events", async () => {
    const seen: CdpEvent[] = [];
    const { port, nonce } = await startProxy((e) => seen.push(e));
    await attachFusebox(port, nonce);

    const upstream = fx.upstreamSockets[0]!;
    upstream.send(JSON.stringify({ id: 1_000_000_050, result: { noise: true } }));
    await waitMs(30);
    expect(seen).toHaveLength(0);
  });

  it("upstream close propagates 1012 to downstream", async () => {
    const { port, nonce } = await startProxy();
    const fusebox = await attachFusebox(port, nonce);

    const closePromise = new Promise<number>((resolve) => {
      fusebox.once("close", (code) => resolve(code));
    });
    fx.upstreamSockets[0]!.close();
    const code = await closePromise;
    expect(code).toBe(1012);
  });

  it("notifies onUpstreamClose when upstream goes away", async () => {
    const closes: number[] = [];
    const { port, nonce } = await startProxy(undefined, (code) => closes.push(code));
    await attachFusebox(port, nonce);

    fx.upstreamSockets[0]!.close(1000);
    await waitMs(30);
    expect(closes).toHaveLength(1);
  });

  it("nonce mismatch is rejected by server", async () => {
    const { port } = await startProxy();
    const bad = swallowError(new WebSocket(`ws://127.0.0.1:${port}/proxy/wrong-nonce`));
    fuseboxen.push(bad);

    const closeCode = await new Promise<number>((resolve) => {
      bad.once("close", (code) => resolve(code));
      bad.once("error", () => resolve(-1));
    });
    // Expect either a close (handshake refused) or an error — both mean the
    // server refused the upgrade. Acceptable outcomes: 1006 (abnormal) or -1
    // (error). What's NOT acceptable is a successful open.
    expect(bad.readyState).not.toBe(WebSocket.OPEN);
    expect(closeCode).not.toBe(1000);
  });

  it("server binds to 127.0.0.1", async () => {
    const { proxy } = await startProxy();
    // Access the underlying WebSocketServer to verify bind address.
    // Stored as a private field; read-only view via casting.
    const addr = (proxy as unknown as { server: WebSocketServer | null }).server?.address();
    expect(addr).toBeTruthy();
    if (addr && typeof addr !== "string") {
      expect(addr.address).toBe("127.0.0.1");
    }
  });

  it("sendCommand rejects with upstream-closed when upstream drops mid-flight", async () => {
    const { proxy, port, nonce } = await startProxy();
    await attachFusebox(port, nonce);

    // Upstream silently ignores our command — we'll close it before timeout.
    const p = proxy.sendCommand(
      { method: "Network.getResponseBody", params: { requestId: "r1" } },
      5000
    );
    await waitMs(10);
    fx.upstreamSockets[0]!.close();
    await expect(p).rejects.toThrow(/upstream-closed/);
  });

  it("Bug A regression — downstream connect against an unreachable upstream does not bubble an unhandled rejection", async () => {
    // Repro: DevToolsManager creates a proxy with the placeholder URL
    // `ws://127.0.0.1:<metro-port>/inspector/no-target` while no Hermes
    // target is selected. When Fusebox connects to that proxy, the proxy
    // calls `void this.openUpstream()` — pre-fix, the rejected promise
    // bubbled as an unhandled rejection and crashed the daemon under
    // Bun's default unhandled-rejection policy. Captured in
    // ~/.rn-dev/logs/daemon-acme-mobile-app-2026-05-04T20-57-23-814Z.log.

    // Capture any unhandled rejection that fires during this test.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      // Pick a random unused port for the unreachable upstream.
      const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((r) => probe.once("listening", () => r()));
      const unusedPort = (probe.address() as AddressInfo).port;
      await new Promise<void>((r) => probe.close(() => r()));

      const proxy = new CdpProxy({
        upstreamUrl: `ws://127.0.0.1:${unusedPort}/inspector/no-target`,
        // No onError, no onUpstreamClose — mirrors the no-target call site
        // in src/core/devtools.ts:210-214.
      });
      proxies.push(proxy);
      const { port, nonce } = await proxy.start();

      const fusebox = await connectFusebox(port, nonce);
      fuseboxen.push(fusebox);

      // Give openUpstream time to try, fail, and (pre-fix) throw.
      await waitMs(150);

      expect(
        rejections,
        `Unhandled rejection bubbled from CdpProxy.openUpstream — daemon would crash under Bun. Captured: ${rejections
          .map((r) => (r instanceof Error ? r.message : String(r)))
          .join("; ")}`,
      ).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("eagerUpstream — start() resolves within the deadline when the upstream hangs", async () => {
    // Repro: a wedged Hermes inspector accepts the TCP connect but never
    // completes the WS upgrade. Pre-fix, `proxy.start()` awaited the open
    // promise forever — and since DevToolsManager.restart() awaits start()
    // two layers under the daemon's IPC subscribe-send (CLIENT_TIMEOUT_MS
    // = 5_000ms), the Reconnect button surfaced
    // `subscribe.send: timeout after 5000ms` with no actionable context.
    // Captured against acme-mobile-app on 2026-05-21.

    // Track every accepted connection so teardown can destroy them
    // synchronously. server.close() only stops accepting new connections;
    // open ones drain on their own schedule, and the `ws` client's TCP
    // socket stays half-open even after we proxy.stop() / terminate(),
    // because `ws` issues TCP RST asynchronously. Without destroying the
    // server-side socket explicitly, hangingUpstream.close() blocks past
    // the test's 5s budget.
    const acceptedSockets = new Set<import("node:net").Socket>();
    const hangingUpstream: TcpServer = createTcpServer((socket) => {
      acceptedSockets.add(socket);
      socket.on("close", () => acceptedSockets.delete(socket));
      // Never write a response — the `ws` client stays in CONNECTING.
    });
    await new Promise<void>((r) =>
      hangingUpstream.listen(0, "127.0.0.1", () => r()),
    );
    const hangPort = (hangingUpstream.address() as AddressInfo).port;

    const errors: Error[] = [];
    const proxy = new CdpProxy({
      upstreamUrl: `ws://127.0.0.1:${hangPort}/inspector/debug`,
      eagerUpstream: true,
      onError: (err) => errors.push(err),
    });
    proxies.push(proxy);

    const startedAt = Date.now();
    const handle = await proxy.start();
    const elapsed = Date.now() - startedAt;

    // 3_000ms deadline + 1_000ms scheduler slack. A pre-fix run sat here
    // until the test timeout (default 5_000ms) blew up the suite.
    expect(elapsed).toBeLessThan(4_000);
    expect(handle.port).toBeGreaterThan(0);
    expect(typeof handle.nonce).toBe("string");
    expect(handle.nonce.length).toBeGreaterThan(0);
    expect(
      errors.some((e) => /eager upstream did not open/i.test(e.message)),
      `Expected an onError call signaling the deadline. Got: ${errors
        .map((e) => e.message)
        .join("; ")}`,
    ).toBe(true);

    await proxy.stop();
    for (const s of acceptedSockets) s.destroy();
    await new Promise<void>((r) => hangingUpstream.close(() => r()));
  });
});
