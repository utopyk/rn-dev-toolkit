# Module System — Phase 3a → Phase 3b Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 3a session)
**For:** The next Claude (or human) continuing this feature

---

## What is Phase 3a vs 3b?

Phase 3 in the plan covers a lot: MCP tool proxying, namespacer,
lifecycle tools, CLI flags, spec-version pinning, `tools/listChanged`
notifications, and the `destructiveHint` confirmation flow. That's more
surface than a single session should land without a review checkpoint,
so I split it:

- **Phase 3a (this session — shipped):**
  - `src/mcp/tool-namespacer.ts` — the Phase 1 naming policy enforced at
    the MCP boundary (helpers `splitNamespacedToolName`,
    `isFlatNamespaceTool`, `assertMcpToolName`).
  - `src/app/modules-ipc.ts` — daemon dispatcher for `modules/list`,
    `modules/status`, `modules/restart`.
  - `src/core/module-host/manager.ts::inspect(id, scope)` — read-only
    lifecycle snapshot for the dispatcher.
  - MCP tools: `rn-dev/modules-list`, `rn-dev/modules-status`,
    `rn-dev/modules-restart` — headless-compatible (return `no-session`
    when no daemon, identical posture to devtools-network-*).
  - Extended `McpFlags` + `parseFlags`:
    - `--enable-module:<id>` / `--disable-module:<id>` (repeatable)
    - `--allow-destructive-tools`
  - `start-flow.ts` loads `~/.rn-dev/modules/*/rn-dev-module.json`
    manifests into a `ModuleRegistry` and registers the IPC dispatcher
    against the session's `IpcServer`.

- **Phase 3b (next — deliberately deferred):**
  - `src/mcp/module-proxy.ts` — on `tools/call` for `<id>__<tool>`:
    resolve owning module → respect `destructiveHint` / allow flag →
    check activation events → `moduleHost.acquire()` → proxy RPC →
    timeout at 3s → surface `MODULE_UNAVAILABLE` /
    `MODULE_ACTIVATION_TIMEOUT`.
  - MCP `tools/list` reads manifests + their declared tools. Currently
    only built-ins surface; 3b adds module-contributed tools.
  - Emit `tools/listChanged` on install / uninstall / enable / disable
    / crash-to-FAILED / recover-from-FAILED.
  - `modules/enable` + `modules/disable` MCP tools with persistence
    (probably `~/.rn-dev/modules/<id>/enabled.flag` or similar).
  - MCP spec version pin (`2025-11-25`).
  - Per-module DevTools S1–S6 warnings codified in SDK.

### Why this split

Phase 3a is the low-risk, read-only half. Phase 3b is the part that
changes how agents actually consume modules — bigger blast radius,
deserves its own session + review.

---

## Commits landed this session

