# Next-Session Prompt — Module System Phase 5 (per-module config + built-in manifests)

**Paste the block below at the start of the next session.**

---

We're continuing the third-party module system for rn-dev-cli. The branch `feat/module-system-phase-4` now contains **Phases 0/0.5/1/2/3a/3b/3c/3d/4** — Phases 0–3d squash-merged to `main` as commit `6718346`; Phase 4 is 9 commits stacked on top, pushed to `origin/feat/module-system-phase-4`. Martin's call (2026-04-22): **keep stacking Phase 5 on the same branch, don't split yet.** Full vitest: **622 / 0 fail**. tsc: **149** (was 154 — test drift cleanup trimmed 5 errors). GUI smoke confirmed working on 2026-04-22.

Before writing any code:

1. Read `docs/plans/2026-04-22-module-system-phase-4-handoff.md` for the last-shipped state (host/call RPC, panel bridge, preload, dynamic sidebar, host-call audit).
2. Skim the plan's Phase 5 section at `docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md:367-387` — it bundles two concerns.
3. Check the manifest schema at `packages/module-sdk/manifest.schema.json:85-93` — `contributes.config.schema` is already accepted (reserved but currently ignored).

### Branching

Stay on `feat/module-system-phase-4`. No new branch. Keep per-step commits + per-phase handoff doc. When Phase 5 is done, Martin may choose to open the PR then, or continue stacking into Phase 6. Ask before merging.

```bash
git checkout feat/module-system-phase-4
git pull
```

### Phase 5 scope — two bundled concerns

The plan pairs "module config surface" with "built-in modules adopt manifest shape". **Recommendation: split them.**

- **Phase 5a (config surface)** ~1–2 days, clean, self-contained.
- **Phase 5b (built-in migration)** ~2–3 days, touches DevSpace + MetroLogs + LintTest + Settings + introduces the Marketplace built-in.

Do 5a first. Commit separately. Ask Martin before moving to 5b — he may prefer to jump to Phase 6 (marketplace) once the config plumbing exists.

---

### Phase 5a scope — per-module config

1. **Manifest:** `contributes.config.schema` is already accepted by `manifest.schema.json` as a JSON-Schema object. Flip the "host ignores in v1" comment to "host validates + persists". Do NOT add a new schema version — additive-only within 1.x.

2. **Storage:** `~/.rn-dev/modules/<id>/config.json`. Atomic-write (write to `.tmp` → rename). Reuse the `~/.rn-dev/modules/<id>/` root the `disabled-flag.ts` pattern already carved out.

3. **Schema validation:** reuse the existing `ajv` dependency (already in root `package.json`, used by `define-module.ts`). Compile the module's `contributes.config.schema` once on load, cache the validator, reject `modules/config/set` patches that fail.

4. **Config lifecycle:**
   - Load at module activation — pass on `initialize` handshake as a new `config` field alongside `capabilities` and `hostVersion`. Modules that don't declare a schema see `config: {}`.
   - Host holds the source of truth; modules never write the file directly.
   - Update via `modules/config/set` → host validates → writes → emits a new `modules/event` kind `"config-changed"` so subscribers (and the module subprocess) can react.

5. **Daemon IPC actions** — add to `src/app/modules-ipc.ts`:
   - `modules/config/get` — `{ moduleId }` → `{ config }`.
   - `modules/config/set` — `{ moduleId, patch }` — host merges patch into current config, validates, persists. Returns `{ kind: "ok", config }` or `{ kind: "error", code: "E_CONFIG_VALIDATION", message }`.

6. **MCP tools** — add to `src/mcp/tools.ts`:
   - `rn-dev/modules-config-get`
   - `rn-dev/modules-config-set`
   Descriptions should note "Advisory permissions do not gate config reads/writes in v1" for honesty.

7. **SDK surface:**
   - `ModuleAppInfo` gains `config?: Record<string, unknown>`.
   - `ctx.config` on `ModuleToolContext` (readonly).
   - New `runModule()` option `onConfigChanged?: (config) => void` so modules can react to live changes without restart. Host sends a `config/changed` notification (vscode-jsonrpc) on each `modules/config/set`.

8. **Electron IPC:** `modules:config-get` + `modules:config-set` channels wired the same way as Phase 4's `modules:host-call` — lazy deps via `getDeps()` closure so timing races are impossible. Audit-log every set like host-call.

### Phase 5a success criteria

- Fixture module with a config schema round-trips `modules/config/set` → `modules/config/get`; invalid patches get rejected with `E_CONFIG_VALIDATION`.
- `ctx.config` is populated in the echo fixture (add a minimal schema to exercise).
- `onConfigChanged` fires when the host writes.
- `modules/event` emits `config-changed` and the renderer forwards it.
- tsc still at 149 baseline; any new errors in new code = red flag.
- Full vitest still at 0 fail.

