---
title: Next-session prompt — Open the H1 hook system PR
type: handoff
status: active
date: 2026-05-04
plan: docs/plans/2026-04-30-feat-hook-system-plan.md
predecessor: docs/plans/2026-05-04-next-session-prompt-h1-continuation.md
---

# Next-session prompt — Open the H1 PR

H1 is fully implemented locally on `claude/zen-nash-73c0a1`. This
session's job is to **open the PR** — push the branch, write the
description, request review, and address any feedback. **Do not
re-implement.** **Do not push without re-running the verification
gate** — it's been a few sessions since the gate last ran.

Copy-paste the section below into a fresh Claude Code session.

---

## Self-contained prompt for next session

You are continuing the rn-dev-cli hook system. **All H1 phases (a–j) have
landed locally** as 20 commits on the branch `claude/zen-nash-73c0a1`.
Nothing pushed; no PR opened. The 3-layer verification gate was green
at end of the previous session (1234 vitest + tsc baseline preserved
+ electron tsc clean + 12/12 playwright incl. REAL_BOOT_SMOKE). Your
job is to **push the branch, open one PR, address review feedback**.

### Where to start

1. **Read these in order:**
   - `memory/h1_complete.md` — full H1 state, design choices worth flagging at review, the 7-showstopper audit summary, real-boot env-var setup for this machine.
   - `memory/test_strategy_gap.md` — `REAL_BOOT_SMOKE=1 npx playwright test` is the merge gate.
   - The 8 g–j commits on the branch (read commit messages, NOT diffs unless investigating something specific):
     ```
     git log --oneline origin/main..HEAD | head -10
     ```
   - The H1 plan: `docs/plans/2026-04-30-feat-hook-system-plan.md` — the §"Phase H1" section is the single source of truth for what should have landed. Cross-reference against the commit stack to confirm full coverage.

2. **Use the existing worktree at `.claude/worktrees/h1-handoff`** —
   it's on `claude/zen-nash-73c0a1` and was clean at session end.
   Confirm with `git status`. If you create a fresh worktree, **MUST
   `bun install` inside it** (see `memory/worktree_bun_install_gotcha.md`)
   AND **separately `bun install` in `renderer/`** (per
   `memory/environment_setup.md`).

### What to do

#### Step 1 — Re-run the 3-layer verification gate

It's been a session or two; don't trust the prior baseline. Confirm:

```bash
npx vitest run                                      # expect 1234/1234
npx tsc --noEmit                                    # expect 150 errors (baseline)
npx tsc --noEmit -p electron/tsconfig.json          # expect 0 errors
REAL_BOOT_SMOKE=1 \
  RN_DEV_REAL_BOOT_TARGET=/Users/martincouso/Documents/GitHub/acme-mobile-app \
  RN_DEV_REAL_BOOT_PACKAGE_MANAGER=pnpm \
  npx playwright test                               # expect 12/12
```

If any layer regresses, **stop and investigate** — do not push. The
flaky `src/daemon/__tests__/registry.test.ts > findActiveDaemons`
test is parallel-flaky; if it's the only failure and passes in
isolation, that's the pre-existing flake (not a regression).

#### Step 2 — Push the branch

```bash
git push -u origin claude/zen-nash-73c0a1
```

#### Step 3 — Open the PR

Use `gh pr create` with the description below. Title: under 70
chars, e.g. `feat: hook system Phase H0 + H1 (modules contribute hooks)`.

Description body — start from this skeleton, adapt as needed:

```markdown
## Summary

Phase H0 + H1 of the hook system. Modules contribute hook
contribution-points via `provides.hooks`; project config + 3p modules
register against them via `consumes.hooks`. The host-end is a
four-class SRP split (Registry / Dispatcher / Runner / AuditWriter)
behind a thin HookManager facade. First built-in: `session/{init,
profile-changed}`.

## What's included

**H0 (foundation, 5 commits):**
- Plan + review todos.
- Manifest schema additions (`provides.hooks`, `consumes.hooks`,
  `HookEntry` discriminated by script/fn).
- `@rn-dev/config` workspace package: `defineConfig` + `loadConfig`
  with TOCTOU realpath check + `HookContracts` augmentable typed-payload
  registry.
- `rn-dev config init` + `rn-dev config validate` CLIs.
- Auto-generated hook-errors reference doc + freshness test.

**H1 (a–f, machinery, 6 commits):**
- (a) `spawn-utils` extraction shared between ModuleHost + hook runner.
- (b) Built-in-privileged allowlist + `ValidatedProfile` branded type.
- (c) Config-file `loadConfig({projectRoot})` realpath containment +
  `profile.name` newline rejection.
- (d) HookRegistry + HookAuditWriter + path-resolver (with TOCTOU
  fingerprint).
- (e) HookSubprocessRunner + JSON-line parser (prototype-pollution
  defense + Object.freeze on result.data + final-env checkEnv).
- (f) HookDispatcher + HookManager facade + facade-preservation tests.

**H1 (g–j, integration, 6 commits):**
- (g) Hook orphan-sweep + per-fire lockfile sentinel at
  `~/.rn-dev/hooks/<pgid>.lock`.
- electron fix: `formatAuditEntry` handles the `kind: "hook"` variant
  the H1d audit-log change added.
- (h.1) `session` built-in module manifest + `provides.hooks: ["init",
  "profile-changed"]`.
- (h.2) HookManager constructed in `bootSessionServices` +
  `fakeBootSessionServices`; new `session/profile-update` RPC.
- (i) Three-phase boot + boot-trace assertion + project-config walk
  extracted to `src/core/hooks/load-project-hooks.ts`.
- (j) `runHookInProcess` + `MockHookRuntime<TFires>` test helpers in
  `@rn-dev/module-sdk`.

**Test infra:** `tests/electron-smoke/real-boot.spec.ts` accepts
`RN_DEV_REAL_BOOT_TARGET` + `RN_DEV_REAL_BOOT_PACKAGE_MANAGER` env
overrides so the smoke isn't pinned to a single fixture.

## 7 H1 security showstoppers — all landed

1. ✅ Curated allowlist for `kind: "built-in-privileged"` —
   `src/modules/built-in-allowlist.ts` (commit b).
2. ✅ Prototype-pollution defense in subprocess parser —
   `JSON.parse` reviver + `Object.freeze` on result.data (commit e).
3. ✅ `ValidatedProfile` branded type at every hook-fire entry
   point — RPC, MCP tool, in-process call (commit b).
4. ✅ Path TOCTOU re-check —
   `path-resolver.ts::checkFingerprint` (commit d).
5. ✅ `profile.name` newline+CR rejection (commit c).
6. ✅ Final-env `checkEnv` after merge in subprocess runner (commit e).
7. ✅ Hook orphan-sweep + lockfile sentinel — commit g.

(Two items in the original showstopper list — `RN_DEV_DAEMON_MODE`
gate for `hooks/run --real`, and `allowModuleHardFails` second gate —
land in H2 and H5 respectively per the plan; not in H1 scope.)

## Architecture worth a second look

- **Four-class SRP split** under `src/core/hooks/`:
  Registry (pure data), AuditWriter (centralized policy), Dispatcher
  (routing + concurrency cap), Runner (subprocess protocol). The
  `HookManager` facade is 6 methods; `hook-manager-facade.test.ts`
  snapshots the surface so adding a method requires updating the
  test (architectural-drift signal).

- **Three-phase boot** in `bootSessionServices`. Phase 1: capabilities
  + built-ins registered. Phase 2: HookManager constructed +
  declareProvider for built-ins + project config walk. Phase 3:
  `session/init` fires. Markers emitted on the HookManager event
  emitter; `SessionServices.bootTrace: ReadonlyArray<{phase, ts}>` is
  the test assertion surface.

- **Hook orphan-sweep is simpler than module orphan-sweep** because
  hooks self-stamp owning daemonPid into the lockfile. No /proc or
  `ps` required to gate on owner liveness.

## Verification

- `npx vitest run`: 1234/1234 passing (was 1083 at H0; +151 across
  the H0 + H1 stack).
- `npx tsc --noEmit`: 150 errors, all pre-existing in `src/ui/**`,
  `src/cli/**`, `src/mcp/tools.ts`. Zero in files touched by this PR.
- `npx tsc --noEmit -p electron/tsconfig.json`: clean.
- `REAL_BOOT_SMOKE=1 npx playwright test`: 12/12 passing including
  both real-boot specs.

## Test plan

- [ ] `npx vitest run` green.
- [ ] `npx tsc --noEmit` at 150 baseline; touched files at zero.
- [ ] `npx tsc --noEmit -p electron/tsconfig.json` clean.
- [ ] `REAL_BOOT_SMOKE=1 npx playwright test` green.
- [ ] `bun run build` green.

## Out of scope (deferred per the plan)

- H2: wrap Builder as `build` built-in module.
- H3: wrap Clean / Metro / DevTools / Preflight.
- H4: `hooks-diagnose` + `hooks-config-validate` MCP tools.
- H5: 3p `consumes.hooks` against built-in slots + `allowModuleOverrides`/`allowModuleHardFails` gates.
- H6: per-target queue caps + `hooks/run` MCP tool with `RN_DEV_DAEMON_MODE` gate.
- H7: docs.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

#### Step 4 — Run the standard review chain

After PR is open, run the project's review chain:

```
/acme-reviewer:pr-review
```

…or whatever the project standard is. Address findings via
`/acme-reviewer:resolve-parallel` or one-by-one via
`/acme-reviewer:triage`.

Default-accept security + architecture findings; default-discuss
simplicity / scope-cut findings (per
`memory/feedback_review_weighting.md`).

#### Step 5 — Watch CI

Check `gh pr checks` after push. If CI is GREEN-on-merge in this repo,
no additional action; if it's checks-must-pass, wait for green before
requesting human review.

### Decisions to highlight in the PR body / review responses

These are encoded in the commits and worth pre-empting at review:

- **Vitest integration test for hook-orphan-sweep** instead of a
  playwright spec (the flow doesn't involve Electron — `spawnTestDaemon`
  + tmp lockfile + sleeping subprocess is enough).
- **`MockHookRuntime` is generic-parameterized** (`TFires extends
  Record<string, unknown>`) instead of referencing
  `@rn-dev/config`'s `HookContracts` — the latter would create a
  circular dep since config imports from module-sdk.
- **Allowlist test seam (`__addBuiltInAllowedForTests` /
  `__resetBuiltInAllowlistForTests`)** — chosen over an opt-out flag
  on `registerBuiltIn` because the seam doesn't pollute the
  production API surface; the double-underscore prefix marks it
  internal.
- **Concurrent-fire queue cap is per-dispatcher, not per-target.** A
  shared HookManager counts ALL in-flight fires together. If H6
  surfaces a need for per-target caps, split the inflight counter
  there.
- **`HookSubprocessOutcome` has 9 variants but `HookFailedOutcome`
  has 7.** The runner uses best-fit mappings (e.g. `exit-nonzero` →
  `outcome: "timeout"`). Known papercut, formalize at H4.
- **No HookManager dispose method.** The dispatcher's inflight cap is
  process-scoped; subprocess hooks have their own lockfile cleanup.
  `SessionServices.dispose` doesn't need to call into HookManager.

### What NOT to do this session

- Do NOT add features. The H1 plan is closed; H2/H3/etc. are next.
- Do NOT amend commits or rewrite history without explicit ask. The
  20-commit stack is the audit trail reviewers expect.
- Do NOT split the PR unless the review explicitly asks for it. The
  natural split (a–f machinery vs g–j integration) is recorded in
  `memory/h1_complete.md` if it comes up; default to one PR.
- Do NOT skip pre-commit hooks or signing.
- Do NOT push to `main`. Push to `claude/zen-nash-73c0a1`; PR targets
  `main`.

### Watch out for (lessons to carry forward)

- **Renderer needs its own `bun install`.** If `npx playwright test`
  fails with `Cannot find package '@vitejs/plugin-react'`, run
  `cd renderer && bun install`.
- **Worktree without `bun install` resolves `@rn-dev/*` to the main
  repo's stale dist** — see `memory/worktree_bun_install_gotcha.md`.
- **Real-boot fixture path is machine-specific.** Use the env vars
  `RN_DEV_REAL_BOOT_TARGET` + `RN_DEV_REAL_BOOT_PACKAGE_MANAGER`
  rather than editing `real-boot.spec.ts` again.
- **macOS `/var/folders/*` is a symlink** to `/private/var/folders/*`.
  When tests `mkdtempSync(tmpdir(), ...)` and later compare against
  `realpathSync` of something inside, must `realpathSync(mkdtempSync(...))`
  upfront. Pre-existing in the path-resolver tests.

Today is 2026-05-04.

---

## Notes for the resumer

- **Branch state:** `claude/zen-nash-73c0a1` is 20 commits ahead of
  `origin/main`. Not pushed.
- **Worktree:** `.claude/worktrees/h1-handoff` clean at session end.
  `bun install` was current; `renderer/bun.lock` was generated and
  is uncommitted (gitignored — confirm before pushing).
- **PR target:** `main`.
- **Reviewers to consider:** project standard chain via
  `/acme-reviewer:pr-review`. Default security + architecture
  acceptance per `memory/feedback_review_weighting.md`.
- **First commit on the branch is `83ecb80` (H0 docs).** That's the
  divergence point from `origin/main` (`ff230b0`). If `git rebase
  --onto origin/main` is needed for any reason, plan accordingly —
  but rebasing 20 commits is a last resort, not a default.