All on `feat/module-system-phase-0` (the same branch as PR #2):

| Commit | Scope |
|--------|-------|
| `6f1c0ae` | tool-namespacer + modules-ipc dispatcher + start-flow wiring (10 new MCP-side tests + 6 new modules-ipc tests) |
| `17b6170` | MCP tools `rn-dev/modules-*` + `McpFlags` extensions + 8 new parse-flags tests |

### Verification

- **vitest:** 521 passed / 18 pre-existing unrelated failures.
  - +24 new tests vs Phase 2 handoff baseline (10 tool-namespacer + 6
    modules-ipc + 8 parse-flags).
- **tsc:** 154 errors (unchanged baseline).
- **bun run build:** green.

---

## Files touched this session

| File | Change |
|------|--------|
| `src/mcp/tool-namespacer.ts` | **New** — `splitNamespacedToolName`, `isFlatNamespaceTool`, `assertMcpToolName`. Throws typed `ModuleError(E_TOOL_NAME_UNPREFIXED)` on violation. |
| `src/mcp/__tests__/tool-namespacer.test.ts` | **New** — 10 tests covering the triple-underscore edge case + built-in-flat enforcement. |
| `src/app/modules-ipc.ts` | **New** — daemon dispatcher for `modules/list` / `modules/status` / `modules/restart`. Exports `dispatchModulesAction` (unit-testable) + `registerModulesIpc(ipc, { manager, registry })`. |
| `src/app/__tests__/modules-ipc.test.ts` | **New** — 6 tests using a fake spawner (PassThrough streams with in-process `initialize` handler). |
| `src/core/module-host/manager.ts` | Added `inspect(id, scopeUnit)` method — read-only snapshot of `{ state, pid, lastCrashReason }`. |
| `src/mcp/tools.ts` | Extended `McpFlags` with 3 new fields (`enabledModules`, `disabledModules`, `allowDestructiveTools`) + added `buildModulesLifecycleTools` returning the 3 `rn-dev/modules-*` tools. |
| `src/mcp/server.ts` | `parseFlags` now parses `--enable-module:<id>`, `--disable-module:<id>`, `--allow-destructive-tools`. |
| `src/mcp/__tests__/tools.test.ts` | Count assertions: 24→27 default, 28→31 with `--enable-devtools-mcp`. `McpFlags` fixtures extended. |
| `src/mcp/__tests__/parse-flags.test.ts` | **New** — 8 tests for the new flag parsing. |
| `src/app/start-flow.ts` | Step 12 now loads user-global manifests via `moduleRegistry.loadUserGlobalModules(...)` and registers the IPC dispatcher against the session's `IpcServer`. |

---

## Permanent contract decisions made in Phase 3a

- **MCP-side tool naming uses `rn-dev/<verb>`**, not the plan's shorthand
  `modules/list`. Every existing `createToolDefinitions()` tool already
  uses the `rn-dev/` prefix; renaming them all is a breaking change for
  any external agent. The plan's `modules/*`, `metro/*`, `devtools/*`
  framing refers to the **conceptual** flat namespace (as opposed to 3p's
  `<id>__<tool>`); the wire name stays under `rn-dev/`. Documented here
  so nobody "fixes" this later without discussion.
- **`McpFlags` is now required full-shape.** The old `{ enableDevtoolsMcp,
  mcpCaptureBodies }` shorthand is gone from all callers. The default
  object in `createToolDefinitions` spells out every field. Tests and
  callers must provide complete `McpFlags`.
- **`--enable-module:<id>` vs `--disable-module:<id>` both recorded.**
  `parseFlags` does not resolve precedence — it just collects both sets.
  Phase 3b's tool-proxy will enforce "`disabledModules` wins" per the
  plan's documented precedence; `parseFlags` stays agnostic.
- **`modules/restart` tears down then re-acquires + immediately releases.**
  The MCP/IPC contract for "restart" is "subprocess is up again", not
  "hand me a refcount". The daemon doesn't hold a refcount on behalf of
  the MCP client — otherwise a restart tool call would pin the module
  forever if the client never called back.
- **IPC dispatcher for modules/* is scoped.** `registerModulesIpc` only
  responds to the 3 actions it owns; other IPC traffic passes through
  untouched, matching the `registerDevtoolsIpc` pattern.
- **`ModuleRegistry.inspect` exposes pid + lastCrashReason without
  handing out the `ModuleInstance`.** Prevents consumers from accidentally
  mutating state; Phase 3b can use it for `modules/status` crash details
  without widening the API.

---

## Deviations from the session prompt — explained

1. **Phase 3 is split 3a/3b.** Plan treats Phase 3 as one unit; I scoped
   this session to the read-only surface. 3b covers the heavier
   tool-proxying work.
2. **MCP names use `rn-dev/modules-*`**, not bare `modules/*`. See
   "permanent contract decisions" above.
3. **No `modules/enable` / `modules/disable` MCP tools yet.** The flags
   exist in `McpFlags` but no runtime toggle tool. Phase 3b pairs these
   with `tools/listChanged` emission — they only make sense together.
4. **No `tools/listChanged` notifications.** Phase 3b.
5. **Daemon-side manifest loading + IPC registration is inlined in
   `startServicesAsync`.** A cleaner factoring would be a dedicated
   `setupModuleSystem(...)` helper — noted for Phase 3b to pull out.

---

## What's next — Phase 3b

### Recommended scope

1. **`src/mcp/module-proxy.ts`** — on `tools/call` for `<id>__<tool>`:
   a. Split via `splitNamespacedToolName`; resolve owning module via IPC
      (`modules/list`) → if not found return `MODULE_UNAVAILABLE`.
   b. If tool has `destructiveHint: true`: require
      `flags.allowDestructiveTools === true` OR
      `args.permissionsAccepted` includes the tool id — else return
      `E_DESTRUCTIVE_REQUIRES_CONFIRM`.
   c. If module is inert: match activation events; fire
      `onMcpTool:<pattern>` — the daemon `moduleHost.acquire()` spawns.
   d. Emit MCP progress token immediately so clients see spawn latency.
   e. Timeout at 3s p95 → `MODULE_ACTIVATION_TIMEOUT` (already
      implemented as `ActivationTimeoutError` in Phase 2).
   f. Call `moduleHost.<daemon-ipc>`: request `modules/call` with
      `{ moduleId, tool, args }` — daemon proxies via the managed
      module's `ModuleRpc`.

2. **Daemon-side `modules/call` IPC handler.** Lives next to
   `modules-ipc.ts` dispatcher. Uses `manager.acquire(..., consumerId)`
   then `managed.rpc.sendRequest("tool/<name>", args)`. Phase 2's echo
   fixture already supports the `echo` request — use it for
   integration-test coverage.

3. **`tools/list` wiring.** Currently shows only built-ins. Phase 3b:
   - Call `modules/list` IPC at MCP startup.
   - For each enabled module, flatten its `contributes.mcp.tools` into
     `ToolDefinition[]` whose handler routes via `module-proxy`.
   - Respect `disabledModules` precedence.

4. **`tools/listChanged` notifications.** MCP spec: server notifies
   clients when the tool list changes. Emit on:
   - Module registered / unregistered (daemon → MCP via IPC event).
   - `modules/enable` / `modules/disable` MCP tool calls.
   - Crash-to-FAILED (already a ModuleHostManager event).
   - Recover-from-FAILED.

5. **`modules/enable` + `modules/disable` MCP tools.** Persistent toggle
   at `~/.rn-dev/modules/<id>/disabled.flag` (simple file presence). The
   daemon checks this during `loadUserGlobalModules` to skip registration.

6. **MCP spec version pin (`2025-11-25`).** Fail-fast on incompatible
   client init. Low-risk — already referenced in the plan.

7. **SDK `module-runtime`.** Consider pulling this into Phase 3b: add
   `src/module-runtime.ts` to the SDK exposing `defineModule({ activate,
   tools, panels })` with a real listen loop over vscode-jsonrpc.
   Module authors today have to bring their own RPC — echo fixture uses
   vscode-jsonrpc directly. This is the bit that lets 3p module authoring
   feel like a library call, not a protocol implementation.

### Things to NOT do in Phase 3b

- No Electron panel contributions (Phase 4).
- No marketplace install flow (Phase 6).
- No Device Control (Phase 7+).
- No signed-module verification — `manifest.signature` stays
  unimplemented.

### Rough size estimate

Phase 3b is ~2–3 days. The module-proxy + daemon call handler +
tools/listChanged wiring is the bulk; the SDK runtime is a separate
smaller effort.

---

## Integration test idea for Phase 3b

Extend `test/fixtures/echo-module/` or add a second fixture that
declares both `onStartup` and `onMcpTool:echo__ping` activation events.
Test:

1. Start daemon (in-process in the test), no modules activated yet.
2. Call `tools/list` — should see `echo__ping` contributed.
3. Call `tools/call` with `echo__ping` — should spawn (first-call cold
   start), return the echo payload, and remain active.
4. Call `modules/status` — should report `state: 'active'`.
5. Kill subprocess via `modules/restart` — verify `tools/listChanged`
   fires.

---

## Key decisions carried forward

All Phase 0/0.5/1/2 decisions still apply. Phase 3a adds:

- Daemon is the single source of truth for module lifecycle. MCP is a
  client; GUI (Phase 4) will be another client.
- `inspect()` is the read-only lens on `ModuleHostManager`; any new
  consumer (Phase 4 sidebar badge, Phase 3b `modules/status` extension
  for crash reason) must go through it rather than reaching into the
  entries map.
- Rejected-manifest reporting goes to the log stream with a
  `[ModuleRegistry]`-prefixed line including the error code
  (`E_INVALID_MANIFEST`, `E_HOST_RANGE_MISMATCH`,
  `E_TOOL_NAME_UNPREFIXED`, `E_INVALID_JSON`, `E_READ_FAILED`).

---

## Environment notes

- Node ≥18; bun for install + build + dev; vitest for tests.
- Branch: `feat/module-system-phase-0` (stacked commits — PR #2 now
  contains Phases 0/0.5/1/2/3a).
- No new runtime deps this session.
