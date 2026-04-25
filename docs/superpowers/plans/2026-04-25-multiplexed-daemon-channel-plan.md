# Multiplexed daemon channel — Phase 13.6 PR-C implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a long-lived bidirectional channel between clients (Electron, MCP) and the daemon — multiplexed events + RPCs over a single subscribe socket, gated by an explicit `supportsBidirectionalRpc` flag and an optional `kinds` event filter — and flip the MCP server to use `connectToDaemonSession`.

**Architecture:** Lean D from the spec. The events/subscribe socket is upgraded to optionally accept follow-up RPCs from the same `connectionId`. A new `SubscribeRegistry` enforces the bidirectional-flag contract daemon-side; the client multiplexer in `IpcClient.subscribe` correlates RPC responses by id while events still flow to `onEvent`. PR-D's `RN_DEV_HOSTCALL_BIND_GATE` flips default-on. Spec at [`docs/superpowers/specs/2026-04-25-multiplexed-daemon-channel-design.md`](../specs/2026-04-25-multiplexed-daemon-channel-design.md).

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import extensions), Bun bundler (`bun run build`), vitest for tests, playwright for the Electron smoke. Conventional Commits. **Per Martin's repo preference, work on a direct feature branch (not a worktree).**

---

## File structure

### New files

- `src/daemon/subscribe-registry.ts` — `SubscribeRegistry` class. Per-`connectionId` storage of `{ bidirectional: boolean, kindFilter: string[] | null }`. Mirrors PR-D's `src/daemon/sender-bindings.ts` style.
- `src/daemon/__tests__/subscribe-registry.test.ts` — unit tests for the registry: bidirectional flag, kinds filter parsing, glob-prefix matcher, socket-close cleanup, edge cases.
- `src/core/__tests__/ipc-multiplex.test.ts` — unit tests for the client multiplexer: send-and-correlate, timeout, socket-close-mid-flight, orphan response, concurrent inflight RPCs.
- `src/daemon/__tests__/multiplex-channel-integration.test.ts` — integration test: client subscribes with `supportsBidirectionalRpc: true`, issues an RPC over the same socket, asserts `connectionId` is preserved end-to-end via bind-sender + host-call.
- `src/mcp/__tests__/mcp-as-daemon-client.test.ts` — keystone integration test: MCP server flipped to `connectToDaemonSession`, exercises a proxy module's host-call through MCP, asserts call routes correctly.

### Modified files

- `src/core/ipc.ts` — `IpcClient.subscribe` returns `{ initial, send, close }`; parser maintains an inflight Map; socket-close rejects pending; type widening.
- `src/daemon/index.ts` — `handleEventsSubscribe` parses new payload fields; populates `SubscribeRegistry`; pre-dispatch check rejects RPC on non-bidirectional subscribe sockets; explicit deny for `events/subscribe` re-subscribe + `session/start` + `daemon/shutdown` on a subscribe socket; kinds filter applied to `supervisor.onEvent` push.
- `src/app/client/session.ts` — `connectToDaemonSession` passes `supportsBidirectionalRpc: true` + optional `kinds`; `session.client` narrows to `Pick<IpcClient, "send">` and routes through `sub.send`.
- `src/app/modules-ipc.ts` — gate flip: `RN_DEV_HOSTCALL_BIND_GATE` defaults to ON. Env flag stays as emergency off-switch (`RN_DEV_HOSTCALL_BIND_GATE=0` or absent treats default as on; `RN_DEV_HOSTCALL_BIND_GATE=0` overrides to off).
- `src/mcp/server.ts` — replace raw `IpcClient` with `connectToDaemonSession`. Drop the separate `modules/subscribe` path; module-list refresh now drives off the multiplexed `events/subscribe` stream filtered by `kinds: ["modules/*"]`.
- `src/mcp/tools.ts` — `McpContext.ipcClient: IpcClient | null` replaced by `McpContext.session: DaemonSession | null` + `McpContext.boundModules: Set<string>` (per-session bind cache). Each tool handler that uses `ctx.ipcClient` migrates to `ctx.session?.client`. Surgical: behavior preserved per-handler.
- `src/daemon/__tests__/sender-bindings-integration.test.ts` — rewrite the "default-off" test to assert default-ON works via `connectToDaemonSession`. Preserve the explicit-off test by setting `RN_DEV_HOSTCALL_BIND_GATE=0`.

---

## Phase 0 — Branch + baseline

### Task 0.1: Create the feature branch

**Files:** none.

- [ ] **Step 1: Verify clean working tree**

```bash
git status
```

Expected: `(clean)` — no uncommitted changes outside the spec/plan docs.

- [ ] **Step 2: Pull main + branch off it**

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-13-6-c
```

Expected: branch created, switched.

- [ ] **Step 3: Capture baseline**

```bash
npx vitest run --reporter=summary 2>&1 | tail -20
npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json
```

Expected: vitest 983 / 0 (or close — Phase 13.5 baseline). tsc root 149 errors (pre-existing wizard). tsc electron 0.

---

## Phase 1 — Daemon-side: SubscribeRegistry + bidirectional flag enforcement

This phase is fully self-contained: TDD a new module + wire it into the daemon's dispatch path. No client changes yet.

### Task 1.1: Create `SubscribeRegistry` with the test fence

**Files:**
- Create: `src/daemon/subscribe-registry.ts`
- Create: `src/daemon/__tests__/subscribe-registry.test.ts`

- [ ] **Step 1: Write the first failing test (registry stores and retrieves an entry)**

In `src/daemon/__tests__/subscribe-registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SubscribeRegistry } from "../subscribe-registry.js";

