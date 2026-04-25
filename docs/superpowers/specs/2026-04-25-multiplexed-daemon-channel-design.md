# Multiplexed daemon channel — Phase 13.6 PR-C design

**Date:** 2026-04-25
**Status:** Draft, pre-implementation
**Phase:** 13.6 — daemon refactor, multi-client foundation
**PR scope:** PR-C (MCP server flipped to daemon-client, the keystone of Phase 13.6)
**Authors:** Martin Couso + Claude (brainstorm session)

## Context

Phase 13.5 shipped the multi-client refcount foundation (PR-A), the active-daemon registry (PR-B), and per-conn sender bindings for `modules/host-call` (PR-D). PR-D was forced default-off (`RN_DEV_HOSTCALL_BIND_GATE=1`) because every existing production caller of host-call uses `IpcClient.send()`, which opens a fresh socket per call. A fresh send-conn has a different `connectionId` than whichever conn issued `bind-sender`, so binding never persists in production. The handoff document for Phase 13.6 frames PR-C as "the keystone remaining" — flipping the MCP server to use `connectToDaemonSession`, which requires a long-lived RPC channel where bind-sender + host-call share `connectionId`.

This document specifies that channel.

## Problem statement

A multi-client daemon must support clients that issue RPCs requiring per-connection identity (`modules/host-call` is the only one today, but the pattern generalizes). The current wire has two shapes:

1. **Fresh-socket sends** (`IpcClient.send()`): one socket, one RPC, socket destroyed on response. No per-connection state survives.
2. **Long-lived event subscriptions** (`IpcClient.subscribe()` for `events/subscribe`): one socket, one initial response, then push-only event stream. No client-initiated follow-up RPCs.

Neither shape supports "long-lived connection that issues RPCs while sharing identity across them." That gap is what blocks PR-D's gate from flipping default-on, and it's what blocks MCP from being a real daemon client.

Two practical concerns sharpen the design:

