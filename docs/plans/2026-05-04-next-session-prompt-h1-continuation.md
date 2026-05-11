---
title: Next-session prompt — Hook system Phase H1 continuation (g–j)
type: handoff
status: active
date: 2026-05-04
plan: docs/plans/2026-04-30-feat-hook-system-plan.md
predecessor: docs/plans/2026-05-03-next-session-prompt-h1-hook-system.md
---

# Next-session prompt — Hook System Phase H1 (continuation)

The 2026-05-04 session landed **steps a–f** of the H1 plan and paused at the
LOC-budget checkpoint (3,221 insertions vs the ~2,500 budget the original
H1 prompt called out). The four-class SRP machinery is complete and tested
in isolation; what remains is the wiring (orphan-sweep, session module,
three-phase boot, test helpers) plus the REAL_BOOT_SMOKE gate.

Copy-paste the section below into a fresh Claude Code session to continue.

---

## Self-contained prompt for next session

You are continuing the rn-dev-cli hook system. **Steps H1a–H1f have landed
locally** as 6 commits on the branch `claude/zen-nash-73c0a1`, on top of
the H0 stack (5 commits + 1 docs commit). Nothing pushed; no PR opened.
Your job is **steps H1g–H1j plus the verification gate**: orphan-sweep,
session built-in module, three-phase boot, test helpers, then the
3-layer verification (vitest + tsc + REAL_BOOT_SMOKE playwright).

### Where to start

1. **The branch is `claude/zen-nash-73c0a1`** (NOT main). The 11-commit
   stack is `83ecb80` (plan + review todos) → `9301a41` (H0e: error
   doc) → `4632d99` (H1 next-session prompt) → `b6d23bf` (H1a
   spawn-utils) → `9f212fe` (H1b allowlist + brand) → `ffeb902` (H1c
   realpath + name-newline) → `f5aae05` (H1d registry + audit-writer +
   path-resolver) → `cc32fff` (H1e runner + parser) → `fae1754` (H1f
   dispatcher + manager + facade tests).
2. **Use the existing worktree at `.claude/worktrees/h1-handoff`** —
   it's on `claude/zen-nash-73c0a1` and was clean at session end.
   Confirm with `git status`. If you create a fresh worktree, **MUST
   `bun install` inside it** before vitest will pass — see
   `memory/worktree_bun_install_gotcha.md`.
3. **Read these in order before writing code:**
   - This file's "What's already done" section (below).
   - The H1 plan: [docs/plans/2026-04-30-feat-hook-system-plan.md](2026-04-30-feat-hook-system-plan.md) §"Phase H1" — focus
     on the orphan-sweep, `session` module, three-phase boot, and
     test-helpers bullets that haven't landed yet.
   - The original H1 prompt: [docs/plans/2026-05-03-next-session-prompt-h1-hook-system.md](2026-05-03-next-session-prompt-h1-hook-system.md) — the
     "What NOT to do" and "Watch out for" sections still apply.
   - `memory/h0_implementation_complete.md` and (new)
     `memory/h1_partial_implementation_a_through_f.md` for full
     context on what's already built and the design choices.
   - The four files you'll be wiring INTO:
     - [src/core/session/boot.ts](../../src/core/session/boot.ts) — bootSessionServices.
     - [src/daemon/orphan-sweep.ts](../../src/daemon/orphan-sweep.ts) — pattern to mirror.
     - [src/daemon/index.ts](../../src/daemon/index.ts) — RPC handler dispatch.
     - [src/daemon/client-rpcs.ts](../../src/daemon/client-rpcs.ts) — H2 will call HookManager from here, so don't break the surface.

### What's already done (steps a–f)

