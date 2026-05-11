---
title: Next-session prompt — Hook system Phase H3
type: handoff
status: active
date: 2026-05-06
plan: docs/plans/2026-04-30-feat-hook-system-plan.md
predecessor: docs/plans/2026-05-05-next-session-prompt.md
---

# Next-session prompt — Hook System Phase H3

H1 + H2 + the middle phase + the real-acme fixes + the build-bundle
discovery + wizard scheme picker have all landed locally on `main`
(69 commits ahead of `origin/main`, not pushed). The probe-real-build
spec passed cleanly in 6.4 minutes today (2026-05-06) — full chain
Electron → daemon → Metro → xcodebuild → Acme.app installed → JS
bundle requested. **Step 1 of the previous handoff is green.** Step 2
(build/discover-bundles + wizard) landed in commit `2582679`.

This session's job is **Phase H3 — Wrap CleanManager / MetroManager /
DevToolsManager / PreflightEngine as built-in modules.**

Copy-paste the section below into a fresh Claude Code session.

---

## Self-contained prompt for next session

You are continuing the rn-dev-cli hook system work on the unified
`main` branch (69 commits ahead of `origin/main`, not pushed). All
sibling branches were consolidated; do **not** create new branches or
worktrees. Work in the repo root per
[memory/single_branch_single_worktree.md](memory/single_branch_single_worktree.md).

The user is `dev@example.com` (this is the personal account —
never push, never open PRs, never run acme-reviewer chains; see
[memory/workflow_local_only_personal_account.md](memory/workflow_local_only_personal_account.md)).

### Where to start

1. **Read these in order:**
   - `memory/MEMORY.md` (already loaded into context).
   - `memory/real_acme_verification_complete.md` — the live build
     chain works against the user's iPhone 15.
   - `memory/h2_complete.md` + `memory/h1_complete.md` — H1 + H2
     ledger; `provides.hooks` slot pattern, capability factory
     pattern, audit-log integration.
   - `memory/2026_05_06_post_consolidation_install_drift.md` — run
     `bun install` + rebuild `packages/*/dist` BEFORE running any
     real-e2e probe. Stale workspace dist will silently mask
     `HookErrorCode` and similar at runtime.
   - The plan: `docs/plans/2026-04-30-feat-hook-system-plan.md`
     §"Phase H3" (line 424). The four wraps + capability factories
     + test layer expectations are documented there.
   - The H2 wrap pattern: `src/modules/built-in/build-host-capability.ts`
     (the canonical capability factory) and the corresponding
     `buildManifest` entry in `src/modules/built-in/manifests.ts`.
     Mirror this exactly for each new wrap.
   - `src/daemon/client-rpcs.ts` — the `builder/build` handler shows
     the `fire("pre", payload)` BEFORE + `fire("post", payload)`
     AFTER call sites that the four new wraps replicate.

2. **The unified branch.** All work lands directly on `main`. Do NOT
   `git worktree add`, do NOT `git checkout -b`. Verify with
   `git status` + `git worktree list` before starting — should show
   one worktree at the repo root, branch `main`.

3. **`bun install` + workspace dist freshness check.** Before running
   anything:
   ```bash
   ~/.nodenv/versions/22.17.0/bin/bun install
   for p in packages/*/; do
     if [ -f "$p/build.ts" ]; then
       (cd "$p" && PATH="$HOME/.nodenv/versions/22.17.0/bin:$PATH" \
         ~/.nodenv/versions/22.17.0/bin/bun run build)
     fi
   done
   ```
   Skipping this is the `worktree_bun_install_gotcha.md` /
   `2026_05_06_post_consolidation_install_drift.md` failure mode.

### H3 deliverables (per the plan)

- `modules/clean/` — wraps [src/core/clean.ts CleanManager](src/core/clean.ts).
  `provides.hooks: ['pre', 'post', 'custom']`.
- `modules/metro/` — wraps [src/core/metro.ts MetroManager](src/core/metro.ts).
  `provides.hooks: ['pre-start', 'post-start', 'pre-stop', 'post-stop']`.
  Hook fires from [src/core/session/boot.ts](src/core/session/boot.ts).
