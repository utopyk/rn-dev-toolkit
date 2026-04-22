---
title: Third-Party Module System + Device Control (first 3p module)
type: feat
status: active
date: 2026-04-21
origin: docs/brainstorms/2026-04-21-module-system-and-device-control-brainstorm.md
---

# Third-Party Module System + Device Control (first 3p module)

## Revision Log — Technical Review Amendments (2026-04-21)

After multi-reviewer technical review (architecture, simplicity, security, agent-native), the plan is preserved in scope but amended in these specific ways. Changes are marked inline in each phase; this section is the changelog.

**Security amendments (from security-sentinel; v1 blockers):**
- Phase 6: `@npmcli/arborist` configured with `--ignore-scripts`; transitive deps pinned by resolving the tree at curation time and shipping the lockfile in the registry entry (not just a package spec).
- Phase 6: `modules.json` protected against registry-compromise — host pins a SHA-256 of the expected `modules.json` per host release; mismatch triggers a warning + refuses auto-install. Detached signature verification against a host-baked pubkey is a v1.1 upgrade path.
- Phase 6: **Consent modal wording reflects reality** — permissions are advisory; the modal says so in plain English. First-ever 3p install on a fresh host requires a one-time acknowledgment ("Third-party modules run as your user and can do anything you can do").
- Phase 6: Tool descriptions (full text agents will see) are displayed in the install consent modal — users inspect what they're authorizing.
- Phase 3: Tools with `destructiveHint: true` require per-call runtime user confirmation when running in GUI mode; in headless MCP mode they require a pre-granted `--allow-destructive-tools` flag or `permissionsAccepted` array in the `tools/call` arguments.
- Phase 4: Host→webview messages route through a per-module channel; `panel-bridge.ts` enforces no cross-module delivery + audit-logs all cross-channel sends.
- Phase 6: Audit log (`~/.rn-dev/audit.log`) is written only through a host-only API with an HMAC sequence chain; modules cannot write or delete the log directly. Stored with restricted POSIX mode (0600 on macOS/Linux) and append-only attribute where the OS supports it.
- Phase 7: Device operations logged with the **calling module id** (supports chained attribution through `uses:` in Phase 10).