**Files added under `src/core/hooks/`:**
- `types.ts` — internal `Registration`, `RegistrationInput`, `RegistrationSource`, `RegistryDump`.
- `path-resolver.ts` — `resolveHookScript` (joins relative paths, runs realpathSync, captures `(realPath, dev, ino)` fingerprint, rejects `~`-prefix and any escape from configDir) + `checkFingerprint` (re-stat + compare for TOCTOU).
- `registry.ts` — `HookRegistry` (pure data; pre-bakes sorted list per slot at registration time; tracks providers; flips `orphaned` flag; single-override invariant) + `suggestHookName` (Levenshtein for did-you-mean).
- `audit-writer.ts` — `HookAuditWriter` (centralized "what gets audited" policy: `writeFailure` / `writeOverrideRegistration` / `writeQueueFull`).
- `runner-subprocess.ts` — `runHookSubprocess` + exported `parseHookRecord`. JSON-line parser with prototype-pollution defense + Object.freeze on result.data; final-env checkEnv after merge; RN_DEV_HOOK_* strip + RN_DEV_* allowlist; rate-limited stdout/stderr; result-termination protocol; ack-first protocol for override slots; group-kill timeout escalation.
- `dispatcher.ts` — `HookDispatcher`. Pulls from `registry.registrationsFor(target)`, routes fn vs script, audits failures, enforces concurrent-fire cap (default 10) with always-audited `queue-full` overflow.
- `manager.ts` — `HookManager` thin facade. `extends EventEmitter`, emits `hooks/registered`/`hooks/orphaned`/`hooks/fired`. Public surface (6 methods): `addRegistration`, `declareProvider`, `dumpRegistry`, `fire`, `orphanedRegistrations`, `retractProvider`. `fire(target, payload, profile: ValidatedProfile)` — branded-type signature enforces re-validation at every entry point.

**Files modified outside `src/core/hooks/`:**
- `src/core/spawn-utils.ts` (new) — `wrapChild`, `buildSpawnCommand`, setpriv probe cache. Generalized `buildSpawnCommand({ command, args })` so both ModuleHost and the runner share it.
- `src/core/module-host/manager.ts` — imports `wrapChild`/`buildSpawnCommand`/`SpawnHandle` from spawn-utils; re-exports `SpawnHandle`.
- `src/modules/built-in-allowlist.ts` (new) — production allowlist `{dev-space, lint-test, settings, marketplace, session}` + test seam (`__addBuiltInAllowedForTests` / `__resetBuiltInAllowlistForTests`).
- `src/modules/registry.ts` — `registerBuiltIn` calls `assertBuiltInAllowed` AFTER schema validation.
- `src/daemon/profile-guard.ts` — `ValidatedProfile` branded type (phantom); `validateProfile` now mints it; `profile.name` rejects `\n` and `\r` with `E_PROFILE_NAME_NEWLINE`.
- `src/core/audit-log.ts` — `AuditHookInput` variant (`kind: "hook"`).
- `packages/module-sdk/src/errors.ts` — `path-outside-project` added to `HookConfigInvalidCause`.
- `packages/config/src/define-config.ts` — `loadConfig` accepts `projectRoot?: string`; when set, runs realpathSync containment check before dynamic import.
- `docs/guides/hook-errors.md` — regenerated from `errors.ts`.
- `package.json` / `bun.lock` — added `split2@4.2.0` + `@types/split2@4.2.3`.
- Test fixtures updated: `src/app/__tests__/modules-ipc.test.ts` (synthetic ids `builtin-cap-only`, `builtin-unspawnable`) and `src/modules/__tests__/built-in-registration.test.ts` (synthetic id `privileged-tools`) opt into the test seam.

**Tests added (94 new, 1,177 total passing):**
- `src/core/__tests__/spawn-utils.test.ts` (9)
- `src/modules/__tests__/built-in-allowlist.test.ts` (7)
- `src/daemon/__tests__/validated-profile-brand.test.ts` (3)
- `packages/config/src/__tests__/define-config.test.ts` (+3 realpath cases)
- `src/daemon/__tests__/profile-guard.test.ts` (+4 newline cases)
- `src/core/hooks/__tests__/path-resolver.test.ts` (10)
- `src/core/hooks/__tests__/registry.test.ts` (17)
- `src/core/hooks/__tests__/audit-writer.test.ts` (9)
- `src/core/hooks/__tests__/parse-hook-record.test.ts` (13)
- `src/core/hooks/__tests__/hook-manager.test.ts` (13)
- `src/core/hooks/__tests__/hook-manager-facade.test.ts` (6)

**Verification baseline at end of session:**
- `npx vitest run`: **1177/1177 passing**.
- `npx tsc --noEmit`: 150 errors, all pre-existing in `src/ui/**`, `src/cli/**`, `src/mcp/tools.ts`. Zero in files touched by H1a–H1f.
- `npx tsc --noEmit -p electron/tsconfig.json`: clean.
- Playwright NOT yet run — that's part of the H1g–H1j gate.

