# Next session — handoff (2026-05-07)

**State:** 96 commits ahead on `main`, all local. Vitest 1344/1344 + 2 skipped real-boot probes. Electron tsc clean. Renderer tsc baseline drift (295 errors) is pre-existing, unrelated to this session.

**Predecessor:** [2026-05-06 TUI + MCP real-process test parity plan](2026-05-06-tui-mcp-real-process-test-parity.md). M1 + M2 + Electron-M2d are landed (per the post-landing summary at the bottom of that doc). T1 (TUI) is the next phase but was deprioritized when the user pivoted to "fix the bugs my manual testing surfaced."

## What landed today (2026-05-07 + late 2026-05-06 night)

### MCP parity — closed
- M1 a–e (transport): tool listing, read-tool round-trip, modules-list daemon-RPC, error path, consent gate + flag plumbing.
- M2 prereq + a–d (use): session lifecycle wired correctly, `rn-dev/build` refactored to daemon RPC, `rn-dev/build-status` for observability, real-build probe against acme (`HEAD 204 https://clients3.google.com/generate_204` actually flowed through MCP), module-proxy round-trip.
- Electron-M2d: extended Electron probe to click DevTools/MetroLogs panels (not just verify build).

### User-reported bug bash (manual testing)
1. **Quick mode + reload "Metro connection fails"** — RN 0.83 banner detection ([commit 71a9f47](../../commits/71a9f47)). Status stayed in `starting` forever because the recognized-banners list was missing the new RN 0.83 wording. Added the marker + HTTP-probe fallback.
2. **"Ultra-clean throws E_PROFILE_MODE"** ([commit 4aa0778](../../commits/4aa0778)) — `RunMode` type included `ultra-clean` but `VALID_MODES` in profile-guard didn't.
3. **"Can't run 2 profiles at the same time"** — architectural Phase 13.6+ feature; UX patch surfaces the existing `PROFILE_MISMATCH` error code visibly ([commit 540e91a](../../commits/540e91a)).
4. **"Kill tab does nothing / shows red ✓"** — full arc:
   - Cosmetic 3s timer race ([commit 380271b](../../commits/380271b))
   - Tab gone but Metro still running ([commit 31794f0](../../commits/31794f0)) — fake-boot test missed it; real-boot test (port-bound assertion) catches it.
   - Synchronous await blocked UI under ultra-clean ([commit 511e70d](../../commits/511e70d)) — fire-and-forget the daemon stop.
   - Two-click confirm pattern reported as unusual UX ([commit 53d905d](../../commits/53d905d)) — replaced with a proper modal (Cancel/Close tab, Esc/backdrop dismiss).

## Open items, in rough priority order

### 1. T1 (TUI real-process harness) — original plan still open
[`docs/plans/2026-05-06-tui-mcp-real-process-test-parity.md`](2026-05-06-tui-mcp-real-process-test-parity.md) Phase T1 was deferred when the user redirected to MCP completion + bug bash. The plan stands as written. T1a is the spike: pick an ANSI parser (or fall back to substring matching) for OpenTUI output. If the spike comes back hostile, revisit the "make the TUI simpler" question instead of building a smarter harness.

### 2. Multi-profile per Electron — Phase 13.6+
`state.daemonSession` is a singleton. Today's UX patch surfaces the limitation in a modal-style alert; the real fix is multi-day refactor across `state.ts`, `services.ts`, `instance.ts`, `main.ts`, and several IPC handlers. Tracked, not blocking.

### 3. `supervisor.stop()` is not interruptible mid-boot
For ultra-clean, the in-flight clean step holds `bootInFlight` for 5-10 minutes. Today's fix is fire-and-forget the daemon stop so the UI doesn't freeze, but the daemon's Metro lingers until clean finishes. Real fix needs an `AbortSignal` plumbed through `CleanManager`. Future hygiene work.

### 4. The session/log lifecycle hyphen-vs-slash discovery
M1c surfaced that `rn-dev/start-session`/`stop-session`/`list-sessions` were sending wrong RPC names; M2-prereq fixed them. But there may be other in-process callers (TUI flow?) that still use the legacy hyphen names — worth a grep.

### 5. Renderer tsc baseline drift (295 errors)
Pre-existing on `main`. Not caused by today's commits. Worth a cleanup pass at some point but doesn't block anything.

## Validation steps for next session

Before claiming any "test pass" on daemon/Metro/devtools surfaces, run:
- `npx vitest run` — fast, baseline.
- `REAL_BOOT_SMOKE=1 npx playwright test --config playwright.config.ts` — Electron real-boot. The kill-tab + DevTools/MetroLogs panel tests live here.
- `PROBE=1 npx playwright test --config tests/electron-real-e2e/playwright.config.ts` — Electron probe-real-build, full acme + iPhone build.
- `PROBE=1 npx vitest run src/mcp/__tests__/probe-real-build-mcp.spec.ts` — MCP real build through daemon.
- `PROBE=1 npx vitest run src/mcp/__tests__/probe-real-devtools-mcp.spec.ts` — MCP real devtools-network + metro-logs against live module subprocesses.

Pre-flight: kill any leaked daemons + Metro:
```
pkill -9 -f "src/index.tsx daemon"
rm -f /Users/martincouso/Documents/GitHub/acme-mobile-app/.rn-dev/{sock,pid}
lsof -P -i :8099 -t | xargs -r kill -9
```

## Deployment notes

The user runs Electron via `npm run dev:gui`. Vite HMR reloads the renderer on save, but **main process code (`electron/`) requires Cmd-Q + relaunch**, not just renderer refresh. This bit me twice this session. When pushing main-process IPC fixes, tell the user explicitly to fully quit before testing.

## Memory entries written this session

- [`2026_05_07_mcp_parity_and_bug_bash.md`](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/2026_05_07_mcp_parity_and_bug_bash.md) — full landing summary.
- [`real_boot_is_the_only_gate.md`](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/real_boot_is_the_only_gate.md) — feedback memory: real-boot is the merge gate.
- [`feedback_modal_over_inline_confirm.md`](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/feedback_modal_over_inline_confirm.md) — feedback memory: prefer modals.
