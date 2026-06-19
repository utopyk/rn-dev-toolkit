# Redux GUI panel — hang fix + full polish — Session Handoff (2026-06-19)

Continuation of the redux module work (impl session: `docs/sessions/2026-06-18-redux-module-implementation.md`). This session took the Electron Redux panel from "renders but hangs" to a feature-complete, on-device-verified DevTools-style panel. Branch `main`, local-only (now 77 ahead of origin, never pushed).

## What landed
- `83c2da0` fix(modules): wrap all module panel scripts in an IIFE — fixes the GUI panel "stuck on Loading…" hang. Root cause: a top-level `const rnDev = window.rnDev` collided with the non-configurable `window.rnDev` the preload installs (`contextBridge.exposeInMainWorld`) → `SyntaxError: Identifier 'rnDev' has already been declared` at parse time → whole script aborts. Affected redux + devtools-network + metro-logs + device-control. Added `electron/__tests__/panel-rnDev-collision.test.ts` (AST guard).
- `cffdda7` test(redux): gate the P7 real-boot MCP probe with `it.skipIf` (it was running unconditionally in the normal suite and failing).
- `77ff92e` feat(redux): per-call redaction `mode` arg on state/actions/action tools — GUI passes `full` to reveal values; agents keep `mcp-redacted` default; blacklist still masks secrets in full mode.
- `364811a` feat(redux): panel polish v1 — app soft-dark theme, Action/State/Diff tabs, search, collapsible JSON tree.
- `1e0edcc` fix(redux): keep tree expansion across the 2s poll (signature-gated re-render + per-path persist) + unified old→new Diff view.
- `bc7d9cb` feat(redux): live theme sync — renderer→main→panel pushes current theme tokens (`modules:report-theme` → `setPanelTheme` → `preload-module.js` applies CSS vars). Applies to ALL module panels.
- `89d8a88` feat(redux): hybrid include/exclude chip filters (reusable `createChipFilter()`) + selecting an action no longer switches tabs.
- `c1ce8de` → `26b12c2` → `c01c2cb` feat/fix(redux): add-mode toggle → made it a segmented `[INCLUDE|EXCLUDE]` switch + clear-all → fixed the autocomplete close→open flash on toggle.

## Decisions made
- **Full values in the GUI, structure-only for agents.** The panel is a local human tool, so it requests `mode:"full"` (with a Reveal toggle); MCP/agents default to structure-only. The host secret blacklist (`*token*`, `*email*`, …) always applies in both modes, so full never leaks secrets. Implemented as a per-call tool arg, not a config flip (config is shared MCP+GUI).
- **Theme sync via IPC push, not hardcoded.** 5 themes + runtime switching exist; hardcoding Soft Dark was the bug. Renderer reports tokens on mount + switch; main forwards to live panels.
- **Filter pattern (standing preference for ALL future filters):** multi-value, per-value include/exclude, autocomplete, `*` glob; **excludes win, multiple includes = OR, no includes = all**, live "N of M" count. Add-mode must be a SEGMENTED toggle (a pill reads as a chip). Reference impl = `createChipFilter()`.

## Verification needed before next slice
- Gate (last green this session): `npx vitest run` (1674 passed), `npx tsc --noEmit` (4 baseline) + `-p electron/tsconfig.json` (0), `npm run test:smoke` (14), and `npx vitest run electron/__tests__/panel-rnDev-collision.test.ts` (5).
- Panel files are static (`modules/redux/panel/*`) — no build; the daemon serves them via the `~/.rn-dev/modules/redux` symlink. After changing `modules/redux/src/*` you MUST rebuild (`cd modules/redux && bun run build.ts`) AND restart the session (the subprocess is spawned at boot — it serves stale dist otherwise).

## Parked / known issues
- **Rich live action stream not exercised.** The acme app is stuck on the 4.3.0 dev-mode lazy-bundle splash (v4.2.0 native + current `main` JS), so the panel only ever showed the ~4-action boot snapshot. Enough to verify every feature, but not a flowing stream. To unblock: build a fresh `betaDebug` (with the 4.3.0 nav fix) onto the device.
- **Emulator touch wedged** (workspace-1 AVD: forced-landscape rendering portrait → digitizer mismatch; adb taps + mouse dead, keyevents/drag work). Testing moved to a physical Samsung phone (SM-S711W, `R5CX23WBLKE`). Cold-restart the AVD to recover.
- **acme local changes uncommitted** on the user's machine: vendored `src/dev/rn-dev-redux-enhancer.ts` (git-excluded) + dev-only line in `src/store/configureStore.ts` + `.rn-dev/profiles/android-emu-5554.json` (default flipped). Keep for testing or revert.
- **Held processes** left running for inspection: `.tmp-redux-keep.mjs` (holds session `25a1d52e` on the acme-main daemon, Metro 8090 + ingest 12090), the phone app, and an `npm run dev:gui` GUI. Kill when done.
- The chip-filter widget is redux-only; porting `createChipFilter()` to metro-logs / devtools-network panels is the obvious follow-up.

## Next-session prompt

```
Pick up at: redux module GUI panel is feature-complete and on-device-verified
(docs/sessions/2026-06-19-redux-gui-panel-polish.md), branch main in
/Users/martincouso/Downloads/rn-dev-cli, 77 commits ahead local-only (never push).

Before starting:
- Verify gate: `npx vitest run` (~1674 pass), `npx tsc --noEmit` (4 baseline) +
  `-p electron/tsconfig.json` (0), `npm run test:smoke` (14).
- Confirm/kill leftover procs: `.tmp-redux-keep.mjs`, an `npm run dev:gui`, the
  phone app (adb R5CX23WBLKE). `lsof -nP -a -i:8090 -i:12090` to see the session.

Highest-leverage next slice: build a fresh acme betaDebug (with the 4.3.0 nav
fix) onto the phone so the app gets past the dev splash, then exercise the panel
against a real flowing action stream (the only thing not yet stress-tested). ~10min build.
Fallback (smaller): port createChipFilter() to the metro-logs + devtools-network
panels so the include/exclude filter pattern is everywhere (the user wants it on all filters).

Parked:
- App stuck on 4.3.0 lazy-bundle splash → only boot-snapshot data so far.
- Emulator touch wedged → use the physical phone or cold-restart the AVD.
- acme local enhancer changes still uncommitted (keep or revert).
```

## Related memories
- [[redux-module-implemented]] — full module + panel status, on-device testing recipe, acme local changes.
- [[feedback_filter_pattern_multivalue_include_exclude]] — the standing multi-value include/exclude filter pattern + UX lessons (segmented toggle, no flash).
- [[code_fact_panel_rndev_global_collision]] — why module panels must not declare `rnDev` at top level.
- [[code_fact_session_stopping_wedge]] — abruptly killing a session's last client wedges it in "stopping".
