# Module System — Phase 3d → Phase 4 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 3d session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 3d

Two deliverables, each a prerequisite the Phase 3c handoff flagged for
Phase 4's Electron panel work:

1. **`tools/listChanged` notification emission.** Agents connected to
   the MCP server now learn about module installs / crashes / enable /
   disable without polling. The server captures a fresh tool snapshot
   and calls `server.sendToolListChanged()` within ~10ms of the change.

2. **SDK `runModule()`.** Third-party authors no longer reimplement the
   vscode-jsonrpc protocol per-module. The SDK owns stdin/stdout framing,
   the `initialize` handshake, and `tool/<name>` routing. Tool handlers
   receive `ctx = { log, appInfo, hostVersion, sdkVersion }`.

### Commits

| Commit   | Scope |
|----------|-------|
| `5ba96ab` | tools/listChanged — IPC subscribe action, manager event bridge, MCP server subscribe wiring, `tools.listChanged: true` capability (+10 tests) |
| `5c276ac` | SDK `runModule()` + echo fixture rewrite + SDK build pipeline (+9 tests) |

### Verification

- **vitest:** 569 passed / 18 pre-existing unrelated failures.
  - +19 tests vs Phase 3c baseline (2 ipc, 5 modules-subscribe, 3 mcp
    subscribe-to-module-changes, 9 module-runtime).
- **tsc:** 154 errors (unchanged baseline).
- **bun run build:** green.
- **SDK build:** `packages/module-sdk/dist/index.js` (12.2 KB), built
  automatically via vitest globalSetup on every test run.

---

## Files touched

### Phase 3d part 1 — tools/listChanged

| File | Change |
|------|--------|
| `src/core/ipc.ts` | `IpcMessageEvent.onClose` hook; new `IpcClient.subscribe()` that resolves on the initial response then streams subsequent events on the same socket. |
| `src/core/__tests__/ipc.test.ts` | +2 tests (subscribe streaming, server-side onClose fires on client dispose). |
| `src/app/modules-ipc.ts` | `ModulesEvent` payload type; new `modules/subscribe` action; `moduleEvents` EventEmitter in `registerModulesIpc`; `ModuleHostManager` events (crashed/failed/state-changed to-or-from active) bridge into the bus; `enableModule` / `disableModule` / `restart` emit the right kinds. |
| `src/app/__tests__/modules-subscribe.test.ts` | **New** — 5 tests (dispatcher emissions + end-to-end subscribe via real IpcServer + socket-close detach). |
| `src/mcp/server.ts` | Capability now declares `tools: { listChanged: true }`; `moduleTools` snapshot is mutable; exported `subscribeToModuleChanges()` helper re-fetches tool contributions and calls `sendToolListChanged()` on every event. |
| `src/mcp/__tests__/subscribe-to-module-changes.test.ts` | **New** — 3 tests (no-ipc path, no-daemon path, happy-path notify-on-event). |

### Phase 3d part 2 — SDK runModule + echo fixture rewrite

| File | Change |
|------|--------|
| `packages/module-sdk/src/module-runtime.ts` | **New** — `runModule()`, `ModuleAppInfo`, `ModuleToolContext`, `ToolHandler`, `RunModuleHandle`. |
| `packages/module-sdk/src/__tests__/module-runtime.test.ts` | **New** — 9 tests (initialize response, tool routing, ctx shape, activate, deactivate, log notifications, onInitialize, onConnection, flat-namespace keys). |
| `packages/module-sdk/src/index.ts` | Re-exports `runModule` + types. |
| `packages/module-sdk/package.json` | Adds `vscode-jsonrpc` dep; `main` → `./dist/index.js`; conditional `exports` (types→src, default→dist); new `build` script. |
| `packages/module-sdk/build.ts` | **New** — Bun bundler building `src/index.ts` → `dist/index.js` (externalizes vscode-jsonrpc + ajv). |
| `vitest.config.ts` | Adds `globalSetup: ["./vitest.global-setup.ts"]`. |
| `vitest.global-setup.ts` | **New** — rebuilds SDK before the suite runs. |
| `test/fixtures/echo-module/index.js` | Rewritten to use `runModule()` + `onInitialize` + `onConnection`. All 6 `manager.integration.test.ts` assertions pass unchanged. |

---

## Permanent contract decisions made in Phase 3d

- **The daemon is authoritative for tool-list freshness.** The MCP
  server never reads `modules.json` directly; it always goes through the
  `modules/list` IPC. `tools/listChanged` just prompts a re-fetch.
- **`modules/subscribe` is stream-shaped.** The first response confirms
  the subscription (`{ subscribed: true }`); every subsequent message is
  an `{ type: "event", action: "modules/event", payload: ModulesEvent }`
  delivered on the same socket with the same id. Clients close the
  socket to unsubscribe — no explicit `modules/unsubscribe` action.
- **`IpcMessageEvent.onClose` is required, not optional.** All new IPC
  handlers get it; existing consumers (`modules-ipc`, `devtools-ipc`)
  simply ignore it. Subscription-style actions depend on it to detach
  listeners when the MCP server disconnects.
- **Manager event-bridge lives in `registerModulesIpc`**, not on
  `ModuleHostManager`. Rationale: the manager is a low-level state
  machine; fanning out to an IPC bus is an app-layer concern. The
  dispatcher composes manager events + dispatcher-level events (enable/
  disable/restart) into one stream.
- **State transitions gate on `to === "active"` OR `from === "active"`.**
  Internal ticks (spawning → handshaking → active) don't wake agents;
  only transitions that change whether the module's tools are callable
  do. This keeps the notification volume proportional to meaningful
  change.