describe("SubscribeRegistry", () => {
  it("records a bidirectional subscriber and reports it", () => {
    const reg = new SubscribeRegistry();
    reg.register("c1", { bidirectional: true, kindFilter: null });
    expect(reg.isBidirectional("c1")).toBe(true);
    expect(reg.has("c1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, see it fail with module-not-found**

```bash
npx vitest run src/daemon/__tests__/subscribe-registry.test.ts
```

Expected: FAIL with "Cannot find module '../subscribe-registry.js'" or similar.

- [ ] **Step 3: Implement minimal SubscribeRegistry**

In `src/daemon/subscribe-registry.ts`:

```typescript
// Per-connection registry of subscribe-socket capabilities.
//
// Phase 13.6 — under the multiplexed channel design (Lean D), a
// subscribe socket optionally accepts follow-up RPCs from the same
// connection. The opt-in is daemon-enforced via the
// `supportsBidirectionalRpc` field on the events/subscribe payload;
// without it, the daemon rejects any RPC arriving on that socket.
//
// Mirrors `SenderBindings`'s API shape. One instance per supervisor
// boot, cleared by `clearConnection(connectionId)` on socket close.

export interface SubscribeEntry {
  /** Whether the client declared `supportsBidirectionalRpc: true`. */
  readonly bidirectional: boolean;
  /**
   * Per-subscriber event-kind filter. `null` = all kinds (default).
   * Empty array = no events. Validated entries (each non-empty,
   * either exact `metro/log` or prefix `modules/*`).
   */
  readonly kindFilter: readonly string[] | null;
}

export class SubscribeRegistry {
  private entries = new Map<string, SubscribeEntry>();

  register(connectionId: string, entry: SubscribeEntry): void {
    this.entries.set(connectionId, entry);
  }

  has(connectionId: string): boolean {
    return this.entries.has(connectionId);
  }

  isBidirectional(connectionId: string): boolean {
    return this.entries.get(connectionId)?.bidirectional === true;
  }

  kindFilter(connectionId: string): readonly string[] | null {
    return this.entries.get(connectionId)?.kindFilter ?? null;
  }

  clearConnection(connectionId: string): void {
    this.entries.delete(connectionId);
  }
}
```

- [ ] **Step 4: Run the test, see it pass**

```bash
npx vitest run src/daemon/__tests__/subscribe-registry.test.ts
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/subscribe-registry.ts src/daemon/__tests__/subscribe-registry.test.ts
git commit -m "feat(daemon): SubscribeRegistry skeleton (Phase 13.6 PR-C)"
```

### Task 1.2: Glob-prefix matcher for kinds filter

**Files:**
- Modify: `src/daemon/subscribe-registry.ts`
- Modify: `src/daemon/__tests__/subscribe-registry.test.ts`

- [ ] **Step 1: Write failing tests for the matcher**

Append to `src/daemon/__tests__/subscribe-registry.test.ts`:

```typescript
import { matchesKindFilter, parseKinds } from "../subscribe-registry.js";

describe("matchesKindFilter", () => {
  it("null filter matches every event", () => {
    expect(matchesKindFilter(null, "metro/log")).toBe(true);
    expect(matchesKindFilter(null, "modules/state-changed")).toBe(true);
  });

  it("empty array filter matches no event", () => {
    expect(matchesKindFilter([], "metro/log")).toBe(false);
  });

  it("exact match", () => {
    expect(matchesKindFilter(["metro/log"], "metro/log")).toBe(true);
    expect(matchesKindFilter(["metro/log"], "metro/status")).toBe(false);
  });

  it("prefix glob with /*", () => {
    expect(matchesKindFilter(["modules/*"], "modules/state-changed")).toBe(true);
    expect(matchesKindFilter(["modules/*"], "modules/crashed")).toBe(true);
    expect(matchesKindFilter(["modules/*"], "metro/log")).toBe(false);
  });

  it("multiple entries union", () => {
    expect(matchesKindFilter(["modules/*", "session/status"], "modules/x")).toBe(true);
    expect(matchesKindFilter(["modules/*", "session/status"], "session/status")).toBe(true);
    expect(matchesKindFilter(["modules/*", "session/status"], "metro/log")).toBe(false);
  });
});

describe("parseKinds", () => {
  it("undefined → null (back-compat: all events)", () => {
    expect(parseKinds(undefined)).toEqual({ ok: true, kinds: null });
  });

  it("empty array → empty array (no events)", () => {
    expect(parseKinds([])).toEqual({ ok: true, kinds: [] });
  });

  it("valid exact and prefix entries", () => {
    const r = parseKinds(["modules/*", "session/status"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kinds).toEqual(["modules/*", "session/status"]);
  });

  it("rejects non-array", () => {
    expect(parseKinds("modules/*").ok).toBe(false);
    expect(parseKinds({}).ok).toBe(false);
  });

  it("rejects non-string entries", () => {
    expect(parseKinds([1, 2]).ok).toBe(false);
  });

  it("rejects empty-string entries", () => {
    expect(parseKinds([""]).ok).toBe(false);
  });

  it("rejects mid-string globs (only trailing /* allowed)", () => {
    expect(parseKinds(["foo/*/bar"]).ok).toBe(false);
    expect(parseKinds(["*"]).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, see fail (functions don't exist)**

```bash
npx vitest run src/daemon/__tests__/subscribe-registry.test.ts
```

Expected: FAIL on import.

- [ ] **Step 3: Implement matcher + parser**

Append to `src/daemon/subscribe-registry.ts`:

```typescript
export function matchesKindFilter(
  filter: readonly string[] | null,
  eventKind: string,
): boolean {
  if (filter === null) return true;
  for (const entry of filter) {
    if (entry.endsWith("/*")) {
      const prefix = entry.slice(0, -1); // keep the trailing slash
      if (eventKind.startsWith(prefix)) return true;
    } else if (entry === eventKind) {
      return true;
    }
  }
  return false;
}

export type ParseKindsResult =
  | { ok: true; kinds: readonly string[] | null }
  | { ok: false; code: "E_SUBSCRIBE_INVALID_KINDS"; message: string };

export function parseKinds(raw: unknown): ParseKindsResult {
  if (raw === undefined) return { ok: true, kinds: null };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: "E_SUBSCRIBE_INVALID_KINDS",
      message: "kinds must be an array of strings",
    };
  }
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      return {
        ok: false,
        code: "E_SUBSCRIBE_INVALID_KINDS",
        message: "kinds entries must be non-empty strings",
      };
    }
    // Only trailing /* is allowed as glob; reject mid-string * usage.
    const starIndex = entry.indexOf("*");
    if (starIndex !== -1) {
      if (!entry.endsWith("/*") || entry.indexOf("*") !== entry.length - 1) {
        return {
          ok: false,
          code: "E_SUBSCRIBE_INVALID_KINDS",
          message: `kinds entry "${entry}" — only trailing "/*" is allowed as glob`,
        };
      }
    }
  }
  return { ok: true, kinds: raw as string[] };
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx vitest run src/daemon/__tests__/subscribe-registry.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/subscribe-registry.ts src/daemon/__tests__/subscribe-registry.test.ts
git commit -m "feat(daemon): kinds glob-prefix matcher + payload parser (Phase 13.6 PR-C)"
```

### Task 1.3: Wire `SubscribeRegistry` into `handleEventsSubscribe`

**Files:**
- Modify: `src/daemon/index.ts`

- [ ] **Step 1: Read current handleEventsSubscribe shape**

```bash
sed -n '420,520p' src/daemon/index.ts
```

(Use Read tool in practice. The handler is around line 423.)

- [ ] **Step 2: Add SubscribeRegistry instance to the daemon scope**

In `src/daemon/index.ts`, near the supervisor instantiation, add:

```typescript
import { SubscribeRegistry, parseKinds, matchesKindFilter } from "./subscribe-registry.js";

// near where supervisor is created (top-level inside startDaemon or runDaemonLoop)
const subscribeRegistry = new SubscribeRegistry();
```

(Exact location: same scope where `supervisor` lives. Pass it through to handlers if needed, or keep module-scoped if the file already does that for similar registries.)

- [ ] **Step 3: Extend `handleEventsSubscribe` to parse new fields and register**

Replace the existing handler logic. The new payload accepts `{ profile?, kinds?, supportsBidirectionalRpc? }`:

```typescript
async function handleEventsSubscribe(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
  subscribeRegistry: SubscribeRegistry,   // pass-through if not module-scoped
): Promise<void> {
  const payload = event.message.payload as
    | { profile?: unknown; kinds?: unknown; supportsBidirectionalRpc?: unknown }
    | null
    | undefined;

  // Parse kinds first — invalid kinds aborts before any side effects.
  const kindsResult = parseKinds(payload?.kinds);
  if (!kindsResult.ok) {
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: { code: kindsResult.code, message: kindsResult.message },
    });
    return;
  }
  const kindFilter = kindsResult.kinds;

  const bidirectional = payload?.supportsBidirectionalRpc === true;

  const push = (evt: SessionEvent): void => {
    if (!matchesKindFilter(kindFilter, evt.kind)) return;
    event.reply({
      type: "event",
      action: "session/event",
      id: event.message.id,
      payload: evt,
    });
  };
  const detach = supervisor.onEvent(push);

  // Register before any await, so socket-close cleanup always
  // matches a registered entry.
  subscribeRegistry.register(event.connectionId, {
    bidirectional,
    kindFilter,
  });

  const subscribeConnId = event.connectionId;
  event.onClose(() => {
    detach();
    subscribeRegistry.clearConnection(subscribeConnId);
    void supervisor.release(subscribeConnId);
  });

  // Listener-only / back-compat path: no profile → no refcount.
  if (!payload || payload.profile === undefined) {
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: { subscribed: true },
    });
    return;
  }

  const validation = validateProfile(payload.profile);
  if (!validation.ok) {
    detach();
    subscribeRegistry.clearConnection(event.connectionId);
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: { code: validation.code, message: validation.message },
    });
    return;
  }
  const attachResult = await supervisor.attach(event.connectionId, {
    profile: validation.profile,
  });
  if (attachResult.kind === "error") {
    detach();
    subscribeRegistry.clearConnection(event.connectionId);
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: { code: attachResult.code, message: attachResult.message },
    });
    return;
  }
  event.reply({
    type: "response",
    action: "events/subscribe",
    id: event.message.id,
    payload: {
      subscribed: true,
      status: attachResult.status,
      started: attachResult.started,
      attached: attachResult.attached,
    },
  });
}
```

- [ ] **Step 4: Verify existing daemon tests still pass**

```bash
npx vitest run src/daemon/__tests__
```

Expected: all pass — the kinds-undefined / bidirectional-false path is back-compat.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/index.ts
git commit -m "feat(daemon): handleEventsSubscribe parses kinds + bidirectional flag (Phase 13.6 PR-C)"
```

### Task 1.4: Pre-dispatch enforcement of bidirectional flag

**Files:**
- Modify: `src/daemon/index.ts`

- [ ] **Step 1: Write failing integration test**

Create `src/daemon/__tests__/bidirectional-enforcement.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import { IpcClient } from "../../core/ipc.js";
import path from "node:path";

describe("bidirectional flag enforcement", () => {
  const liveHandles: TestDaemonHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) await h.stop();
    for (const c of cleanups.splice(0)) c();
  });

  it("rejects RPC on a subscribe socket without supportsBidirectionalRpc", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const client = new IpcClient(path.join(worktree, ".rn-dev", "sock"));
    const sub = await client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-1",
        payload: {},   // no supportsBidirectionalRpc
      },
      { onEvent: () => {} },
    );

    try {
      // After PR-C, sub.send exists. For now, write a raw line to the
      // underlying socket via send semantics — see Task 2.x. This test
      // is wired in Phase 2 once IpcClient gains the multiplexer; for
      // Phase 1 we exercise the daemon-side check via a raw socket.
      // Placeholder: the assertion lives here so we can run it once
      // Phase 2 wires the client side. Mark .skip until Phase 2.3.
    } finally {
      sub.close();
    }
  });
});
```

(Note: this test is _seeded_ in Phase 1 but its assertion is wired in Phase 2.3 once the client multiplexer exists. For now, mark `.skip` on the `it`. The daemon-side change in this task gets covered indirectly by Phase 2's integration tests; we still implement it now.)

Mark the `it` as `.skip` for this task.

- [ ] **Step 2: Add the pre-dispatch check in `daemon/index.ts`**

Inside the main `ipc.on("message", ...)` handler, BEFORE the existing switch, add:

```typescript
// Phase 13.6 PR-C — bidirectional flag enforcement. A connection
// registered as a subscribe socket without supportsBidirectionalRpc
// can only call admin / re-subscribe — any other RPC is rejected.
const SUBSCRIBE_ALWAYS_ALLOWED = new Set<string>([
  "events/subscribe",   // re-subscribe is rejected separately below, but
                        // the early reject must skip this gate so
                        // the re-subscribe path runs and replies.
  "daemon/ping",
  "daemon/shutdown",
]);

if (
  subscribeRegistry.has(event.connectionId) &&
  !subscribeRegistry.isBidirectional(event.connectionId) &&
  !SUBSCRIBE_ALWAYS_ALLOWED.has(message.action)
) {
  reply({
    type: "response",
    action: message.action,
    id: message.id,
    payload: {
      code: "E_RPC_NOT_AUTHORIZED",
      message: `action "${message.action}" requires supportsBidirectionalRpc on this subscribe socket`,
    },
  });
  return;
}
```

(Re-subscribe rejection itself is Task 1.5.)

- [ ] **Step 3: Run vitest, expect existing pass + new test still skipped**

```bash
npx vitest run src/daemon
```

Expected: all existing tests pass; new test is skipped.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/index.ts src/daemon/__tests__/bidirectional-enforcement.test.ts
git commit -m "feat(daemon): pre-dispatch bidirectional-flag check (Phase 13.6 PR-C)"
```

### Task 1.5: Reject re-subscribe + session/start + daemon/shutdown on subscribe socket

**Files:**
- Modify: `src/daemon/index.ts`

- [ ] **Step 1: Add explicit rejections inside `handleEventsSubscribe` and the switch**

In `handleEventsSubscribe`, at the very top, before parsing payload:

```typescript
// Reject re-subscribe on an already-subscribed socket.
if (subscribeRegistry.has(event.connectionId)) {
  event.reply({
    type: "response",
    action: "events/subscribe",
    id: event.message.id,
    payload: {
      code: "E_RPC_NOT_AUTHORIZED",
      message: "this connection is already subscribed; close and reopen to re-subscribe",
    },
  });
  return;
}
```

In the main switch, for `session/start` and `daemon/shutdown`, add a guard at the top:

```typescript
case "session/start": {
  if (subscribeRegistry.has(event.connectionId)) {
    reply({
      type: "response",
      action: "session/start",
      id: message.id,
      payload: {
        code: "E_RPC_NOT_AUTHORIZED",
        message: "session/start is not allowed on a subscribe socket",
      },
    });
    return;
  }
  void handleSessionStart(event, supervisor);
  return;
}
case "daemon/shutdown":
  if (subscribeRegistry.has(event.connectionId)) {
    reply({
      type: "response",
      action: "daemon/shutdown",
      id: message.id,
      payload: {
        code: "E_RPC_NOT_AUTHORIZED",
        message: "daemon/shutdown is not allowed on a subscribe socket",
      },
    });
    return;
  }
  // ... existing handler ...
```

- [ ] **Step 2: Run daemon tests**

```bash
npx vitest run src/daemon
```

Expected: existing pass.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/index.ts
git commit -m "feat(daemon): reject re-subscribe + admin actions on subscribe socket (Phase 13.6 PR-C)"
```

---

## Phase 2 — Client-side multiplexer in `IpcClient.subscribe`

### Task 2.1: Add `send` to subscribe handle, parser routes by id

**Files:**
- Modify: `src/core/ipc.ts`
- Create: `src/core/__tests__/ipc-multiplex.test.ts`

- [ ] **Step 1: Write failing test for send-and-correlate**

In `src/core/__tests__/ipc-multiplex.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
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
});
```

- [ ] **Step 2: Run, see fail (`sub.send is not a function`)**

```bash
npx vitest run src/core/__tests__/ipc-multiplex.test.ts
```

Expected: FAIL with `sub.send is not a function`.

- [ ] **Step 3: Implement `send` on the subscribe handle in `src/core/ipc.ts`**

Modify `IpcClient.subscribe`. Replace the current return type/promise with:

```typescript
subscribe(
  message: IpcMessage,
  options: {
    onEvent: (event: IpcMessage) => void;
    onError?: (err: Error) => void;
    onClose?: () => void;
  },
): Promise<{
  initial: IpcMessage;
  send: (msg: IpcMessage) => Promise<IpcMessage>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(this.socketPath);
    let buffer = "";
    let confirmed = false;
    let closed = false;

    const inflight = new Map<
      string,
      {
        resolve: (msg: IpcMessage) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();

    const close = (): void => {
      if (closed) return;
      closed = true;
      // Reject any pending RPC over the multiplexed socket.
      for (const [, entry] of inflight) {
        clearTimeout(entry.timer);
        entry.reject(new Error("subscribe: connection closed before response"));
      }
      inflight.clear();
      socket.destroy();
    };

    const send = (msg: IpcMessage): Promise<IpcMessage> => {
      return new Promise((res, rej) => {
        if (closed || socket.destroyed) {
          rej(new Error("subscribe.send: connection already closed"));
          return;
        }
        const timer = setTimeout(() => {
          inflight.delete(msg.id);
          rej(new Error(`subscribe.send: timeout after ${CLIENT_TIMEOUT_MS}ms`));
        }, CLIENT_TIMEOUT_MS);
        inflight.set(msg.id, { resolve: res, reject: rej, timer });
        socket.write(JSON.stringify(msg) + "\n");
      });
    };

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.write(JSON.stringify(message) + "\n");
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: IpcMessage;
        try {
          parsed = JSON.parse(trimmed) as IpcMessage;
        } catch {
          continue;
        }

        if (parsed.type === "response") {
          // Subscription confirmation: only the first id-matching response.
          if (!confirmed && parsed.id === message.id) {
            confirmed = true;
            resolve({ initial: parsed, send, close });
            continue;
          }
          // Multiplexed RPC response.
          const entry = inflight.get(parsed.id);
          if (entry) {
            clearTimeout(entry.timer);
            inflight.delete(parsed.id);
            entry.resolve(parsed);
            continue;
          }
          // Orphan response — drop silently.
          continue;
        }

        // type === "event" or other → onEvent.
        try {
          options.onEvent(parsed);
        } catch (err) {
          options.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
    });

    socket.on("error", (err) => {
      if (!confirmed) {
        reject(err);
        return;
      }
      // Reject any pending RPC.
      for (const [, entry] of inflight) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      inflight.clear();
      options.onError?.(err);
    });

    socket.on("close", () => {
      if (!confirmed) {
        reject(new Error("IPC subscribe: connection closed before confirmation"));
        return;
      }
      // Reject any pending RPC.
      for (const [, entry] of inflight) {
        clearTimeout(entry.timer);
        entry.reject(new Error("subscribe: connection closed before response"));
      }
      inflight.clear();
      if (!closed) closed = true;
      options.onClose?.();
    });
  });
}
```

- [ ] **Step 4: Run multiplex test, expect pass**

```bash
npx vitest run src/core/__tests__/ipc-multiplex.test.ts
```

Expected: 1 pass.

- [ ] **Step 5: Run all core tests to confirm no regression**

```bash
npx vitest run src/core
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/ipc.ts src/core/__tests__/ipc-multiplex.test.ts
git commit -m "feat(core): IpcClient.subscribe multiplexed send (Phase 13.6 PR-C)"
```

### Task 2.2: Multiplexer covers timeout, close mid-flight, orphan, concurrent

**Files:**
- Modify: `src/core/__tests__/ipc-multiplex.test.ts`

- [ ] **Step 1: Add four more tests**

Append to the test file:

```typescript
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

  // Force timeout fast: rely on CLIENT_TIMEOUT_MS being 5s; mock by
  // racing with a shorter Promise.race for test speed if needed.
  // For simplicity, accept the 5s wait — vitest default timeout is 5s,
  // so bump test timeout to 10s.
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
```

- [ ] **Step 2: Run, expect all pass**

```bash
npx vitest run src/core/__tests__/ipc-multiplex.test.ts
```

Expected: 5 pass (1 from Task 2.1 + 4 new).

- [ ] **Step 3: Commit**

```bash
git add src/core/__tests__/ipc-multiplex.test.ts
git commit -m "test(core): multiplex covers timeout/close-mid-flight/orphan/concurrent (Phase 13.6 PR-C)"
```

### Task 2.3: Wire the bidirectional-flag enforcement test (Phase 1.4's `.skip`)

**Files:**
- Modify: `src/daemon/__tests__/bidirectional-enforcement.test.ts`

- [ ] **Step 1: Replace the `.skip` placeholder with a real assertion**

```typescript
it("rejects RPC on a subscribe socket without supportsBidirectionalRpc", async () => {
  const { path: worktree, cleanup } = makeTestWorktree();
  cleanups.push(cleanup);
  const daemon = await spawnTestDaemon(worktree, {
    env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
  });
  liveHandles.push(daemon);

  const client = new IpcClient(path.join(worktree, ".rn-dev", "sock"));
  const sub = await client.subscribe(
    {
      type: "command",
      action: "events/subscribe",
      id: "sub-1",
      payload: {},   // no supportsBidirectionalRpc
    },
    { onEvent: () => {} },
  );
  try {
    const r = await sub.send({
      type: "command",
      action: "metro/reload",
      id: "rpc-x",
    });
    expect((r.payload as { code: string }).code).toBe("E_RPC_NOT_AUTHORIZED");
  } finally {
    sub.close();
  }
});

it("accepts RPC on a subscribe socket WITH supportsBidirectionalRpc", async () => {
  const { path: worktree, cleanup } = makeTestWorktree();
  cleanups.push(cleanup);
  const daemon = await spawnTestDaemon(worktree, {
    env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
  });
  liveHandles.push(daemon);

  const client = new IpcClient(path.join(worktree, ".rn-dev", "sock"));
  const sub = await client.subscribe(
    {
      type: "command",
      action: "events/subscribe",
      id: "sub-1",
      payload: { supportsBidirectionalRpc: true },
    },
    { onEvent: () => {} },
  );
  try {
    // The daemon will reply with E_SESSION_NOT_RUNNING because no
    // session/start was issued, but crucially NOT E_RPC_NOT_AUTHORIZED.
    const r = await sub.send({
      type: "command",
      action: "metro/reload",
      id: "rpc-x",
    });
    expect((r.payload as { code: string }).code).not.toBe("E_RPC_NOT_AUTHORIZED");
  } finally {
    sub.close();
  }
});
```

- [ ] **Step 2: Run, expect pass**

```bash
npx vitest run src/daemon/__tests__/bidirectional-enforcement.test.ts
```

Expected: 2 pass.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/__tests__/bidirectional-enforcement.test.ts
git commit -m "test(daemon): bidirectional flag enforcement end-to-end (Phase 13.6 PR-C)"
```

---

## Phase 3 — DaemonSession integration

### Task 3.1: `connectToDaemonSession` passes flag + accepts `kinds` option

**Files:**
- Modify: `src/app/client/session.ts`
- Modify: `src/app/client/__tests__/*` (whichever covers connectToDaemonSession)

- [ ] **Step 1: Locate the existing test file**

```bash
ls src/app/client/__tests__/
```

Expected: `session-boot.test.ts`, `session-disconnect.test.ts`, etc.

- [ ] **Step 2: Add a test asserting the flag is in the subscribe payload**

In a new test file `src/app/client/__tests__/session-multiplex.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { IpcClient } from "../../../core/ipc.js";

// Mock connectToDaemon so we don't spawn anything; assert the
// subscribe payload contains supportsBidirectionalRpc: true.

describe("connectToDaemonSession (Phase 13.6 PR-C)", () => {
  it("subscribe payload includes supportsBidirectionalRpc: true and optional kinds", async () => {
    // ... use the same pattern as session-disconnect.test.ts: stub a
    // tiny IpcServer, capture the subscribe message, assert payload.
    // Implement using the existing test helpers in this directory.
  });
});
```

(Concrete: model it on `src/app/client/__tests__/session-disconnect.test.ts` — stub `IpcServer`, capture the subscribe message, assert `payload.supportsBidirectionalRpc === true`. If `kinds` is passed via opts, assert it's in payload too.)

- [ ] **Step 3: Run, see fail**

```bash
npx vitest run src/app/client/__tests__/session-multiplex.test.ts
```

Expected: FAIL — flag not yet added.

- [ ] **Step 4: Update `connectToDaemonSession` in `src/app/client/session.ts`**

Find the subscribe call (around line 172). Update:

```typescript
const sub = await client.subscribe(
  {
    type: "command",
    action: "events/subscribe",
    id: idGen(),
    payload: {
      profile,
      supportsBidirectionalRpc: true,
      ...(opts.kinds !== undefined ? { kinds: opts.kinds } : {}),
    },
  },
  { onEvent: onIncomingEvent, onClose: ..., onError: ... },
);
```

Update `ConnectToDaemonSessionOptions`:

```typescript
export interface ConnectToDaemonSessionOptions extends ConnectToDaemonOptions {
  sessionReadyTimeoutMs?: number;
  /**
   * Per-subscriber event-kind filter. Default = all kinds (every
   * session event delivered). Pass `["modules/*"]` for MCP to skip
   * the metro/builder/devtools firehose.
   */
  kinds?: string[];
}
```

- [ ] **Step 5: Run, expect pass**

```bash
npx vitest run src/app/client/__tests__/session-multiplex.test.ts
```

Expected: pass.

- [ ] **Step 6: Run full app tests**

```bash
npx vitest run src/app
```

Expected: all pass — Electron's existing `connectToDaemonSession` callers don't pass `kinds`, so they get the firehose like today.

- [ ] **Step 7: Commit**

```bash
git add src/app/client/session.ts src/app/client/__tests__/session-multiplex.test.ts
git commit -m "feat(client): connectToDaemonSession declares supportsBidirectionalRpc + accepts kinds (Phase 13.6 PR-C)"
```

### Task 3.2: Route `session.client.send` through the subscribe handle

**Files:**
- Modify: `src/app/client/session.ts`

- [ ] **Step 1: Write a test that asserts session.client.send rides the same connectionId as bind-sender**

This is the "host-call binding identity preserved" property. Create `src/app/client/__tests__/session-channel-identity.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../session.js";
import type { Profile } from "../../../core/types.js";

describe("DaemonSession channel identity", () => {
  const live: TestDaemonHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const h of live.splice(0)) await h.stop();
    for (const c of cleanups.splice(0)) c();
  });

  function fakeProfile(worktree: string): Profile {
    return {
      name: "test", isDefault: true, worktree: null, branch: "main",
      platform: "ios", mode: "quick", metroPort: 8081, devices: {},
      buildVariant: "debug", preflight: { checks: [], frequency: "once" },
      onSave: [], env: {}, projectRoot: worktree,
    };
  }

  it("bind-sender + host-call ride same connectionId via session.client.send", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake", RN_DEV_HOSTCALL_BIND_GATE: "1" },
    });
    live.push(daemon);
    const session = await connectToDaemonSession(worktree, fakeProfile(worktree));

    // bind dev-space (a built-in fake module) on this session
    const bindResp = await session.client.send({
      type: "command", action: "modules/bind-sender", id: "bind-1",
      payload: { moduleId: "dev-space" },
    });
    expect((bindResp.payload as { ok?: boolean; code?: string }).code).toBeUndefined();

    // host-call should now succeed (gate enabled, binding present on same conn)
    const callResp = await session.client.send({
      type: "command", action: "modules/host-call", id: "call-1",
      payload: {
        moduleId: "dev-space",
        capabilityId: "ping",
        method: "ping",
        args: {},
      },
    });
    expect((callResp.payload as { code?: string }).code).not.toBe("MODULE_UNAVAILABLE");

    await session.release();
  });
});
```

- [ ] **Step 2: Run, see fail (because session.client.send opens fresh sockets today)**

```bash
npx vitest run src/app/client/__tests__/session-channel-identity.test.ts
```

Expected: FAIL with `MODULE_UNAVAILABLE` — bind-sender on conn-A, host-call on conn-B.

- [ ] **Step 3: Implement the route through `sub.send`**

In `src/app/client/session.ts`, after the `await client.subscribe(...)` call, replace the `client` field on the returned `DaemonSession` with a thin proxy. Also update the type to narrow:

```typescript
// After sub is resolved:
const channelClient: { send: IpcClient["send"] } = {
  send: (msg: IpcMessage) => sub.send(msg),
};
```

Update the return:

```typescript
return {
  client: channelClient,
  // ...adapters constructed against `client` (raw IpcClient) STILL need
  //    to use channelClient. Reconstruct adapters AFTER subscribe so
  //    they receive channelClient.
  metro,
  devtools,
  builder,
  watcher,
  modules,
  worktreeKey,
  disconnect,
  release,
  stop,
};
```

**Important:** the adapters (`MetroClient`, etc.) are constructed BEFORE `await client.subscribe(...)` resolves today. They hold a reference to the raw `IpcClient`. We must reconstruct them with `channelClient` instead — OR change adapters to accept a `Pick<IpcClient, "send">` and construct them after the subscribe resolves. The latter is cleaner: move adapter construction to AFTER `sub` is available.

Refactor: move adapter construction below the subscribe call. Pass `channelClient` to each adapter constructor. Each adapter's constructor signature should already be `IpcClient` — verify it only uses `.send`. If so, narrow the type to `{ send: IpcClient["send"] }`.

Update `DaemonSession.client` type:

```typescript
export interface DaemonSession {
  client: { send: IpcClient["send"] };   // narrowed
  metro: MetroClient;
  // ... rest unchanged
}
```

Update each adapter file (`metro-adapter.ts`, `devtools-adapter.ts`, `builder-adapter.ts`, `watcher-adapter.ts`, `module-host-adapter.ts`) — narrow the constructor's `client` parameter type to `{ send: IpcClient["send"] }`. Their internal usage already only calls `.send`.

- [ ] **Step 4: Run the channel-identity test, expect pass**

```bash
npx vitest run src/app/client/__tests__/session-channel-identity.test.ts
```

Expected: pass.

- [ ] **Step 5: Run the full app + daemon test suite**

```bash
npx vitest run src/app src/daemon
```

Expected: all pass. Particularly important: `session-disconnect.test.ts`, `session-release.test.ts`, `session-boot.test.ts`, `gui-mcp-survive.test.ts`, `panel-bridge-daemon.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/app/client
git commit -m "feat(client): route session.client.send through subscribe handle (Phase 13.6 PR-C)"
```

### Task 3.3: tsc + electron tsc green

- [ ] **Step 1: Run both tsc passes**

```bash
npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json
```

Expected: root 149 (pre-existing wizard, unchanged). electron 0.

- [ ] **Step 2: If new errors, address them now (likely callers expecting `IpcClient` shape on `session.client`).**

- [ ] **Step 3: Commit any fixes**

```bash
git commit -am "fix(types): narrow session.client to { send } across consumers (Phase 13.6 PR-C)"
```

---

## Phase 4 — PR-D gate flip + Electron verification

### Task 4.1: Flip `RN_DEV_HOSTCALL_BIND_GATE` default-on

**Files:**
- Modify: `src/app/modules-ipc.ts`

- [ ] **Step 1: Update the gate logic at modules-ipc.ts:768**

Replace:

```typescript
const gateEnabled =
  process.env.RN_DEV_HOSTCALL_BIND_GATE === "1" &&
  opts.senderBindings !== undefined;
```

With:

```typescript
// Phase 13.6 PR-C — gate flips default-on. Long-lived RPC channel
// preserves binding identity, so production callers (Electron, MCP)
// no longer break. The env flag stays as an emergency off-switch:
//   RN_DEV_HOSTCALL_BIND_GATE=0 → off
//   RN_DEV_HOSTCALL_BIND_GATE=1 / unset → on
const gateEnabled =
  process.env.RN_DEV_HOSTCALL_BIND_GATE !== "0" &&
  opts.senderBindings !== undefined;
```

Also update the comment block above to match.

- [ ] **Step 2: Run all sender-bindings tests**

```bash
npx vitest run src/daemon/__tests__/sender-bindings-integration.test.ts src/app/__tests__
```

Expected: most pass; some may fail because they assume default-off semantics. Identify each failing test.

- [ ] **Step 3: Update `sender-bindings-integration.test.ts`**

The test "host-call without bind-sender succeeds when RN_DEV_HOSTCALL_BIND_GATE is unset" (around line 192) needs rewriting. Under default-on, an unset env means gate is ON. Two changes:

1. Rename: "host-call without bind-sender succeeds when gate is explicitly off"
2. Set `RN_DEV_HOSTCALL_BIND_GATE=0` in the daemon env for this test.

Apply that change, plus invert the docstring at the top of the describe block.

- [ ] **Step 4: Run again, expect pass**

```bash
npx vitest run src/daemon/__tests__/sender-bindings-integration.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/modules-ipc.ts src/daemon/__tests__/sender-bindings-integration.test.ts
git commit -m "feat(modules): flip host-call bind-gate default to ON (Phase 13.6 PR-C)"
```

### Task 4.2: Electron smoke verification

- [ ] **Step 1: Run electron smoke**

```bash
npx playwright test
```

Expected: 10 / 0 (Phase 13.5 baseline).

- [ ] **Step 2: If red, debug — likely a host-call path that wasn't routing through session.client.send. Track down and fix.**

- [ ] **Step 3: Commit any fixes**

```bash
git commit -am "fix(electron): route remaining host-call sites through session channel (Phase 13.6 PR-C)"
```

---

## Phase 5 — MCP server flip + keystone test

### Task 5.1: Replace `IpcClient` with `DaemonSession` in `McpContext`

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Modify: every call site of `ctx.ipcClient`

- [ ] **Step 1: Update `McpContext` interface**

In `src/mcp/tools.ts`:

```typescript
import type { DaemonSession } from "../app/client/session.js";

export interface McpContext {
  projectRoot: string;
  profileStore: ProfileStore;
  artifactStore: ArtifactStore;
  metro: MetroManager | null;
  preflightEngine: PreflightEngine;
  /**
   * Phase 13.6 PR-C — replaced raw `IpcClient` with the multiplexed
   * DaemonSession. `session.client.send` rides the long-lived
   * subscribe socket, preserving connectionId for bind-sender +
   * host-call. `null` when MCP starts before a daemon exists or after
   * the daemon connection drops.
   */
  session: DaemonSession | null;
  /**
   * Per-session set of moduleIds that have been bound on this
   * channel via `modules/bind-sender`. Cleared on
   * `notifyDisconnected` and re-populated lazily as tool handlers
   * issue host-calls.
   */
  boundModules: Set<string>;
  flags?: McpFlags;
}
```

- [ ] **Step 2: Update `startMcpServer` in `src/mcp/server.ts`**

Replace:

```typescript
const ctx: McpContext = {
  // ...
  ipcClient: new IpcClient(path.join(rnDevDir, "sock")),
  // ...
};
```

With (around the existing block):

```typescript
import { connectToDaemonSession } from "../app/client/session.js";

// Resolve default profile. NO existing helper today in src/mcp/server.ts —
// the implementer needs to either (a) reuse logic from src/core/profile.ts
// (grep for `isDefault`), (b) reuse the TUI's first-run picker pattern in
// src/app/first-run.ts, or (c) write a small helper here:
//   const profiles = await profileStore.list();
//   const profile = profiles.find((p) => p.isDefault) ?? profiles[0];
const profile = await resolveDefaultProfile(profileStore);
if (!profile) {
  throw new Error(
    "MCP server: no profile configured. Configure one via `rn-dev save-profile` first.",
  );
}

let session: DaemonSession | null = null;
try {
  session = await connectToDaemonSession(projectRoot, profile, {
    kinds: ["modules/*"],   // MCP only needs modules events
  });
} catch (err) {
  // Daemon unreachable at startup — degrade to built-ins-only mode
  // (mirrors today's IpcClient-null fallback).
  session = null;
}

const ctx: McpContext = {
  projectRoot,
  profileStore: new ProfileStore(path.join(rnDevDir, "profiles")),
  artifactStore: new ArtifactStore(path.join(rnDevDir, "artifacts")),
  metro: null,
  preflightEngine: createDefaultPreflightEngine(projectRoot),
  session,
  boundModules: new Set(),
  flags,
};
```

(Use the existing `selectDefaultProfile` logic from `src/mcp/server.ts` — don't reimplement.)

- [ ] **Step 3: Migrate every `ctx.ipcClient` call site**

Each tool handler today does:

```typescript
if (ctx.ipcClient) {
  const resp = await ctx.ipcClient.send(makeIpcMessage(...));
  // ...
}
```

Becomes:

```typescript
if (ctx.session) {
  const resp = await ctx.session.client.send(makeIpcMessage(...));
  // ...
}
```

There are ~10-15 such call sites across `tools.ts`. Find them with:

```bash
grep -n "ctx.ipcClient" src/mcp/tools.ts
```

Replace each. Mechanical work.

- [ ] **Step 4: Drop the standalone `subscribeToModuleChanges` raw subscribe**

The existing `subscribeToModuleChanges` at `server.ts:195-` opens its own subscribe socket via `ctx.ipcClient.subscribe`. Under PR-C, MCP's session ALREADY subscribes to `modules/*` via `connectToDaemonSession`. The `module-host-adapter.ts`'s `ModuleHostClient` emits a single `"modules-event"` with a discriminated `kind` field (`"state-changed" | "crashed" | "failed"`); subscribe to that instead:

```typescript
// In startMcpServer, after ctx is built. Verify exact event name and
// payload shape against src/app/client/module-host-adapter.ts before
// wiring — the adapter emits "modules-event" with { kind, ... }.
if (ctx.session) {
  ctx.session.modules.on("modules-event", async (evt) => {
    if (evt.kind !== "state-changed") return;
    try {
      const next = await discoverModuleContributedTools(ctx, flags);
      moduleTools = next;
      await server.sendToolListChanged();
    } catch {
      // best-effort, see existing comments
    }
  });
}
```

Delete `subscribeToModuleChanges` and its call site.

- [ ] **Step 5: tsc**

```bash
npx tsc --noEmit
```

Expected: root 149 (or close — possibly +/- 1 because of import changes).

- [ ] **Step 6: Run mcp tests**

```bash
npx vitest run src/mcp
```

Expected: most pass; tests that mock `ctx.ipcClient` need updating to mock `ctx.session` instead. Update each.

- [ ] **Step 7: Commit**

```bash
git add src/mcp
git commit -m "feat(mcp): flip MCP server to connectToDaemonSession (Phase 13.6 PR-C)"
```

### Task 5.2: Implement `boundModules` cache + bind-on-first-host-call

**Files:**
- Modify: `src/mcp/tools.ts` (or wherever `modules/host-call` is invoked)

- [ ] **Step 1: Find every site that calls modules/host-call from MCP**

```bash
grep -n "modules/host-call\|host-call" src/mcp/
```

- [ ] **Step 2: Wrap each in a bind-on-first-use helper**

In `src/mcp/tools.ts` (or a small new helper file `src/mcp/host-call.ts`):

```typescript
async function ensureBoundAndCall(
  ctx: McpContext,
  moduleId: string,
  capabilityId: string,
  method: string,
  args: unknown,
): Promise<IpcMessage> {
  if (!ctx.session) {
    throw new Error("MCP: no daemon session");
  }
  if (!ctx.boundModules.has(moduleId)) {
    const bind = await ctx.session.client.send({
      type: "command", action: "modules/bind-sender",
      id: makeIpcMessage("modules/bind-sender").id,
      payload: { moduleId },
    });
    if ((bind.payload as { code?: string }).code) {
      throw new Error(
        `bind-sender failed: ${(bind.payload as { code: string; message?: string }).code} ${(bind.payload as { message?: string }).message ?? ""}`,
      );
    }
    ctx.boundModules.add(moduleId);
  }
  return ctx.session.client.send({
    type: "command", action: "modules/host-call",
    id: makeIpcMessage("modules/host-call").id,
    payload: { moduleId, capabilityId, method, args },
  });
}
```

Hook `ctx.session.notifyDisconnected` (or use the disconnect events on the modules adapter) to clear `ctx.boundModules` on disconnect.

- [ ] **Step 3: Migrate host-call sites**

Replace direct `ctx.session.client.send` calls for host-call with `ensureBoundAndCall`.

- [ ] **Step 4: Run mcp tests**

```bash
npx vitest run src/mcp
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp
git commit -m "feat(mcp): bind-on-first-host-call cache on McpContext (Phase 13.6 PR-C)"
```

### Task 5.3: Keystone integration test — MCP-as-daemon-client

**Files:**
- Create: `src/mcp/__tests__/mcp-as-daemon-client.test.ts`

- [ ] **Step 1: Write the keystone test**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../../app/client/session.js";
import type { Profile } from "../../core/types.js";

describe("MCP as daemon client (Phase 13.6 PR-C keystone)", () => {
  const live: TestDaemonHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const h of live.splice(0)) await h.stop();
    for (const c of cleanups.splice(0)) c();
  });

  function fakeProfile(worktree: string): Profile {
    return {
      name: "test", isDefault: true, worktree: null, branch: "main",
      platform: "ios", mode: "quick", metroPort: 8081, devices: {},
      buildVariant: "debug", preflight: { checks: [], frequency: "once" },
      onSave: [], env: {}, projectRoot: worktree,
    };
  }

  it("MCP-shaped client (kinds=modules/*) attaches, binds, host-calls successfully", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    live.push(daemon);

    // Simulate the MCP client's attach: kinds filter to skip metro firehose.
    const mcpSession = await connectToDaemonSession(worktree, fakeProfile(worktree), {
      kinds: ["modules/*"],
    });

    // Bind the dev-space module on this session.
    const bindResp = await mcpSession.client.send({
      type: "command", action: "modules/bind-sender", id: "bind-1",
      payload: { moduleId: "dev-space" },
    });
    expect((bindResp.payload as { code?: string }).code).toBeUndefined();

    // host-call against dev-space — gate is now default-on; this
    // should NOT return MODULE_UNAVAILABLE.
    const callResp = await mcpSession.client.send({
      type: "command", action: "modules/host-call", id: "call-1",
      payload: {
        moduleId: "dev-space", capabilityId: "ping", method: "ping", args: {},
      },
    });
    expect((callResp.payload as { code?: string }).code).not.toBe("MODULE_UNAVAILABLE");

    await mcpSession.release();
  });

  it("MCP attaches alongside Electron-shaped client; both ride distinct connectionIds", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    live.push(daemon);

    // Electron-shaped: no kinds filter (full firehose).
    const electron = await connectToDaemonSession(worktree, fakeProfile(worktree));
    // MCP-shaped: kinds filter.
    const mcp = await connectToDaemonSession(worktree, fakeProfile(worktree), {
      kinds: ["modules/*"],
    });

    // Both bind dev-space on their own sessions; both host-calls succeed.
    for (const session of [electron, mcp]) {
      await session.client.send({
        type: "command", action: "modules/bind-sender", id: `bind-${Math.random()}`,
        payload: { moduleId: "dev-space" },
      });
      const r = await session.client.send({
        type: "command", action: "modules/host-call", id: `call-${Math.random()}`,
        payload: { moduleId: "dev-space", capabilityId: "ping", method: "ping", args: {} },
      });
      expect((r.payload as { code?: string }).code).not.toBe("MODULE_UNAVAILABLE");
    }

    await mcp.release();
    await electron.release();
  });
});
```

- [ ] **Step 2: Run, expect pass**

```bash
npx vitest run src/mcp/__tests__/mcp-as-daemon-client.test.ts
```

Expected: 2 pass.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/__tests__/mcp-as-daemon-client.test.ts
git commit -m "test(mcp): keystone MCP-as-daemon-client integration (Phase 13.6 PR-C)"
```

