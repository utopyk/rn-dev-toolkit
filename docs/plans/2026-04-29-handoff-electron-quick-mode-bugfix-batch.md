# Handoff — Electron quick/dirty mode bugfix batch (Phase 13.6 follow-up)

**Date:** 2026-04-29
**Predecessor:** [PR #29](https://github.com/utopyk/rn-dev-cli/pull/29) merged as [`ff230b0`](https://github.com/utopyk/rn-dev-cli/commit/ff230b0) (2026-04-29 12:07 UTC)
**Branch state:** uncommitted local edits in `~/Downloads/rn-dev-cli/`. Ready to slice into ~4 PRs (see "Suggested commit slicing").
**Next-session prompt:** [`2026-04-29-next-session-prompt-electron-followup.md`](2026-04-29-next-session-prompt-electron-followup.md)

---

## Context

This was the first real Electron-GUI usage session on a fresh MacBook with the user's actual RN project (`acme-mobile-app`), running against a connected Android phone (Samsung Galaxy S23 FE, serial `R5CX23WBLKE`). Several user-facing issues surfaced that the synthetic test grid couldn't have caught — same category as PR [#25](https://github.com/utopyk/rn-dev-cli/pull/25)'s Phase-13.4 migration leftovers, plus a few new ones specific to real-world usage patterns.

All four fixes below are independent and reviewable in isolation.

---

## What shipped this session (uncommitted)

### 1. Android device detection — `parseAdbDevices` ownership + friendly names

**Bug:** Connected Android phones appeared in the wizard's device step as `💻 R5CX23WBLKE Simulator` — mislabeled (`isPhysical` defaulted to `false`) and unidentifiable (raw serial used as `name`). Users assumed Android wasn't being detected at all. Backend log showed `[ipc] Found 1 devices` but the renderer's UX made the phone unrecognizable.

**Files:**
- [src/core/device.ts](../../src/core/device.ts) — `parseAdbDevices` now sets `isPhysical: !serial.startsWith("emulator-")`. Added `enrichAndroidNames(devices)` that fans out per-device `adb -s <serial> shell getprop ro.product.marketname` (Samsung-friendly), with `manufacturer + model` fallback for physical and `adb emu avd name` for emulators. Wired into `listDevices`.
- [src/core/__tests__/device.test.ts](../../src/core/__tests__/device.test.ts) — added test pinning `isPhysical` resolution from serial prefix; updated existing fixtures to assert the new field.

**Verification:** Live `listDevices('android')` against the connected phone returns `{id: "R5CX23WBLKE", name: "Samsung SM-S711W", type: "android", status: "available", isPhysical: true}`. Wizard now shows `📱 Samsung SM-S711W   Device`.

### 2. Port-conflict handling — ownership-aware kill, poll-until-free, fallback port

**Bug:** Quick-mode boot failed with `EADDRINUSE: address already in use :::8081` against the user's existing `npm start` Metro. Three independent issues conspired:

1. **`killProcessOnPort` → 1s sleep → continue** was racy. RN CLI's graceful-shutdown handler holds the socket 2–5s after SIGTERM. The fixed sleep raced the grace window and Metro's `earlyPortCheck` then bound EADDRINUSE.
2. **`findProcessOnPort` matched any socket on the port**, including our own outbound HTTP probe from `isMetroOnPort`. `parseInt(stdout)` picked the wrong PID — the daemon's outbound, not the listener — so the cwd comparison compared against ourselves and falsely reported "different worktree".
3. **No worktree-ownership check.** Old behaviour killed any Metro on the port, even one belonging to a sibling branch. Different worktrees should fall back to a different port, not stomp each other.
4. **lsof selectors OR'd by default on macOS** (`-p PID -d cwd` returned every process's cwd, not PID's). Both `getProcessCwd` and the fixed `findProcessOnPort` now pass `-a`. Documented in `docs/plans/2026-04-29-handoff-electron-quick-mode-bugfix-batch.md` (this file) and project memory.

**Files:**
- [src/core/metro.ts](../../src/core/metro.ts) — `killProcessOnPort(port, signal)` accepts signal; new `waitForPortFree(port, timeoutMs, pollMs)`, `isMetroOnPort(port)` (HTTP `/status` probe), `getProcessCwd(pid)` (lsof `-a -p PID -d cwd -Fn`), `findFreePortInRange(min, max)` (probes each port via `isPortFree`, no artifact persistence), and a `portRangeReadable` getter. `findProcessOnPort` rewritten with `lsof -a -nP -iTCP:PORT -sTCP:LISTEN -t` so only the listener is matched.
- [src/core/session/boot.ts](../../src/core/session/boot.ts) — step 5 reorganised:
  - port free → continue
  - busy + non-Metro → throw with clear remediation
  - busy + Metro + same cwd → SIGTERM → `waitForPortFree(5s)` → SIGKILL → `waitForPortFree(3s)` → throw
  - busy + Metro + different cwd → `findFreePortInRange`, persist new port to artifact, continue with new port
  - One diagnostic emit retained: `holder pid=… cwd=… sameWorktree=…` so future port-conflict regressions surface the inputs to the decision in one line.

**Verification (live):** With user's `npm start` Metro on 8081 (PID 97039) + dirty profile + cold-spawn → daemon detected port busy, `isMetroOnPort` true, `getProcessCwd` returned the acme path, `sameWorktree` true → SIGTERM → poll-until-free → daemon's Metro spawned on 8081 (PID 63228). Mock-Metro test reproduced the same path under dirty mode (mock exited with code 143 = SIGTERM).

### 3. Auto-build trigger for Electron — parity with TUI start-flow

**Bug:** Dirty / clean / ultra-clean modes silently skipped the build under Electron. The TUI's [src/app/start-flow.ts](../../src/app/start-flow.ts) had `triggerBuildsIfNeeded(session, profile, projectRoot)` that fired a `builder/build` for non-quick modes; the Electron entrypoint at `electron/ipc/services.ts::startRealServices` (and the wizard-path attach in `electron/ipc/instance.ts::instances:create`) never called it. Symptom: Metro started, log lines flowed, but `react-native run-android` / `run-ios` never spawned. Pre-existing Phase 13.4 migration leftover, same category as PR #25's `wireInstanceEvents` fix.

**Files:**
- [src/app/auto-build.ts](../../src/app/auto-build.ts) (new) — extracted `triggerBuildsIfNeeded` here. **Critical:** it had to live in a leaf module with no React/Ink imports, otherwise pulling it into the Electron tsconfig graph would surface ~150 pre-existing wizard type errors. The TUI start-flow re-exports for backwards-compat.
- [src/app/start-flow.ts](../../src/app/start-flow.ts) — replaced inline definition with `import { triggerBuildsIfNeeded } from "./auto-build.js"; export { triggerBuildsIfNeeded };`.
- [electron/ipc/services.ts](../../electron/ipc/services.ts) — calls `triggerBuildsIfNeeded(session, defaultProfile, targetProjectRoot)` after `wireInstanceEvents`. **Static import** at the top of the file, NOT dynamic — see "Dynamic import gotcha" below.
- [electron/ipc/instance.ts](../../electron/ipc/instance.ts) — `instances:create` calls the same after `wireInstanceEvents`.

**Dynamic import gotcha:** Initial fix used `await import('../../src/app/auto-build.js')` (mirroring the existing `wizard.ts` pattern). It failed with `ERR_MODULE_NOT_FOUND` at runtime. Root cause: `electron/launcher.cjs` registers `tsx/cjs` which only intercepts `require()`, not dynamic ESM imports. Static imports get rewritten as `require()` by tsx-cjs and work; dynamic imports go through Node's ESM resolver which has no `.ts` awareness. **Audit-target:** the existing `await import('../../src/core/tooling-detector.js')` in [electron/ipc/wizard.ts:86](../../electron/ipc/wizard.ts:86) is broken too — it just hasn't been exercised in practice.

**Verification (live):** Cold-spawn dev:gui in dirty mode against acme-mobile-app. Tool-output panel showed `Building for android...` followed by `react-native run-android --port 8081 --verbose --deviceId R5CX23WBLKE`, and Gradle began compiling.

### 4. Renderer layout — log panel grew infinitely past viewport

**Bug:** Tool-output panel had no bounded height; long log streams (preflight + watchman + Metro start + Gradle) made the panel grow off-screen, pushing the Metro-output panel out of view. Both panels' internal `.panel-content` had `overflow-y: auto` correctly, but the parent flex chain didn't constrain heights, so the inner scroll containers never engaged.

**Files:**
- [renderer/App.css](../../renderer/App.css) — `.app-root` switched from `min-height: 100vh` to `height: 100vh` (hard viewport constraint). `.app-main` got `min-height: 0` (grid items default to `min-height: auto` which floors at content-size and cancels every `min-height: 0` further down the tree).

**Verification:** Vite HMR picked up both edits live (`hmr update /App.css`). User confirmed the window looks correct now.

### 5. Real-boot smoke target — acme-mobile-app

**Files:**
- [electron/main.ts:92](../../electron/main.ts:92) — fallback project root changed from `/Users/martincouso/Documents/Projects/movie-nights-club` to `/Users/martincouso/Documents/GitHub/acme-mobile-app`.
- [tests/electron-smoke/real-boot.spec.ts](../../tests/electron-smoke/real-boot.spec.ts) — `PROJECT_ROOT`, `packageManager` (npm → pnpm to match acme-mobile-app's `packageManager` field), and comments updated.

**Note:** These are machine-specific edits and probably should NOT be committed unless the team agrees `acme-mobile-app` is the canonical real-boot target. Likely candidate for an env-var override pattern in a follow-up.

### 6. Node version pin

**Files:**
- [.node-version](../../.node-version) (new) — pinned to `22.17.0`. Vite 6 wants `>= 22.12`; jsdom test deps want `>= 20.19`. The package.json `engines: ">=18"` undersells the real requirement and any machine using nodenv with < 22.12 will silently break Vite + flake jsdom tests.

---

## Bugs surfaced and NOT fixed (the queue)

### A. Section components / `instance:retryStep` (P0 — known queued)

User noted: "what I see right now is just the logs, not the step components, so the retry button is not only just a stub, it's not even visible". Confirmed: daemon emits all boot progress as flat `session/log` lines instead of structured section events. Renderer's [renderer/App.tsx:252-322](../../renderer/App.tsx:252) listens for `instance:section:start|end` and has retry buttons calling `instance:retryStep`, but no events ever arrive and `instance:retryStep` is a stub returning `"Step retry … not wired to the daemon yet"`.

**Already documented** as item #2 (P0 user-visible) in [`2026-04-26-next-session-prompt-phase-13-6-followup.md`](2026-04-26-next-session-prompt-phase-13-6-followup.md). Scope: ~200-400 LOC across daemon supervisor (track sections + `retryStep(stepId)` driving individual sections against live `SessionServices`), `bootSessionServices` (emit `session/section:start|end`), client adapter (route to `instance:section:start|end`), Electron handler (replace stub with real RPC call). Deferred from Phase 13.5; still pending. **Top priority for the next session.**

### B. Wizard saves `worktree: <projectRoot>` for "Default (root)"

When the wizard's worktree step picks "Default (root)", the saved profile gets `worktree: "/Users/martincouso/Documents/GitHub/acme-mobile-app"` instead of `worktree: null`. The boot lookup uses `profileStore.findDefault(null, branch)` which strict-compares `p.worktree === worktree`, so the saved profile doesn't match and the daemon falls back to the wizard. Worked around in this session by hand-editing the profile JSON. Not fixed in code.

**Where:** [renderer/views/Wizard.tsx:214](../../renderer/views/Wizard.tsx:214) does `worktree: state.worktree?.path ?? null` — the issue is that picking "Default (root)" sets `state.worktree.path` to the project root rather than null. Either the wizard's worktree step needs a sentinel for "main repo" (= null), or `findDefault` needs to normalise main-repo equivalence.

### C. Per-worktree port allocation is bypassed

`MetroManager.allocatePort(worktreeKey)` exists and is per-worktree-aware (artifact-backed). The wizard hardcodes `metroPort: 8081` in every saved profile, and `boot.ts` uses `profile.metroPort` directly, bypassing `allocatePort`. Two worktrees from the same wizard always fight over 8081 unless one of them was previously booted (artifact remembers its port). The fallback I added in step 5 (different worktree → `findFreePortInRange`) papers over this at boot time, but the upstream fix is to either drop `profile.metroPort` (always allocate) or treat it as a hint and route through `allocatePort`.

### D. Helper consolidation — attach + wire + trigger

PR #25's reviewer flagged: "a third attach site means folding attach + wire into one helper rather than triplicating". I just made it three sites:
- `electron/ipc/services.ts::startRealServices`: `attachDaemonSession` + `wireInstanceEvents` + `triggerBuildsIfNeeded`
- `electron/ipc/instance.ts::instances:create`: same trio

Should fold into a single `attachAndWireInstance(profile, projectRoot, instance)` helper. Cosmetic but worth doing before the section/retryStep work duplicates the call pattern a fourth time.

### E. Dynamic-import-of-src/* in Electron is broken

`electron/ipc/wizard.ts:86` does `await import('../../src/core/tooling-detector.js')`. tsx/cjs only registers a CJS hook; dynamic ESM imports go through Node's vanilla ESM resolver which can't find `.ts` files for `.js` specifiers. This hasn't fired in practice (the wizard's tooling step might not exercise it on every run), but it's a latent bug. Either replace with a static import, or register a tsx ESM hook (`tsx/esm`) in `electron/launcher.cjs`.

### F. Stale `~/Downloads/Xcode.app`

User has Xcode 26.4.1 properly installed at `/Applications/Xcode.app`. A second copy (Xcode 26.2, 3.7GB) sits in `~/Downloads/Xcode.app` — probably a half-finished install that grabbed the `xcode-select` symlink. Re-pointed `xcode-select` at `/Applications/Xcode.app/Contents/Developer` early in the session. The Downloads copy is safe to delete; not done because it's outside the project scope.

### G. Standalone CLT mismatch (brew is blocked)

Standalone CLT package at `/Library/Developer/CommandLineTools` is at 16.2.0; brew on macOS 26.4 wants 26.x. Worked around by installing bun via `npm install -g bun` (uses precompiled binary, no compilation). To unblock brew: `sudo softwareupdate -i "Command Line Tools for Xcode 26.4-26.4.1"` (~920MB).

### H. Android product flavors break the build (acme blocker, P0)

Live repro against acme-mobile-app: the Electron auto-build fires `npx react-native run-android --port 8081 --verbose --deviceId R5CX23WBLKE`, which RN CLI translates to `./gradlew app:installDebug -x lint -PreactNativeDevServerPort=8081`. Gradle rejects it:

> Cannot locate tasks that match 'app:installDebug' as task 'installDebug' is ambiguous in project ':app'. Candidates are: 'installBetaDebug', 'installBetaDebugAndroidTest', 'installBetaDebugOptimized', 'installProductionDebug', 'installProductionDebugAndroidTest', 'installProductionDebugOptimized'.

acme's `android/app/build.gradle` defines two product flavors (`beta` and `production`) and the unflavored `installDebug` task no longer exists. RN CLI 0.72+ supports `--mode <flavor><Variant>` (e.g. `--mode betaDebug`) to disambiguate, but [src/core/builder.ts:82-100](../../src/core/builder.ts:82) only emits `--port`, `--verbose`, `--deviceId`, and `--variant release` — never `--mode`.

**Scope of the fix:**
1. Add an optional `androidFlavor: string | null` (or generic `mode: string | null`) to the `Profile` shape in [src/core/types.ts](../../src/core/types.ts).
2. Thread it through `BuildOptions` in [src/core/builder.ts:26](../../src/core/builder.ts:26) and append `--mode ${flavor}${variant}` (where variant is `Debug` or `Release`) when set. RN CLI honors `--mode` directly.
3. Auto-detect candidate flavors at wizard time by parsing `android/app/build.gradle` (or the simpler `gradlew :app:tasks --all`) and offering them as a step. If only one flavor exists, prefill it; if none, leave the field unset (current behaviour).
4. iOS scheme has the equivalent gap — `--scheme <name>` for projects with multiple schemes. Worth pairing in the same change.

**This couples directly to the acme-dev-cli research deliverable** ([../brainstorms/2026-04-29-acme-dev-cli-research.md](../brainstorms/2026-04-29-acme-dev-cli-research.md), in flight) — the broader question is whether build-step customisation should be (a) profile fields like the above, (b) per-project hooks the consumer ships in their repo (e.g. `rn-dev.config.ts` with a `buildArgs(platform, profile)` callback), or (c) both. The research doc's section 6 covers this. The minimum viable fix to unblock acme is the profile-field path; the longer-term flexibility story is the hook path.

### I. Wizard layout regression from PR #4 (fixed in this session)

The PR #4 fix to bound `.app-root` to `height: 100vh` exposed a flexbox-centering-overflow trap in [renderer/views/Wizard.css:2-12](../../renderer/views/Wizard.css:2). `.wizard-root` was using `display: flex; align-items: center; justify-content: center; overflow-y: auto` — a known browser quirk where, when the centered child grows past the container, it overflows *above* the visible area and the user can't scroll up to reach it. Pre-fix this didn't surface because `.app-root` could grow with the page; post-fix the wizard root has a hard ceiling and centred-overflow becomes user-visible. The branch-selection step was the canary — repos with many branches looked "endless" because the top of the list was inaccessible.

Fix on the `fix/renderer-bounded-layout` branch: switch `.wizard-root` to `flex-direction: column; align-items: center` (no `justify-content: center`), pinning the wizard to the top of the scroll region while preserving horizontal centering. Comment in the CSS explains the trap so the next person doesn't re-introduce it.

---

## Verification (post-fixes)

| Layer | Result | Baseline | Notes |
|---|---|---|---|
| `bunx vitest run` | 1021 / 1 flake | 1021 / 0 | Flake is `src/daemon/__tests__/registry.test.ts:395` daemon-pid race; passes 13/13 in isolation; pre-existing |
| `bunx tsc --noEmit -p electron/tsconfig.json` | 0 | 0 | clean |
| `bunx tsc --noEmit` (root) | 149 | 149 | pre-existing wizard `color` props on Ink TextProps; unchanged |
| `bun run build` | green | green | full bundle + tree-sitter wasm copies |
| Live: dirty-mode boot against running external Metro | ✅ | n/a | mock-Metro on 8081 + cold-spawn → SIGTERM mock → daemon Metro on 8081 |
| Live: clean dirty-mode boot, port free | ✅ | n/a | daemon's Metro on 8081, build kicked off, Gradle building |
| Real-boot smoke (`REAL_BOOT_SMOKE=1`) | not run | n/a | not exercised this session; would now target acme-mobile-app per the spec edit |

---

## Suggested commit slicing

Each fix is independent. Recommended PRs:

1. **`fix(devices): label Android phones as physical and resolve friendly names via adb getprop`** — `src/core/device.ts` + `src/core/__tests__/device.test.ts`. ~80 LOC. Trivial review.
2. **`fix(daemon): worktree-aware port handling with poll-until-free + lsof selector hardening`** — `src/core/metro.ts` + `src/core/session/boot.ts`. ~120 LOC. The chunkiest fix; deserves its own PR description explaining the three independent root causes (race, wrong PID via lsof OR-trap, no ownership check). Worth adding a unit test that mocks `MetroManager` and exercises the same/different-worktree branches.
3. **`fix(electron): trigger auto-build for non-quick modes, mirroring TUI start-flow`** — `src/app/auto-build.ts` (new), `src/app/start-flow.ts`, `electron/ipc/services.ts`, `electron/ipc/instance.ts`. ~70 LOC. Note in PR description: companion to PR #25's `wireInstanceEvents` fix; same Phase 13.4 leftover category. Flag the helper consolidation as queued (item D above).
4. **`fix(renderer): bound layout to viewport so log panel can't grow off-screen`** — `renderer/App.css`. ~10 LOC. Trivial.

Skip from this batch (machine-specific): `electron/main.ts:92`, `tests/electron-smoke/real-boot.spec.ts`. Either keep local or land them once the team agrees on a canonical real-boot target. `.node-version` is worth committing — it documents a real Node-version requirement that `engines` doesn't capture.

---

## What I did this session

1. Cloned the repo properly (was working off a zip extract before)
2. Diagnosed and fixed the Xcode CLT misconfiguration (`xcode-select` was pointing at `~/Downloads/Xcode.app`)
3. Installed bun under nodenv (Node 20.18.0 + Node 22.17.0; vitest's global setup shells out to `bun`)
4. Pinned project Node to 22.17.0 (Vite needs >= 22.12)
5. Got the test grid green: vitest 1021/1021, tsc electron 0, tsc root 149, playwright 10+2 skipped
6. Ran dev:gui against the connected Android phone; surfaced bugs A through G
7. Fixed bugs 1-5 above (device detection, port handling, auto-build, layout, smoke target)
8. Wrote this handoff + the next-session prompt
9. Saved learnings to project memory at `~/.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/` — particularly the lsof OR-trap, which is the kind of thing that bites again

---

## References

- Predecessor PR: [#29 `ff230b0`](https://github.com/utopyk/rn-dev-cli/pull/29) (session/log routing + MCP-side e2e harness)
- 04-26 follow-up prompt that listed `instance:retryStep` as P0: [`2026-04-26-next-session-prompt-phase-13-6-followup.md`](2026-04-26-next-session-prompt-phase-13-6-followup.md)
- 04-26 handoff that called out PR-C real-boot regression: [`2026-04-26-handoff-phase-13-6-pr-c-and-test-gap.md`](2026-04-26-handoff-phase-13-6-pr-c-and-test-gap.md)
- Original module-system plan: [`2026-04-21-feat-module-system-and-device-control-plan.md`](2026-04-21-feat-module-system-and-device-control-plan.md)
- Modes UX description: [`renderer/views/Wizard.tsx:58-63`](../../renderer/views/Wizard.tsx:58)
- Builder logic (manual `react-native run-*` spawn): [`src/core/builder.ts`](../../src/core/builder.ts)