### Remaining H1 deliverables (steps g–j)

#### (g) Hook orphan-sweep + RN_DEV_HOOK_PGID sentinel + playwright spec

**Sentinel mechanism.** Every `runHookSubprocess` spawn already sets
`RN_DEV_HOOK_PGID=<daemon-pid>` in the child env. We need a way to find
those processes at next daemon boot. **Recommended approach (matches the
existing module orphan-sweep at `src/daemon/orphan-sweep.ts`):** the
runner writes a per-fire lockfile at
`~/.rn-dev/hooks/<pgid>.lock` containing `{ daemonPid, target, ts }`,
and unlinks it on hook exit. The new
`src/daemon/hook-orphan-sweep.ts` walks `~/.rn-dev/hooks/*.lock`, reads
the daemonPid from each, kills the pgid (`process.kill(-pgid, "SIGKILL")`)
when the recorded daemon is no longer alive, and unlinks the lockfile.

Why a lockfile rather than scanning `/proc`/`ps -E` for the env var:
macOS has no portable way to read another process's environment, and
the existing module orphan-sweep already pioneered the lockfile pattern
on this codebase. Stay consistent.

**Files to add:**
- `src/daemon/hook-orphan-sweep.ts` — mirror the structure of
  `src/daemon/orphan-sweep.ts`. Export `sweepOrphanHooks(opts)` returning
  `{ scanned, killed, cleared }`. Tests at
  `src/daemon/__tests__/hook-orphan-sweep.test.ts`.
- `tests/electron-smoke/hook-orphan.spec.ts` — REAL_BOOT_SMOKE spec.
  Boot the daemon, spawn a sleeping hook (write a fixture script that
  sleeps 60s after writing the lockfile), SIGKILL the daemon
  mid-fire, boot a fresh daemon, assert `process.kill(-pgid, 0)` throws
  `ESRCH` within 2s.

**Files to modify:**
- `src/core/hooks/runner-subprocess.ts` — write the lockfile right
  after spawn (you have `child.pid`); unlink in the `onExit` handler
  AND in the timeout/error paths. Keep the writeLockfile sync to avoid
  a race window between spawn and the pgid being recorded.
- `src/daemon/index.ts` (or wherever `bootSessionServices` is wired) —
  call `sweepOrphanHooks` early in daemon boot, before any hook fire
  could land. Mirrors the position of `sweepOrphanModules`.

#### (h) `session` built-in module + `session/init` + `session/profile-changed` + RPC

**New built-in module manifest:**
- `src/modules/built-in/session-manifest.ts` (or co-locate in
  `src/modules/built-in/manifests.ts` — match the existing pattern).
  Manifest:
  ```ts
  export const sessionManifest: ModuleManifest = {
    id: "session",
    version: "0.1.0",
    hostRange: ">=0.1.0",
    scope: "global",
    provides: { hooks: ["init", "profile-changed"] }, // "shutdown" deferred until consumer asks
  };
  ```
  The id `session` is **already on `BUILT_IN_MODULE_ALLOWLIST`** —
  step (b) added it.

**Wire registration:**
- Wherever the existing built-ins register (`src/daemon/fake-boot.ts`
  AND `src/modules/create-module-system.ts`), add
  `moduleRegistry.registerBuiltIn(sessionManifest)`.
- Whatever HookManager construction ends up looking like in (i),
  call `hookManager.declareProvider("session", ["init", "profile-changed"])`
  in Phase 2 of the three-phase boot.

**New daemon RPC:** `session/profile-update`
- Add the handler in `src/daemon/client-rpcs.ts` (or wherever
  RPC handlers register). Shape:
  ```
  request:  { profile: unknown }
  response: { ok: true } | { ok: false; code: string; message: string }
  ```
- Handler logic: `validateProfile(input.profile)` → mint
  `ValidatedProfile` → call `hookManager.fire("session/profile-changed", {profile}, validated)`.
- Persist the new profile via the existing profile-store flow
  (search for existing profile persistence — the wizard updates one;
  match that pattern).

**Fire `session/init`:**
- At the END of `bootSessionServices` in `src/core/session/boot.ts`,
  in Phase 3 of (i)'s boot phasing, fire `session/init` with the
  validated profile.