- **Capability escalation.** If we extend the existing subscribe socket to accept any RPC implicitly, every current event-only listener silently gains full RPC reach. That violates least-authority and isn't enforceable from the client side. Whatever we do, the daemon must enforce the channel contract.
- **Event firehose pollution.** `events/subscribe` today delivers the full session event stream (metro/log every line, builder/line every line, devtools/delta every 100ms, modules/* events, session/status, watcher events). For Electron's renderer that's the design. For an MCP server bridging an LLM, every Metro log line round-trips into MCP's process buffer — a token-leak risk and unnecessary IPC traffic. MCP only needs `modules/*` events to keep its tool list current.

## Goals

- Provide a single long-lived per-client connection that carries both filtered events and bidirectional RPCs, where bind-sender + host-call share `connectionId` automatically.
- Preserve PR-A's refcount invariant ("one client = one long-lived subscribe socket = one connection identity = one refcount slot").
- Close the capability-escalation gap by daemon-enforced declaration: a subscribe socket only accepts RPCs if the client explicitly opted in.
- Allow MCP to subscribe without consuming the metro/builder/devtools event firehose.
- Flip PR-D's `RN_DEV_HOSTCALL_BIND_GATE` default-on; MCP and Electron both ride a long-lived channel where binding identity persists.
- Land a real integration test pinning MCP-as-daemon-client end-to-end.

## Non-goals

- Per-module bearer tokens or SO_PEERCRED-based authentication. Phase 14+.
- Differentiated `subCode` field for module errors (PR-D Kieran P1-1, deferred).
- Bundling Node binary with packaged Electron (PR-E concern).
- Full migration of MCP tool handlers off raw `IpcMessage` payloads onto adapter-typed methods. PR-C does the minimum-viable swap; per-handler migration can land incrementally.
- Deletion of the `session/start` back-compat handler (Phase 13.5 carry-cost item 4).

## Architectural decision

**Lean D: one subscribe socket per client, multiplexed.** The events/subscribe payload gains two optional fields:

```ts
events/subscribe {
  profile: Profile,                       // existing, required for attacher
  kinds?: string[],                       // NEW: per-subscriber event filter
  supportsBidirectionalRpc?: boolean,     // NEW: declares RPC capability
}
```

The daemon-enforced contract:

- Without `supportsBidirectionalRpc`: socket accepts only events/subscribe (and basic admin like daemon/ping). Any RPC arriving on it → `E_RPC_NOT_AUTHORIZED`. **New enforcement.**
- With `supportsBidirectionalRpc: true`: socket accepts the existing client-RPC allowlist + modules actions on the same connection. bind-sender + host-call share that connection's `connectionId` automatically.
- `kinds` filter applies per-subscriber to event push routing. Daemon still emits everything; per-conn it forwards only matching kinds. Default = all kinds (back-compat).

### Alternatives considered

**A2 (no flag, no filter, accept anything on any open socket).** Rejected. Implicit capability escalation: every existing subscriber would silently gain full RPC reach, with the boundary enforced only by client-side discipline. MCP would also receive the full metro/builder/devtools firehose by default.

**B (wire flag without filter).** Rejected. Closes capability escalation but leaves MCP eating the firehose.

**C (flag + daemon-side narrowing of allowed actions).** Rejected. Permanent maintenance overhead — every new RPC requires a "allowed on subscribe socket?" triage decision. Doesn't add a property the per-conn binding (PR-D) doesn't already enforce.

**Sibling RPC channel (handoff Option B).** Rejected. Forces PR-A's refcount invariant to either expand (two release paths to coordinate) or become awkward (rpc/open as "auxiliary" but holding bindings — fictional). Doubles socket count per client. Cleaner orthogonality on paper, but regresses a Phase 13.5 invariant we explicitly fought to establish.

The Lean D flag is not a bad-pattern mode-switch; it's a capability declaration on a multiplexed socket — same pattern as HTTP/2 SETTINGS or gRPC streams. The `type` field (`"event"` vs `"response"`) already disambiguates which multiplex a message belongs to.

## Wire protocol

### Subscribe payload (extended)

```ts
{
  type: "command",
  action: "events/subscribe",
  id: <messageId>,
  payload: {
    profile: Profile,
    kinds?: string[],                       // optional, default = all
    supportsBidirectionalRpc?: boolean,     // optional, default = false
  }
}
```

### Subscribe response (existing shape, unchanged)

```ts
// Success
{
  type: "response",
  action: "events/subscribe",
  id: <same>,
  payload: { subscribed: true, status, started, attached }
}
// Failure
{
  type: "response",
  action: "events/subscribe",
  id: <same>,
  payload: { code: "E_PROFILE_MISMATCH" | "E_SUBSCRIBE_INVALID_KINDS" | ..., message }
}
```

### Kinds filter

- Matched against the event message's `action` field (e.g. `metro/log`, `modules/state-changed`).
- Glob-prefix only: `"modules/*"` matches `modules/state-changed`, `modules/crashed`, `modules/failed`. No regex, no general glob.
- Validation: each entry must be a non-empty string. Each entry must end with `/*` for prefix match, or be an exact event-kind name. Invalid → `E_SUBSCRIBE_INVALID_KINDS`.
- Empty array `[]` → no events delivered. Legitimate use: subscribe purely as refcount holder + RPC channel. (May be useful for future MCP variants that don't need any events.)
- Absent or `undefined` → all kinds. Back-compat.

### Bidirectional flag enforcement

- New per-conn registry on the daemon side: `SubscribeRegistry` (analogous to PR-D's `SenderBindings`). Stores per-`connectionId`: `{ subscribed: true, bidirectional: boolean, kindFilter: string[] | null }`.
- Populated when `handleEventsSubscribe` succeeds. Cleared on socket close.
- Pre-dispatch check in `daemon/index.ts`: for every incoming message NOT in `["events/subscribe", "daemon/ping", "daemon/shutdown"]`, if `SubscribeRegistry.has(connectionId)` AND `bidirectional === false` → reply with `E_RPC_NOT_AUTHORIZED`. Don't pass the message to action handlers.
- Connections NOT in `SubscribeRegistry` (fresh-socket sends) bypass the check entirely. Existing fresh-send semantics unchanged.

### New error codes

- `E_RPC_NOT_AUTHORIZED` — RPC attempted on non-bidirectional subscribe socket.
- `E_SUBSCRIBE_INVALID_KINDS` — malformed `kinds` array.

### Allowlist of actions over bidirectional subscribe socket

Allowed:
- All entries in `CLIENT_RPC_ACTIONS` (defined in [`src/daemon/client-rpcs.ts`](../../../src/daemon/client-rpcs.ts) — `metro/*`, `devtools/*`, `builder/*`, `watcher/*`).
- All entries in `MODULES_ACTIONS` (defined in [`src/app/modules-ipc.ts`](../../../src/app/modules-ipc.ts) — `modules/*`, `marketplace/*`, including `modules/bind-sender`, `modules/host-call`).
- `session/stop`, `session/status`.

Explicitly NOT allowed (rejected even with the flag set):
- `events/subscribe` — re-subscribe forbidden. The connection is already subscribed.
- `session/start` — back-compat path is fresh-socket only (no refcount participation).
- `daemon/shutdown` — admin action; fresh-socket only.

For now, "explicitly not allowed" is enforced at the action-dispatch layer (an additional check inside the existing switch in `daemon/index.ts`). This adds three reject branches; not enough surface to justify a separate allowlist registry. Each rejection returns `E_RPC_NOT_AUTHORIZED` with a clarifying message field.

## Client-side multiplexer

Single structural change in `src/core/ipc.ts`. The `subscribe` method's return shape gains a `send` method:

```ts
interface SubscribeHandle {
  initial: IpcMessage;
  send: (msg: IpcMessage) => Promise<IpcMessage>;   // NEW
  close: () => void;
}
```

### Inflight RPC correlation

Internally `subscribe` maintains:

```ts
const inflight = new Map<string, {
  resolve: (msg: IpcMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
```

Parser logic per incoming line, in order:

1. If `parsed.type === "response"`:
   - If `!confirmed && parsed.id === subscribeMsg.id` → it's the subscription confirmation. Resolve `{ initial, send, close }` as the original subscribe promise.
   - Else if `inflight.has(parsed.id)` → it's a follow-up RPC response. Resolve that entry, clear timer, delete entry.
   - Else → orphan response. Drop silently. (Optional: `console.warn` in dev.)
2. If `parsed.type === "event"` → `onEvent(parsed)` as today.

`send(msg)`:
1. Generate timer with `CLIENT_TIMEOUT_MS` (5s) timeout. On expiry: reject + delete inflight entry.
2. Register `{ resolve, reject, timer }` in `inflight` keyed by `msg.id`.
3. Write `JSON.stringify(msg) + "\n"` to socket.
4. Return promise.

### Socket-close mid-flight

When the underlying socket closes (planned `close()` or daemon death), iterate `inflight` and reject every pending promise with `new Error("subscribe: connection closed before response")`. Same shape as `IpcClient.send`'s close-before-response error.

### Back-compat for existing `subscribe` callers

The new `{ initial, send, close }` is a strict superset of `{ initial, close }`. Existing tests that destructure `{ initial, close }` continue to work without change. The public type widens; no caller code change needed unless the caller wants to use `send`.

### Why `send` lives on the handle, not on `IpcClient`

`IpcClient.send()` opens fresh sockets. The subscribe handle's `send()` rides the long-lived socket. Keeping them on different objects forces callers to make an explicit choice — they can't accidentally call the wrong one and lose binding identity. The multiplexer is scoped to the lifetime of the subscription.

## DaemonSession integration

In `src/app/client/session.ts`, `connectToDaemonSession` upgrades the subscribe call:

```ts
const sub = await client.subscribe(
  {
    type: "command",
    action: "events/subscribe",
    id: idGen(),
    payload: {
      profile,
      supportsBidirectionalRpc: true,
      kinds: opts.kinds,                  // pass-through, optional
    },
  },
  { onEvent: onIncomingEvent, onClose, onError },
);
```

`session.client`'s public type narrows. Today: `IpcClient`. New: `Pick<IpcClient, "send">`. The `subscribe` method is removed from the surface (calling subscribe on an already-subscribed session makes no sense). `session.client.send` is reimplemented as a thin proxy over `sub.send`:

```ts
const channelClient: { send: IpcClient["send"] } = {
  send: (msg) => sub.send(msg),
};
```

`ConnectToDaemonSessionOptions` gains:

```ts
interface ConnectToDaemonSessionOptions extends ConnectToDaemonOptions {
  sessionReadyTimeoutMs?: number;
  kinds?: string[];                       // NEW: pass-through to subscribe
}
```

`disconnect`, `release`, `stop`: unchanged. `sub.close()` closes the multiplexed socket; daemon's auto-release fires.

**Adapter compatibility:** `MetroClient`, `DevToolsClient`, `BuilderClient`, `WatcherClient`, `ModuleHostClient` all only use `client.send(...)`. They keep working unchanged.

## PR-D gate flip

`RN_DEV_HOSTCALL_BIND_GATE` defaults flip from off to on in this PR. The env flag stays as an emergency off-switch.

Rationale:
- Pre-Lean-D: Electron's `IpcClient.send()` opened fresh sockets per call → `bind-sender` and `host-call` had different `connectionId`s → gate-on broke Electron's host-call bridge.
- Post-Lean-D: Electron's `session.client.send()` rides the multiplexed subscribe socket → bind-sender + host-call share `connectionId` → gate-on works.

Test changes:
- The PR-D "load-bearing default-off check" test rewrites: gate-on works when called via a `connectToDaemonSession` channel.
- Old default-off semantic preserved as a separate test that explicitly sets `RN_DEV_HOSTCALL_BIND_GATE=0`.
- Phase 13.5 carry-cost retired in this PR.

## MCP server flip

`src/mcp/server.ts` today builds `McpContext` with a raw `IpcClient`. After PR-C:

```ts
const session = await connectToDaemonSession(projectRoot, profile, {
  kinds: ["modules/*"],   // MCP doesn't need metro/builder/devtools firehose
});

// ctx.session : DaemonSession
// ctx.ipcClient removed (replaced by ctx.session.client for raw access if needed)
```

### Profile resolution

MCP needs a profile to attach. Existing default-profile selection logic in [`src/mcp/server.ts`](../../../src/mcp/server.ts) stays. Clear error if no profile is configured.

### Tool handlers needing binding identity (host-call)

Use `session.modules.bindSender(moduleId)` once per module before the first host-call. The `ModuleHostClient` adapter handles bind-sender; under the multiplexed channel, the binding sticks to the subscribe socket's `connectionId`, so subsequent host-calls through `session.client.send` succeed.

Caching: a `Set<moduleId>` of "bound on this session" lives on `McpContext` (one entry per moduleId, scoped to the current `DaemonSession`). Cleared on `notifyDisconnected`; re-populated lazily as tool handlers re-bind.

### Lifecycle

- MCP startup: `connectToDaemonSession`. Stores `session` on context.
- MCP shutdown signal (SIGTERM/SIGINT): `await session.release()` then exit. Daemon's auto-release fires; if MCP was the last attacher, daemon tears down the session.
- Daemon disconnect mid-life: `notifyDisconnected` already wired through adapters. MCP server's tool handlers fail with a coherent "daemon unreachable" error rather than hanging.

### Migration scope

`McpContext` surface change: `ipcClient` field replaced by `session: DaemonSession`. ~10-15 tool handlers touch `ctx.ipcClient.send(...)` directly. Two strategies:

- **Minimum-viable swap (chosen for PR-C):** add a `ctx.session.client` shim that exposes `send` so existing tool handlers compile with a one-line change per handler (`ctx.ipcClient` → `ctx.session.client`). No deeper refactor.
- **Full adapter migration (deferred):** rewrite each handler to call typed adapter methods (`ctx.session.metro.reload(...)` instead of `ctx.session.client.send({ action: "metro/reload", ... })`). Cleaner long-term. Out of scope for PR-C.

## Migration & back-compat

- **Existing tests using `IpcClient.send()` directly:** unchanged. Daemon still accepts fresh-socket sends; they're not in `SubscribeRegistry` so the bidirectional check skips them.
- **Existing tests using `IpcClient.subscribe()` event-only:** the return shape adds `send` (purely additive). Tests destructuring `{ initial, close }` keep working.
- **Phase 13.5 carry-cost (`session/start` migration):** orthogonal to this PR. Tracked as item 4 in the next-session prompt; can land in a follow-up.
- **Daemon-side rollback:** if the bidirectional flag's enforcement turns out to break something, `RN_DEV_HOSTCALL_BIND_GATE=0` reverts host-call to pre-PR-D semantics. The `SubscribeRegistry`'s rejection of non-bidirectional RPC is an additional new error path; it should not need a flag because every production caller passes the flag.

## Testing strategy

### Unit (vitest)

- `IpcClient.subscribe` multiplexing:
  - send + correlate response (happy path).
  - send + 5s timeout.
  - send + socket-close-mid-flight (rejection with consistent error shape).
  - Orphan response handling (silent drop).
  - Concurrent inflight RPCs over the same socket.
- `SubscribeRegistry` daemon-side:
  - Bidirectional flag enforcement (reject without flag).
  - Allowlist enforcement (events/subscribe re-subscribe rejected even with flag).
  - Kinds filter routing (only matching kinds delivered).
  - Socket-close cleanup.
- Kinds filter glob-prefix matcher (unit: `"modules/*"` matches `modules/x`; `"modules/x"` matches exactly; `"foo/*/bar"` invalid).
- `DaemonSession.client.send` routes through subscribe handle.

### Integration (vitest)

- **MCP-as-daemon-client end-to-end (the keystone test).** Boot daemon, attach Electron, attach MCP, MCP issues a proxy module host-call, assert: call reaches the right module subprocess, response routes back, binding identity preserved.
- Cross-client coexistence: Electron + MCP attached simultaneously, each with different `kinds` filters, both issue RPCs, both receive their filtered events.
- Bidirectional flag absent → RPC rejected with `E_RPC_NOT_AUTHORIZED`.
- Last-release teardown still works when both clients release.

### E2E (playwright)

Existing smoke suite at `tests/electron-smoke/smoke.spec.ts` should stay green. Electron's renderer flow externally is unchanged. Red here means we've broken something subtle in the multiplexed path.

### Verification baseline

Match or improve on Phase 13.5 baselines:
- vitest: 983 / 0 → likely +20 to +30 new tests.
- tsc root: 149 (pre-existing wizard, unchanged).
- tsc electron: 0.
- `bun run build`: green.
- `npx playwright test`: 10 / 0.

## Risks and mitigations

- **Risk:** Multiplexed socket subtly drops events under RPC concurrency. Mitigation: explicit concurrent-inflight unit test; the parser logic separates `type:"event"` and `type:"response"` paths cleanly with no shared state.
- **Risk:** PR-D gate flip breaks an Electron flow we missed. Mitigation: playwright smoke + manual exercise of the section retry buttons. The env flag stays as an emergency off-switch.
- **Risk:** MCP's tool handlers have hidden assumptions about fresh-socket send semantics (timing, ordering). Mitigation: minimum-viable swap means the dispatch layer is unchanged at the message-payload level; only the client object swaps.
- **Risk:** `SubscribeRegistry` interacts badly with PR-A's `attachedConnections` (same `connectionId` lives in two registries). Mitigation: distinct concerns (refcount vs RPC capability); they never write to each other's storage. Cleanup hook on socket close fires both.

## Open questions

None blocking implementation. Items deferred to follow-up PRs are tracked in the Phase 13.5 handoff.

## References

- Phase 13.5 handoff: [`docs/plans/2026-04-25-module-system-phase-13-5-handoff.md`](../../plans/2026-04-25-module-system-phase-13-5-handoff.md)
- Phase 13.6 next-session prompt: [`docs/plans/2026-04-26-next-session-prompt-phase-13-6.md`](../../plans/2026-04-26-next-session-prompt-phase-13-6.md)
- PR-A (refcount): [PR #21](https://github.com/utopyk/rn-dev-cli/pull/21)
- PR-B (registry): [PR #22](https://github.com/utopyk/rn-dev-cli/pull/22)
- PR-D (sender bindings): [PR #23](https://github.com/utopyk/rn-dev-cli/pull/23)
