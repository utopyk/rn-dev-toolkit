---
title: Next-session prompt — Real e2e tests + fix broken behaviour before H3
type: handoff
status: active
date: 2026-05-04
plan: docs/plans/2026-04-30-feat-hook-system-plan.md
predecessor: docs/plans/2026-05-04-next-session-prompt-h1-pr-open.md
---

# Next-session prompt — Real e2e tests + fix broken behaviour before H3

H1 + H2 landed locally (35 commits on `claude/zen-nash-73c0a1`,
3-layer gate green: 1297 vitest + 0/150 tsc + 12/12 REAL_BOOT_SMOKE).
**Manual verification against the real acme-mobile-app surfaced
multiple broken behaviours that the green pipeline missed.** This
session does NOT continue with H3. It inserts a middle phase:

1. **Repro the acme breakage** with the new daemon-stderr capture
   already in place (commit `dc99957`).
2. **Build real e2e test coverage** that exercises the FULL stack
   the way a user does — not the wire shapes in isolation, the
   actual long-running session UX.
3. **Fix every broken behaviour** below in its own commit, with the
   new e2e test as the regression gate.
4. **Then** plan H3 against `docs/plans/2026-04-30-feat-hook-system-plan.md` §H3.

Copy-paste the section below into a fresh Claude Code session.

---

## Self-contained prompt for next session

You are continuing the rn-dev-cli hook system. **H1 + H2 are landed
locally on `claude/zen-nash-73c0a1` (35 commits ahead of origin/main,
not pushed)**. Worktree:
`/Users/martincouso/Downloads/rn-dev-cli/.claude/worktrees/h1-handoff`.

The 3-layer test pipeline is green but **manual verification against
acme-mobile-app revealed the app is not actually usable in the
real-user flow**. This session pivots from "continue with H3" to
"build real e2e tests + fix what's broken before adding more".

### Where to start

1. **Read these in order:**
   - `memory/h2_followup_real_e2e_needed.md` — full bug list, why the
     test pipeline missed it, what to do about it.
   - `memory/h2_complete.md` — H2 ledger, what landed in the
     `build` built-in module + builder/build hook firing.
   - `memory/h1_complete.md` — H1 ledger.
   - `memory/test_strategy_gap.md` — the H1-era observation that
     synthetic tests miss daemon-protocol regressions.
   - `memory/workflow_local_only_personal_account.md` — this account
     does NOT push or open PRs.
   - The H1+H2 commits: `git log --oneline origin/main..HEAD | head -36`
     (start at `dc99957` — the daemon stderr capture — which is what
     the next repro depends on).

2. **Use the existing worktree at `.claude/worktrees/h1-handoff`** —
   clean at session end. `bun install` is current. `renderer/bun.lock`
   is gitignored.

### Step 1 — Repro the acme disconnect with the new diagnostic primitive

Commit `dc99957` redirects daemon stdout + stderr to
`~/.rn-dev/logs/daemon-<basename>-<iso-ts>.log`. Pre-fix, both were
discarded. So the next repro lands a real crash trace on disk.

```bash
# 1. Make sure no stale daemon is around for acme
pkill -f "src/index.tsx daemon /Users/martincouso/Documents/GitHub/acme" 2>&1
rm -f /Users/martincouso/Documents/GitHub/acme-mobile-app/.rn-dev/sock \
      /Users/martincouso/Documents/GitHub/acme-mobile-app/.rn-dev/pid

# 2. Start dev:gui pointed at acme
cd /Users/martincouso/Downloads/rn-dev-cli/.claude/worktrees/h1-handoff
RN_DEV_PROJECT_ROOT=/Users/martincouso/Documents/GitHub/acme-mobile-app \
  npm run dev:gui > /tmp/devgui.log 2>&1 &

# 3. In the Electron window: pick the user's profile
#    `/Users/martincouso/Documents/GitHub/acme-mobile-app/.rn-dev/profiles/profile-1777926131792.json`
#    Wait until "Daemon disconnected (metro): unknown" surfaces.

# 4. Read the daemon log — this is the crash trace pre-fix would have lost.
ls -t ~/.rn-dev/logs/daemon-acme-mobile-app-*.log | head -1 | xargs cat
```

The daemon stderr will reveal what actually killed it. **Bisect on
`origin/main` only if the trace is ambiguous about whether H1/H2
introduced the crash.**

### Step 2 — Bug list to investigate + fix