#### (i) Three-phase boot trace + boot-trace assertion

**Mechanic:** turn `bootSessionServices` into three explicit phases. The
existing function probably mixes them; tease apart:

- **Phase 1: register all built-in capabilities.** Existing
  `moduleRegistry.registerBuiltIn(...)` calls + capability registration.
  NO hook fires. NO HookManager construction (because we want the
  registry built first, then HookManager constructed against it).
- **Phase 2: construct HookManager + walk consumes.hooks + mark
  orphans.** Build the HookManager; call `declareProvider` for each
  registered built-in's `provides.hooks`; walk the project's
  `rn-dev.config.ts` (loaded via `@rn-dev/config`'s `loadConfig` with
  `projectRoot` set) and add registrations; `recomputeOrphans`.
- **Phase 3: fire `session/init`.** First hook fire of the session.

**Boot-trace assertion:** add an opt-in trace mechanism (env var or
debug option) that writes phase markers, then a vitest test asserts
that all built-in capabilities are registered before any
`session/init` listener invocation. Simplest implementation: emit
phase markers on the HookManager event emitter, vitest collects them,
asserts ordering.

#### (j) `runHookInProcess` + `MockHookRuntime` test helpers

**Goal:** ship under `@rn-dev/module-sdk` so module authors writing 3p
hooks at H5 time have test infra. Documentation lives in H7.

- `runHookInProcess(manifest, hookName, payload)` — invokes a
  registered in-process hook with a typed payload, captures
  result/logs without spawning a subprocess. Useful for testing
  module-author code that registers an `fn` entry against a built-in
  contribution point.
- `MockHookRuntime<S extends keyof HookContracts>` — a minimal mock
  of the runtime interface that captures fires; `mock.fires[]` is the
  assertion surface. Type-parameterized so consumers get full
  inference on payload shape.

Both go in `packages/module-sdk/src/test-helpers.ts` (new file),
exported from `packages/module-sdk/src/index.ts`. Ship the dist build
via `vitest.global-setup.ts` (already builds the package).

### Verification gate (CLAUDE.md three-layer standard)

1. `npx vitest run` — must pass; baseline is 1177 from this session.
2. `npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json` — must
   stay at 150 baseline; touched files must be zero.
3. `REAL_BOOT_SMOKE=1 npx playwright test` — required per
   `memory/test_strategy_gap.md`. The hook-orphan spec from (g) is
   part of this gate.

### What NOT to do this session

(Same as the original H1 prompt — repeated for the resumer who reads only this file.)

- Do NOT wrap Builder/Clean/Metro/DevTools/Preflight as built-in modules. That's H2/H3.
- Do NOT add MCP tools. `hooks-diagnose` + `hooks-config-validate` are H2; the rest are H6.
- Do NOT extend `consumes.hooks` validation to walk active modules' `provides.hooks` — that's H5.
- Do NOT alter Builder concurrency, Metro lifecycle, or DevTools internals.
- Do NOT relitigate the hardcoded `custom` override slot, the `session/shutdown` deferral, or the no-fall-back-on-missing-ack rule.

### Watch out for (lessons from this session)

- **Worktree without `bun install` resolves `@rn-dev/*` to the main repo's stale dist.** First sign of trouble: `Cannot read properties of undefined (reading 'E_HOOK_*')` in vitest. Fix: `bun install` inside the worktree. See `memory/worktree_bun_install_gotcha.md`.
- **macOS `/var/folders/*` is a symlink to `/private/var/folders/*`.** Anywhere a test mints `mkdtempSync(tmpdir(), ...)` and later compares against `realpathSync` of something inside it, you must `realpathSync(mkdtempSync(...))` upfront. The path-resolver tests had to learn this lesson.
- **`registerBuiltIn` allowlist runs AFTER schema validation.** If you add a new built-in id, add it to `src/modules/built-in-allowlist.ts`'s `PRODUCTION_ALLOWLIST` AND register it via the existing pattern. Test-only synthetic ids should use the `__addBuiltInAllowedForTests` seam in a `beforeEach`.
- **`HookEntry` does NOT have an `env` field today.** The runner's env composition merges `profile.env` + runner-injected keys only. If H5 (3p modules) ends up needing per-entry env, add it to `@rn-dev/config`'s `HookEntryCommon` and update the runner.
- **`HookSubprocessOutcome` has 9 variants, only some of which map cleanly to `HookFailedOutcome`.** The current runner uses some best-fit mappings (e.g. `exit-nonzero` maps to `outcome: "timeout"` in `HookErrorDetails`). H4 will likely need to formalize this — at that point either expand `HookFailedOutcome` or wrap with a translation layer. This is a known papercut; don't try to fix it as part of g–j.
- **`split2` integration verified working with Bun's child_process** in this session — the original H1 prompt's open question is resolved. No need to swap for a hand-rolled splitter.
- **`docs/guides/hook-errors.md` is auto-generated** by `scripts/gen-hook-errors-doc.ts`. If you add error codes or causes, run `bun run scripts/gen-hook-errors-doc.ts` and commit the regen.

