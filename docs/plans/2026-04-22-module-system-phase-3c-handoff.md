# Module System — Phase 3c → Phase 4 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 3c session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 3c

The **persistent enable/disable surface** for modules. A pair of MCP
tools plus disk-backed persistence that lets operators and agents
disable a module at the daemon boundary without touching the manifest
or uninstalling it.

- **`~/.rn-dev/modules/<id>/disabled.flag`** — human-readable file-
  presence marker. Writing it disables; removing it enables.
- **`ModuleRegistry.loadUserGlobalModules` honors the flag** at load
  time. Disabled manifests don't register; they silently drop out of
  `modules/list`.
- **Daemon IPC** gained `modules/enable` and `modules/disable` actions.
- **MCP surface** gained `rn-dev/modules-enable` and
  `rn-dev/modules-disable` tools.
- **SDK** promoted `E_MODULE_CALL_FAILED` into the
  `ModuleErrorCode` enum (it was an inline string in Phase 3b).

### Commits

| Commit | Scope |
|--------|-------|
| `f82c645` | disabled-flag persistence + daemon enable/disable + MCP tools + SDK enum promotion (+13 new tests) |

### Verification

- **vitest:** 550 passed / 18 pre-existing unrelated failures.
  - +13 tests vs Phase 3b baseline (6 disabled-flag + 7 modules-ipc).
- **tsc:** 154 errors (unchanged baseline).
- **bun run build:** green.

---

## Files touched

| File | Change |
|------|--------|
| `src/modules/disabled-flag.ts` | **New** — `isDisabled`, `setDisabled`, `disabledFlagPath`, `defaultModulesRoot`. |
| `src/modules/__tests__/disabled-flag.test.ts` | **New** — 6 tests covering flag ops + registry skip behavior. |
| `src/modules/registry.ts` | `loadUserGlobalModules` now short-circuits on `isDisabled(entry, modulesDir)` before reading the manifest. |
| `src/app/modules-ipc.ts` | Added `modules/enable` + `modules/disable` actions. Dispatcher options extended with `modulesDir` + `hostVersion` + `scopeUnit` so the enable path can re-run the loader. |
| `src/app/__tests__/modules-ipc.test.ts` | +7 tests for enable/disable (idempotence, payload validation, subprocess teardown). |
| `src/mcp/tools.ts` | Added `rn-dev/modules-enable` + `rn-dev/modules-disable` tools. |
| `src/mcp/__tests__/tools.test.ts` | Count assertions: 27→29 default, 31→33 with `--enable-devtools-mcp`. |
| `packages/module-sdk/src/errors.ts` | Promoted `E_MODULE_CALL_FAILED` into `ModuleErrorCode`. |

---

## Permanent contract decisions made in Phase 3c

- **The disabled.flag file is the source of truth.** Not an in-memory
  Set. Not a settings database. File-presence survives daemon restarts,
  is inspectable with `ls`, and can be manually repaired if the daemon
  refuses to start.
- **Flag file path is canonical:** `~/.rn-dev/modules/<id>/disabled.flag`.
  Tests override via a `modulesDir` option on both the flag helpers and
  the dispatcher options.
- **`modules/disable` shuts down the running subprocess immediately.**
  It doesn't wait for consumers to release. The subprocess is killed;
  outstanding `modules/call` requests fail. Rationale: an operator
  disabling a module almost certainly wants the bleeding to stop now,
  not "after the agent finishes its current task".
- **`modules/enable` on a not-yet-loaded module triggers a registry
  re-load.** The dispatcher takes `hostVersion` + `scopeUnit` in its
  options so the re-load can happen without the caller threading them
  through.
- **Idempotent responses:** both actions report `alreadyDisabled` /
  `alreadyEnabled` so agents can detect no-ops without re-reading state.
- **`unregisterManifest` on disable, not just `shutdown`.** The
  registry's manifest map is updated so the next `modules/list` snapshot
  doesn't surface a ghost entry.

---

## Where the module system stands (end of 3c)