---

## Phase 6 — Verification + cleanup

### Task 6.1: Full three-layer verification

- [ ] **Step 1: vitest**

```bash
npx vitest run
```

Expected: all green. Compare count vs Phase 13.5 baseline (983 / 0): expect roughly +20 to +30 new tests.

- [ ] **Step 2: tsc both configs**

```bash
npx tsc --noEmit
npx tsc --noEmit -p electron/tsconfig.json
```

Expected: root unchanged at 149 errors. electron 0.

- [ ] **Step 3: bun run build**

```bash
bun run build
```

Expected: green.

- [ ] **Step 4: playwright**

```bash
npx playwright test
```

Expected: 10 / 0.

- [ ] **Step 5: If anything red, fix and re-run before proceeding.**

### Task 6.2: Push branch + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/module-system-phase-13-6-c
```

- [ ] **Step 2: Open PR with full body**

```bash
gh pr create --title "feat(daemon): multiplexed daemon channel + MCP-as-daemon-client (Phase 13.6 PR-C)" --body "$(cat <<'EOF'
## Summary

- Multiplexed long-lived channel: `events/subscribe` socket optionally accepts follow-up RPCs (`supportsBidirectionalRpc: true`) + per-subscriber event-kind filter (`kinds`).
- MCP server flipped to `connectToDaemonSession`: bind-sender + host-call now ride the same connectionId.
- `RN_DEV_HOSTCALL_BIND_GATE` flips default-on; env flag stays as emergency off-switch.

