# Next-Session Prompt — Module System Phase 6 (install flow)

**Paste the block below at the start of the next session.**

---

We're continuing the third-party module system for rn-dev-cli. **Phase 5c shipped in PR #4 (squash-merged to `main` on 2026-04-22).** Phase 6 is the real install/uninstall flow — the Marketplace panel's action column has been intentionally bare since Phase 5b waiting on this work.

### Before writing any code

1. Read `docs/plans/2026-04-22-module-system-phase-5c-handoff.md` — **Deferred items**, **In-session regression** (preload-must-be-self-contained lesson), and the **Pre-merge review follow-ups** section that flags Phase 6 items.
2. Skim `docs/superpowers/specs/2026-04-13-tab-close-retry-continue-quick-mode-design.md` — section 3 shipped as Quick Mode; sections 1, 2, 4 are still open if Martin wants them folded in.
3. Re-read the "Install flow" section of `docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md` — arborist + consent dialog + SHA-pinned registry design.
4. `git log origin/main --oneline -5` — confirm you're stacking on PR #4's squash merge.

### Branching

Fresh branch off main: `feat/module-system-phase-6`. Target < 2000 line insertions; the Marketplace UI work is mostly wiring on top of existing panels.

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-6
```

### Phase 6 scope — the install/uninstall flow

#### Primary

1. **Curated registry with SHA pinning.** `modules.json` on GitHub, fetched per host release. Schema: `{ version, modules: [{ id, npmPackage, version, tarballSha256, description, author }] }`. Host refuses to install any module whose fetched tarball doesn't match the pinned SHA256.
2. **Install via `@npmcli/arborist`.** Always `--ignore-scripts`. Target directory: `~/.rn-dev/modules/<id>/`. After install, validate the manifest schema. Failure path: rollback (delete the partial install directory).
3. **Consent dialog.** Electron modal listing:
   - Module id / version / author / description (from `modules.json`).
   - Manifest `permissions[]` (advisory — v1 doesn't enforce at runtime but users should see them).
   - Tarball SHA256 + registry URL.
   - "Install" / "Cancel" buttons. Install button disabled until the user ticks "I trust this module author".
4. **Wire the Marketplace panel.** The "Action" column (deliberately removed in Phase 5c, sim-P0-2) comes back with:
   - **Built-ins:** `system, uninstallable` badge (unchanged from pre-deletion).
   - **3p modules:** `Uninstall` button + lifecycle state (running / stopped / crashed).
   - **Available-to-install rows** (read from `modules.json`, not yet in `moduleRegistry`): `Install` button.
5. **`modules/install` + `modules/uninstall` MCP actions.** Route through the curated registry + consent UI. Agents must call `modules/install { id }` — the host then shows the consent dialog to the user; the agent doesn't bypass it. Uninstall tears down the subprocess + deletes `~/.rn-dev/modules/<id>/`.

#### Secondary — review follow-ups parked from Phase 5c

From PR #4 review (all P1, documented in the 5c handoff):

- **Arch P1-1** — extract `createModuleSystem()` factory. `electron/module-system-bootstrap.ts` currently duplicates `src/app/start-flow.ts`'s capability + registry + built-in wiring. Doing this during Phase 6 avoids touching all three files for each new built-in / capability the install flow adds.
- **Arch P1-2** — extract `useModuleConfig(moduleId, scope)` hook. The Marketplace "click a row → open a per-module settings drawer" pattern Phase 6 adds is the second consumer this hook was sized for.
- **Security P1-1** — split host-UI trust from wildcard cross-module config-write. Phase 6 is the right time: once 3p modules carry real permission surface, a renderer XSS → arbitrary 3p config rewrite is a much bigger deal.
- **Kieran P1-3** — tighten `renderer/hooks/useIpc.ts` to `<T>(channel): Promise<T>`. Low-cost cleanup; kills the `as ConfigSetReply` casts scattered through the new renderer code.

#### Do NOT do

- **Option (b) sidebar.** Defer until a third renderer-native panel motivates the `electronPanel.kind` schema extension.
- **MCP tool contributions on built-ins.** Separate follow-up.
- **HMAC-chained `AuditLog.append()`.** Separate follow-up — swap ALL `service:log` audit sinks at once when it lands.
- **Tab close / Retry & Continue / Profile banner bug** (spec sections 1, 2, 4) — ask Martin if these should fold in; default is no.

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
- Electron `modules:*` ipcMain handlers register eagerly with `getDeps()` closure — never race the services.
- Panel bridge attaches at most ONE `WebContentsView` to `window.contentView` at a time.
- `ModuleHostManager.capabilities` + `.configStore` are `public readonly` — single source of truth.
- Tests that mock shell calls mock `../exec-async.js`, NOT `child_process`.
- `modules:host-call` / `modules:config-*` handlers check `_event.sender` against `PanelSenderRegistry` and reject cross-module payloads.
- Panel-bridge register() rejects webviewEntry with absolute paths or `..` traversal.
- SDK `ctx.config` / `ctx.appInfo.config` are getters; `config/changed` notifications pre-initialize are buffered and flushed post-activate.
- **Electron preloads are self-contained `.cjs` files.** No project-relative `require` from the preload. (Phase 5c regression lesson.)
- **`setModuleConfig` is async + per-module serialized.** Callers must `await`.
- `CapabilityRegistry` reserves `log` + `appInfo` unless `{allowReserved: true}`.
- Channel allowlist in `electron/preload.cjs` is the closed set of renderer → ipcMain channels. Adding a new channel = edit this file.
- Settings built-in schema is mirrored in `renderer/views/Settings.tsx:SETTINGS_CONFIG_SCHEMA`; a parity test catches drift.

### Verification commands

```bash
# Unit + integration tests — expect 707+ passing / 0 failed
npx vitest run

# Type check — baseline 149
npx tsc --noEmit | grep -c "error TS"

# Production build
bun run build

# Manual GUI smoke — Phase 6 MUST smoke the install flow end-to-end.
# Use Quick Mode to skip xcodebuild:
#   1. Set the profile mode to `quick` (wizard → build mode → Quick).
#   2. Run `bun run dev:gui`.
#   3. Open Marketplace → click Install on a test 3p module → walk the
#      consent dialog → verify the module appears in the registry row
#      list + the subprocess spawns.
#   4. Click Uninstall → verify subprocess teardown + directory removal.
bun run dev:gui
```

### When done

1. Commit with Conventional Commits + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
2. Write `docs/plans/2026-04-??-module-system-phase-6-handoff.md`.
3. Push.
4. Open a PR from `feat/module-system-phase-6`.
5. Ask Martin whether Phase 7 (MCP tool contributions on built-ins + option (b) sidebar) is next, or whether to pivot to Device Control module.

Remember:
- `vitest run`, not `bun test`.
- `bun run build` for production verification.
- Baselines: **707+ / 0** vitest, **149** tsc, **bun run build green**.
- `.claude/` is gitignored.
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it.
- All module state under `~/.rn-dev/modules/<id>/` — `disabled.flag` (Phase 3c) + `config.json` (Phase 5a) + (NEW) the installed package tree.
- Use **Quick Mode** (`mode: "quick"`) when smoke-testing. `[electron] Services started successfully` + no build step = you're in Quick mode.