---

### Phase 5b scope — built-in modules adopt manifest shape

Only start after Martin signs off. Scope recap:

- Add `contributes` blocks to each existing built-in: `src/modules/built-in/{dev-space,metro-logs,lint-test,settings}.ts`. Stay in-process and privileged (no subprocess split).
- Extend `RegisteredModule` with `kind: "built-in-privileged"` the registry honors (separate from subprocess-spawning 3p modules).
- Create the **Marketplace built-in** module — React-native panel (not a webview), registers a `modules` capability (list/install/uninstall) into the host registry. Real install logic lands in Phase 6; Phase 5b ships the stub.
- Settings panel (already an existing renderer view) migrates to use the new `modules/config/*` tools so the panel works for both built-ins AND 3p modules through the same surface.

### Phase 5b success criteria

- Each existing built-in loads via the manifest path; rendered output unchanged (capture before/after screenshots).
- Marketplace panel lists all four built-ins with "system, uninstallable" badge.
- No regression in DevSpace / MetroLogs / LintTest / Settings.

---

### Leverage existing Phase 4 work

- **Config panel in renderer:** use `<ModulePanel />` pattern from Phase 4 if a 3p module wants a native config UI (optional in 5a — most modules will use the generic Settings render driven by the schema). No new React plumbing needed.
- **`modules/subscribe` stream:** `config-changed` events flow through the same bus the sidebar already listens to. One subscription path — do NOT add a second.
- **Audit sink:** `modules:config-set` goes through the same `service:log` route `host-call` uses. An HMAC-chained sink replaces both when `AuditLog.append()` lands.

### Do NOT do

- **Install / uninstall / @npmcli/arborist** — Phase 6.
- **Registry SHA pin / consent dialog** — Phase 6.
- **Device Control module impl** — Phase 7.
- **Schema versioning / migrations** — V2; v1 schemas are additive-only within 1.x.
- **Config encryption at rest** — not in scope; plan calls out "permissions advisory in v1".
- **Per-worktree vs global config scoping** — v1 config is keyed on `moduleId` only; worktree scoping is a v2 concern noted in the handoff.

### Permanent contract rules (unchanged — do not drift)

- `<moduleId>__<tool>` for 3p / flat for built-ins.
- SDK exports `host.capability<T>(id)` generic — not hardcoded names.
- Manifest at `rn-dev-module.json` at package root.
- Schema additive-only within 1.x.
- `ModuleHostManager` lives in the daemon — Electron main + MCP server are clients.
- Per-module Electron partition `persist:mod-<id>` + dedicated preload.
- `destructiveHint: true` tools require confirmation.
- `IpcMessageEvent.onClose` is required; subscription handlers detach on socket close.
- `runModule()` is the supported contribution surface for 3p authors.
- **NEW (Phase 4):** Electron `modules:*` ipcMain handlers register eagerly with `getDeps()` closure — never race the services.
- **NEW (Phase 4):** panel bridge attaches at most ONE `WebContentsView` to `window.contentView` at a time — cross-module delivery structurally impossible.
- **NEW (Phase 4):** `ModuleHostManager.capabilities` is `public readonly` — single source of truth, Electron main + subprocess resolve against the same registry.
- **NEW (Phase 4):** tests that mock shell calls must mock `../exec-async.js`, NOT `child_process`. Commit `5a76b27` replaced `execSync` with async wrappers; `child_process` mocks silently miss and spawn real processes.

### Verification commands

```bash
# Unit + integration tests — expect 622+ passing / 0 failed
npx vitest run

# Type check — baseline 149 (dropped from 154 after Phase 4 test-drift fixes)
npx tsc --noEmit | grep -c "error TS"

# Production build
bun run build

# Manual GUI smoke — Phase 5a should not visually regress Phase 4;
# a 3p fixture module with `contributes.config.schema` exercises the round-trip
bun run dev:gui
```

### When done

Per sub-phase (5a separate from 5b):
1. Commit with Conventional Commits + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
2. Write `docs/plans/2026-04-??-module-system-phase-5<a|b>-handoff.md` matching the existing format.
3. Push; verify branch is clean.
4. After 5a, ask Martin whether to proceed to 5b or pause for a PR.

Remember:
- `vitest run`, not `bun test`.
- `bun run build` for production bundle verification.
- tsc baseline is **149** (not 154 anymore).
- Full vitest should be **622+ / 0 fail**. Any failure is this-session's regression.
- `.claude/` is gitignored.
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it before each test run.
- All module state lives under `~/.rn-dev/modules/<id>/` — `config.json` joins `disabled.flag` (Phase 3c) there.
