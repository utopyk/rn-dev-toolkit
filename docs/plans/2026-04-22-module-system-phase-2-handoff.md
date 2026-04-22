# Module System — Phase 2 → Phase 3 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 2 session)
**For:** The next Claude (or human) continuing this feature

---

## Where we are

### Shipped this session (stacked onto PR #2)

Phase 2 — **subprocess module host + JSON-RPC protocol** — landed as a
series of commits on `feat/module-system-phase-0`:

| Step | Commit | Scope |
|------|--------|-------|
| 1 | `1062355` | `ModuleInstance` state machine (IDLE → SPAWNING → HANDSHAKING → ACTIVE → UPDATING → RESTARTING → CRASHED → FAILED → STOPPING). Pure logic; transition table enforced; 23 tests. |
| 2 | `9ac944c` | `CapabilityRegistry` — id-keyed registry with exact-match permission gating; 13 tests. |
| 3 | `ba9edb7` | `Supervisor` — LSP-style restart policy with injectable clock and sliding-window crash detection; 7 tests. |
| 4 | `29a3b1d` | `ModuleLockfile` — global-scope arbitration via PID/UID-stamped JSON file with stale-detection; 13 tests. |
| 5 | `2674d6c` | `ModuleRpc` + `performInitialize` — thin wrapper over `vscode-jsonrpc` stdio Content-Length framing; `ActivationTimeoutError` surfaced; 7 tests. |
| 6 | `4a3a206` | `ModuleHostManager` + `NodeSpawner` + `test/fixtures/echo-module/` fixture + 5 real-subprocess integration tests. |
| 7 | `3d924cd` | Daemon-side wiring: `startServicesAsync` now stands up a `ModuleHostManager` and registers built-in `appInfo` / `log` / `metro` / `artifacts` capabilities. |
| 8 | `255e2c4` | Added integration test for refcount-driven idle-shutdown (completes last Phase 2 success criterion). |

### Verification (2026-04-22)

- **vitest:** module-host suite 85/85 green (68 unit + 6 integration from manager, +11 added after). Full vitest: 497 passed / 18 pre-existing unrelated failures (chip tracked).
- **tsc:** 154 errors (unchanged baseline — same pre-existing OpenTUI / Promise-of-Array issues from Phase 0/0.5/1).
- **bun run build:** green.

### Phase 2 success criteria — checklist

From the plan's Phase 2 "Success criteria" section:

- ✅ Spawning a minimal fixture module and receiving a handshake reply works end-to-end in a vitest.
  - Covered by `manager.integration.test.ts::ModuleHostManager — integration (real subprocess) > spawns a module subprocess, completes the handshake, and reports 'active'`.
- ✅ Killing the host process (SIGTERM) kills the module subprocess.
  - Covered by `shutdownAll() kills every managed subprocess (orphan prevention)`. Uses `process.kill(-pid, 'SIGTERM')` on POSIX (detached process group). Windows is documented as v2.
- ✅ Crash loop detected and module transitions `CRASHED → ... → FAILED`.
  - Covered by `supervisor.test.ts::fifth crash within window transitions instance to 'failed'`.
- ✅ Two concurrent callers of the same `global` module share one subprocess via lockfile; idle-shutdown after both release.
  - Covered by `refcounts global-scope consumers and reuses a single subprocess` + `releases drive idle-shutdown for global-scope modules after last consumer leaves`.
- ✅ `host.capability('metro')` returns the MetroManager façade; `host.capability('artifacts')` returns `null` if `fs:artifacts` not granted.
  - `capabilities.test.ts` covers the registry contract. Daemon-side wiring (step 7) registers `metro` with `requiredPermission: "exec:react-native"` and `artifacts` with `requiredPermission: "fs:artifacts"`. Phase 3 will exercise this end-to-end when modules actually call `host.capability<T>()` over RPC.

---

## Files touched this session