- **`runModule()` is the contribution surface for 3p authors.** The
  `tools` map keys are full manifest names (`<moduleId>__<tool>`); the
  SDK strips the prefix when registering the JSON-RPC handler. Built-in
  modules use bare keys and pass through.
- **`onInitialize` and `onConnection` are escape hatches, not primary
  API.** They exist for fixtures and forward-compat; real 3p modules
  should stay on `tools` + `activate` + `deactivate`.
- **SDK `dist/` is gitignored; vitest globalSetup rebuilds it.**
  Developers modifying SDK source see their changes on the next
  `vitest run` without a manual `bun run build`. Production consumers
  get `dist/` via `npm pack`.

---

## Where the module system stands (end of 3d)

PR [#2](https://github.com/utopyk/rn-dev-cli/pull/2) now contains, on
branch `feat/module-system-phase-0`:

- **Phase 0 / 0.5:** Monorepo foundation + ipc-bridge split.
- **Phase 1:** `@rn-dev/module-sdk` v0.1 — manifest schema, validator,
  3p prefix policy, typed error codes, host-RPC type surface, registry.
- **Phase 2:** Subprocess module host — state machine, supervisor,
  lockfile, RPC, refcounted manager.
- **Phase 3a:** `tool-namespacer`, daemon `modules/list|status|restart`
  IPC, MCP `rn-dev/modules-*` tools, CLI flags.
- **Phase 3b:** `modules/call` end-to-end + `destructiveHint` gating.
- **Phase 3c:** persistent enable/disable via `disabled.flag`, MCP
  tools, `E_MODULE_CALL_FAILED` promoted to the SDK enum.
- **Phase 3d (this session):** `tools/listChanged` emission on module
  drift + SDK `runModule()` author entry point + SDK build pipeline.

**Test totals:** ~170 new tests across Phase 1–3d (19 added this
session). Full vitest: 569 passed / 18 pre-existing unrelated failures.
tsc: 154 errors (unchanged). `bun run build`: green.

---

## What's still deferred (Phase 3d → Phase 4 gap)

From the Phase 3c handoff's list of deferred items, Phase 3d shipped
(1) and (2). These remain:

3. **Progress-token streaming on cold-start.** The plan asks for MCP
   progress tokens emitted while a module spawns so clients see spawn
   latency as a "spawning" signal rather than a pause. Low priority.

4. **Per-activation-event routing.** `onMcpTool:<pattern>` activation
   events still aren't checked — a `<id>__<tool>` call acquires
   regardless. Functionally correct; strict matching is a belt-and-
   suspenders defense.

5. **MCP spec version pin (`2025-11-25`).** Simple
   `server.setRequestHandler(InitializeRequestSchema, ...)` wiring.

6. **Headless-daemonless `tools/call` path.** When no daemon is running,
   module tools silently don't surface. Phase 2's `ModuleHostManager`
   supports a custom spawner, so a future mode could spawn modules
   directly from the MCP process. Only relevant for TUI/GUI-less users.

---

## What's next — Phase 4

Electron panel contributions (WebContentsView pivot). The Phase 3c
handoff still describes the target accurately; Phase 3d didn't change
the Phase 4 scope. Recap:

1. `electron/panel-bridge.ts` — host-side registry that creates a
   `WebContentsView` per `manifest.contributes.electron.panels[]` with:
   - `partition: 'persist:mod-<id>'`
   - `preload: electron/preload-module.js` (single preload, moduleId +
     hostApi[] via query)
   - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`
2. `electron/preload-module.ts` — `contextBridge.exposeInMainWorld('rnDev', …)`
   exposing only manifest-declared `hostApi[]` methods.
3. Daemon-side `host/*` RPC handlers on each managed module's `rpc`.
   Resolves via the capability registry with the module's granted
   permissions. This is what makes `host.capability<T>(id)` actually do
   something (currently type-only).
4. `renderer/components/ModulePanel.tsx` — generic `WebContentsView`
   embedder that resizes on layout changes and focuses on click.
5. `renderer/App.tsx` refactor — build view map from
   `invoke('modules:list')` instead of the hardcoded `ViewTab` switch.
   Remove the `ViewTab` union; `string` is fine.
6. Security controls: `panel-bridge.ts` enforces no cross-module
   delivery; every cross-channel send audit-logged; applies the S1–S6
   controls from the DevTools plan per-module.

### Prerequisites status

- ✅ **`tools/listChanged` emission** — shipped this session.
- ✅ **SDK `runModule()`** — shipped this session; the same ergonomic
  win applies to Electron module authors: they `runModule(…)` once and
  get the subprocess wiring for free.
- 🔜 **Phase 4 proper** — Electron panels.

### Rough size estimate

- Phase 4 proper (Electron panels): ~3–5 days, mostly due to
  `WebContentsView` surface area (Chromium 30+) and the preload/
  contextBridge allowlist semantics.

---

## Environment notes

- Node ≥18; Bun for install + build + dev; vitest for tests.
- Branch: `feat/module-system-phase-0` — PR #2 now contains Phases
  0/0.5/1/2/3a/3b/3c/3d. That's **7** named phases in one PR. The
  Phase 3c handoff suggested splitting after 3c; the Phase 3d session
  continued stacking on the same branch per Martin's call. Suggested
  split point: **squash-merge PR #2 to `main` before starting Phase 4**,
  so Phase 4's ~3–5 days of Electron work land on a fresh, reviewable
  branch.
- New runtime dep this session: `vscode-jsonrpc` in
  `packages/module-sdk` (already present at the repo root; workspace
  hoist keeps the install identical).
- SDK build is automatic via `vitest.global-setup.ts`. Authors running
  bare `node packages/module-sdk/build.ts` can rebuild manually.
