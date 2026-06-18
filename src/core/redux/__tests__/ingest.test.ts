import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { ReduxIngestServer, reduxPortForMetroPort, REDUX_INGEST_PORT_OFFSET } from "../ingest.js";
import { ReduxStore } from "../buffer.js";

// Integration: a real WS client (the enhancer's role) against a real
// ReduxIngestServer, asserting frames land in the right session's store
// and that two sessions on two ports don't cross-talk.

const servers: ReduxIngestServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  for (const srv of servers.splice(0)) await srv.stop();
});

async function startServer(store: ReduxStore, sessionKey: string): Promise<number> {
  // Port 0 → OS-assigned ephemeral; read it back off the underlying server.
  const srv = new ReduxIngestServer({ port: 0, store, sessionKey, host: "127.0.0.1" });
  await srv.start();
  servers.push(srv);
  // @ts-expect-error — reach into the private wss for the bound port (test-only).
  const addr = srv.wss.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function send(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

/** Poll the store until `predicate` holds or the deadline passes. */
async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("until: condition not met in time");
}

describe("reduxPortForMetroPort", () => {
  it("offsets by the agreed constant", () => {
    expect(reduxPortForMetroPort(8081)).toBe(8081 + REDUX_INGEST_PORT_OFFSET);
  });
});

describe("ReduxIngestServer", () => {
  it("appends action frames into the store", async () => {
    const store = new ReduxStore();
    const port = await startServer(store, "w1");
    const ws = await connect(port);
    send(ws, { t: "hello", metroPort: 8081, enhancerVersion: "0.1.0" });
    send(ws, { t: "action", type: "auth/login", payload: { id: "u1" }, stateAfter: { auth: { id: "u1" } } });
    send(ws, { t: "action", type: "ui/toggle" });
    await until(() => store.size("w1") === 2);
    const { entries } = store.listActions("w1");
    expect(entries.map((e) => e.type)).toEqual(["auth/login", "ui/toggle"]);
    expect(store.getState("w1", "auth.id").value).toBe("u1");
  });

  it("hello clears prior actions (fresh app connection bumps epoch)", async () => {
    const store = new ReduxStore();
    store.append("w1", { type: "STALE" });
    const before = store.listActions("w1").meta.bufferEpoch;
    const port = await startServer(store, "w1");
    const ws = await connect(port);
    send(ws, { t: "hello" });
    await until(() => store.listActions("w1").meta.bufferEpoch > before);
    expect(store.size("w1")).toBe(0);
  });

  it("drops malformed frames without crashing", async () => {
    const store = new ReduxStore();
    const port = await startServer(store, "w1");
    const ws = await connect(port);
    ws.send("not json");
    ws.send(JSON.stringify({ no: "type" }));
    ws.send(JSON.stringify({ t: "action" })); // missing required `type`
    send(ws, { t: "action", type: "OK" });
    await until(() => store.size("w1") === 1);
    expect(store.listActions("w1").entries[0]!.type).toBe("OK");
  });

  it("two sessions on two ports do not cross-talk", async () => {
    const storeA = new ReduxStore();
    const storeB = new ReduxStore();
    const portA = await startServer(storeA, "a");
    const portB = await startServer(storeB, "b");
    const wsA = await connect(portA);
    const wsB = await connect(portB);
    send(wsA, { t: "action", type: "A1" });
    send(wsB, { t: "action", type: "B1" });
    send(wsB, { t: "action", type: "B2" });
    await until(() => storeA.size("a") === 1 && storeB.size("b") === 2);
    expect(storeA.listActions("a").entries.map((e) => e.type)).toEqual(["A1"]);
    expect(storeB.listActions("b").entries.map((e) => e.type)).toEqual(["B1", "B2"]);
  });
});