| File | Change |
|------|--------|
| `package.json`, `bun.lock` | Added `vscode-jsonrpc@^8.2.1`. |
| `src/core/module-host/instance.ts` | **New** — state machine + `InvalidStateTransitionError`. |
| `src/core/module-host/capabilities.ts` | **New** — `CapabilityRegistry`. |
| `src/core/module-host/supervisor.ts` | **New** — crash-loop detector. |
| `src/core/module-host/lockfile.ts` | **New** — `ModuleLockfile`. |
| `src/core/module-host/rpc.ts` | **New** — `ModuleRpc` + `performInitialize` + `ActivationTimeoutError`. |
| `src/core/module-host/manager.ts` | **New** — `ModuleHostManager` + `NodeSpawner`. |
| `src/core/module-host/__tests__/instance.test.ts` | **New** — 23 tests. |
| `src/core/module-host/__tests__/capabilities.test.ts` | **New** — 13 tests. |
| `src/core/module-host/__tests__/supervisor.test.ts` | **New** — 7 tests. |
| `src/core/module-host/__tests__/lockfile.test.ts` | **New** — 13 tests. |
| `src/core/module-host/__tests__/rpc.test.ts` | **New** — 7 tests. |
| `src/core/module-host/__tests__/manager.integration.test.ts` | **New** — 6 real-subprocess tests. |
| `test/fixtures/echo-module/index.js` | **New** — spawnable ESM fixture. |
| `test/fixtures/echo-module/rn-dev-module.json` | **New** — matching manifest for registry tests. |
| `src/app/service-bus.ts` | Extended with `moduleHost` topic + `setModuleHost`. |
| `src/app/start-flow.ts` | Step 12 of `startServicesAsync` stands up ModuleHostManager and registers built-in capabilities; return type extended. |

---

## Permanent contract decisions made in Phase 2

- **Transition graph is frozen for 1.x.** Any addition of a state or arrow is additive; any removal = major bump. Current graph:
  ```
  idle       → spawning
  spawning   → handshaking | crashed
  handshaking→ active | crashed
  active     → updating | restarting | crashed | stopping
  updating   → active | crashed
  restarting → spawning
  crashed    → spawning | failed
  failed     → spawning                   (manual modules/restart recovery)
  stopping   → idle
  ```