- `modules/devtools-core/` — wraps [src/core/devtools.ts DevToolsManager](src/core/devtools.ts).
  `provides.hooks: ['pre-start', 'post-start']`. Renamed from
  `modules/devtools/` to disambiguate from existing
  `modules/devtools-network/` (pattern-recognition finding 8).
- `modules/preflight/` — wraps [src/core/preflight.ts PreflightEngine](src/core/preflight.ts).
  `provides.hooks: ['before-checks', 'after-checks']`. **`extra-checks` is
  NOT a hook** — preflight checks are *data*, contributed via the
  existing `PreflightEngine.register()` exposed as a capability
  (code-simplicity finding 5).
- `modules/_template/` — six-entry layout reference matching existing
  `modules/device-control/` (pattern-recognition finding 2).
- Capability factories: `createCleanHostCapability`,
  `createMetroHostCapability`, `createDevtoolsCoreHostCapability`,
  `createPreflightHostCapability`. Subsystem-first naming matches
  H2's `createBuildHostCapability`. Permission gate
  `host:hooks:dispatch`. Capability ids added to
  `src/core/module-host/capabilities.ts:KNOWN_CAPABILITIES` typo-detector.

### Sub-phase decomposition (a–k pattern, mirrors H1 + H2)

H3 has four wraps; the work decomposes naturally into per-wrap
sub-phases:

- **H3a — `_template/`** — six-entry boilerplate (`src/`, `panel/`,
  `build.ts`, `package.json`, `tsconfig.json`, `rn-dev-module.json`).
  Copy from `modules/device-control/`. Documented in
  `modules/_template/README.md` so future built-in wraps share the
  scaffold.
- **H3b — `modules/clean/`** — manifest + capability factory.
  `provides.hooks: ['pre', 'post', 'custom']`.
- **H3c — clean RPC integration** — daemon `clean/run` (or whatever
  the existing handler is — check `src/daemon/client-rpcs.ts`) fires
  `clean/pre` BEFORE + `clean/post` AFTER. Mirror H2g's
  `builder/build` handler.
- **H3d — `modules/metro/`** — manifest + factory with the four
  lifecycle hooks.
- **H3e — Metro lifecycle wiring** — `src/core/session/boot.ts` fires
  `metro/pre-start` before `MetroManager.start()`, `metro/post-start`
  after the Metro server is reachable. Stop hooks at session
  teardown.
- **H3f — `modules/devtools-core/`** — manifest + factory.
- **H3g — DevTools lifecycle wiring** — same pattern as Metro.
- **H3h — `modules/preflight/`** — manifest + factory +
  `extra-checks` capability surface (NOT a hook).
- **H3i — Preflight lifecycle wiring** — fire `preflight/before-checks`
  + `preflight/after-checks` from the preflight runner.
- **H3j — Cross-module boot-order Playwright smoke** — extends
  `tests/electron-smoke/smoke.spec.ts`. Asserts via boot-trace that
  all built-in capabilities are registered (Phase 1) before any
  `session/init` listener invocation (Phase 3). Closes the
  capability-registration race documented in todo #011 of the plan.
- **H3k — `REAL_BOOT_SMOKE=1` gate + memory ledger** — same
  institutional standard as H1+H2. Land memory entry summarizing
  commits, vitest/tsc/smoke counts.

### Verification gate (do not push without all three green)

Per CLAUDE.md (`renderer/electron/IPC verification standard`):

