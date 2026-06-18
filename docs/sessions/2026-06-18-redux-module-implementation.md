# Session — Redux inspection module: implemented + live-verified through MCP (2026-06-18)

## Goal

Build the rn-dev **redux module** (plan: `docs/plans/2026-06-17-feat-redux-module.md`) and verify
it end-to-end through **both MCP and the Electron GUI** against the real **acme-mobile-app** on an
**Android emulator**. Surfaces a React Native app's Redux action stream + state + per-action diffs to
agents (`redux__*` MCP tools) and humans (Electron "Redux" panel), redacted by default.

## Outcome

**Implementation: COMPLETE.** 7 phases, 7 commits on `main` (local-only, 66 ahead of origin):

| Phase | Commit | What |
|-------|--------|------|
| P1 | `030c7f0` | host data plane — `ReduxStore` ring buffer + black/white-list redaction (pure, unit-tested) |
| P2 | `e434cbe` | WS ingest server (`metroPort + 4000`) + per-session boot wiring |
| P3 | `665b9fd` | `redux` host capability + registration |
| P4 | `954f03f` | `modules/redux` subprocess + `redux__*` MCP tools + **host-side** redaction |
| P5 | `420ba14` | Electron "Redux" panel (WebContentsView) |
| P6 | `affd819` | vendored app-side store enhancer + vendoring docs |
| P7 | `2d38389` | env-gated real-boot MCP probe (`src/mcp/__tests__/probe-real-redux-mcp.spec.ts`) |

**Gate:** `npx vitest run` 1665 pass · tsc root 4 (baseline, excl `src/ui`) / electron 0 / redux module 0 · smoke unaffected.

**MCP half — VERIFIED LIVE.** Real acme (main repo, `betaDebug`) built via rn-dev MCP and running on
Android `emulator-5554`, enhancer streaming to redux ingest on `12090`:
- `redux__status` → `bufferSize=10`, `hasState=true`
- `redux__actions` → 10 real boot actions: `RESTORE_SESSION` → `SET_AUTH_TOKEN` →
  `REQUEST_COMPANIES_SUCCEEDED` → `SET_CURRENT_COMPANY` → `SOCKET_CONNECTION`
- `redux__state` → 39 slices, with live PII redaction holding: `authToken`, `company_token`,
  `phone_number`, `resetPassword` all `[redacted]`; everything else structure-only.

This is the substantive goal: the data plane works against the real app + emulator, redacted, on the agent client.

## OPEN — GUI panel data-load hang (follow-up: task #26)

The Electron **Redux panel renders and is wired**: sidebar entry, panel selected (status bar shows
`Module: redux`), ACTIONS / STATE columns, Clear / Refresh buttons all present (screenshots
`/tmp/redux-gui.png`, `/tmp/redux-gui-native.png`). But its `rnDev.callTool` round-trips **hang on
"Loading…"** — not an error, not empty.

**This is NOT a redux-core bug.** The exact same `status`/`actions`/`state` calls return fine over MCP.
The bug is in the **GUI panel-bridge ↔ redux module-call path** (`modules:call-tool` / lazy module
acquire for the panel's session). `devtools-network` + `metro-logs` panels load fine, so the fix is to
diff their bridge/acquire path against redux's. Tracked as task #26.

## Architecture notes (for whoever picks up #26)

- Redux store is **per-session** (one `ReduxStore` per boot, mirrors `MetroLogsStore`). Session
  identity is **implicit in the port** — the enhancer streams to `metroPort + 4000`, no announce/resolve,
  no supervisor surgery.
- **Redaction runs host-side** — raw values never cross to the module subprocess. The module passes
  operator config from `ctx.config` fail-closed; `DEFAULT_BLACKLIST` lives host-side and is always unioned.
- acme's token lives in the **`session`** slice (not `auth`).

## acme LOCAL test changes (uncommitted, on this machine)

To re-verify or revert later:
- `src/dev/rn-dev-redux-enhancer.ts` — vendored enhancer (git-excluded via `.git/info/exclude`).
- `src/store/configureStore.ts` — dev-only enhancer line in the `compose(...)` chain (tracked, uncommitted).
- `.rn-dev/profiles/android-emu-5554.json` — new profile (`isDefault: true`, metroPort 8090, betaDebug, beta suffix).
- `.rn-dev/profiles/default.json` — `isDefault` flipped to false (revert: set it back to true).