Closes the Phase 13.5 deferred PR-C. Spec at `docs/superpowers/specs/2026-04-25-multiplexed-daemon-channel-design.md`.

## Wire protocol

- New optional fields on `events/subscribe { profile, kinds?, supportsBidirectionalRpc? }`.
- Daemon-enforced rejection (`E_RPC_NOT_AUTHORIZED`) of:
  - any RPC arriving on a non-bidirectional subscribe socket
  - re-subscribe on an already-subscribed socket
  - `session/start` / `daemon/shutdown` on a subscribe socket
- New error code `E_SUBSCRIBE_INVALID_KINDS` for malformed `kinds` arrays.
- Glob-prefix only for `kinds`: `"modules/*"` matches `modules/x`; mid-string globs rejected.

## Client-side multiplexer

- `IpcClient.subscribe` returns `{ initial, send, close }`.
- Per-subscribe-socket inflight `Map<id, resolver>` correlates RPC responses by id; events still flow to `onEvent`.
- 5s timeout per RPC, socket-close mid-flight rejects all inflight with consistent error shape.

## DaemonSession

- `session.client` narrowed to `Pick<IpcClient, "send">`; routes through the subscribe handle.
- `connectToDaemonSession` accepts `kinds?: string[]` option.

## MCP server

- `McpContext.ipcClient` replaced by `McpContext.session: DaemonSession | null` + `boundModules: Set<string>`.
- ~10-15 tool handlers migrated to `ctx.session?.client.send(...)`.
- Module-list refresh now drives off the multiplexed events stream (modules/state-changed via `ctx.session.modules` adapter).
- Stand-alone `modules/subscribe` raw call removed.