**Architecture amendments (from architecture-strategist; no scope change, just sequencing and correctness):**
- **NEW Phase 0.5 — Split [electron/ipc-bridge.ts](electron/ipc-bridge.ts) before Phase 4.** The file is already 1203 lines; adding module handlers on top of it compounds debt fast. Split into `electron/ipc/{instance,profile,wizard,devtools,modules}.ts` with a thin `electron/ipc/index.ts` barrel.
- Phase 2: `ModuleHostManager` runs in the **long-lived daemon process** (same process owning `MetroManager`/`DevToolsManager`), not Electron main. GUI and MCP modes share one process topology — Electron main is a client over IPC, MCP is a client over stdio.
- Phase 2: State machine — add `FAILED` (terminal, supervisor gave up) distinct from `CRASHED` (transient); add `UPDATING` for in-flight drain on version bump; drop `RECONNECTING` (processes don't reconnect), rename to `RESTARTING` (supervisor-driven respawn).
- Phase 2: `ModuleHostManager` implements `acquire(consumerId)` / `release(consumerId)` refcounting for `global` scope modules; idle-shutdown after last release + 60s grace period.
- Phase 1: Reserve manifest fields for V2 without implementation — `signature?: {...}`, `sandbox?: {...}`, `target?: { kind: 'emulator' | 'simulator' | 'physical' }`, and `scope: 'global' | 'per-worktree' | 'workspace'` (third value accepted but treated as `per-worktree` in v1). Schema is additive-only within 1.x.
- Phase 1: Add `contributes.api?: {...}` to manifest schema now (used by Phase 10's `host.call` — explicit method signatures, not implicit surface).
- SDK: Replace `host.metro` / `host.artifacts` with generic `host.capability<T>(id: string)` lookup. Built-ins register against the same registry as 3p; `metro` / `artifacts` are just the first entries. Prevents freezing specific built-ins into the SDK contract.

**Agent-native amendments (from agent-native-reviewer; MCP parity with the GUI):**
- Phase 3: Add MCP tools `modules/list`, `modules/status`, `modules/restart`, `modules/enable`, `modules/disable`.
- Phase 6: Add MCP tools `marketplace/list`, `marketplace/search`, `marketplace/info`, `modules/install` (with `permissionsAccepted: string[]` for headless consent), `modules/uninstall` (with `keepData: boolean`).
- Phase 5: Add MCP tools `modules/config/get`, `modules/config/set`; define per-module config schema at `~/.rn-dev/modules/<id>/config.json`, declared in manifest `contributes.config.schema`.
- Phase 3: Wire MCP `tools/listChanged` notification on install / uninstall / enable / disable / crash / recover.
- Phase 7: `device/mirror/start`, `device/mirror/stop`, `device/mirror/frame` MCP tools — streaming frame access for agents (MJPEG-chunked base64 over MCP notifications; WebCodecs H.264 for the webview).

**Tool prefix policy (from architecture-strategist; permanent contract decision):**
- Built-in modules keep flat namespace (`metro/*`, `devtools/*`, `modules/*`, `marketplace/*`, `device/*` for the first-party-by-ownership Device Control if and only if it ever gets pulled in-tree — it stays 3p-packaged as `device-control__*`).
- All third-party modules MUST use `<moduleId>__<tool>` (double underscore, MetaMCP convention).
- Host rejects 3p tools that don't match at manifest-load time with `E_TOOL_NAME_UNPREFIXED`.
- If a first-party module is ever promoted to a 3p package (or vice-versa), tool names change AND the old names ship as deprecation aliases for two minor versions with `destructiveHint: true` warnings in the description.

## Overview

Turn the RN dev toolsuite into a platform. Introduce a declarative, subprocess-isolated third-party module system that contributes MCP tools (required), Electron UI panels (required), and optional terminal TUI views — then co-develop `@rn-dev-modules/device-control`, an open-source, agent-native, Maestro-inspired module for Android emulators and iOS simulators, as the first validator of the 3p contract. A privileged built-in **Marketplace** module discovers modules from a curated GitHub-hosted `modules.json` and installs them with a permission-consent dialog.

**Shape of the work:** one bun-workspaces monorepo, three stacks:
1. **Host** (existing `src/` + `electron/` + `renderer/`) — extended with a module host, SDK-aware registry, MCP tool proxying, and a generic `<ModulePanel>` renderer.
2. **`@rn-dev/module-sdk`** — new package (`packages/module-sdk/`) exposing manifest types, JSON Schema, `defineModule()` helper, and the typed host-RPC client.
3. **`@rn-dev-modules/device-control`** — new module package (`modules/device-control/`) exercising every SDK surface.

## Problem Statement

The toolsuite already has a module abstraction (`RnDevModule` in [src/core/types.ts:105](src/core/types.ts:105)), but it is **Ink-only**. MCP tools are hardcoded in [src/mcp/tools.ts](src/mcp/tools.ts) and Electron views are hardcoded in [renderer/App.tsx:395](renderer/App.tsx:395). The active DevTools Network plan ([2026-04-21-feat-agent-native-devtools-network-plan.md](docs/plans/2026-04-21-feat-agent-native-devtools-network-plan.md), Phase 1 landed in commit `854617a`) is hand-wiring a first-party "three-surface" module; generalizing that hand-wiring into a real contract — one that 3p authors can depend on — is what this plan does.

Without this work:

- Every new capability (DevTools Network, Device Control, future modules) requires simultaneous edits to three unrelated files in three unrelated layers.
- External contributors can't ship a module without forking the host.
- The agent-native thesis (MCP is the primary contract) has no path to extensibility — only the first-party tools we bake in.

## Proposed Solution

**Declarative manifest + subprocess isolation + typed RPC, mirroring the VSCode Extension Host model** but adapted to three surfaces (MCP, Electron, TUI) and agent-native use cases.

Every module ships a `rn-dev-module.json` manifest at package root declaring:
- `id`, `version`, `hostRange` (semver)
- `scope`: `global` | `per-worktree`
- `contributes.mcp.tools[]` — declared statically with full `inputSchema` so `tools/list` never spawns a subprocess
- `contributes.electron.panels[]` — id, title, icon, webview entry, `hostApi[]` allowlist of RPC methods the panel may call
- `contributes.tui.views[]` (optional)
- `permissions[]` — `adb`, `net:<port-range>`, `fs:artifacts`, `exec:<binary>`, `network:outbound`
- `activationEvents[]` — `onStartup`, `onMcpTool:<pattern>`, `onElectronPanel:<id>`, `onWorktreeOpen`
- `uses[]` — module-to-module dependencies, resolved via `@npmcli/arborist`

The host runs each active module in its own Node subprocess, framed with **`vscode-jsonrpc`** (Content-Length headers, battle-tested in the LSP ecosystem). Crash-and-restart follows the LSP policy: restart unless ≥5 crashes in 3 min, then mark the module `Failed` and surface a dismissable notification. Orphan prevention uses a POSIX process group on macOS/Linux and a Windows Job Object.

**Namespaced MCP tools** (`<moduleId>__<tool>`, `__` separator — MetaMCP convention) let agents see all contributed tools in `tools/list` without spawning subprocesses. On `tools/call`, the host spawns the owning subprocess lazily (MCP-only mode) or uses the already-running instance (GUI mode). First-call spawn is gated by a **3s p95 cold-start SLO** enforced by an MCP progress token.

**Electron panels embed via `WebContentsView`** (the 2026 Electron-recommended alternative to `<webview>`; see Technical Approach for why we're pivoting away from the brainstorm's `<webview>` choice). Each module gets its own `partition: 'persist:mod-<id>'` and a thin module-scoped preload that exposes only the manifest-declared `hostApi` methods via `contextBridge.exposeInMainWorld('rnDev', …)`.

**Marketplace is a privileged built-in module** listing entries from `https://github.com/<owner>/rn-dev-modules-registry/blob/main/modules.json` (schema TBD in Phase 6). Install uses `@npmcli/arborist` directly (not `execa npm install`) to get a proper lockfile-backed tree and reliable error reporting. A Chrome-style permission-consent modal gates every install.

**`@rn-dev-modules/device-control`** exercises every surface:
- Android (via **appium-adb** for commands + **adbkit** for framebuffer streaming).
- iOS Simulator (via **simctl** for lifecycle + **idb** for input/accessibility/video, with explicit `simctl`-only fallback because idb's maintenance has slowed post-2023).
- Live device view transported over **ws-scrcpy**-style H.264 + WebSocket, decoded in the panel with the WebCodecs API (Electron's Chromium 94+ supports it natively).
- Record/replay flows in a canonical JSON format (`schemaVersion` field) with a **Maestro-compatible YAML** export facade.

## Technical Approach

### Architecture

```
rn-dev-cli/                              (bun-workspaces monorepo root)
├── package.json                          EXTEND: add "workspaces": ["packages/*", "modules/*"]
│
├── src/                                  (host — stays at repo root for v1)
│   ├── core/
│   │   ├── module-host/                 NEW
│   │   │   ├── manager.ts               per-host ModuleHostManager (EventEmitter + Map), mirrors MetroManager / DevToolsManager
│   │   │   ├── instance.ts              per-subprocess state machine: IDLE→SPAWNING→HANDSHAKING→ACTIVE→RECONNECTING→CRASHED→STOPPING
│   │   │   ├── rpc.ts                   vscode-jsonrpc wrapper: host↔module typed calls
│   │   │   ├── supervisor.ts            LSP-style restart policy (≥5 in 3min), orphan prevention (process group / Job Object)
│   │   │   ├── lockfile.ts              global-scope arbitration via ~/.rn-dev/modules/<id>/.lock
│   │   │   └── capabilities.ts          host capability registry (ArtifactStore, ServiceBus topic, etc.) exposed over RPC
│   │   ├── module-registry.ts           EXTENDS src/modules/registry.ts: manifest load + schema validate + hostRange + permission check + activation state
│   │   └── modules-dir.ts               NEW: locate ~/.rn-dev/modules/, per-module private data dir, purge/GC
│   │
│   ├── mcp/
│   │   ├── server.ts                    CHANGE: read activation events, spawn subset on tools/call, MCP spec version pinned to 2025-11-25
│   │   ├── module-proxy.ts              NEW: proxies ListTools/CallTool over module RPC, enforces cold-start SLO, returns MODULE_UNAVAILABLE / MODULE_ACTIVATION_TIMEOUT error codes
│   │   ├── tool-namespacer.ts           NEW: <moduleId>__<tool> rewriting
│   │   └── tools.ts                     EXTEND: loadModuleTools(ctx, registry) merges built-in + module-contributed tool definitions
│   │
│   ├── modules/
│   │   ├── registry.ts                  EXTEND: keep existing loadPlugins() API, add loadUserGlobalModules(), loadBuiltIns()
│   │   ├── built-in/                    EXTEND each: wrap with manifest shape (still privileged, in-process, but self-consistent with 3p contract)
│   │   │   ├── dev-space.ts
│   │   │   ├── metro-logs.ts
│   │   │   ├── lint-test.ts
│   │   │   ├── settings.ts
│   │   │   ├── devtools-network.ts      (arrives via DevTools plan Phase 2/3 — adopts manifest shape)
│   │   │   └── marketplace.ts           NEW: privileged built-in, always on
│   │   └── index.ts                     EXTEND barrel
│   │
│   └── app/
│       ├── start-flow.ts                EXTEND: after built-in register, loadUserGlobalModules() + loadPlugins(projectRoot)
│       └── service-bus.ts               EXTEND: generic `module:<id>:<topic>` channel with type-safe declaration-merge helper (no runtime change — EventEmitter stays stringly-typed; types enforce at author site)
│
├── electron/
│   ├── main.ts                          EXTEND: register per-module partitions, ipcMain handlers for modules:{list,install,activate,uninstall,rpc}
│   ├── module-host-bridge.ts            NEW: when running in GUI mode, host spawns module subprocesses from main (same manager.ts code, different entry)
│   ├── panel-bridge.ts                  NEW: postMessage/ipc bridge between host renderer and per-module WebContentsView, enforces hostApi allowlist
│   ├── preload-module.ts                NEW: per-module preload — exposes rnDev.<allowlistedMethod> via contextBridge
│   └── ipc-bridge.ts                    EXTEND: add modules handlers. FLAG: this file is already 1203 lines — split deferred (see Risks).
│
├── renderer/
│   ├── App.tsx                          CHANGE: build view map from invoke('modules:list') instead of hardcoded switch. Remove ViewTab union.
│   ├── components/
│   │   ├── Sidebar.tsx                  CHANGE: take `modules: ModuleInfo[]` prop; render from registry
│   │   └── ModulePanel.tsx              NEW: generic WebContentsView embedder; resizes on layout; focuses on click
│   ├── views/
│   │   ├── DevToolsView.tsx             REFACTOR: migrate from <webview> to WebContentsView (spike in Phase 4; may defer to post-Phase-6 if Fusebox embedding complicates)
│   │   └── Marketplace.tsx              NEW: browse modules.json, install with permission consent
│   └── types.ts                         CHANGE: ViewTab → string
│
├── packages/
│   └── module-sdk/                      NEW — @rn-dev/module-sdk
│       ├── package.json
│       ├── manifest.schema.json         JSON Schema, published with package for 3rd-party IDE validation
│       ├── src/
│       │   ├── index.ts                 barrel: defineModule, types, schema
│       │   ├── types.ts                 ModuleManifest, ContributeMcp, ContributeElectron, Permission, ActivationEvent, ModuleScope, HostCapability
│       │   ├── define-module.ts         defineModule() authoring helper; runtime-validates against schema
│       │   ├── host-rpc.ts              typed client: host.metro, host.artifacts (gated), host.log, host.subscribe('module:<id>:<topic>'), host.call('<otherModuleId>.<method>')
│       │   ├── mcp-adapter.ts           helpers to turn a tool's handler into the JSON-RPC method the host proxies to
│       │   ├── panel-host.ts            in-webview helper used from module renderer (calls rnDev.<method> from allowlist)
│       │   └── errors.ts                typed error codes (MODULE_UNAVAILABLE, E_NOT_ALLOWED, MODULE_ACTIVATION_TIMEOUT, …)
│       └── tsconfig.json
│
└── modules/
    └── device-control/                  NEW — @rn-dev-modules/device-control
        ├── package.json
        ├── rn-dev-module.json           id, version, hostRange, scope: "global", permissions, activationEvents, contributes
        ├── src/
        │   ├── index.ts                 defineModule({ activate, deactivate, tools, panels, lifecycle })
        │   ├── adapters/
        │   │   ├── android-adb.ts       appium-adb wrapper
        │   │   ├── android-framebuffer.ts   adbkit for streaming
        │   │   ├── android-scrcpy.ts    optional scrcpy-server launcher for mirror
        │   │   ├── ios-simctl.ts        simctl wrapper (lifecycle, install, launch, URL)
        │   │   ├── ios-idb.ts           idb wrapper (input, accessibility, video) — with try/fallback
        │   │   └── device-discovery.ts  unify Android + iOS device list
        │   ├── mcp-tools.ts             primitives: device/list, /screenshot, /accessibility-tree, /tap, /swipe, /type, /launch-app, /install-apk, /logs, /record-flow/{start,stop}, /replay-flow
        │   ├── flow/
        │   │   ├── schema.ts            canonical JSON { schemaVersion: 1, steps: [...] }
        │   │   ├── recorder.ts
        │   │   ├── replayer.ts
        │   │   └── maestro-export.ts    JSON → Maestro YAML export (one-way)
        │   └── arbitration.ts           FIFO queue for multi-worktree Device Control consumers
        ├── renderer/                    Vite-bundled panel UI (device list, mirror <canvas> using WebCodecs, log stream, flow recorder controls)
        │   ├── index.html
        │   ├── main.tsx
        │   ├── components/{DeviceMirror,DeviceList,FlowRecorder,LogStream}.tsx
        │   └── vite.config.ts
        └── flows/                       committed sample flows used as E2E tests
            ├── login.rn-dev-flow.json
            └── onboarding.rn-dev-flow.json
```

### Implementation Phases

Phases are ordered so each phase produces a demo-able slice. Phases 0–3 deliver the module system's backbone; Phases 4–6 land the GUI + Marketplace; Phases 7–10 build and prove Device Control.

#### Phase 0: Monorepo foundation

Scope:
- Add `"workspaces": ["packages/*", "modules/*"]` to root [package.json](package.json). **Verify first:** `bun.lock` already has a `workspaces` object — confirm whether workspaces was previously attempted.
- Delete [esbuild.config.ts](esbuild.config.ts) (unused; `build.ts` is the real path) OR document why both exist.
- Reconcile test runner: `package.json` scripts say `bun test`; prior note says `vitest run`. Standardize on `vitest run` for this plan (vi.mock required), document in CLAUDE.md.
- Create empty `packages/module-sdk/` + `modules/device-control/` skeletons with `package.json` only.
- Write a root `CLAUDE.md` documenting: no `any`/`unknown`, `.js` imports, vitest, bun build.

Success criteria:
- `bun install` from root installs both workspace packages.
- `npx vitest run` runs all existing tests green.
- `bun run build` still produces a working CLI.

#### Phase 0.5: Split `electron/ipc-bridge.ts` (architecture amendment)

**Non-optional, landed before Phase 4.** The existing [electron/ipc-bridge.ts](electron/ipc-bridge.ts) is 1203 lines mixing instance lifecycle, profile handlers, wizard, DevTools fetch, and more. Phases 4–10 add a dozen more handlers; split now, not later.

Scope:
- Split into `electron/ipc/` with one file per concern:
  - `electron/ipc/instance.ts` (current instance lifecycle)
  - `electron/ipc/profile.ts` (profile store handlers)
  - `electron/ipc/wizard.ts` (wizard flow)
  - `electron/ipc/devtools.ts` (DevTools fetch + Metro targets — lines 491–507 of current file)
  - `electron/ipc/index.ts` — barrel + single `registerAllIpcHandlers(mainWindow)` entry
- `electron/main.ts` swaps the single `import './ipc-bridge'` for `registerAllIpcHandlers(win)`.
- No behavior change. Pure mechanical refactor with green tests.

Success criteria:
- All existing IPC routes still work; diff green in a playwright-electron smoke test.
- No file in `electron/ipc/` exceeds 400 lines.

#### Phase 1: Module SDK + manifest schema

Scope:
- Ship `@rn-dev/module-sdk` v0.1:
  - `manifest.schema.json` — full JSON Schema for `rn-dev-module.json` (versioned `$id`). **Additive-only within 1.x** to preserve module contracts.
  - `types.ts` — generated or hand-written types matching the schema.
  - `define-module.ts` — `defineModule(spec)` helper validating at runtime.
  - `errors.ts` — typed error codes (including `E_TOOL_NAME_UNPREFIXED`, `E_NOT_ALLOWED`, `MODULE_UNAVAILABLE`, `MODULE_ACTIVATION_TIMEOUT`, `E_PERMISSION_DENIED`, `E_MISSING_DEP`, `E_MANIFEST_SHA_MISMATCH`, `E_DESTRUCTIVE_REQUIRES_CONFIRM`).
- **Manifest reserved fields for V2 (accepted by schema now, implementation deferred):**
  - `signature?: { algo: 'ed25519', publicKey: string, signature: string }` — future signed-module verification.
  - `sandbox?: { kind: 'none' | 'node-permission' | 'os-sandbox', ... }` — future runtime capability enforcement; `none` is the v1 default.
  - `target?: { kind: 'emulator' | 'simulator' | 'physical' }` — device-focused module targeting (Device Control v1 declares `emulator` + `simulator`).
  - `scope: 'global' | 'per-worktree' | 'workspace'` — `workspace` accepted but treated as `per-worktree` in v1.
  - `contributes.api?: { methods: Record<string, { inputSchema, outputSchema, description }> }` — explicit inter-module RPC surface (used by Phase 10's `host.call`).
  - `contributes.config?: { schema: JSONSchema }` — per-module config shape (used by `modules/config/*` in Phase 5).
  - `experimental?: boolean` — flag a manifest feature as experimental; host emits a warning in logs.
- Extend `src/modules/registry.ts`:
  - `loadUserGlobalModules()` reads `~/.rn-dev/modules/*/rn-dev-module.json`, validates schema, checks `hostRange` (semver), returns `RegisteredModule[]` in `inert` state.
  - Keep existing `loadPlugins(projectRoot)` for per-project override; feed both into the same validation pipeline.
  - Loosen `isRnDevModule` — MCP-only or Electron-only modules are valid (no `component` required).
  - **Enforce the tool-prefix policy at load time:** 3p modules whose tool names don't match `<moduleId>__<tool>` are rejected with `E_TOOL_NAME_UNPREFIXED`. Built-ins are exempt (carry flat namespace).
- Add scope-aware registry: map key = `${moduleId}:${scopeUnit}` where `scopeUnit` is `"global"` or a worktreeKey.
- SDK exposes **generic `host.capability<T>(id: string)`** (architecture amendment) — no `host.metro` / `host.artifacts` hardcoded names in the SDK contract. Built-ins register into the same capability registry as 3p (`log`, `appInfo`, `metro`, `artifacts` are the initial entries).

Success criteria:
- A test fixture module (`fixtures/test-module/rn-dev-module.json`) loads end-to-end with correct scope/permissions/activation fields.
- `hostRange` mismatch is rejected with clear error.
- Invalid manifest is rejected with path-pointing JSON Schema errors.

Test files:
- `packages/module-sdk/src/__tests__/define-module.test.ts`
- `src/core/__tests__/module-registry.test.ts`

#### Phase 2: Subprocess module host + JSON-RPC protocol

**Process topology (architecture amendment):** `ModuleHostManager` runs in the long-lived daemon process (same process that owns `MetroManager` / `DevToolsManager`). Electron main is a client over IPC; MCP server is a client over stdio. **Both modes share one process topology.**

Scope:
- Integrate [`vscode-jsonrpc`](https://github.com/microsoft/vscode-languageserver-node/tree/main/jsonrpc) v8+ for stdio framing.
- `src/core/module-host/instance.ts` — state machine:
  - `IDLE → SPAWNING → HANDSHAKING → ACTIVE → UPDATING → RESTARTING → CRASHED → FAILED → STOPPING → IDLE`.
  - `CRASHED` is transient (supervisor retries); `FAILED` is terminal (supervisor gave up). `UPDATING` covers in-flight drain during version bumps. `RESTARTING` replaces `RECONNECTING` (processes don't reconnect — they respawn).
  - Handshake: host→module `initialize` with capability list, module→host `initialized` with declared surface.
- `src/core/module-host/supervisor.ts` — restart policy: auto-restart unless ≥5 crashes in 3 min; then transition to `FAILED` and emit `module:failed` on the host event bus. `module:crashed` emitted on each transient crash. Both observable via `modules/status` MCP tool (Phase 3) and the sidebar badge.
- Orphan prevention:
  - macOS/Linux: `child_process.spawn(cmd, args, { detached: true })`, kill with `process.kill(-pid)`.
  - Windows: use [`win-job-object`](https://www.npmjs.com/package/win-job-object) (or native Job Object via N-API) with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
  - Register `process.on('exit'|'SIGINT'|'SIGTERM')` and an `uncaughtException` shutdown drain.
- `src/core/module-host/lockfile.ts` — for `scope: "global"` modules, atomic lockfile acquisition at `~/.rn-dev/modules/<id>/.lock` (PID + UID stamped, stale-detection on acquire); second acquirer becomes a proxy client to the holder via a local Unix domain socket.
- `src/core/module-host/manager.ts` — **`acquire(consumerId)` / `release(consumerId)` refcounting** for `global` scope modules; idle-shutdown after last release + 60s grace period. Prevents accumulating idle `global` subprocesses in long-lived daemons.
- `src/core/module-host/capabilities.ts` — **generic capability registry** (architecture amendment):
  - Host-side API: `registry.register(id: string, impl: T, requiredPermission?: string)`, `registry.resolve<T>(id, grantedPermissions): T | null`.
  - Built-ins register at daemon startup: `log`, `appInfo`, `metro`, `artifacts`, `modules` (marketplace uses this).
  - SDK wraps this as `host.capability<T>(id)` for module authors — no `host.metro` / `host.artifacts` hardcoded names in the SDK contract.

Success criteria:
- Spawning a minimal fixture module and receiving a handshake reply works end-to-end in a vitest.
- Killing the host process (SIGTERM) kills the module subprocess — verified via `ps` snapshot in CI.
- Crash loop detected and module transitions `CRASHED → ... → FAILED`.
- Two concurrent callers of the same `global` module share one subprocess via lockfile; idle-shutdown after both release.
- `host.capability('metro')` returns the MetroManager façade; `host.capability('artifacts')` returns `null` if `fs:artifacts` permission not granted.

Test files:
- `src/core/module-host/__tests__/instance.test.ts`
- `src/core/module-host/__tests__/supervisor.test.ts`
- `src/core/module-host/__tests__/lockfile.test.ts`
- `test/fixtures/echo-module/` — fixture used by multiple tests

#### Phase 3: MCP tool proxying + module lifecycle tools

**Tool prefix policy (permanent contract decision):** Built-in modules keep the flat namespace they have today (`metro/*`, `devtools/*`, new `modules/*` + `marketplace/*` in this phase). Third-party modules MUST use `<moduleId>__<tool>` (double underscore). Manifest load rejects non-compliant 3p with `E_TOOL_NAME_UNPREFIXED`.

Scope:
- `src/mcp/tool-namespacer.ts` — enforce the prefix policy: built-ins pass through unchanged; 3p tool names are verified to start with `<manifest.id>__` (not rewritten silently — fail-fast validation).
- `src/mcp/module-proxy.ts` — on `tools/call`:
  1. Resolve the owning module.
  2. If tool has `destructiveHint: true`: require per-call runtime confirmation (GUI mode) OR `permissionsAccepted` in the `tools/call` arguments / `--allow-destructive-tools` CLI flag (headless) — else return `E_DESTRUCTIVE_REQUIRES_CONFIRM`.
  3. If the module is `inert`, check activation events; fire `onMcpTool:<pattern>` if matched.
  4. Emit an MCP progress token immediately (client sees spawn latency).
  5. Timeout at 3s p95 → `MODULE_ACTIVATION_TIMEOUT` error.
  6. If module in `FAILED` state → `MODULE_UNAVAILABLE`.
- `src/mcp/server.ts`:
  - Parse `--enable-module:<id>` / `--disable-module:<id>` / `--allow-destructive-tools` flags.
  - Pin MCP spec version 2025-11-25 (latest). Fail-fast if client announces an incompatible version.
  - `tools/list` reads manifests ONLY; never spawns subprocesses.
  - **Emit MCP `tools/listChanged` notification** on install / uninstall / enable / disable / crash-to-FAILED / recover-from-FAILED. Agents reconnect or rediscover on receipt.
- Apply DevTools plan's security controls S1–S6 (nonce, loopback bind, prompt-injection warning in tool descriptions) to every module tool — codify in SDK so authors get it by default.
- **NEW: Built-in module lifecycle MCP tools** (agent-native amendment) — first-party, flat namespace:
  - `modules/list` — returns installed modules with id, version, state, scope, enabled flag.
  - `modules/status` — per-module state (`IDLE`/`ACTIVE`/`CRASHED`/`FAILED`/…) + last-crash reason.
  - `modules/restart` — manual re-spawn of a `FAILED` module (exposes the "Retry" GUI button to agents).
  - `modules/enable` / `modules/disable` — runtime toggles; emits `tools/listChanged`.

Success criteria:
- `tools/list` with 3 inert modules returns all tools without any spawn (observable via `ps` snapshot).
- `tools/call` cold-start p95 ≤ 3s on a noop module.
- Per-tool `readOnlyHint` / `destructiveHint` / `openWorldHint` annotations round-trip correctly to the MCP client.
- Two modules each exposing `screenshot` don't collide (`moduleA__screenshot` vs `moduleB__screenshot`).
- `tools/call` on a `destructiveHint: true` tool without confirmation returns `E_DESTRUCTIVE_REQUIRES_CONFIRM`; with the flag, it proceeds and the invocation is logged to the audit log.
- `modules/list` + `modules/status` + `modules/restart` round-trip against a fixture that transitions through all lifecycle states.
- `tools/listChanged` fires within 100ms of `modules/enable`.

Test files:
- `src/mcp/__tests__/tool-namespacer.test.ts`
- `src/mcp/__tests__/module-proxy.test.ts`
- `src/mcp/__tests__/cold-start-slo.test.ts`

#### Phase 4: Electron panel contributions (WebContentsView pivot)

This is a deliberate deviation from the brainstorm (see Alternatives Considered).

Scope:
- **Pivot the renderer embedding from `<webview>` to `WebContentsView`** (Electron 30+).
- `electron/panel-bridge.ts` — host-side registry: given a module's manifest, create a `WebContentsView` with:
  - `partition: 'persist:mod-<id>'`
  - `preload: electron/preload-module.js` (single preload; receives moduleId + `hostApi[]` allowlist via query)
  - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`
  - Added to main window's `contentView` tree, repositioned on renderer layout events.
- `electron/preload-module.ts` — exposes `window.rnDev.<method>` via `contextBridge.exposeInMainWorld` strictly for methods listed in the panel's manifest `hostApi[]`. Unknown methods → `E_NOT_ALLOWED`.
- **Per-module message channel (security amendment).** `panel-bridge.ts` routes host→webview messages through a channel keyed by `moduleId`; cross-module delivery is a programmer error that the bridge rejects and audit-logs. No `broadcastAllModules` API exposed anywhere in host code.
- `renderer/components/ModulePanel.tsx` — host-side React component; posts layout rectangle to main via IPC; main positions the WebContentsView accordingly.
- `renderer/App.tsx` — replace hardcoded view switch with `activeModule` lookup over `modules:list`. Built-in native views (DevSpace, LintTest, MetroLogs, Settings) declare `kind: "native"` and keep their React implementations inline; 3p modules use `kind: "webview"` → `ModulePanel`.
- `renderer/components/Sidebar.tsx` — render from `modules: ModuleInfo[]` prop.
- Port existing `DevToolsView.tsx` to WebContentsView **as the canary**: it already embeds Fusebox via `<webview>`, so migrating it early validates the pattern.

Success criteria:
- All five existing sidebar views still render (DevSpace, MetroLogs, LintTest, Settings, DevTools) after the switch to dynamic `modules:list`-driven rendering.
- A test 3p module's webview panel loads, calls an allowlisted `hostApi` method, and is rejected calling a non-allowlisted one.
- WebContentsView repositions correctly on window resize.
- Keybindings (Cmd/Ctrl+N, Tab navigation) still work; input focus lands in the panel on click.

Test files:
- `electron/__tests__/panel-bridge.test.ts`
- `renderer/components/__tests__/ModulePanel.test.tsx` (using playwright-electron for E2E)

#### Phase 5: Built-in modules adopt manifest shape + module config

Scope:
- Add `contributes` blocks to each of the four existing built-ins ([dev-space.ts](src/modules/built-in/dev-space.ts), [metro-logs.ts](src/modules/built-in/metro-logs.ts), [lint-test.ts](src/modules/built-in/lint-test.ts), [settings.ts](src/modules/built-in/settings.ts)). They stay in-process and privileged — no subprocess split — but expose the same manifest shape for conceptual unity.
- Coordinate with the DevTools Network Phase 2/3 work so `devtools-network` lands native to this model, not retrofitted.
- Create the **Marketplace built-in** module:
  - Privileged built-in with an explicit `kind: 'built-in-privileged'` flag the registry honors.
  - Registers a `modules` capability (list installed, resolve update, install, uninstall) into the host capability registry.
  - Panel is renderer-native React (no webview, since it's privileged).
- **Module config surface (agent-native amendment):**
  - Modules declare `contributes.config.schema` (JSON Schema) in the manifest.
  - Config stored at `~/.rn-dev/modules/<id>/config.json`; loaded at activation; emitted to module on `initialize`.
  - MCP tools: `modules/config/get` (`{moduleId}` → config), `modules/config/set` (`{moduleId, patch}`; host validates against schema before write).
  - Settings panel uses these MCP tools under the hood for parity.

Success criteria:
- Each existing built-in loads via the manifest path and renders unchanged.
- Marketplace panel lists at least the built-in modules (with "system, uninstallable" badge).
- No behavior regression in DevSpace / MetroLogs / LintTest / Settings (capture screenshots before/after).
- A fixture module with a config schema round-trips `modules/config/set` → `modules/config/get` with schema-rejection on invalid patches.

#### Phase 6: Marketplace — `modules.json` + install flow (SECURITY-HARDENED)

**This phase was amended after security review.** All changes are v1 blockers.

Scope:

**Registry repo (`rn-dev-modules-registry`):**
- `schema.json` — strict JSON Schema for each entry (id, npmPackage, version, description, author, homepage, permissions mirrored from manifest, icon URL, **`npmResolvedTree`** — lockfile-equivalent snapshot of the entire dep tree resolved at curation time, including SHA-512 integrity hashes for every package).
- `modules.json` — top-level index. Initially lists `@rn-dev-modules/device-control`.
- CI validates every PR against the schema. **CI also runs `arborist reify --dry-run` at curation time** and writes the resolved tree + integrity hashes into the entry. A dep graph change upstream does NOT auto-propagate; the module must be re-curated.
- Model: MCP's own [registry](https://github.com/modelcontextprotocol/registry).

**Registry integrity (security amendment):**
- Host release bakes in a **SHA-256 of the expected `modules.json`** (pinned per host version). On fetch, if the SHA differs, the host refuses to auto-install anything and surfaces "Registry mismatch — possible compromise" banner. User can override via a `--accept-registry-sha <sha>` flag they must paste manually.
- v1.1 upgrade path: detached `Ed25519` signature on `modules.json` checked against a pubkey baked into the host (reserve manifest field already allocated in Phase 1).

**Marketplace panel in renderer:**
- Fetches raw `modules.json` from GitHub (cache in `~/.rn-dev/modules-registry-cache.json`, TTL 1h).
- Browse list + search + detail pane.
- Install flow:
  1. **Consent modal (security amendment — honest wording):**
     - Lists every declared permission in plain English.
     - Shows the **full text of every MCP tool description** the module contributes (users inspect what the agent will be told).
     - Includes a verbatim disclaimer: *"Third-party modules run with your full user permissions. Declared permissions above are advisory — the host does not sandbox them in this version. Install only modules you trust."*
     - **First-ever 3p install on a fresh host requires a one-time additional acknowledgment** ("I understand modules run as me"). Decision stored at `~/.rn-dev/.third-party-acknowledged`.
  2. On confirm, call host IPC `modules:install` with npm package spec.
  3. Host uses [`@npmcli/arborist`](https://github.com/npm/cli/tree/latest/workspaces/arborist) programmatically into `~/.rn-dev/modules/<id>/`. Configured with **`--ignore-scripts` (security amendment)** — npm lifecycle scripts (`preinstall`, `postinstall`, etc.) are NOT executed for 3p modules; only the declared module entry runs post-install on activation.
  4. Resolved tree must match `npmResolvedTree` from the registry entry exactly (SHA-512 per-package); mismatch → refuse install with `E_INTEGRITY_MISMATCH(package, expected, actual)`.
  5. Copy manifest to `~/.rn-dev/modules/<id>/rn-dev-module.json`.
  6. Activate per activation events.
- **CLI parity + MCP parity (agent-native amendment):**
  - CLI: `rn-dev module {install,uninstall,list,enable,disable,restart}`.
  - MCP: `marketplace/list`, `marketplace/search`, `marketplace/info`, `modules/install` (takes `permissionsAccepted: string[]` for headless consent; must include every declared permission verbatim, else `E_PERMISSION_DENIED`), `modules/uninstall` (takes `keepData: boolean`).
- Uninstall flow:
  - Prompt `{Keep data | Delete data}` (GUI) OR `keepData: boolean` (MCP). "Keep" preserves `~/.rn-dev/modules/<id>/data/` for 30 days; a GC sweep at host startup purges expired dirs. Re-install within 30 days restores data.
  - Action logged to tamper-evident audit log (below).
- Offline behavior: marketplace browse fails gracefully with cached list; installed modules activate as normal.

**Audit log (security amendment):**
- Path: `~/.rn-dev/audit.log`, POSIX mode `0600` (owner-only), OS append-only attribute where supported (`chattr +a` on Linux, `chflags uappnd` on macOS).
- Format: HMAC-chained JSONL. Each line `{ seq, ts, event, data, prevHmac, hmac }` where `hmac = HMAC-SHA256(key, prevHmac || seq || ts || event || data)`. Key stored in the host keychain (macOS Keychain, libsecret, Windows Credential Manager) — never in the home dir.
- Written ONLY via a host-internal `AuditLog.append()` API. **Modules cannot write, read, or delete the log** — no `fs:audit-log` permission exists.
- Events logged: module install / uninstall / activate / crash / enable / disable, permission grant, destructive-tool invocation, `E_NOT_ALLOWED` rejection, registry SHA mismatch.
- Tamper detection: `rn-dev audit verify` command re-HMACs the chain; mismatch or truncation surfaces a loud warning.

Success criteria:
- Install of a dummy test module from a local `npm pack` tarball works end-to-end.
- **`postinstall` scripts in the test package are NOT executed** (verified by sentinel file check).
- **Integrity mismatch** (hand-edit the tarball to tamper one dep) triggers `E_INTEGRITY_MISMATCH` and leaves no partial state.
- **Registry SHA mismatch** triggers the override banner; install blocked unless `--accept-registry-sha` provided.
- Permission consent modal blocks install until accepted; rejection cancels cleanly.
- Headless `modules/install` without full `permissionsAccepted` returns `E_PERMISSION_DENIED`.
- Uninstall + reinstall within 30 days restores private data dir.
- Offline start: all installed modules still activate; marketplace shows "offline — cached list" banner.
- Audit log chain verifies after 100 simulated events; tampering (truncate 1 line) surfaces in `rn-dev audit verify`.
- First-time 3p install shows the extra acknowledgment; subsequent installs don't.

Test files:
- `src/core/modules-dir/__tests__/install.test.ts` (uses a local npm tarball fixture)
- `src/core/modules-dir/__tests__/uninstall-retention.test.ts`

#### Phase 7: Device Control — Android Emulator

Per the tool-prefix policy, Device Control is a 3p package, so its MCP tools use double-underscore prefix: **`device-control__*`**. The spec-level names below are shorthand — the actual MCP tool names are `device-control__list`, `device-control__screenshot`, etc.

Scope:
- Scaffold `modules/device-control/` with `rn-dev-module.json`:
  - `id: "device-control"`, `scope: "global"`, `target: { kind: "emulator" }` (reserved field declared now; Phase 8 adds `"simulator"`).
  - `permissions: ["adb", "net:5554-5683", "exec:adb", "exec:scrcpy"]`.
  - `activationEvents: ["onMcpTool:device-control__*", "onElectronPanel:device-control"]`.
  - `contributes.mcp.tools[]`: `list`, `screenshot`, `accessibility-tree`, `tap` (**destructiveHint: false** — interactive but reversible), `swipe`, `type`, `launch-app`, `install-apk` (**destructiveHint: true**), `uninstall-app` (**destructiveHint: true**), `logs/tail`, `flow/start`, `flow/stop`, `flow/replay`, **`mirror/start`, `mirror/stop`, `mirror/frame`** (agent-native amendment — streaming frame access for agents; MJPEG chunks over MCP notifications; WebCodecs H.264 for the webview).
  - `contributes.electron.panels[]`: one panel `device-control` with `hostApi: ['log']` (minimal — panel talks to module via in-webview IPC).
- Android adapters:
  - `adapters/android-adb.ts` — wraps `appium-adb` (commands: shell, install, uninstall, input tap/swipe/text).
  - `adapters/android-framebuffer.ts` — wraps `adbkit` (screenshot, framebuffer stream).
  - `adapters/android-scrcpy.ts` — launches `scrcpy-server.jar` on device + opens adb-forwarded WebSocket the panel consumes via WebCodecs.
- Device discovery: `adb devices -l` parsed; emits `deviceConnected` / `deviceDisconnected` events.
- Arbitration (`arbitration.ts`): FIFO queue for serializing commands per-device when multiple worktrees share the global instance. **Every queued command records the calling module id + MCP tool invocation id to the audit log** (security amendment — supports chained attribution through `uses:` in Phase 10).
- Panel UI: device list, mirror canvas, log tail, flow recorder controls.

Success criteria:
- `device-control__screenshot` returns a PNG in < 1s on a running emulator.
- `device-control__tap` at a coordinate visibly clicks in the panel's mirror.
- `device-control__install-apk` (destructive) without confirmation returns `E_DESTRUCTIVE_REQUIRES_CONFIRM`; with the flag it proceeds.
- Two worktrees calling `device-control__tap` in quick succession serialize through the arbitration queue without lost taps; audit log shows calling module id for each invocation.
- Panel shows H.264 mirror at ≥ 30 fps.
- `device-control__mirror/start` → agent receives periodic MJPEG notifications for the same frames.

Test files:
- `modules/device-control/src/__tests__/mcp-tools.test.ts` (with adb mocked against fixture socket)
- `modules/device-control/src/__tests__/arbitration.test.ts`
- `modules/device-control/flows/__tests__/e2e-login.test.ts` — requires a local emulator, tagged `@e2e`, skipped in CI by default, runnable via `vitest run --mode e2e`.

#### Phase 8: Device Control — iOS Simulator

Scope:
- Adapters:
  - `adapters/ios-simctl.ts` — Apple's `xcrun simctl` for lifecycle (list, boot, shutdown, launch, install, URL, terminate).
  - `adapters/ios-idb.ts` — `idb_companion` + `idb` CLI for input injection, accessibility tree, video stream.
  - Feature-detect idb at activation; if unavailable OR if a later call errors, downgrade to `simctl`-only mode with `device/tap` / `device/swipe` returning `FEATURE_UNAVAILABLE_IDB_REQUIRED` and a user-friendly reason.
- Video: idb's `video-stream` (MP4 fragments / H.264) → WebCodecs in panel. Same decoder pipeline as Android path.
- Xcode version compat matrix documented (iOS 17+, iOS 18+).

Success criteria:
- iOS Sim boot + app launch via `device/launch-app` works on macOS CI (GitHub macos-14 runner has Xcode).
- idb-broken fallback gracefully degrades to simctl-only with accurate error code.

#### Phase 9: Flow recording + replay + Maestro YAML export

Scope:
- Canonical JSON schema v1 (versioned with `schemaVersion: 1`):
  ```json
  {
    "schemaVersion": 1,
    "moduleVersion": "0.1.0",
    "platform": "android" | "ios",
    "steps": [
      { "action": "tap", "selector": { "kind": "a11y-id", "value": "loginButton" }, "ts": 0 },
      { "action": "type", "text": "user@example.com", "ts": 120 }
    ]
  }
  ```
- Recorder listens to `device/tap` / `device/swipe` / `device/type` tool calls during `device/flow/start` → `device/flow/stop` window; snapshots accessibility tree per step to support durable selectors.
- Replay: re-executes steps through the same primitives, matching selectors against current a11y tree; reports per-step pass/fail.
- Maestro YAML export: one-way JSON → Maestro-compatible YAML (import NOT in scope).
- Schema versioning policy documented: major bump = breaking replay compatibility; host includes a migration function for ≤1 major version gap.

Success criteria:
- Record a 5-step login flow, replay it on a fresh emulator, verify each step passes.
- Maestro YAML export for the same flow is valid per Maestro's CLI (spot-check).

#### Phase 10: Module dependencies (`uses:`) — EXPERIMENTAL in v1.0

**Architecture amendment:** this phase ships behind `experimental: true` in the manifest. The SDK emits a warning in logs when a module uses it. Inter-module RPC may evolve in v1.1; do not build a production-critical module on `uses:` yet.

Scope:
- Manifest `uses: [{ id, versionRange }]`.
- **Declared surface:** the depended-on module MUST publish a `contributes.api.methods` block in its manifest (reserved in Phase 1). `host.call` rejects calls to unpublished methods with `E_METHOD_NOT_EXPOSED`. No implicit surface.
- Install-time: Arborist ensures all `uses[]` are installed (respecting the integrity + ignore-scripts rules from Phase 6); otherwise refuses install with `E_MISSING_DEP(id, reason)`.
- Runtime: host exposes `host.call('<depId>.<method>', args)` from the SDK; routes through the dep's module host instance.
- Dependencies appear in consent dialog ("This module depends on: device-control (v0.1)"). The union of all declared permissions (direct + transitive via `uses:`) is shown at install.
- **Audit attribution (security amendment):** every `host.call` logs the calling module id AND the destination method to the audit log. Chained calls (`A uses B uses C`) produce one log entry per hop.
- Diamond deps are deduped by Arborist normally.

Success criteria:
- A toy "e2e-test" module depending on `device-control` can call the declared API method `tap(deviceId, x, y)` via `host.call`.
- Missing-dep install fails with a clear remediation message ("install device-control first, or use the Marketplace").
- Calling an unpublished method returns `E_METHOD_NOT_EXPOSED`.
- Audit log attributes a chained call to the correct originating module.

#### Phase 11: Polish, docs, threat model

Scope:
- `packages/module-sdk/README.md` — author tutorial (Hello World module in 50 lines).
- `docs/module-threat-model.md` — explicit threat boundaries:
  - What subprocess isolation covers (memory, crash, file-descriptor scope).
  - What it does NOT cover (filesystem at large, network, env vars — manifest permissions are advisory).
  - Webview allowlist as the only enforced boundary on the renderer side.
- Root CLAUDE.md updated with module-system conventions.
- Publish `@rn-dev/module-sdk` v1.0.0 to npm; publish `@rn-dev-modules/device-control` v0.1.0.
- Add marketplace-registry GitHub repo's first entry pointing at `device-control`.

Success criteria:
- External developer can follow the tutorial and publish a passing Hello World module in under 30 minutes.
- Threat model doc reviewed + linked from README.

---

## Alternatives Considered

### `<webview>` (brainstorm's choice) vs. `WebContentsView` (this plan)

The brainstorm selected `<webview>` for consistency with the existing [DevToolsView.tsx](renderer/views/DevToolsView.tsx) (which embeds Fusebox via `<webview>`). External research surfaced that **Electron officially [recommends migration away from `<webview>`](https://www.electronjs.org/docs/latest/api/webview-tag) and toward [`WebContentsView`](https://www.electronjs.org/blog/migrate-to-webcontentsview) (Electron 30+)**. Building the foundational 3p extension surface on a deprecation path is a compounding debt.

Trade-off analysis:

| Dimension | `<webview>` | `WebContentsView` |
|---|---|---|
| Status | Discouraged, still works | Current recommendation |
| Process isolation | Yes | Yes |
| Layout | Inline HTML element (CSS stacking) | Main-process child view positioned by rect (must resize on events) |
| API surface for preload / partition | Stable | Stable |
| Future-proofing | Unknown; possible future removal | Aligned with Electron direction |
| DevToolsView migration cost | None today | One-time port of `<webview>` → `WebContentsView` in `DevToolsView.tsx` |

**Decision:** pivot to `WebContentsView`. The extra complexity (manual layout reposition) is contained to a single `ModulePanel.tsx` component and amortized over every future module panel. Migrate `DevToolsView.tsx` in Phase 4 as the canary.

**User-approvable off-ramp:** if the reposition complexity turns out to be worse than expected in the Phase 4 spike, revert to `<webview>` with a documented `WebContentsView`-TODO and a Phase-12 follow-up task.

### Extension Host style (subprocess per module) vs. in-process dynamic import

Brainstorm picked subprocess per module for crash isolation, security boundary, and long-running device stream lifecycle. In-process (current `rn-dev.plugins` pattern) is cheaper but any module crash kills the host and blocks the marketplace story. Kept brainstorm's decision; this plan implements it.

### Flat MCP tool namespace vs. prefix-by-module

Flat namespace risks collisions (`screenshot` appearing in Device Control and a hypothetical Browser Automation module). Prefix-by-module (`device-control__screenshot`) is MetaMCP's convention and Claude Desktop surfaces it cleanly. Chose prefix.

### Newline-delimited JSON vs. `vscode-jsonrpc` framing

Newline-delimited is tempting for simplicity but breaks on multi-byte UTF-8 payloads and backpressure. `vscode-jsonrpc`'s `Content-Length` framing is battle-tested in the entire LSP ecosystem. No reason to invent.

### Programmatic npm via `execa npm install` vs. `@npmcli/arborist`

`execa` is slower, has worse error reporting, and can be defeated by a user's global npm config. Arborist is what npm itself uses. Chose Arborist.

---

## System-Wide Impact

### Interaction Graph

Agent MCP call → `src/mcp/server.ts` `tools/call` handler → `src/mcp/module-proxy.ts` resolves owning module → if inert, `ModuleHostManager.ensureActive(moduleId, scopeUnit)` → either (a) `instance.ts` state machine spawns subprocess → `vscode-jsonrpc` handshake → registers `CallTool` handler, or (b) reuses running subprocess → proxies JSON-RPC `callTool` → module's `mcp-tools.ts` handler → returns response → host proxy wraps as MCP `ToolResult` → flows back to agent.

On GUI mode, parallel path: `electron/main.ts` IPC `modules:rpc` → same ModuleHostManager instance (shared with MCP) → same subprocess → response routed back via `panel-bridge.ts` → `preload-module.ts` → module's webview.

Two levels deep: module's handler may call `host.metro.state(worktreeKey)` → `ModuleHostManager` forwards to host-side capability registry → returns `MetroManager` snapshot → serialized over JSON-RPC.

### Error & Failure Propagation

From module subprocess up:
- Module code throws → `vscode-jsonrpc` wraps in JSON-RPC error → `module-proxy.ts` translates code → MCP `ToolResult` with error code (`MODULE_UNAVAILABLE`, `MODULE_ACTIVATION_TIMEOUT`, `E_NOT_ALLOWED`, `E_PERMISSION_DENIED`).
- Module subprocess crashes → `instance.ts` emits `crashed` → `supervisor.ts` restarts or marks `Failed` → `ModuleHostManager` emits `module:status` on host event bus → MCP in-flight calls return `MODULE_UNAVAILABLE` → GUI renderer receives status update via IPC, shows badge on sidebar entry.
- Webview → host RPC allowlist miss → `panel-bridge.ts` rejects with `E_NOT_ALLOWED`, logs to audit log, panel may retry or surface error.

Retry conflicts: the LSP-style restart policy (≥5 in 3 min) must not fight with in-flight MCP retries. Host emits exactly one `MODULE_UNAVAILABLE` per call; agent decides retry policy.

### State Lifecycle Risks

- **Orphan processes** — mitigation: process groups / Job Objects + `exit` handlers (Phase 2).
- **Stale `.lock` files** — if a host crashes, `.lock` may not be cleaned. Mitigate with PID-stamped lock + stale detection on acquire.
- **Module data dir GC** — 30-day retention requires a scheduled sweep at host startup; if host never starts for 30+ days, data keeps. Acceptable.
- **In-flight tool call during module update** — upgrade should drain active calls with a 5s timeout, then restart with new version. Phase 10 or 11 topic.
- **Arborist install partial failure** — Arborist is transactional over its lockfile; partial install should roll back. Verify in Phase 6 test.

### API Surface Parity

Every module surface MUST be reachable from both Electron (via `modules:rpc` IPC → panel or `<moduleId>__<tool>` MCP proxy) and MCP (direct proxy). The SDK enforces this: `defineModule({ tools, panels })` where both arrays feed the same handler map.

TUI parity is optional; modules declaring `contributes.tui.views[]` get loaded; others don't appear in the terminal UI. No TUI regression for v1.

### Integration Test Scenarios

Cross-layer scenarios unit tests won't catch:

1. **MCP `tools/list` triggers no subprocess spawn even with 5 installed modules.** Observable via `ps` snapshot before/after.
2. **Module crashes during GUI session → sidebar entry shows "Failed" badge AND in-flight MCP call returns `MODULE_UNAVAILABLE`.** Both surfaces must reflect the same state within 100ms.
3. **Two worktrees simultaneously call `device/tap` → arbitration FIFO serializes; both calls succeed in deterministic order.**
4. **Install → permission denied → cancel → private data dir never created.** No partial state left behind.
5. **Host hard-kill (SIGKILL) → module subprocess dies within 1s** (verify process group / Job Object).

---

## Acceptance Criteria

### Functional Requirements

Module system:
- [ ] Modules load from `~/.rn-dev/modules/` (user-global) and `package.json#rn-dev.plugins` (per-project override).
- [ ] Manifest (`rn-dev-module.json`) validated against JSON Schema; invalid manifests rejected with path-pointing errors.
- [ ] Each module runs in its own Node subprocess; crash in one module never takes down another or the host.
- [ ] `ModuleHostManager` runs in the daemon process; Electron main and MCP server are clients (shared process topology).
- [ ] 3p modules use `<moduleId>__<tool>` MCP tool namespacing; built-ins stay flat (`metro/*`, `devtools/*`, `modules/*`, `marketplace/*`). Non-compliant 3p manifests rejected with `E_TOOL_NAME_UNPREFIXED`.
- [ ] Electron panels embed via `WebContentsView` with per-module partition + preload.
- [ ] Webview → host RPC gated by `contributes.electron.panels[].hostApi[]` allowlist; unlisted calls → `E_NOT_ALLOWED`.
- [ ] Host → webview messages route through per-module channels; no cross-module delivery; audit-logged.
- [ ] Modules declare `scope: "global" | "per-worktree" | "workspace"` (workspace treated as per-worktree in v1); host spawns one subprocess per scope unit with `acquire` / `release` refcounting + idle-shutdown for global.
- [ ] Module subprocess state machine includes `IDLE / SPAWNING / HANDSHAKING / ACTIVE / UPDATING / RESTARTING / CRASHED / FAILED / STOPPING`.
- [ ] SDK exposes generic `host.capability<T>(id)` — no `host.metro` / `host.artifacts` hardcoded in the public SDK.
- [ ] Modules may declare `uses: [...]` (experimental in v1); Arborist ensures deps installed; `host.call` rejects methods not in dep's `contributes.api.methods`.
- [ ] Privileged built-in modules (Marketplace + the four existing) load through the same manifest pipeline.

MCP lifecycle + agent-native parity (agent-native amendment):
- [ ] `modules/list`, `modules/status`, `modules/restart`, `modules/enable`, `modules/disable` MCP tools work.
- [ ] `modules/install`, `modules/uninstall`, `marketplace/list`, `marketplace/search`, `marketplace/info` MCP tools work.
- [ ] `modules/config/get` + `modules/config/set` validate against each module's `contributes.config.schema`.
- [ ] `tools/listChanged` fires within 100ms of install / uninstall / enable / disable / FAILED / recover.
- [ ] Tools with `destructiveHint: true` require confirmation (GUI) or `permissionsAccepted` / `--allow-destructive-tools` (headless).
- [ ] Headless `modules/install` without full `permissionsAccepted` returns `E_PERMISSION_DENIED`.

Marketplace + install (security-hardened):
- [ ] Marketplace panel fetches `modules.json` from GitHub, caches 1h, displays cached list offline.
- [ ] Host verifies `modules.json` SHA-256 against host-release-pinned value; mismatch blocks auto-install.
- [ ] Install uses `@npmcli/arborist` programmatically with `--ignore-scripts`; not `execa npm install`.
- [ ] `postinstall` / `preinstall` npm lifecycle scripts are NOT executed for 3p modules.
- [ ] Installed tree SHA-512 hashes match registry entry's `npmResolvedTree`; mismatch → `E_INTEGRITY_MISMATCH` and clean rollback.
- [ ] Consent modal shows declared permissions + full MCP tool descriptions + honest-wording disclaimer about advisory enforcement.
- [ ] First-ever 3p install requires one-time extra acknowledgment stored at `~/.rn-dev/.third-party-acknowledged`.
- [ ] Uninstall prompts `{Keep data | Delete data}`; "Keep" preserves data 30 days then GCs.
- [ ] CLI parity: `rn-dev module {install,uninstall,list,enable,disable,restart}`.

Audit log (security-hardened):
- [ ] Audit log at `~/.rn-dev/audit.log`, POSIX 0600, append-only OS attribute where supported.
- [ ] HMAC-chained JSONL format with key in OS keychain.
- [ ] Written ONLY via host-internal `AuditLog.append`; no module has write access.
- [ ] Events logged: install / uninstall / activate / crash / FAILED / enable / disable / permission grant / destructive-tool call / `E_NOT_ALLOWED` / registry SHA mismatch / `host.call` hops.
- [ ] `rn-dev audit verify` re-HMACs the chain; tampering surfaces loudly.

Device Control (v1):
- [ ] Tool names prefixed `device-control__*`; destructive operations (`install-apk`, `uninstall-app`) require confirmation.
- [ ] Android Emulator fully supported (list, screenshot, a11y tree, tap, swipe, type, launch, install APK, logs).
- [ ] iOS Simulator supported via simctl (lifecycle) + idb (input/a11y/video); idb-unavailable falls back gracefully.
- [ ] Live mirror in panel at ≥ 30 fps (Android ws-scrcpy H.264 + WebCodecs).
- [ ] `device-control__mirror/*` MCP tools provide streaming frame access to agents (MJPEG chunks).
- [ ] Record/replay flows in canonical JSON (`schemaVersion: 1`) with Maestro YAML export.
- [ ] FIFO arbitration serializes commands across multiple worktrees; each invocation audit-logged with calling module id.

### Non-Functional Requirements

- [ ] MCP `tools/call` cold-start p95 ≤ 3s on a noop module (local benchmark in CI).
- [ ] `tools/list` p95 ≤ 200ms with 10 installed modules (zero subprocess spawn).
- [ ] Module crash auto-restart unless ≥5 crashes in 3 min (LSP policy); then transition to `FAILED`.
- [ ] Host SIGTERM → all module subprocesses die within 1s (process group / Job Object).
- [ ] Global-scope module idle-shutdown 60s after last `release()`.
- [ ] No `any` / `unknown` in SDK public API.

### Quality Gates

- [ ] `npx vitest run` green across host, SDK, and Device Control.
- [ ] Playwright-electron E2E green for ModulePanel rendering, sidebar dynamic load, install/uninstall flows, audit-log tamper detection.
- [ ] Two recorded device flows (`login.rn-dev-flow.json`, `onboarding.rn-dev-flow.json`) replay green on a fresh emulator.
- [ ] SDK v1.0.0 + Device Control v0.1.0 published to npm; registry PR merged with Device Control entry + `npmResolvedTree` populated.
- [ ] Module threat model doc reviewed.
- [ ] Root CLAUDE.md documents module-system conventions.
- [ ] `@npmcli/arborist --ignore-scripts` verified by sentinel test (postinstall file NOT created).

---

## Success Metrics

- **Time to first external module:** < 30 min for a developer following the tutorial to publish a Hello World module to npm and install it via the marketplace.
- **Module crash blast radius:** zero host-level crashes attributable to module code across E2E test runs.
- **Cold-start latency:** p95 ≤ 3s for first `tools/call` against an inactive module.
- **Device Control usability:** both canonical flows (login, onboarding) replay green on a reference RN sample app without manual intervention.
- **Deprecation debt:** no new usage of `<webview>` after Phase 4 (DevToolsView migrated to `WebContentsView`).

## Dependencies & Prerequisites

- External npm packages added: `vscode-jsonrpc`, `@npmcli/arborist`, `appium-adb`, `adbkit`, `win-job-object` (Windows only), `semver`, possibly `pacote`.
- A new GitHub repo `rn-dev-modules-registry` owned by the same org.
- macOS CI runner (Xcode) for iOS simulator tests — Phase 8 gates on this.
- `scrcpy-server.jar` bundled with the Device Control module (or downloaded at activation) — license compat check (Apache-2).
- Coordination with DevTools Network plan: Phase 2/3 of that plan should land against the module-system manifest pipeline — either before Phase 3 of this plan (preferable, since it's the largest first-party example) or a simultaneous Phase 2/5 bridge.

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| `WebContentsView` pivot complexity exceeds estimate | Phase 4 slips; sidebar layout bugs | Run a dedicated spike at Phase 4 start porting `DevToolsView.tsx` alone. If the spike lands cleanly, proceed; else fall back to `<webview>` with a recorded `WebContentsView` follow-up. |
| `idb` broken by Xcode update | iOS Sim features regress | simctl-only fallback built in from day one (Phase 8). Compat matrix in docs. |
| `ipc-bridge.ts` (1203 lines) becomes harder to reason about after this plan's additions | Future bugs hide in coupling | Split-up TODO flagged; not scope for this plan. Track as Phase 11.5 cleanup. |
| Programmatic `@npmcli/arborist` incompatible with user's global npm config | Install fails silently | Shell out to `bun install` as secondary fallback; prefer Arborist. |
| MCP spec 2025-11-25 obsoletes during implementation | Agent compatibility breaks | Pin the version; gate upgrades behind an explicit bump. |
| `scope: 'global'` lockfile contention if multiple users on same machine | False "Failed" | Lockfile includes UID; per-user scope. |
| Brainstorm's `<webview>` decision reversed here | Plan may need user redirect | Explicit "Alternatives Considered" section; user can reject pivot in review. |
| bun workspaces already partially present in `bun.lock` — prior attempt may have left cruft | Phase 0 surprises | Audit `bun.lock`; `rm -rf node_modules` + fresh install as part of Phase 0. |
| idb / adb device-discovery timing races across worktrees | Flaky E2E | Arbitration queue (Phase 7) + explicit deterministic device selector by serial. |
| `@rn-dev-modules/device-control` npm name availability | Publish blocked | Reserve the npm scope early. |

## Resource Requirements

- Development: single primary dev full-time through phases 0–4 (foundation), then foundation + module dev in parallel from Phase 5 onward.
- CI: macOS runner for iOS tests; Linux runner for Android emulator (GitHub Actions supports `android-emulator-runner`).
- Timeline: rough estimate 8–12 weeks for Phases 0–9; Phases 10–11 follow-up.

## Future Considerations (post-v1)

- **Physical Android + iOS devices** in Device Control (Phase 12).
- **Full Maestro YAML import** (not just export).
- **Signed modules** and a public `modules.json` moderation process beyond GitHub PRs.
- **Workspace-scoped install** (monorepo recommendations).
- **Runtime capability gating** — upgrade from advisory permissions to actual sandbox enforcement (macOS App Sandbox profile per module subprocess? Linux seccomp? Windows AppContainer?).
- **Web Worker Extension Host** analog for lightweight modules that don't need Node.
- **Module update UX** with in-flight drain + migration scripts.
- **TUI contribution parity** — current v1 is optional; make it first-class later if demand emerges.

## Documentation Plan

- [ ] `packages/module-sdk/README.md` — Hello World tutorial, manifest reference, capability list.
- [ ] `modules/device-control/README.md` — user-facing docs, platform support matrix, troubleshooting.
- [ ] `docs/module-threat-model.md` — explicit threat boundaries.
- [ ] Root `CLAUDE.md` — add module system section.
- [ ] Marketplace module's own panel shows inline help per listed module.
- [ ] `rn-dev-modules-registry/README.md` — how to submit a module.

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-04-21-module-system-and-device-control-brainstorm.md](docs/brainstorms/2026-04-21-module-system-and-device-control-brainstorm.md). Key decisions carried forward:
  - Electron + MCP required surfaces; TUI optional (see brainstorm: Required surfaces).
  - Subprocess-per-module Extension Host isolation (see brainstorm: Process model).
  - Declarative manifest-only with consent-UI enforcement (see brainstorm: Manifest).
  - `scope: "global" | "per-worktree"` (see brainstorm: Module scope).
  - Hybrid module-to-module: manifest `uses:` + MCP composition (see brainstorm: Module ↔ module).
  - Standalone npm package for Device Control from day one (see brainstorm: Device Control packaging).
  - Co-evolved monorepo sequencing (Approach A in brainstorm).

### Internal References

- Existing module abstraction: [src/core/types.ts:105](src/core/types.ts:105), [src/modules/registry.ts:5](src/modules/registry.ts:5).
- Existing plugin loader: [src/modules/registry.ts:55](src/modules/registry.ts:55) (`rn-dev.plugins` dynamic import).
- Current MCP contract: [src/mcp/server.ts](src/mcp/server.ts), [src/mcp/tools.ts](src/mcp/tools.ts).
- Hardcoded Electron views: [renderer/App.tsx:395](renderer/App.tsx:395), [renderer/components/Sidebar.tsx:17](renderer/components/Sidebar.tsx:17).
- `<webview>` prior art: [renderer/views/DevToolsView.tsx:142](renderer/views/DevToolsView.tsx:142).
- Per-worktree lifecycle pattern to mirror: [src/core/metro.ts:33](src/core/metro.ts:33), [src/core/devtools.ts:20](src/core/devtools.ts:20).
- ServiceBus current typing: [src/app/service-bus.ts:10](src/app/service-bus.ts:10).
- IPC wire format prior art: [src/core/ipc.ts:28](src/core/ipc.ts:28).
- Concurrent DevTools plan: [docs/plans/2026-04-21-feat-agent-native-devtools-network-plan.md](docs/plans/2026-04-21-feat-agent-native-devtools-network-plan.md). Phase 1 landed (commit `854617a`).

### External References

- [Electron: Migrate to WebContentsView](https://www.electronjs.org/blog/migrate-to-webcontentsview).
- [Electron webview tag (discouraged)](https://www.electronjs.org/docs/latest/api/webview-tag).
- [vscode-jsonrpc](https://www.npmjs.com/package/vscode-jsonrpc) + [repo](https://github.com/microsoft/vscode-languageserver-node/tree/main/jsonrpc).
- [VSCode Extension Host architecture](https://code.visualstudio.com/api/advanced-topics/extension-host).
- [MCP tools spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- [MCP official registry](https://github.com/modelcontextprotocol/registry) (model for our `modules.json`).
- [MetaMCP aggregator](https://github.com/metatool-ai/metamcp) (module-prefix namespacing prior art).
- [@npmcli/arborist](https://github.com/npm/cli/tree/latest/workspaces/arborist).
- [appium-adb](https://github.com/appium/appium-adb).
- [adbkit](https://github.com/openstf/adbkit) (framebuffer streaming).
- [facebook/idb](https://github.com/facebook/idb) (iOS Sim; maintenance risk noted).
- [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) + [escrcpy](https://github.com/viarotel-org/escrcpy) — H.264 + WebCodecs mirror.
- [android-emulator-webrtc](https://github.com/google/android-emulator-webrtc) (official emulator alt transport).
- [InditexTech/mcp-server-simulator-ios-idb](https://github.com/InditexTech/mcp-server-simulator-ios-idb) — iOS-simulator MCP precedent.
- [win-job-object](https://www.npmjs.com/package/win-job-object) — Windows orphan-kill primitive.

### Related Work

- Origin brainstorm: [docs/brainstorms/2026-04-21-module-system-and-device-control-brainstorm.md](docs/brainstorms/2026-04-21-module-system-and-device-control-brainstorm.md).
- Predecessor brainstorm: [docs/brainstorms/2026-04-21-devtools-agent-native-brainstorm.md](docs/brainstorms/2026-04-21-devtools-agent-native-brainstorm.md).
- Predecessor plan (Phase 1 landed): [docs/plans/2026-04-21-feat-agent-native-devtools-network-plan.md](docs/plans/2026-04-21-feat-agent-native-devtools-network-plan.md).

### Open questions deferred to implementation

- Final `rn-dev-module.json` JSON Schema field list (Phase 1 deliverable).
- ServiceBus type-safe namespaced-topic declaration-merge ergonomics (Phase 2).
- DevTools Network Phase 2/3 sequencing vs. this plan's Phase 3 (coordination meeting needed).
- Whether to split `ipc-bridge.ts` in scope here or in a follow-up (recommended: follow-up).
- `package.json` workspaces cruft audit (Phase 0).
- Whether `<webview>` → `WebContentsView` pivot survives the Phase 4 spike (decision point).