Each bug below should land as its own commit with a regression test
under `tests/electron-smoke/` or `src/**/__tests__/`. Order roughly
by blast radius.

#### Bug A — Daemon disconnect mid-session (root cause unknown)
- Symptom: renderer surfaces `⚠ Daemon disconnected (metro): unknown`
  shortly after `[daemon] ✔ All services started`.
- Stack on the Electron side:
  ```
  Error: subscribe.send: connection already closed
    at <anonymous> (src/core/ipc.ts:332)
    ... at MetroClient.reload (src/app/client/metro-adapter.ts:39)
    ... at electron/ipc/metro.ts:23
  ```
- Suspected cause: daemon process death; need the captured log.
- Fix: depends on the captured trace.
- Regression test: e2e that boots dev:gui against a fixture, picks a
  profile, waits 60+ seconds, asserts NO `subscribe.send: connection
  already closed` shows up in any log surface and the daemon process
  is still alive.

#### Bug B — DevTools tab cannot recover from disconnect (regression)
- Symptom: after Bug A, the DevTools tab shows "DevTools unavailable
  / Cannot restart DevTools proxy for Metro on port 8081". Pressing
  the **Retry button removes the panel entirely** and prints
  "DevTools unavailable" in the output area.
- Code path: `renderer/views/DevToolsView.tsx` (Retry handler) +
  `src/app/client/devtools-adapter.ts` + `electron/ipc/devtools.ts`.
- Suspected cause: Retry tries to reuse a torn-down session
  reference; the daemon-client doesn't auto-reconnect after the
  subscribe socket dies.
- Fix: either auto-reconnect the daemon-client on socket close, or
  make Retry trigger a fresh `connectToDaemonSession`.
- Regression test: e2e that simulates a daemon restart, then clicks
  DevTools Retry, asserts the panel reappears + works.

#### Bug C — Output panel growing unboundedly (regression)
- Symptom: a previous fix for the output panel growing unboundedly
  (per user report) appears to have rotted.
- Investigation start: `git log --all --grep="growing\|unbounded\|truncate\|cap\|trim" -- renderer/components/LogPanel.tsx renderer/components/CollapsibleLog.tsx renderer/views/MetroLogs.tsx` to find the prior fix's commit; diff against current state.
- Fix: re-apply the bound (likely a max-line cap on the in-memory log buffer).
- Regression test: e2e or vitest that pushes N lines through the
  panel, asserts displayed line count is capped.

#### Bug D — `bootDevice` runs `xcrun simctl boot` against physical iPhones
- Symptom: log shows "⏳ Booting simulator Martin Couso's iPhone 15..."
  even though the profile's `devices.ios` is a physical UDID
  (`00008130-001A653A3E11001C`).
- Code: `src/core/device.ts:240` — `bootDevice` does NOT branch on
  `device.isPhysical`. Runs `xcrun simctl boot <id>` for any `device.type === "ios"`.
- Fix: add at the top of `bootDevice`:
  ```ts
  if (device.isPhysical) return true; // physical devices connect via USB; nothing to boot
  ```
- Regression test: vitest unit test that mocks a `Device` with
  `isPhysical: true` and asserts `bootDevice` returns `true` without
  spawning anything.

#### Bug E — Tab-close UX trap
- Symptom: clicking the close X on a tab "doesn't work" — actually a
  two-click confirm pattern at
  `renderer/components/InstanceTabs.tsx:40-51`. First click changes
  the X to `?` and shows a tooltip "Stop Metro on :PORT?"; second
  click within 3s actually closes.
- Fix options (pick one): louder visual change (full-tab tinting,
  animated pulse), persistent affordance until dismissed, or
  shift-click for instant close (with the confirm flow as default).
- Regression test: vitest playwright on the renderer that asserts
  the close affordance is discoverable (some explicit text or visual
  guidance the test can match).

#### Bug F — Stale test-fixture daemons accumulate
- Symptom: `pgrep -fl "src/index.tsx daemon"` after a few test runs
  shows multiple `bun run ... daemon /var/folders/.../rn-dev-version-handshake-*` processes.
- Fix: `test/helpers/spawnTestDaemon.ts`'s `cleanup` should reliably
  kill the spawned daemon. Audit existing usages — the `afterEach`
  `await h.stop()` should already do this; investigate why some
  escape.
- Regression test: vitest that asserts no leftover daemon processes
  after the suite tears down.

### Step 3 — Build a real-e2e test layer

