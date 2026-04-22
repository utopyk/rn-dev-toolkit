import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IpcServer, IpcClient, IpcMessage } from "../ipc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rn-dev-cli-ipc-"));
}

function makeMessage(action: string, payload?: unknown): IpcMessage {
  return {
    type: "command",
    action,
    payload,
    id: `test-${Math.random().toString(36).slice(2)}`,
  };
}

// ---------------------------------------------------------------------------
// IpcServer
// ---------------------------------------------------------------------------

describe("IpcServer", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: IpcServer;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    socketPath = join(tmpDir, "test.sock");
    server = new IpcServer(socketPath);
  });

  afterEach(async () => {
    await server.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts and isRunning returns true", async () => {
    expect(server.isRunning()).toBe(false);
    await server.start();
    expect(server.isRunning()).toBe(true);
  });

  it("creates the socket file on start", async () => {
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
  });

  it("stops cleanly and isRunning returns false", async () => {
    await server.start();
    expect(server.isRunning()).toBe(true);
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("removes the socket file on stop", async () => {
    await server.start();
    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("cleans up stale socket file on start", async () => {
    // Write a fake stale socket file
    const { writeFileSync } = await import("fs");
    writeFileSync(socketPath, "stale");
    expect(existsSync(socketPath)).toBe(true);

    // Should not throw even though file exists
    await expect(server.start()).resolves.not.toThrow();
    expect(server.isRunning()).toBe(true);
  });

  it("emits message event when client sends a message", async () => {
    await server.start();

    const receivedMessages: IpcMessage[] = [];
    server.on("message", ({ message }: { message: IpcMessage; reply: (r: IpcMessage) => void }) => {
      receivedMessages.push(message);
    });

    const client = new IpcClient(socketPath);
    const msg = makeMessage("reload");

    // Fire and don't wait — server won't reply in this test
    client.send(msg).catch(() => {});

    // Give time for the server to receive
    await new Promise((r) => setTimeout(r, 100));

    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    expect(receivedMessages[0].action).toBe("reload");
    expect(receivedMessages[0].id).toBe(msg.id);
  });
});

// ---------------------------------------------------------------------------
// IpcClient
// ---------------------------------------------------------------------------

describe("IpcClient", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: IpcServer;
  let client: IpcClient;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    socketPath = join(tmpDir, "test.sock");
    server = new IpcServer(socketPath);
    client = new IpcClient(socketPath);
  });

  afterEach(async () => {
    await server.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("isServerRunning returns false when no server is running", async () => {
    const result = await client.isServerRunning();
    expect(result).toBe(false);
  });

  it("isServerRunning returns true when server is running", async () => {
    await server.start();
    const result = await client.isServerRunning();
    expect(result).toBe(true);
  });

  it("sends a message and receives a response with matching id", async () => {
    await server.start();

    // Server echoes back a response
    server.on(
      "message",
      ({ message, reply }: { message: IpcMessage; reply: (r: IpcMessage) => void }) => {
        reply({
          type: "response",
          action: message.action,
          payload: { ok: true },
          id: message.id,
        });
      }
    );

    const msg = makeMessage("status");
    const response = await client.send(msg);

    expect(response.id).toBe(msg.id);
    expect(response.type).toBe("response");
    expect(response.action).toBe("status");
    expect((response.payload as { ok: boolean }).ok).toBe(true);
  });

  it("handles multiple round-trips correctly", async () => {
    await server.start();

    server.on(
      "message",
      ({ message, reply }: { message: IpcMessage; reply: (r: IpcMessage) => void }) => {
        reply({
          type: "response",
          action: message.action,
          payload: { received: message.action },
          id: message.id,
        });
      }
    );

    const actions = ["reload", "dev-menu", "clean"];
    const responses = await Promise.all(
      actions.map((action) => client.send(makeMessage(action)))
    );

    for (let i = 0; i < actions.length; i++) {
      expect(responses[i].action).toBe(actions[i]);
      expect((responses[i].payload as { received: string }).received).toBe(actions[i]);
    }
  });

  it("times out after 5 seconds when server does not reply", async () => {
    await server.start();

    // Server receives message but never replies
    server.on("message", () => {
      // intentionally no reply
    });

    const msg = makeMessage("no-reply");
    await expect(client.send(msg)).rejects.toThrow(/timeout/i);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// IpcClient.subscribe — Phase 3d stream semantics
// ---------------------------------------------------------------------------

describe("IpcClient.subscribe", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: IpcServer;
  let client: IpcClient;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    socketPath = join(tmpDir, "sub.sock");
    server = new IpcServer(socketPath);
    client = new IpcClient(socketPath);
  });

  afterEach(async () => {
    await server.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves with the initial response + streams every subsequent event", async () => {
    await server.start();
    server.on(
      "message",
      ({
        message,
        reply,
      }: {
        message: IpcMessage;
        reply: (r: IpcMessage) => void;
      }) => {
        reply({
          type: "response",
          action: message.action,
          payload: { subscribed: true },
          id: message.id,
        });
        // Push two events after the initial response.
        for (let i = 0; i < 2; i++) {
          reply({
            type: "event",
            action: "stream/tick",
            payload: { n: i },
            id: message.id,
          });
        }
      },
    );

    const events: IpcMessage[] = [];
    const sub = await client.subscribe(makeMessage("subscribe"), {
      onEvent: (evt) => events.push(evt),
    });

    expect(sub.initial.payload).toEqual({ subscribed: true });

    // Give events time to flow in; no timer-based guarantee so we poll.
    const deadline = Date.now() + 500;
    while (events.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(events).toHaveLength(2);
    expect(events[0].action).toBe("stream/tick");
    expect((events[1].payload as { n: number }).n).toBe(1);

    sub.close();
  });

  it("fires the server-side onClose listener when the client disposes", async () => {
    await server.start();
    let serverSideClosed = false;
    server.on(
      "message",
      ({
        message,
        reply,
        onClose,
      }: {
        message: IpcMessage;
        reply: (r: IpcMessage) => void;
        onClose: (cb: () => void) => void;
      }) => {
        onClose(() => {
          serverSideClosed = true;
        });
        reply({
          type: "response",
          action: message.action,
          payload: { subscribed: true },
          id: message.id,
        });
      },
    );

    const sub = await client.subscribe(makeMessage("subscribe"), {
      onEvent: () => {},
    });
    sub.close();

    const deadline = Date.now() + 500;
    while (!serverSideClosed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(serverSideClosed).toBe(true);
  });
});