- **Crash counter resets on `active`.** Successful recovery zeros both the instance's internal counter and the supervisor's sliding window. Does NOT reset on `failed` — the supervisor stays "gave up" even as the user clicks "Retry".
- **`FAILED → SPAWNING` is allowed.** User-driven recovery via the `modules/restart` MCP tool (Phase 3) or GUI "Retry" button respawns the subprocess and bypasses the supervisor's crash window, so the retry cycle actually runs (otherwise a module at 5/5 crashes would immediately re-fail on the first crash).
- **`ModuleRpc` is symmetric.** Same class on host and module sides; bound to either a `ChildProcess`'s pipes or the subprocess's `process.stdin / process.stdout`. No separate host/module classes.
- **Handshake is host-driven.** Host sends `initialize` with `{ capabilities: CapabilityDescriptor[], hostVersion }`, module returns `InitializeResult { moduleId, toolCount?, sdkVersion?, ...moduleReportedFields }`. If the module does not reply within `initializeTimeoutMs` (default 3000 — tracks Phase 3's cold-start SLO), the host transitions the instance to `crashed` and kills the subprocess with SIGKILL.
- **Spawner indirection is part of the contract.** `ModuleHostManager` takes a `ModuleSpawner` so tests can inject fake subprocesses and future runtimes (Electron main, Deno, Bun-only) can ship their own spawner without forking the manager.
- **Log forwarding via `log` notification.** Module → host JSON-RPC notification `log { level, message }` is re-emitted as a `log` event on the `ModuleHostManager` bus. Module `stderr` is also forwarded as `log` events with `level: "error"`. Phase 3's `modules/status` MCP tool surfaces these.
- **`NodeSpawner` uses `detached: true` on POSIX.** Process group = subprocess's pid × −1. Lets `process.kill(-pid, 'SIGTERM')` reap grandchildren (e.g. a module that spawns its own helpers). On Windows, `detached: true` creates a new process group but cross-process signal semantics differ — documented as a v2 gap.
- **Shutdown drain is 1 second.** `stopEntry` sends SIGTERM, waits up to 1s for `onExit`, then escalates to SIGKILL. Phase 3 might need this bumped for modules that do graceful draining (e.g. saving per-module state to disk) — currently nothing does so 1s is fine.

### Daemon-side capabilities registered in `startServicesAsync` step 12

| id | requiredPermission | Impl |
|----|--------------------|------|
| `appInfo` | *(none)* | `{ hostVersion, platform, worktreeKey }` |
| `log` | *(none)* | `LogCapability` — debug/info/warn/error; pipes through `serviceBus.log`. |
| `metro` | `exec:react-native` | Direct `MetroManager` reference. |
| `artifacts` | `fs:artifacts` | Direct `ArtifactStore` reference. |

Phase 3 adds `modules` (marketplace lookup) + possibly `devtools-network` (depends on the DevTools plan's direction).

---

## Deviations / gaps the next session should know about

1. **No in-SDK module-side RPC wrapper yet.** The `@rn-dev/module-sdk` still exposes only a type-only `HostApi` interface. The echo fixture uses `vscode-jsonrpc` directly. Phase 3 (or an early Phase 2.5) should:
   - Add `src/module-runtime.ts` to the SDK exposing `defineModule({ activate, tools, panels })` with a real activate-and-listen loop.
   - `host.capability<T>(id)` should proxy to a host-provided `capability/resolve` request (host side: respond using the bound granted-permissions set for that module).
   - This is the bit that actually makes 3p module authoring pleasant. For integration tests, the echo fixture is enough.
2. **Lockfile doesn't yet wire `socketPath`.** The v1 stored payload supports it; the manager doesn't populate it. Real cross-process proxy (where a second daemon sees the lockfile and becomes a client of the first) is a Phase 6+ marketplace concern — flagged in the plan's "proxy client" language, not blocking Phase 3.
3. **Windows:** `NodeSpawner`'s process-group kill is POSIX-only. Windows currently falls through to `child.kill(signal)`, which does not reap grandchildren. Phase 6 is when we sign an installer on Windows; orphan prevention there needs `win-job-object` or native Job Object via N-API.
4. **`crashed → failed` reason passthrough.** `Supervisor.onCrashed` calls `instance.transitionTo("failed", { reason: "... supervisor gave up." })` with its own message, not the original crash reason. The instance keeps `lastCrashReason` independently so both are observable, but the `failed` event reports the supervisor reason. Intentional — the `failed` cause the user cares about is "supervisor gave up after N crashes," not the message of the individual crash. The last-crash message is still accessible via `instance.lastCrashReason` for Phase 3's `modules/status` tool.
5. **No `stopping` emission on unexpected exit.** If the subprocess dies while in `active`, we go `active → crashed` directly (via the `child.onExit` path). `stopping` only runs when the host chooses to shut down. Matches the state graph but worth knowing.
6. **`startServicesAsync` reads `package.json#version` via `require()`.** Crude — flagged with a TODO comment. When the daemon is ever spun out into its own process, pin this at build time via `bun build --define`.

---

## What's next — Phase 3

Per the plan's Phase 3 section: **MCP tool proxying + module lifecycle tools.**

### Recommended scope for the next PR (stacked onto phase-0)

1. **`src/mcp/tool-namespacer.ts`** — enforce `<moduleId>__<tool>` prefix for 3p tool names in MCP `tools/list`. Built-ins pass through unchanged.
2. **`src/mcp/module-proxy.ts`** — on `tools/call`:
   - Resolve owning module via `ModuleRegistry.getAllManifests()` + manifest `contributes.mcp.tools[].name` lookup.
   - If `destructiveHint: true`: require confirmation (GUI) or `--allow-destructive-tools` / `permissionsAccepted` array (headless) — else return `E_DESTRUCTIVE_REQUIRES_CONFIRM`.
   - Module inert → run `activationEvents` (`onMcpTool:<pattern>` matches → `moduleHost.acquire(...)`).
   - Emit MCP progress token right away (spawn latency hits client).
   - Timeout at 3s p95 → `MODULE_ACTIVATION_TIMEOUT`.
   - Instance in `failed` → `MODULE_UNAVAILABLE`.
3. **`src/mcp/server.ts`** — parse `--enable-module:<id>`, `--disable-module:<id>`, `--allow-destructive-tools`. Pin MCP spec version `2025-11-25`. `tools/list` reads manifests only (never spawns). Emit `tools/listChanged` notification on install / uninstall / enable / disable / crash-to-FAILED / recover-from-FAILED.
4. **Built-in module lifecycle MCP tools** (flat namespace):
   - `modules/list` — returns installed modules with id, version, state, scope, enabled.
   - `modules/status` — per-module state + last-crash reason (already tracked on `ModuleInstance.lastCrashReason`).
   - `modules/restart` — manual `FAILED → SPAWNING` (this is why we kept that transition).
   - `modules/enable` / `modules/disable` — runtime toggles; emit `tools/listChanged`.
5. **Apply DevTools S1–S6 security controls to every module tool** — nonce, loopback bind, prompt-injection warning in descriptions. Codify in SDK so authors can't opt out.
6. **SDK module-runtime** (`packages/module-sdk/src/module-runtime.ts`) — see deviation #1 above. Ideally this lands in Phase 3 too since module authoring is what Phase 3 exposes to the world.

### Things to NOT do in Phase 3

- No Electron panel integration (Phase 4).
- No marketplace install flow (Phase 6).
- No Device Control (Phase 7+).
- No signed-module verification — `manifest.signature` stays unimplemented.

### Rough size estimate

Phase 3 is ~3–4 days. The MCP refactor touches `src/mcp/server.ts` + `src/mcp/tools.ts`, introduces two new modules (`tool-namespacer.ts`, `module-proxy.ts`), and adds SDK module-runtime. Cold-start SLO is the risk bit — the current `initializeTimeoutMs: 3000` already aligns, but `modulesload + activate + first RPC` needs to come in under 3s p95 on real modules.

---

## Key decisions carried forward

All Phase 0/0.5/1 decisions still apply. Phase 2 adds:

- **ModuleHostManager is the daemon-side singleton for subprocess lifecycle.** GUI and MCP are both clients — neither should `child_process.spawn` a module directly. Phase 3 routes `tools/call` through `moduleHost.acquire()`.
- **`consumerId` is the contract term** for acquire/release refcount keys. Phase 3's MCP proxy uses the request's MCP session id (or `mcp-<requestId>` for short-lived calls). Phase 4's Electron panels use `electron-panel-<panelId>`.
- **`Supervisor` is opt-in per module.** `ModuleHostManager` attaches one automatically in `spawnEntry`. Tests can bypass by instantiating a bare `ModuleInstance`.
- **Capabilities declare required permissions at registration time**, NOT at resolve time. Prevents accidental escalation if the caller's permission set is computed wrong — the source of truth is the registry entry.

---

## Open questions (carry over from Phase 1 + new)

From Phase 1 handoff:

1. ✅ Host ↔ module RPC protocol — confirmed `vscode-jsonrpc` stdio Content-Length framing.
2. ServiceBus generalization — still open. The `moduleHost` topic added in Phase 2 is a fixed single-slot; module-namespaced topics (`module:<id>:<topic>`) with declaration-merge typing is still a Phase 3+ concern.
3. SDK versioning policy — still open.
4. Device mirror transport — Phase 7.
5. `electron/ipc/services.ts` 499-line trim — pre-Phase 4.

New in Phase 2:

6. **How does Phase 3 discover which modules to load?** Registry provides `loadUserGlobalModules()`. Phase 3 needs to call it at daemon start (or lazily) and feed the `RegisteredModule[]` into `ModuleHostManager` as needed. Probably: load at startup, keep manifests in memory, spawn on first `tools/call` that matches an `onMcpTool:<pattern>` activation event.
7. **Is `metro` resolvable at daemon startup?** In `startServicesAsync`, `metro` is registered AFTER it's fully set up — but before any module could actually resolve it (module host comes last). Fine today. If a future refactor moves capability registration earlier, make sure the impls are non-null at resolve time.
8. **`log` capability is ServiceBus-scoped, not module-scoped.** Every module's `log()` currently emits into the same ServiceBus stream. Phase 3 might want to rewrap into a module-aware logger so MCP can surface `[device-control/info]` vs `[devtools/info]` cleanly. Minor.
9. **Handshake timeout exit code semantics.** Current behavior: host SIGKILLs the subprocess on `ActivationTimeoutError`. Some modules may need a "please drain before we kill you" hook — Phase 3/4 can add an `initialize-cancel` request for future-proofing; today's behavior is fine for v1.

---

## Environment notes

- Node ≥18; bun for install + build + dev; vitest for tests.
- Branch: `feat/module-system-phase-0` (stacked commits — PR #2 now contains Phases 0/0.5/1/2).
- `.claude/` still gitignored.
- New dep: `vscode-jsonrpc@^8.2.1`.