## Test plan
- [ ] `npx vitest run` green (target +20-30 over 983 baseline)
- [ ] `npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json` (root 149, electron 0)
- [ ] `bun run build` green
- [ ] `npx playwright test` 10 / 0
- [ ] Manual: `bun run start` boots, Metro logs visible in renderer, host-call from a module panel works (gate now default-on)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Task 6.3: Parallel reviewer round (4 agents)

Per the established workflow for Phase 13.5:

- [ ] **Step 1: Dispatch four reviewers in parallel via Agent tool**

Reviewers (use the `compound-engineering:review:*` agents listed at session start):
1. `compound-engineering:review:kieran-typescript-reviewer` — TS quality, modern patterns.
2. `compound-engineering:review:architecture-strategist` — pattern compliance, design integrity (especially: refcount invariant preservation).
3. `compound-engineering:review:security-sentinel` — auth, capability, OWASP, especially the bidirectional flag enforcement.
4. `compound-engineering:review:code-simplicity-reviewer` — YAGNI, minimal code.

- [ ] **Step 2: Triage findings: P0 (blocking), P1 (should-fix), P2+ (advisory).**

- [ ] **Step 3: Fix all P0 + P1 in-branch with targeted commits**

```bash
git commit -m "fix(daemon): apply <reviewer> P0-N (Phase 13.6 PR-C)"
```

