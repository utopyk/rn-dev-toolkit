# Module System — Phase 0 / 0.5 → Phase 1 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 0 / 0.5 session)
**For:** The next Claude (or human) continuing this feature

---

## Where we are

### Shipped this session

- **Brainstorm:** [docs/brainstorms/2026-04-21-module-system-and-device-control-brainstorm.md](docs/brainstorms/2026-04-21-module-system-and-device-control-brainstorm.md) — 7 resolved design questions + 6 open items kicked to the plan.
- **Plan:** [docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md](docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md) — 12 phases. Includes a **Revision Log** section at the top capturing amendments from multi-reviewer technical review (architecture-strategist, code-simplicity-reviewer, security-sentinel, agent-native-reviewer).
- **Phase 0 (monorepo foundation)** + **Phase 0.5 (ipc-bridge split)** — commit `ec8b4f3` on branch `feat/module-system-phase-0`, PR [#2](https://github.com/utopyk/rn-dev-cli/pull/2).

### Verification

All identical to clean `main` baseline (zero regressions):

- `bun install` — both workspace packages linked.
- `npx vitest run` — 398 passed / 18 failed (18 failures are pre-existing on `main`: `src/core/__tests__/{clean,preflight,project}.test.ts` — spawned chip for a separate session to fix).
- `npx tsc --noEmit` — 154 pre-existing errors (all in `src/ui/wizard/*.tsx`, OpenTUI JSX issues unrelated). **Zero** new type errors from the ipc split.
- `bun run build` — produces working `dist/index.js` (3.7 MB).

### Caveats flagged in PR

- **`electron/ipc/services.ts` is 499 lines** (plan target was <400). Down from 1321 in a single file — 7× improvement. Trim before Phase 4 if it still matters.
- **No playwright-electron smoke test run.** The repo has no harness set up; Phase 4 depends on one. Type-check + vitest + build confirm the split mechanically; manual `bun run dev:gui` recommended before depending on this branch.

### Files touched this session

| File | Change |
|------|--------|
| `package.json` | Added `"workspaces": ["packages/*", "modules/*"]`; `test` → `vitest run`. |
| `vitest.config.ts` | Added `exclude: ["**/.claude/**", ...]` to keep worktree shadow copies out of the test run. |
| `.gitignore` | Added `.claude/`. |
| `esbuild.config.ts` | Deleted (unused; `build.ts` is the real builder). |
| `CLAUDE.md` | **New** — documents conventions + headline module-system rules (tool prefix policy, manifest location, etc.). |
| `electron/ipc-bridge.ts` | Deleted (1321 lines). |
| `electron/ipc/state.ts` | **New** — shared module state + helpers. |
| `electron/ipc/instance.ts` | **New** — `instances:*` + `instance:retryStep`. |
| `electron/ipc/profile.ts` | **New** — `profiles:*` + `worktrees:list` + `get:profile` + `get:themes`. |
| `electron/ipc/metro.ts` | **New** — `metro:reload/devMenu/port`. |
| `electron/ipc/tools.ts` | **New** — `run:lint/typecheck/clean` + `watcher:toggle` + `logs:dump`. |
| `electron/ipc/wizard.ts` | **New** — `wizard:*` handlers. |
| `electron/ipc/devtools.ts` | **New** — `devtools-network:*` handlers (local helpers `getInstanceByPort`, `ensureDevtoolsStarted`). |
| `electron/ipc/services.ts` | **New** — `startInstanceServices` + `startRealServices`. Mechanical move from the old file; also fixed a latent TS bug where `startRealServices` was building an `InstanceState` literal missing `devtools` / `devtoolsStarted`. |
| `electron/ipc/index.ts` | **New** — `setupIpcBridge(window, projectRoot?)` barrel + `startRealServices` re-export. |
| `electron/main.ts` | Import path `./ipc-bridge.js` → `./ipc/index.js` (one-line change). |
| `packages/module-sdk/{package.json,tsconfig.json,src/index.ts}` | **New** — placeholder SDK (to be populated in Phase 1). |
| `modules/device-control/{package.json,src/index.ts}` | **New** — placeholder module (implementation in Phase 7). |

---

## Key decisions carried forward (must respect in future phases)

These were resolved either in the brainstorm, in the plan, or in the technical-review Revision Log. They're **permanent contract decisions** for 1.x — treat changes as breaking-version bumps.

### Module contract shape

- **Required surfaces:** Electron + MCP (TUI optional).
- **Manifest location:** `rn-dev-module.json` at module package root (VSCode-style), NOT `package.json#rn-dev`.
- **Distribution:** curated GitHub `modules.json` (zero ops, PR-based moderation).
- **Install scope:** user-global default (`~/.rn-dev/modules/`), per-project override via `package.json#rn-dev.plugins`.
- **Process model:** each module runs in its own Node subprocess (VSCode Extension Host style), framed with `vscode-jsonrpc` (Content-Length headers). **`ModuleHostManager` runs in the daemon**, not Electron main — GUI and MCP clients share one topology.
- **Electron UI:** `WebContentsView` (pivoted from `<webview>` per Electron 2026 guidance). Per-module `partition: 'persist:mod-<id>'`, dedicated `preload-module.ts`, `hostApi[]` allowlist.
- **MCP tool-prefix policy (permanent):** built-ins keep flat namespace (`metro/*`, `devtools/*`, `modules/*`, `marketplace/*`). Third-party modules MUST use `<moduleId>__<tool>` (double underscore, MetaMCP convention). Host rejects non-compliant 3p with `E_TOOL_NAME_UNPREFIXED`.
- **Module scope:** `"global" | "per-worktree" | "workspace"` (workspace accepted, treated as per-worktree in v1).
- **SDK surface (architecture amendment):** use generic `host.capability<T>(id)` lookup, NOT hardcoded `host.metro` / `host.artifacts` — prevents freezing built-in names into the SDK.

### Subprocess lifecycle (Phase 2 target)

- State machine: `IDLE → SPAWNING → HANDSHAKING → ACTIVE → UPDATING → RESTARTING → CRASHED → FAILED → STOPPING`. **`FAILED` is terminal** (supervisor gave up); `CRASHED` is transient. Drop `RECONNECTING` — processes don't reconnect.
- LSP-style restart policy: auto-restart unless ≥5 crashes in 3 min.
- `global`-scope lockfile at `~/.rn-dev/modules/<id>/.lock` (PID + UID stamped, stale-detection).
- `acquire(consumerId)` / `release(consumerId)` refcounting + 60s idle-shutdown.
- Orphan prevention: process groups (POSIX) / Job Object (Windows).

### Marketplace / install (Phase 6 target — security-hardened)

- `@npmcli/arborist` with `--ignore-scripts` (NO npm lifecycle scripts run for 3p).
- Registry entry includes `npmResolvedTree` with SHA-512 per-package integrity; mismatch → `E_INTEGRITY_MISMATCH`.
- Host pins SHA-256 of expected `modules.json` per host release; mismatch blocks auto-install.
- Consent modal shows declared permissions + full MCP tool descriptions + **honest** disclaimer ("advisory, not sandboxed in v1"). First-ever 3p install requires an extra one-time ack stored at `~/.rn-dev/.third-party-acknowledged`.
- HMAC-chained append-only audit log at `~/.rn-dev/audit.log` with key in OS keychain. Modules cannot write/read/delete.
- `destructiveHint: true` tools require runtime confirmation (GUI) or `permissionsAccepted` array / `--allow-destructive-tools` flag (headless).

### Device Control (Phase 7–9 target)

- Standalone npm package from day one: `@rn-dev-modules/device-control`. Tool names prefixed `device-control__*`.
- v1 platforms: Android Emulator + iOS Simulator. Physical devices = v2.
- Android: `appium-adb` (commands) + `adbkit` (framebuffer stream); mirror via `ws-scrcpy`-style H.264 + WebCodecs.
- iOS: `simctl` (lifecycle) + `idb` (input/a11y/video) with `simctl`-only fallback when idb breaks on new Xcode.
- Flow recording: canonical JSON with `schemaVersion: 1` (source of truth) + Maestro-compatible YAML export (facade).
- FIFO arbitration queue serializes commands across worktrees; audit-logged with calling module id.

---

## Open questions (not yet resolved — for Phase 1 / Phase 6)

From the plan's "Open Questions" section + remaining brainstorm items:

1. **Manifest JSON Schema — final field list.** Phase 1 deliverable. Draft inventory of fields in the Revision Log already; Phase 1 writes the actual `packages/module-sdk/manifest.schema.json`.
2. **Host ↔ module RPC protocol — vscode-jsonrpc is the likely choice**, but confirm on first spawn in Phase 2.
3. **ServiceBus generalization.** Currently typed for fixed topics; needs module-namespaced topics (`module:<id>:<topic>`) without losing type safety. Declaration-merge helper in the SDK.
4. **SDK versioning policy.** `hostRange` semver behavior, deprecation windows, additive-only for 1.x.
5. **Device mirror transport detail.** `ws-scrcpy` / WebCodecs chosen in plan; the actual wire format (WebSocket frames, binary vs JSON) is a Phase 7 concern.
6. **`services.ts` further split.** 499 lines. Extract `startRealServices` + the PM-prompt + code-signing-prompt helpers to separate files if pre-Phase-4 we decide strictness matters.

---

## What's next — Phase 1

Per the plan's Phase 1 section: **Module SDK + manifest schema + scope-aware registry.**

### Recommended scope for the next PR

Branch from `main` **after** PR #2 merges. If you want to work in parallel, branch from `feat/module-system-phase-0` and rebase when it lands.

#### Step 1 — SDK v0.1 (`packages/module-sdk/`)

- `manifest.schema.json` with a versioned `$id` URL. Field inventory (from Revision Log):
  - Core: `id`, `version`, `hostRange`, `scope: 'global' | 'per-worktree' | 'workspace'`, `experimental?: boolean`.
  - `contributes.mcp.tools[]` — name (enforce `<moduleId>__<tool>` for 3p), description, inputSchema, `destructiveHint?`, `readOnlyHint?`, `openWorldHint?`.
  - `contributes.electron.panels[]` — id, title, icon, `webviewEntry`, `hostApi: string[]`.
  - `contributes.tui.views[]?` (optional surface).
  - `contributes.api?: { methods: Record<string, { inputSchema, outputSchema, description }> }` — reserved for Phase 10 `uses:` dependency.
  - `contributes.config?: { schema: JSONSchema }` — reserved for Phase 5 module config.
  - `permissions[]` — `adb`, `net:<port-range>`, `fs:artifacts`, `exec:<binary>`, `network:outbound`.
  - `activationEvents[]` — `onStartup`, `onMcpTool:<pattern>`, `onElectronPanel:<id>`, `onWorktreeOpen`.
  - `uses?: [{ id, versionRange }]` — reserved for Phase 10.
  - **Reserved for V2 (accept but no-op):** `signature?`, `sandbox?`, `target?: { kind: 'emulator' | 'simulator' | 'physical' }`.
- `src/types.ts` — types matching the schema (prefer hand-written over generated for readability; keep in sync).
- `src/define-module.ts` — `defineModule(spec)` helper that validates at runtime against the schema.
- `src/errors.ts` — typed error codes listed in Revision Log (`MODULE_UNAVAILABLE`, `E_NOT_ALLOWED`, `MODULE_ACTIVATION_TIMEOUT`, `E_PERMISSION_DENIED`, `E_MISSING_DEP`, `E_MANIFEST_SHA_MISMATCH`, `E_DESTRUCTIVE_REQUIRES_CONFIRM`, `E_TOOL_NAME_UNPREFIXED`, `E_INTEGRITY_MISMATCH`, `E_METHOD_NOT_EXPOSED`).
- `src/host-rpc.ts` — shape only (implementation comes in Phase 2 when the RPC transport lands). The key thing Phase 1 nails down is the TYPE surface of `host.capability<T>(id)`.

#### Step 2 — Registry load path (`src/modules/registry.ts`)

- `loadUserGlobalModules()` reads `~/.rn-dev/modules/*/rn-dev-module.json`, validates schema, checks `hostRange` via `semver`, returns `RegisteredModule[]` in `inert` state.
- Keep existing `loadPlugins(projectRoot)` for per-project override; feed both into the same validation pipeline.
- Loosen `isRnDevModule` — MCP-only or Electron-only modules are valid (no `component` required).
- Scope-aware map key: `${moduleId}:${scopeUnit}` where `scopeUnit` is `"global"` or a worktreeKey.
- **Enforce tool-prefix policy at load time** — 3p tools not matching `<manifest.id>__<tool>` fail with `E_TOOL_NAME_UNPREFIXED`.

#### Step 3 — Success criteria (copy from plan Phase 1)

- Fixture module (`fixtures/test-module/rn-dev-module.json`) loads end-to-end with correct scope/permissions/activation fields.
- `hostRange` mismatch rejected with clear error.
- Invalid manifest rejected with path-pointing JSON Schema errors.

#### Tests to write

- `packages/module-sdk/src/__tests__/define-module.test.ts`
- `src/core/__tests__/module-registry.test.ts` (mirror existing `src/modules/__tests__/registry.test.ts` pattern)

### Things to NOT do in Phase 1

- No subprocess spawning yet (Phase 2).
- No MCP tool proxying yet (Phase 3).
- No Electron panel integration yet (Phase 4).
- No device code, no Device Control (Phase 7–9).

### Rough size estimate

Phase 1 is ~2–3 days of focused work: new SDK package, schema design, one registry extension, one new load path, fixture + tests. Smaller than Phase 0.5's refactor.

---

## Parallel work that may land first

- **Pre-existing vitest failures** (`src/core/__tests__/{clean,preflight,project}.test.ts`) — separate chip spawned. Independent of module-system work; when fixed, the 18-failure baseline goes to 0.
- **DevTools Network plan** is already fully merged to `main` (Phases 1–3 + `--enable-devtools-mcp` CLI flag). No pending DevTools branch to coordinate with.

---

## Environment notes

- Node ≥18; bun is the canonical runtime + installer + test runner (but tests run via `vitest run` because `bun test` has `vi.mock` issues).
- macOS (Darwin 24.3.0) is the primary dev env; cross-platform concerns (Windows Job Object, Linux `chattr`) show up in Phase 2 + Phase 6.
- Current branch: `feat/module-system-phase-0`; PR [#2](https://github.com/utopyk/rn-dev-cli/pull/2).
- `.claude/worktrees/gracious-swartz/` exists on disk — that's a stale superpowers worktree. `.gitignore` now excludes `.claude/` so it stops cluttering.