### Decisions captured in code (for review)

These choices are encoded in the a–f commits and worth flagging at PR-review time so reviewers don't re-litigate:

- **Allowlist test seam.** Could have been done with an opt-out flag on `registerBuiltIn`. Test seam was chosen because it doesn't pollute the production API surface; the seam is named with double-underscore prefixes so it's clearly internal.
- **`writeLockfile` and `runHookSubprocess` flow** — currently the runner does NOT write a lockfile (deferred to (g)). The dispatcher and manager pass a `daemonPid` through which the runner stamps as `RN_DEV_HOOK_PGID` env var. Adding the lockfile write is mechanical.
- **`HookSubprocessRunner` integration tests deferred to (f)'s cross-class suite.** I wrote 13 parser unit tests (security-critical) but no full subprocess integration tests; the cross-class tests in `hook-manager.test.ts` use a mock `runSubprocess` to exercise the dispatcher contract. Real-subprocess testing of the runner ends up easier to land in the playwright spec at (g) where there's a real daemon process to drive.
- **Concurrent-fire queue cap is per-dispatcher, not per-target.** A single `HookManager` shared across the daemon counts ALL in-flight fires together. If H6 needs per-target caps, split the inflight counter by target.

### Suggested commit ordering for g–j

1. **`feat(daemon): hook-orphan-sweep + lockfile sentinel`** — adds `hook-orphan-sweep.ts`, `hook-orphan-sweep.test.ts`; modifies `runHookSubprocess` to write/unlink the lockfile; wires into daemon boot. Add the playwright spec at the end of this commit.
2. **`feat(modules): session built-in module manifest + provides.hooks`** — adds `sessionManifest`, registers it in `fake-boot.ts` + `create-module-system.ts`. No HookManager wiring yet.
3. **`feat(daemon): session/profile-update RPC + HookManager construction`** — adds the new RPC handler, wires `HookManager` into `bootSessionServices`, calls `declareProvider("session", ["init","profile-changed"])`, fires `session/profile-changed` from the new RPC.
4. **`feat(session): three-phase boot + boot-trace assertion`** — refactors `bootSessionServices` into the three explicit phases; fires `session/init` at end of Phase 3; adds the boot-trace assertion test.
5. **`feat(sdk): runHookInProcess + MockHookRuntime test helpers`** — `packages/module-sdk/src/test-helpers.ts` + colocated tests + `index.ts` export.

After the 5th commit, run the full 3-layer verification. The total H1 stack will be 11 commits (a–j + the docs commit).

Today is 2026-05-04.

---

## Notes for the resumer

- **Branch state:** `claude/zen-nash-73c0a1` is 11 commits ahead of `origin/main`. Nothing pushed.
- **Worktree:** `.claude/worktrees/h1-handoff` was clean at session end. Reuse it; `bun install` already ran.
- **PR plan once g–j land:** push as one PR per the original H1 prompt. Reviewer should spot-check the 7 security showstoppers in the description (built-in allowlist, ValidatedProfile, realpath check, name-newline, prototype-pollution, final-env checkEnv, TOCTOU re-check) plus the orphan-sweep mechanism. The four-class SRP split is the architectural piece worth highlighting.
- **If the H1 PR review ends up wanting the a–f and g–j stacks split into two PRs:** the natural split is at commit `fae1754` (end of step f). a–f are pure additions; g–j wire the system into the daemon boot.