1. `npx vitest run` — full suite must pass excluding the 2
   pre-existing jsdom-blocked renderer tests
   (`renderer/components/__tests__/ModuleConfigForm.test.tsx`,
   `renderer/views/__tests__/Wizard.test.tsx` — see "Known
   environmental issue" below).
2. `npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json` —
   tsc baseline 150 errors (TUI Ink/OpenTUI drift, all pre-existing);
   electron tsc must be 0.
3. `REAL_BOOT_SMOKE=1 npx playwright test` — full smoke gate. This
   suite is the merge gate per
   [memory/test_strategy_gap.md](memory/test_strategy_gap.md). Each
   wrap landing without REAL_BOOT_SMOKE is a regression risk in the
   same class as the issues that motivated `middle_phase_complete.md`.

### Known environmental issue

`renderer/components/__tests__/ModuleConfigForm.test.tsx` and
`renderer/views/__tests__/Wizard.test.tsx` currently fail with
`ERR_REQUIRE_ESM` from `html-encoding-sniffer@6` (transitive of
`jsdom@29`) requiring `@exodus/bytes` as CommonJS, but `@exodus/bytes`
is `"type": "module"` ESM-only. Tracked as a separate task; do NOT
block H3 on this. The fix is either pinning
`html-encoding-sniffer<6` or migrating renderer tests to `happy-dom`.
Vitest run reports `1302 passed | 2 failed` from this issue alone;
H3 should preserve the 1302 number while adding new vitest-only tests
for the four new modules.

### What NOT to do this session

- Do NOT push. Do NOT open PRs. Do NOT run `acme-reviewer:*`
  skills. (Personal-account workflow.)
- Do NOT create branches like `claude/zen-nash-*`, `feat/hooks-h3`,
  or `verify/*`. Single branch is the hard rule.
- Do NOT spawn `.claude/worktrees/*`. Single worktree is the hard
  rule.
- Do NOT touch the renderer's iOS code-signing prompt — it's
  Skip-by-default + clearly labeled, per the user-reported pbxproj
  damage incident. The `signingStyle` gate from the discover-bundles
  hook is forward-looking; threading it into `settleCodeSigning` is
  out of scope for H3.
- Do NOT relitigate H3's settled architecture. The four wraps + their
  hook namespaces are pinned. `modules/devtools-core/` is the name
  (not `devtools/`); `extra-checks` is NOT a hook.
- Do NOT introduce a sub-phase that removes the H2 commit-by-commit
  rhythm — sub-phases are 1–3 commits each, gate green per phase
  before starting the next.

### Things to carry forward from the previous session

- The probe `tests/electron-real-e2e/probe-real-build.spec.ts` leaks
  the daemon (PID survives `app.close()`) — separate task spawned
  for it. If you re-run the probe during H3 verification, manually
  `pkill -9 -f "src/index.tsx daemon /Users/martincouso/Documents/GitHub/acme"`
  after.
- The acme mobile app's `ios/Acme.xcodeproj/project.pbxproj` +
  `ios/Podfile.lock` had unstaged changes today (CocoaPods UUID
  regeneration noise from `pod install` triggered by
  `react-native run-ios`). Not damage; reverts cleanly with
  `git checkout`. The user asked about lost changes during this
  session; the answer was "no — only CocoaPods UUID noise, no
  CODE_SIGN damage." If they ask again, point at this paragraph.
- The `wizard:getBundles` IPC + scheme picker landed in commit
  `2582679`. The default `discoverBundles()` in
  [src/core/build-discovery.ts](src/core/build-discovery.ts) parses
  `xcshareddata/xcschemes/*.xcscheme` + `project.pbxproj`. H3 should
  not need to touch it. Hook-side dispatch of
  `build/discover-bundles` (registering project hooks via
  `rn-dev.config.ts`) is a separate follow-up after H3 lands the
  pattern for module-host hook fires from non-daemon code paths.

Today is 2026-05-06.

---

## Notes for the resumer

- **Branch state:** `main` is 69 commits ahead of `origin/main`. Not
  pushed. Local-only.
- **Sibling branches:** none. Unified onto main.
- **The user's iPhone is connected** and on the same network as the
  Mac. The default profile points at it
  (`/Users/martincouso/Documents/GitHub/acme-mobile-app/.rn-dev/profiles/profile-1778002269015.json`).
- **Test-fixture daemon leaks:** the new probe-real-build leaks (see
  task chip in this session). The other real-e2e specs do not.
