# Next-Session Prompt — Phase 13.6 follow-up: section events, retryStep, helper consolidation

**Paste the block below at the start of the next session.**

---

We're continuing the rn-dev-cli daemon refactor. Context:

- Latest merged PR is [#29 `ff230b0`](https://github.com/utopyk/rn-dev-cli/pull/29) (2026-04-29): session/log routing + MCP-side e2e harness.
- An uncommitted bugfix batch sits on top in `~/Downloads/rn-dev-cli/`. Read the handoff before starting:
  - **[`docs/plans/2026-04-29-handoff-electron-quick-mode-bugfix-batch.md`](2026-04-29-handoff-electron-quick-mode-bugfix-batch.md)** — covers Android device detection, port-conflict handling, Electron auto-build parity, and the renderer layout fix. Section "Suggested commit slicing" lists 4 PRs to land that work.
- Original Phase-13.6 follow-up queue (dated, but most items still open): [`docs/plans/2026-04-26-next-session-prompt-phase-13-6-followup.md`](2026-04-26-next-session-prompt-phase-13-6-followup.md)

## This session — pick by time available

### Top priority: ship yesterday's bugfix batch

If yesterday's edits are still uncommitted, slice them into 4 PRs per the handoff's "Suggested commit slicing" before doing anything else. Each is independent and reviewable in isolation:

1. `fix(devices): label Android phones as physical and resolve friendly names via adb getprop` — `src/core/device.ts` + tests, ~80 LOC.
2. `fix(daemon): worktree-aware port handling with poll-until-free + lsof selector hardening` — `src/core/metro.ts` + `src/core/session/boot.ts`, ~120 LOC. PR description should call out the three independent root causes (race, wrong-PID-via-lsof OR-trap, no ownership check). Add a unit test exercising same/different-worktree branches with a mocked MetroManager.
3. `fix(electron): trigger auto-build for non-quick modes, mirroring TUI start-flow` — `src/app/auto-build.ts` (new) + `src/app/start-flow.ts` + `electron/ipc/{services,instance}.ts`, ~70 LOC. Companion to PR #25 in the same Phase-13.4-leftover category.
4. `fix(renderer): bound layout to viewport so log panel can't grow off-screen` — `renderer/App.css`, ~10 LOC.

The `.node-version` pin is also worth committing in PR 1 or 2 — `package.json#engines: ">=18.0.0"` undersells the real requirement (Vite 6 wants >= 22.12, jsdom test deps want >= 20.19).

Machine-specific edits to NOT commit unless the team agrees: `electron/main.ts:92` (acme-mobile-app fallback) and `tests/electron-smoke/real-boot.spec.ts` (PROJECT_ROOT + packageManager). Probably wants an env-var override pattern in a follow-up.

### Then: section events + `instance:retryStep` (P0 user-visible — top of queue)

This is item #2 in the [04-26 follow-up prompt](2026-04-26-next-session-prompt-phase-13-6-followup.md), still pending. Symptom in the Electron GUI: dev-space panel shows flat `[daemon] …` log lines instead of the section components (Preflight ✓, Watchman ✓, Metro ✓, etc.) with retry buttons. The renderer's [renderer/App.tsx:252-322](../../renderer/App.tsx:252) is fully wired for `instance:section:start|end` and the retry button calls `invoke('instance:retryStep', { instanceId, stepId })`, but no events ever arrive and `instance:retryStep` is a stub.

**Required pieces:**

- **Daemon side:** `bootSessionServices` ([src/core/session/boot.ts](../../src/core/session/boot.ts)) emits `session/section:start` / `session/section:end` events alongside the existing `session/log` lines. Step IDs likely match the existing comment block: `"preflight" | "lockfile-install" | "clean" | "watchman" | "port-check" | "simulator-boot" | "metro" | "devtools" | "builder"` — pick the canonical set and document.
- **Daemon side:** new `session/retryStep` action handled in [src/daemon/client-rpcs.ts](../../src/daemon/client-rpcs.ts). Body `{ stepId: <one of the above> }`. Supervisor exposes `retryStep(stepId)` driving individual sections against the *live* `SessionServices` (don't re-run the whole boot). Each step needs to be safely re-runnable in isolation — for example, a Metro retry shouldn't re-run preflight or rewire DevTools subscribers.
- **Client adapter:** `DaemonSession` already has a `lifecycle` adapter for `session/log` (PR #29). Add a `sections` adapter (or extend `lifecycle`) that fans `session/section:*` out as events.
- **Electron side:** `electron/ipc/services.ts::wireInstanceEvents` routes the new section events onto `instance:section:start|end`. `electron/ipc/instance.ts::instance:retryStep` replaces its current stub with `session.lifecycle.retryStep(stepId)` (or whatever the adapter call shape is).
- **Tests:** unit-test the supervisor's per-step retry; integration-test that retrying a single step doesn't tear down other sections.

Scope estimate: 200-400 LOC across daemon + supervisor + client adapter + electron IPC + tests.

### Helper consolidation (small, but do before sections work to avoid quadrupling)

PR #25's reviewer flagged: "a third attach site means folding attach + wire into one helper rather than triplicating". Yesterday's auto-build fix made that three sites (`startRealServices` and `instances:create` both call `attachDaemonSession + wireInstanceEvents + triggerBuildsIfNeeded`). The section-events work above will likely add a fourth attach point (instance restart? worktree switch?). Fold into one helper first.

Suggested signature: `attachAndWireInstance(profile: Profile, projectRoot: string, instance: InstanceState): Promise<DaemonSession>` returning the session, doing all three steps internally. Lives in `electron/ipc/services.ts` next to `attachDaemonSession`.

### Audit: dynamic-import-of-src in Electron

`electron/launcher.cjs` registers `tsx/cjs` which only handles CJS imports. Dynamic ESM imports (`await import('../../src/...js')`) go through Node's native ESM resolver which doesn't know about `.ts`. Yesterday's auto-build fix landed on this and switched to a static import. There's still one latent: [`electron/ipc/wizard.ts:86`](../../electron/ipc/wizard.ts:86) does `await import('../../src/core/tooling-detector.js')` — broken too, just hasn't been exercised. Either replace with a static import or register `tsx/esm` in the launcher.

### Other 04-26 follow-up items (still pending, lower priority)

Picking from [`2026-04-26-next-session-prompt-phase-13-6-followup.md`](2026-04-26-next-session-prompt-phase-13-6-followup.md):

- PR-E packaged-Electron daemon entry (~30 LOC) — `electron/daemon-connect.ts::resolveDaemonEntry` still throws under `app.isPackaged`.
- ModuleHostClient `client` → `sender` field rename (cosmetic, P1 carry-over).
- `tryIpcAction` helper to consolidate `src/mcp/tools.ts` boilerplate (~36 LOC saved).
- session/status auto-append layer placement debate (Architecture P1-1).
- Teardown-ordering test for SubscribeRegistry + SenderBindings (Architecture P1-3).
- `session/start` migration off legacy handler (Simplicity P0-3 carry-over).
- Pid-recycling defense + consumer-side socket validation (PR-B carry-overs).
- Audit-log lifecycle entries (PR-A + PR-B carry-overs).

## Pre-push verification standard (unchanged, enforced via CLAUDE.md)

Every renderer/electron change MUST pass three layers before push:

1. `bunx vitest run` — fast (~25s).
2. `bunx tsc --noEmit && bunx tsc --noEmit -p electron/tsconfig.json`.
3. `bunx playwright test` — slow (~50s, fake-boot mode).

For daemon-protocol PRs (anything touching boot.ts, supervisor, or wire shape), also run:

4. `REAL_BOOT_SMOKE=1 bunx playwright test tests/electron-smoke/real-boot.spec.ts` — needs a running iOS simulator + the configured RN target (acme-mobile-app on Martin's machine). This is the gate that PR-C's synthetic grid was missing; do not skip it for daemon work.

Pre-existing flake to ignore: `src/daemon/__tests__/registry.test.ts:395` daemon-pid race under concurrent test pressure. Passes 13/13 in isolation. File a fix or pin to serial execution if you have time.

## Baselines to match or improve on

- vitest: **1021 / 0** (1 known flake; not a regression)
- tsc root: **149** (pre-existing wizard `color`-on-TextProps; unchanged)
- tsc electron: **0**
- `bun run build`: green
- `bunx playwright test` (fake-boot): **10 passed + 2 skipped** (real-boot, by design)

## Branching

```sh
git checkout main
git pull
# then per-PR branches as listed above:
git checkout -b fix/devices-android-physical-friendly-names
# … etc
```

## Remember

- `bunx vitest run`, not `bun test` (bun test has issues with `vi.mock`).
- `bun run build` and `bun run typecheck` for production verification.
- `bunx playwright test` for fake-boot smoke before any merge.
- `REAL_BOOT_SMOKE=1` flips the smoke onto a real Metro spawn against the configured RN target.
- `RN_DEV_HOSTCALL_BIND_GATE` is default-on. `=0` is the emergency off-switch.
- `connectToDaemonSession` auto-appends `session/status` to caller-supplied `kinds`.
- The daemon's session refcount is held by the long-lived subscribe socket. Tests that expect daemon teardown on a single client's release should structure around that.
- macOS `lsof` OR's selectors by default — always pass `-a` to AND. Bit yesterday's port-handling fix; documented in project memory.
- Electron's `tsx/cjs` register doesn't intercept dynamic ESM imports. Use static imports of `src/*.js` from `electron/*` files unless you've registered an ESM hook too.