- [ ] **Step 4: Re-run three-layer verification after fixes**

```bash
npx vitest run && npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json && npx playwright test
```

- [ ] **Step 5: Push fixes**

```bash
git push
```

### Task 6.4: Squash-merge

- [ ] **Step 1: Wait for CI green**

```bash
gh pr checks --watch
```

- [ ] **Step 2: Squash-merge**

```bash
gh pr merge --squash --delete-branch
```

### Task 6.5: Update memory + queue next-session prompt

- [ ] **Step 1: Update `~/.claude/.../memory/project_rn_dev_cli.md`**

Add Phase 13.6 PR-C completion: link to PR, summary of wire-protocol changes (kinds filter, bidirectional flag, gate flip), the keystone MCP-as-daemon-client test now pinning the property.

- [ ] **Step 2: Queue Phase 13.6 next-session prompt for PR-E + remaining items**

Write `docs/plans/2026-04-26-next-session-prompt-phase-13-6-followup.md` covering: PR-E (packaged Electron daemon entry), `instance:retryStep`, session/start retirement, audit-log lifecycle entries, IpcServer.stop investigation, pid-recycling defense.

- [ ] **Step 3: Commit memory + handoff**

```bash
git add docs/plans/2026-04-26-next-session-prompt-phase-13-6-followup.md
git commit -m "docs: Phase 13.6 PR-C handoff + queue followups"
git push
```

