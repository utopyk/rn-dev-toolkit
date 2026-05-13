# Phase D3 — Per-session services (SessionId-keyed Maps + Promise Builder)

**Status:** Landed in commit `9f584f7` on `main` (local-only, 7 commits ahead of origin per the personal-account workflow).

**Plan:** [2026-05-12-feat-multi-session-daemon-and-electron-plan.md](../plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md)
**Predecessor:** [Phase D2 — sessionId threaded through RPC envelopes](2026-05-13-d2-sessionid-rpc-envelopes.md)

---

## Problem

Phase D2 landed the wire shape — supervisor speaks SessionId, every RPC envelope carries it, `sessions/list` is live, observer mode is cut. But the in-process service layer below the dispatcher was still keyed by `worktreeKey`:

- `MetroManager.instances: Map<string, MetroInstance>` — same worktreeKey ⇒ the same Map slot, so two sessions for one worktree would collide.
- `DevToolsManager.instances: Map<string, WorktreeState>` — same constraint, plus the worktreeKey-driven event payloads couldn't tell two sibling sessions apart.
- `Builder.build()` returned `void` and emitted `done` on a shared EventEmitter. `client-rpcs.ts:312` attached `services.builder.once("done", () => fire("build/post"))`, which carried two pre-D3 hazards:
  1. **listener leak** — if the subprocess wedged and never emitted `done`, the listener stayed attached for the lifetime of the Builder.
  2. **cross-talk** — `auto-build.ts:triggerBuildsIfNeeded` fires iOS + Android concurrently against one Builder. The synchronous concurrency-guard `done` for the second build would fire BOTH builds' `once("done")` listeners, then unhook them — leaving the real iOS `done` event with no subscriber.

D3 lights up real concurrent-session capability at the service layer and closes the listener-leak / cross-talk vectors at their actual seam (the Builder API), not the call site.

---

## Solution

### 1. Map key flip: worktreeKey ⇒ SessionId

The simplicity reviewer's deepening insight (plan § A, refined): SessionId is unique by construction; worktreeKey is metadata, not identity. A composite-key Map would carry the same uniqueness as the SessionId alone. **Key is SessionId; worktreeKey lives on the value.**

The flip is mechanical but the discipline matters — every Map operation (`get`, `set`, `delete`, `has`) routes via the typed SessionId brand. The `WorktreeKey` brand from D0.5 stayed as documentation for callsites that compose persistence keys (artifact store, port allocation), where the worktree-shaped value is still the right level of identity.

| Type | Pre-D3 | Post-D3 |
| --- | --- | --- |
| `MetroManager.instances` | `Map<string, MetroInstance>` (worktreeKey) | `Map<SessionId, MetroInstance>` |
| `MetroInstance` | `{ worktree, port, pid, status, … }` | `{ sessionId, worktree, port, pid, status, … }` |
| `DevToolsManager.instances` | `Map<string, WorktreeState>` (worktreeKey) | `Map<SessionId, SessionState>` |
| `SessionState` (renamed) | `{ worktreeKey, proxy, taps, … }` | `{ sessionId, worktreeKey, proxy, taps, … }` |

Event payloads gain `sessionId` alongside the existing `worktreeKey` so subscribers can route on either dimension. The supervisor's `wireServiceEvents` already uses closure-captured values for fan-out, so the payload extension is purely additive.

### 2. Promise-returning Builder

`Builder.build()` now returns a `BuildHandle = { buildId, promise, cancel }`. The Promise wrapping closes the listener-leak + cross-talk vectors at the API boundary:

- Each `build()` call mints a fresh `buildId` (UUID v4) and a fresh deferred. The internal `proc.on("exit")` handler resolves THIS call's resolver, not a shared listener.
- The concurrency-guard rejection (`build already in progress`) resolves synchronously with a synthetic `BuildResult`. It emits a `done` event for downstream fan-out but settles only the call's own promise — no other in-flight handle is touched.
- `BuilderDoneEvent` carries the `buildId` so external subscribers can correlate `done` events to specific build calls.
- A new `Builder.dispose()` method calls `cancel()` and awaits the in-flight build's promise. `SessionServices.dispose()` calls it before tearing down Metro/DevTools, so a build subprocess can never outlive the session that spawned it.

`client-rpcs.ts:308` rewires the `build/post` hook fire from `once("done", ...)` to `await handle.promise.then(fire)`. Each call's promise resolves exactly once with its own outcome, so the hook fan-out is per-handle — concurrency-guard rejection for Android no longer steals iOS's post-hook.