Today's `REAL_BOOT_SMOKE` proves "Electron mounts + renders tabs +
shortcuts dispatch RPCs" — short-lived (≈3s per test), no UI
interaction, no long-running session assertions. The new layer
should:

- Live alongside `tests/electron-smoke/` (probably
  `tests/electron-real-e2e/` to avoid mixing with the existing
  smoke).
- Drive the renderer UI via Playwright clicks (not just assert
  content).
- Use a fixture project with a real (or simulated) Metro target
  reachable.
- Run sessions for **30+ seconds** with periodic activity (push N
  log lines through the panel, click reload, click DevTools, etc.).
- Assert no `subscribe.send: connection already closed` in any log.
- Assert daemon process is alive at end of session.
- Assert output panel line count is bounded.
- Assert DevTools recovery works after a forced daemon restart.

The H1-era memory entry `test_strategy_gap.md` already documented
that synthetic tests miss daemon-protocol regressions — the same
class of gap is biting now at the renderer-UI layer. The right
mental model: **every behaviour that ships should have a test that
fails when that behaviour breaks.** The current pipeline doesn't
satisfy that for the bugs above.

### Step 4 — Run the gate

After fixes, the gate is:

```bash
npx vitest run                                    # expect 1297+ baseline
npx tsc --noEmit                                  # expect 150 errors (baseline)
npx tsc --noEmit -p electron/tsconfig.json        # expect 0 errors
REAL_BOOT_SMOKE=1 \
  RN_DEV_REAL_BOOT_TARGET=/Users/martincouso/Documents/GitHub/acme-mobile-app \
  RN_DEV_REAL_BOOT_PACKAGE_MANAGER=pnpm \
  npx playwright test                             # expect 12/12
# NEW: the real-e2e suite
npx playwright test --config tests/electron-real-e2e/playwright.config.ts
# (or however the new suite is configured)
```

### Step 5 — Plan H3

Only after Steps 1-4 are green. Use the same a–k sub-phase pattern
H1+H2 used. Update `memory/MEMORY.md` with the new entry.

### What NOT to do this session

- Do NOT continue with H3 until the bugs above are fixed + covered.
- Do NOT push. Do NOT open a PR. Do NOT run any
  `/acme-reviewer:*` skill that posts to GitHub. This account is
  local-only per `memory/workflow_local_only_personal_account.md`.
- Do NOT add features. The middle phase is fix + cover, not extend.
- Do NOT delete the H2 commits or the `dc99957` daemon-stderr
  capture commit. They're load-bearing.

### Watch out for (lessons to carry forward)

- **Test pipelines that prove wire shapes are not the same as
  pipelines that prove product behaviour.** The 1297 vitest +
  REAL_BOOT_SMOKE pipeline gave a green light while the app failed
  on first real use. This is a test-strategy gap, not a bug count
  problem. Adding 100 more vitest cases in the same style won't
  close it; only e2e against the actual UI lifecycle will.
- **Daemon stderr was discarded for 13+ phases.** Diagnostics
  primitives are easy to defer and brutal to debug without. When
  you ship a long-lived subprocess, ship its log capture in the
  same commit.
- **Two-click confirm patterns need visual reinforcement.** The
  Stop-Metro confirm tooltip exists but users still report "the
  close didn't work". The discoverability bar is higher than "show
  a tooltip somewhere".
- **`isPhysical` is a real distinction in `Device` — code that
  spawns simulator commands needs to branch on it.** `bootDevice`
  is one offender; audit other simctl call sites in the same pass.

Today is 2026-05-04.

---

## Notes for the resumer

- **Branch state:** `claude/zen-nash-73c0a1` is 35 commits ahead of
  `origin/main`. Not pushed.
- **Worktree:** `.claude/worktrees/h1-handoff` clean at session end.
- **The diagnostic primitive (commit `dc99957`) is what unblocks
  Bug A.** Pre-fix repro produces no daemon log; post-fix repro
  produces `~/.rn-dev/logs/daemon-<wt>-<ts>.log` with the actual
  crash trace.
- **The acme user profile** is at
  `/Users/martincouso/Documents/GitHub/acme-mobile-app/.rn-dev/profiles/profile-1777926131792.json`,
  points at physical iPhone UDID `00008130-001A653A3E11001C`, branch
  `feat/camera-mode-memory`, port 8081, pnpm.
- **The previous next-session prompt**
  (`docs/plans/2026-05-04-next-session-prompt-h1-pr-open.md`) is for
  the work-account push flow; on this account it doesn't apply.
