# Next-Session Prompt — Module System Phase 5c (renderer-side finish of Phase 5)

**Paste the block below at the start of the next session.**

---

We're continuing the third-party module system for rn-dev-cli. **Phases 4 + 5a + 5b core shipped in PR #3 (squash-merged to `main` as `2311dd4` on 2026-04-22).** Phase 5c closes the loop on the renderer side: the Marketplace panel, Settings panel migration to `modules/config/*`, and sidebar driven from the manifest list. Alongside it, pick up the review follow-ups Phase 5b intentionally deferred.

### Before writing any code

1. Read `docs/plans/2026-04-22-module-system-phase-5b-handoff.md` — the "Deferred items" section lists exactly what 5c owes.
2. Read the review-fix commit on main (`git show 29dc476`) — the "Follow-ups flagged" section enumerates review items parked for later.
3. Skim `renderer/views/Settings.tsx` + `renderer/components/Sidebar.tsx` + `renderer/App.tsx` — today they dispatch by hardcoded strings (`'dev-space' | 'metro-logs' | …`). Phase 5c either keeps the dispatch and treats manifests as metadata, or drives the sidebar off `modules/list`. Pick one up-front; don't let it emerge from the diff.
4. `git log origin/main --oneline -5` — confirm you're stacking on `2311dd4` or later.

### Branching