---

## Risk register (mid-implementation watchpoints)

- **Adapter constructor signature change (Task 3.2):** moving adapter construction below the subscribe call is the largest internal refactor in this plan. If a test mocks adapter construction, it may need updating. Likely affected: `module-host-adapter.test.ts`.
- **MCP `subscribeToModuleChanges` removal (Task 5.1 step 4):** if any test asserts the standalone subscribe path, update to drive off the adapter event instead.
- **Playwright smoke (Task 4.2):** if it goes red, it's almost certainly a host-call site in Electron's renderer that wasn't routing through `session.client.send`. Check `electron/ipc/modules.ts` and the panel-bridge code.
- **Concurrency timing in multiplex tests (Task 2.2):** the timeout test takes 5s; consider mocking `CLIENT_TIMEOUT_MS` for faster CI if it dominates the suite. Don't shave below 1s — too flaky.

---

## Checklist summary

- [ ] Phase 0 — Branch + baseline
- [ ] Phase 1 — Daemon-side: SubscribeRegistry + bidirectional flag enforcement
- [ ] Phase 2 — Client-side multiplexer in IpcClient.subscribe
- [ ] Phase 3 — DaemonSession integration
- [ ] Phase 4 — PR-D gate flip + Electron verification
- [ ] Phase 5 — MCP server flip + keystone test
- [ ] Phase 6 — Verification + reviewer round + merge

---

## References

- Spec: [`docs/superpowers/specs/2026-04-25-multiplexed-daemon-channel-design.md`](../specs/2026-04-25-multiplexed-daemon-channel-design.md)
- Phase 13.5 handoff: [`docs/plans/2026-04-25-module-system-phase-13-5-handoff.md`](../../plans/2026-04-25-module-system-phase-13-5-handoff.md)
- Phase 13.6 next-session prompt: [`docs/plans/2026-04-26-next-session-prompt-phase-13-6.md`](../../plans/2026-04-26-next-session-prompt-phase-13-6.md)
- PR-A: [#21](https://github.com/utopyk/rn-dev-cli/pull/21) — refcount
- PR-B: [#22](https://github.com/utopyk/rn-dev-cli/pull/22) — registry
- PR-D: [#23](https://github.com/utopyk/rn-dev-cli/pull/23) — sender bindings