### 3. SessionServices.sessionId

`BootSessionServicesOptions` and `SessionServices` both gain `sessionId: SessionId`. The supervisor's `bootAsync` already had the value (`entry.sessionId`); threading it into the boot factory was the minimal change. The struct field lets `client-rpcs.ts` dispatch by `services.sessionId` rather than re-deriving from the supervisor at every RPC.

### 4. Devtools host capability — per-session construction

The module-facing `DevtoolsHostCapability` shape keeps its `worktreeKey?: string` argument for back-compat with already-shipped 3p modules, but the factory now requires a `sessionId: SessionId` at construction time. The capability routes every call to that sessionId regardless of the worktreeKey the module passes; the worktreeKey check survives as the cross-worktree-leak guard.

This is cheaper than translating worktreeKey → sessionId at request time: the host (bootSessionServices) already knows which session owns the registration, so the binding happens once.

---

## Test surface

| Spec | What it pins |
| --- | --- |
| `metro-multi-session.test.ts` | 5 cases — Map-key flip; two starts with same worktreeKey + different sessionIds coexist; getInstance disambiguates by sessionId; stop() doesn't touch siblings; status events emit sessionId; duplicate sessionId throws. |
| `devtools-multi-session.test.ts` | 3 cases — two sessionIds on shared worktreeKey produce distinct SessionStates with independent proxy ports / nonces; targeted stop; sessionId-tagged status fan-out. |
| `builder-per-session.test.ts` | 5 cases — promise contract; buildId discriminator; concurrency-guard rejection settling without cross-talk; two-instance independence; dispose() awaits resolver chain. |

Plus 5 existing test files updated for the new typed API (`metro.test.ts`, `devtools.test.ts`, `devtools.polling.test.ts`, `devtools.tap-seam.test.ts`, `host-capability.test.ts`) and 4 supervisor / boot test fixtures threaded with sessionId (`boot-trace.test.ts`, `builder-build-hooks.test.ts`, `supervisor-multi.test.ts`, `supervisor-refcount.test.ts`).

---

## Validation

| Layer | Pre-D3 | Post-D3 | Delta |
| --- | --- | --- | --- |
| vitest | 1399 passed + 2 skipped | 1412 passed + 2 skipped | +13 D3 specs |
| tsc root | 4 baseline | 4 baseline | no drift |
| tsc electron | clean | clean | — |
| smoke | 13/13 + 4 skipped | 13/13 + 4 skipped | — |

Real-boot is NOT a D3 gate — that's D7. The D3 contract is the in-process state machine; the smoke gate's end-to-end daemon-spawn proves the wire shape didn't regress.

---

## What's NOT in D3 (carried to later phases)

- **Cross-session ModuleHost refcount** — `acquiredModules: []` is pre-allocated on every supervisor entry but no consumer-set walk yet. **D4**.
- **ServiceBus per-session payloads** — TUI's React fan-out still treats `worktreeKey` as the addressing dimension. **D5**.
- **Fake-boot harness multi-session** — the smoke fixture boots a single session today. **D6**.
- **Real-boot multi-session probe** — the actual merge gate for the multi-session arc. **D7**.
- **Singleton-pin test flip** — the pre-D0.5 test that asserted "only one session at a time" is currently a freezer; flip to assert the inverse after D7. **D8**.

Phases M1–M6 (MCP multi-session), E1–E6.5 (Electron multi-session), T1–T2 (TUI multi-session), and X1–X3 (cleanup) chase D3 in parallel as the plan's dependency graph allows.

---

## Files touched

```
src/core/builder.ts            +95  -25  Promise-returning build() + dispose()
src/core/devtools.ts           +66  -39  Map<SessionId, SessionState>
src/core/metro.ts              +50  -19  Map<SessionId, MetroInstance>
src/core/devtools/host-capability.ts  +33  -22  per-session construction
src/core/session/boot.ts       +33  -2   sessionId field; builder.dispose() in dispose
src/core/types.ts              +12      MetroInstance.sessionId
src/daemon/client-rpcs.ts      +44  -24  services.sessionId; handle.promise
src/daemon/supervisor.ts       +1        thread entry.sessionId into bootFn
src/daemon/fake-boot.ts        +83  -25  fake builder returns BuildHandle
src/core/__tests__/builder-per-session.test.ts          NEW
src/core/__tests__/devtools-multi-session.test.ts       NEW
src/core/__tests__/metro-multi-session.test.ts          NEW
plus 9 existing test files updated for the typed API
```

Total: 21 files, +1345 lines, -326 lines.