Fresh branch off main: `feat/module-system-phase-5c`. PR #3's 12-commit stack is merged; this PR should stay smaller — aim for one tight commit per discrete concern.

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-5c
```

### Phase 5c scope

#### Primary — the three things the 5b handoff deferred

1. **Marketplace renderer-native React panel.** `renderer/views/Marketplace.tsx` + sidebar entry. Drives off `modules/list` via the existing `invoke('modules:list-panels')` pattern (or the new `modules:config-get`-style channel if you need more than panel metadata). Each row shows id / version / scope / kind ("subprocess" vs "built-in-privileged") / state; built-ins carry a "system, uninstallable" badge per the plan. No install button yet — that's Phase 6.

2. **Settings panel migration to `modules/config/*`.** Today `renderer/views/Settings.tsx` renders informational text. Replace that with a form driven by `settingsManifest.contributes.config.schema` (the schema already declares `theme` and `showExperimentalModules` — see `src/modules/built-in/manifests.ts`). Reads via `invoke('modules:config-get', { moduleId: 'settings' })`, writes via `invoke('modules:config-set', ...)`. Same wiring works for metro-logs' `follow` / `filter` schema; consider generalizing into a `<ModuleConfigForm schema={...} moduleId={...} />` component that takes any JSON Schema and renders a form.

3. **Sidebar driven from the manifest list.** `renderer/components/Sidebar.tsx` currently hardcodes built-in ids. Pick option (a) or (b) from the handoff:
   - (a) Keep the hardcoded dispatch; treat manifests as metadata-only. Cheaper to ship.
   - (b) Drive the sidebar off `modules:list-panels` + branch on `RegisteredModuleRow.kind` to pick native React view vs `<ModulePanel />` WebContentsView. Clean endpoint.
   Martin's call before you start; (b) is where this is heading long-term.

#### Secondary — review follow-ups (do these if time remains; otherwise file issues)

From the PR #3 review panel, these are tracked and should land sometime this phase or next:

- **Architecture #1 (unify the two `ModuleRegistry` instances).** `src/app/start-flow.ts:81` and `:549` create two instances of the same class — the TUI surface and the daemon manifest surface. Low-touch, high-leverage. Do this **before** you wire the sidebar off `modules/list` (option (b)), otherwise you'll need to reconcile twice.
- **Architecture #3 (consolidate `MarketplaceModuleEntry` with `RegisteredModuleRow`).** Same projection from the same source. Either `Pick<RegisteredModuleRow, ...>` or have Marketplace return `RegisteredModuleRow[]`. Centralizes the row projection (`rowFor` in modules-ipc.ts) as the single source of truth.
- **Architecture #4 (branch on `kind` everywhere; delete `isBuiltInModulePath`).** `src/modules/registry.ts` exports both a `kind` discriminator and a sentinel modulePath helper. Two representations of the same fact will drift. Keep `kind`; delete the sentinel predicate.
- **Security F3 (per-module config-set serialization).** Two concurrent writes to the same moduleId can lose-update. 8-line in-process `Map<moduleId, Promise<void>>` chain fixes it.
- **Security F5 (renderer preload channel allowlist).** `electron/preload.js:10`'s generic `invoke: (channel, ...args)` exposes every ipcMain handle. Replace with an explicit allowlist.
- **Security F6 (reserve `log` / `appInfo` capability ids).** `CapabilityRegistry.register()` should reject id `"log"` or `"appInfo"` so the SDK's local synthesis can never be accidentally shadowed by a host-side author. One-line guard.
- **Simplicity #6 (`serviceBus.moduleEventsBus` simplification).** `registerModulesIpc` could accept the emitter from `start-flow.ts` directly, eliminating the topic + the listener in `electron/ipc/index.ts`. ~20 LOC removed.

#### Do NOT do

- **Install / uninstall / `@npmcli/arborist`.** Phase 6.
- **Registry SHA pin + consent dialog.** Phase 6.
- **HMAC-chained `AuditLog.append()`.** Separate follow-up; swap ALL `service:log` audit sinks at once when it lands.
- **Device Control module implementation.** Phase 7+.

### Permanent contract rules (unchanged — do not drift)

- `<moduleId>__<tool>` for 3p / flat for built-ins.
- SDK exports `host.capability<T>(id)` generic.
- Manifest at `rn-dev-module.json` at package root.
- Schema additive-only within 1.x.
- `ModuleHostManager` lives in the daemon — Electron main + MCP server are clients.
- Per-module Electron partition `persist:mod-<id>` + dedicated preload.
- `destructiveHint: true` tools require confirmation.
- `IpcMessageEvent.onClose` is required; subscription handlers detach on socket close.
- `runModule()` is the supported contribution surface for 3p authors.
- Electron `modules:*` ipcMain handlers register eagerly with `getDeps()` closure — never race the services (Phase 4).
- Panel bridge attaches at most ONE `WebContentsView` to `window.contentView` at a time (Phase 4).
- `ModuleHostManager.capabilities` + `.configStore` are `public readonly` — single source of truth (Phase 4/5a).
- Tests that mock shell calls mock `../exec-async.js`, NOT `child_process` (Phase 4).
- `modules:host-call` / `modules:config-*` handlers check `_event.sender` against `PanelSenderRegistry` and reject cross-module payloads (Phase 5b review fix).
- Panel-bridge register() rejects webviewEntry with absolute paths or `..` traversal (Phase 5b review fix).
- SDK `ctx.config` / `ctx.appInfo.config` are getters; `config/changed` notifications pre-initialize are buffered and flushed post-activate (Phase 5b review fix).

### Verification commands

```bash
# Unit + integration tests — expect 681+ passing / 0 failed
npx vitest run

# Type check — baseline 149
npx tsc --noEmit | grep -c "error TS"

# Production build
bun run build

# Manual GUI smoke — REQUIRED for Phase 5c because it's renderer work.
# Capture before/after screenshots of Settings + DevSpace + MetroLogs +
# LintTest + Marketplace to demonstrate no regression + new panels land.
bun run dev:gui
```

### When done

1. Commit with Conventional Commits + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
2. Write `docs/plans/2026-04-??-module-system-phase-5c-handoff.md` matching the existing format.
3. Push.
4. Open a PR from `feat/module-system-phase-5c` — this one should be smaller than PR #3 (target < 2000 lines insertions).
5. Ask Martin whether Phase 6 (marketplace install flow) is next, or whether to pause for a different priority (e.g. Device Control module, DevTools Network extension).

Remember:
- `vitest run`, not `bun test`.
- `bun run build` for production verification.
- Baselines: **681+ / 0** vitest, **149** tsc, **bun run build green**.
- `.claude/` is gitignored.
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it.
- All module state under `~/.rn-dev/modules/<id>/` — `disabled.flag` (Phase 3c) + `config.json` (Phase 5a).
