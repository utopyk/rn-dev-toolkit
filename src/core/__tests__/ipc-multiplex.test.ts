import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { IpcClient, IpcServer } from "../ipc.js";

describe("IpcClient.subscribe multiplex", () => {
  const sockets: string[] = [];

  afterEach(() => {
    for (const s of sockets.splice(0)) {
      try { fs.unlinkSync(s); } catch { /* ignore */ }
    }
  });

  function makeSock(): string {
    const p = path.join(os.tmpdir(), `mux-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    sockets.push(p);
    return p;
  }

  it("send() over a subscribed socket correlates response by id", async () => {
    const sockPath = makeSock();
    const server = new IpcServer(sockPath);
    server.on("message", ({ message, reply }) => {
      if (message.action === "events/subscribe") {
        reply({
          type: "response",
          action: "events/subscribe",
          id: message.id,
          payload: { subscribed: true },
        });
      } else if (message.action === "echo") {
        reply({
          type: "response",
          action: "echo",
          id: message.id,
          payload: { ok: true, echoed: (message.payload as { v: number }).v },
        });
      }
    });
    await server.start();

    const client = new IpcClient(sockPath);
    const sub = await client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1" },
      { onEvent: () => {} },
    );

    const r = await sub.send({
      type: "command",
      action: "echo",
      id: "rpc-1",
      payload: { v: 42 },
    });
    expect(r.id).toBe("rpc-1");
    expect((r.payload as { ok: boolean; echoed: number }).ok).toBe(true);
    expect((r.payload as { ok: boolean; echoed: number }).echoed).toBe(42);

    sub.close();
    await server.stop();
  });

  it("send() rejects on timeout", async () => {
    const sockPath = makeSock();
    const server = new IpcServer(sockPath);
    server.on("message", ({ message, reply }) => {
      if (message.action === "events/subscribe") {
        reply({ type: "response", action: "events/subscribe", id: message.id, payload: { subscribed: true } });
      }
      // never replies to "slow"
    });
    await server.start();

    const client = new IpcClient(sockPath);
    const sub = await client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1" },
      { onEvent: () => {} },
    );

    // CLIENT_TIMEOUT_MS is 5s; bump test timeout to 10s.
    await expect(
      sub.send({ type: "command", action: "slow", id: "rpc-slow" }),
    ).rejects.toThrow(/timeout/);

    sub.close();
    await server.stop();
  }, 10_000);

  it("send() rejects when socket closes mid-flight", async () => {
    const sockPath = makeSock();
    const server = new IpcServer(sockPath);
    server.on("message", ({ message, reply }) => {
      if (message.action === "events/subscribe") {
        reply({ type: "response", action: "events/subscribe", id: message.id, payload: { subscribed: true } });
      }
      // never replies to "slow"
    });
    await server.start();

    const client = new IpcClient(sockPath);
    const sub = await client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1" },
      { onEvent: () => {} },
    );

    const pending = sub.send({ type: "command", action: "slow", id: "rpc-slow" });
    setTimeout(() => sub.close(), 50);
    await expect(pending).rejects.toThrow(/closed/);

    await server.stop();
  });

  it("orphan response (no inflight match) is dropped silently", async () => {
    const sockPath = makeSock();
    const server = new IpcServer(sockPath);
    let sawEvent = false;
    server.on("message", ({ message, reply }) => {
      if (message.action === "events/subscribe") {
        reply({ type: "response", action: "events/subscribe", id: message.id, payload: { subscribed: true } });
        // Inject an unsolicited response with an id no inflight RPC matches.
        reply({ type: "response", action: "phantom", id: "phantom-id", payload: {} });
      }
    });
    await server.start();

    const client = new IpcClient(sockPath);
    const sub = await client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1" },
      { onEvent: () => { sawEvent = true; } },
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(sawEvent).toBe(false); // orphan response should NOT route to onEvent
    sub.close();
    await server.stop();
  });

  it("concurrent inflight RPCs over same socket", async () => {
    const sockPath = makeSock();
    const server = new IpcServer(sockPath);
    server.on("message", ({ message, reply }) => {
      if (message.action === "events/subscribe") {
        reply({ type: "response", action: "events/subscribe", id: message.id, payload: { subscribed: true } });
      } else if (message.action === "echo") {
        // Reply order intentionally reversed to test correlation.
        setTimeout(() => {
          reply({ type: "response", action: "echo", id: message.id, payload: message.payload });
        }, message.id === "a" ? 80 : 10);
      }
    });
    await server.start();

    const client = new IpcClient(sockPath);
    const sub = await client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1" },
      { onEvent: () => {} },
    );

    const [ra, rb] = await Promise.all([
      sub.send({ type: "command", action: "echo", id: "a", payload: { n: 1 } }),
      sub.send({ type: "command", action: "echo", id: "b", payload: { n: 2 } }),
    ]);
    expect(ra.id).toBe("a");
    expect((ra.payload as { n: number }).n).toBe(1);
    expect(rb.id).toBe("b");
    expect((rb.payload as { n: number }).n).toBe(2);

    sub.close();
    await server.stop();
  });
});