PR [#2](https://github.com/utopyk/rn-dev-cli/pull/2) now contains, on
branch `feat/module-system-phase-0`:

- **Phase 0/0.5:** Monorepo foundation + ipc-bridge split.
- **Phase 1:** `@rn-dev/module-sdk` v0.1 — manifest schema (JSON Schema
  draft 2020-12, versioned `$id`), hand-written types, `defineModule()`
  runtime validator, `enforceToolPrefix()` 3p policy check, typed error
  codes, host-RPC type surface. `ModuleRegistry.loadUserGlobalModules`
  + scope-aware keys.
- **Phase 2:** Subprocess module host — `ModuleInstance` state machine,
  `Supervisor` (LSP restart policy), `ModuleLockfile`, `ModuleRpc`
  (vscode-jsonrpc), `ModuleHostManager` with refcount + idle-shutdown +
  orphan prevention. Daemon-side wiring + built-in capabilities
  (`appInfo`, `log`, `metro`, `artifacts`) registered in
  `startServicesAsync`.
- **Phase 3a:** `tool-namespacer.ts`, daemon `modules/list` /
  `modules/status` / `modules/restart` IPC, MCP tools
  `rn-dev/modules-list` / `-status` / `-restart`, CLI flags
  (`--enable-module:<id>`, `--disable-module:<id>`,
  `--allow-destructive-tools`).
- **Phase 3b:** `modules/call` end-to-end — IPC dispatcher +
  `src/mcp/module-proxy.ts` + `tools/list` composition. `destructiveHint`
  gating at the MCP boundary. Automatic description decoration with
  security warning.
- **Phase 3c (this session):** persistent enable/disable via
  `disabled.flag`, MCP tools `rn-dev/modules-enable` /
  `rn-dev/modules-disable`, `E_MODULE_CALL_FAILED` promoted to the
  SDK enum.

**Test totals**: ~150 new tests across Phase 1–3c. Full vitest: 550
passed / 18 pre-existing unrelated failures (chip tracked). tsc: 154
errors (unchanged baseline). `bun run build`: green.

---

## What's still deferred (Phase 3 → Phase 4 gap)

These are Phase 3 items the plan called for that I deliberately did
NOT ship this stretch. Each is safe to skip for now — nothing
downstream today requires them — but each should land before the
feature set is complete.

1. **`tools/listChanged` notification emission.** MCP server's
   `tools/list` is still static-at-startup. After a module installs /
   crashes / gets enabled or disabled, agents need to re-handshake to
   see the change. Implementation sketch:
   - `ModuleHostManager` events (`crashed`, `failed`, new entry) →
     emit IPC-level events on a subscribe channel.
   - MCP server subscribes; on each event, calls
     `server.sendNotification("notifications/tools/list_changed")`.
   - Also fire on `modules/enable` / `modules/disable` /
     `modules/install` (Phase 6) / `modules/uninstall`.

2. **SDK `module-runtime.ts`.** Module authors still have to bring
   their own `vscode-jsonrpc` setup (the echo fixture does this
   inline). The SDK should expose `runModule({ manifest, tools,
   activate, panels })` that wires stdin/stdout framing, the
   `initialize` handler, and `tool/<name>` routing. Without this,
   3p authoring feels like implementing a protocol instead of calling a
   library.

3. **Progress-token streaming on cold-start.** The plan asks for "emit
   MCP progress token immediately so clients see spawn latency". Phase
   3b just awaits the IPC response. Agents currently see a pause, not a
   "spawning" signal. Low priority for v1; nice-to-have for UX.

4. **Per-activation-event routing.** `onMcpTool:<pattern>` activation
   events aren't checked — a `<id>__<tool>` call just acquires
   regardless. Functionally correct today because the manifest already
   declared the tool; but strict activation-event matching would
   prevent "tool exists but activation event was narrower than tool
   list" drift. Low priority.

5. **MCP spec version pin (`2025-11-25`).** Simple
   `server.setRequestHandler(InitializeRequestSchema, ...)` wiring.

6. **Headless-daemonless `tools/call` path.** Today if no daemon is
   running, module tools silently don't surface. A future mode could
   spawn modules directly from the MCP process (Phase 2's
   `ModuleHostManager` already supports a custom spawner). Only
   relevant for users who don't run the TUI/GUI.

---

## What's next — Phase 4

Electron panel contributions (WebContentsView pivot).

### Recommended scope

1. `electron/panel-bridge.ts` — host-side registry that, given a
   manifest, creates a `WebContentsView` with:
   - `partition: 'persist:mod-<id>'`
   - `preload: electron/preload-module.js` (single preload, receives
     moduleId + hostApi[] via query)
   - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`
2. `electron/preload-module.ts` — exposes `rnDev.<allowlistedMethod>`
   via `contextBridge` per the manifest's `contributes.electron.panels[].hostApi`.
3. `renderer/components/ModulePanel.tsx` — generic embedder; resizes on
   layout events; focuses on click.
4. Build the view map from `invoke('modules:list')` instead of the
   hardcoded sidebar switch. Remove `ViewTab` union; `string` is fine.
5. Panel-bridge ties `rnDev.<method>` calls into `ModuleHostManager`'s
   RPC so UI events reach the module subprocess.

### Prerequisites worth landing first

- `tools/listChanged` emission (from Phase 3c deferred list) — the
  Electron sidebar needs to re-render when a module installs or crashes.
- SDK `module-runtime.ts` — Electron module authors need the same
  authoring ergonomics MCP module authors will.

Consider Phase 3d (~1 day) to pick both up before diving into the
Electron work.

### Rough size estimate

- Phase 3d (listChanged + SDK runtime + small polish): ~1 day
- Phase 4 proper (Electron panels): ~3–5 days, mostly due to
  `WebContentsView` surface area (Chromium 30+) and the preload/
  contextBridge allowlist semantics.

---

## Environment notes

- Node ≥18; bun for install + build + dev; vitest for tests.
- Branch: `feat/module-system-phase-0` — PR #2 now contains Phases
  0/0.5/1/2/3a/3b/3c. That's 6 named phases in one PR; it may be
  worth splitting once Phase 4 lands. Suggested split point: after
  Phase 3c ships, squash-merge to `main` and branch Phase 4 fresh.
- No new runtime deps this session.
