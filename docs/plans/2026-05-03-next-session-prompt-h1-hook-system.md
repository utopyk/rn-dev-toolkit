---
title: Next-session prompt — Hook system Phase H1
type: handoff
status: active
date: 2026-05-03
plan: docs/plans/2026-04-30-feat-hook-system-plan.md
predecessor: docs/plans/2026-05-01-next-session-prompt-h0-hook-system.md
---

# Next-session prompt — Hook System Phase H1

Copy-paste the section below into a fresh Claude Code session to start H1.

---

## Self-contained prompt for next session

You are picking up the rn-dev-cli hook system. **Phase H0 has landed locally** as 5 commits on the branch `claude/zen-nash-73c0a1` (not pushed; no PR opened). Your job this session is **Phase H1 — HookManager + spawn primitives extraction + lifecycle namespace bootstrap.** This is the first phase that touches the daemon and introduces real dispatch infrastructure.

### Where to start

1. **Branch off `claude/zen-nash-73c0a1`** (NOT main). The H0 work — `@rn-dev/config`, the manifest schema fields, the error catalog, the `rn-dev config init/validate` CLI — is the foundation H1 imports. Suggested branch name: `feat/hooks-h1`.
2. **Check the prior session's worktree was deleted.** If `.claude/worktrees/zen-nash-73c0a1` doesn't exist, just create a fresh worktree off the branch: `git worktree add .claude/worktrees/h1 claude/zen-nash-73c0a1`.
3. **Read these in order before writing code:**
   - The plan: [docs/plans/2026-04-30-feat-hook-system-plan.md](docs/plans/2026-04-30-feat-hook-system-plan.md) §"Phase H1" (line 344+). Reference §"Architecture" and §"Performance Budget" as needed.
   - The H0 next-session prompt: [docs/plans/2026-05-01-next-session-prompt-h0-hook-system.md](docs/plans/2026-05-01-next-session-prompt-h0-hook-system.md) — the Settled Architectural Decisions list applies in full.
   - The H0 implementation memory: [memory/h0_implementation_complete.md](../../memory/h0_implementation_complete.md) (also surfaced via session-start).
   - CLAUDE.md at repo root for verification standard, ESM/NodeNext rules, no-`any`-no-`unknown`, colocated tests.
   - Existing parallels:
     - [src/core/module-host/manager.ts:71-119](../../src/core/module-host/manager.ts) — the spawn primitives you will extract into `src/core/spawn-utils.ts`.
     - [src/daemon/orphan-sweep.ts](../../src/daemon/orphan-sweep.ts) — the orphan-sweep pattern you will mirror for hooks.
     - [src/core/metro.ts](../../src/core/metro.ts) and [src/core/devtools.ts](../../src/core/devtools.ts) — `EventEmitter + Map<key, State>` pattern that `HookManager` follows.
     - [src/daemon/__tests__/session-boot.test.ts:212](../../src/daemon/__tests__/session-boot.test.ts) — the `LD_PRELOAD` regression test you will mirror at the hook spawn boundary.

### Settled architectural decisions (do NOT relitigate — reference [memory/hook_system_plan.md](../../memory/hook_system_plan.md))

- **Per-module contribution points.** Hooks are tuples `(<module-id>, <hook-name>)`.
- **In-process for built-ins, subprocess for 3p.**
- **Override slot hardcoded as `custom`.** Single override allowed; missing-ack on first record = hard fail; NO fall-back.
- **`session` module owns `session/init` + `session/profile-changed`.** `session/shutdown` deferred until a consumer asks. Namespace capped at 3.
- **HookManager SRP split.** `HookRegistry` + `HookDispatcher` + `HookSubprocessRunner` + `HookAuditWriter` + thin `HookManager` facade.
- **No scope cuts.**

### H1 deliverables (from the plan)

#### Spawn primitives extraction

- `src/core/spawn-utils.ts` — extract `wrapChild`, `buildSpawnCommand`, and the `setpriv` cache from [src/core/module-host/manager.ts:71-119](../../src/core/module-host/manager.ts). Generalize `buildSpawnCommand` to take `{ command, args }` so both ModuleHost and HookSubprocessRunner can call it. ModuleHost imports from the new module — existing module-host tests should pass without modification.

#### HookManager + 4-class SRP split

- `src/core/hooks/registry.ts` — `HookRegistry` (pure data — `provides`/`consumes` map, validation, did-you-mean suggestions, orphan tracking, zero I/O).
- `src/core/hooks/dispatcher.ts` — `HookDispatcher` (fire ordering by `(priority desc, registrationOrder asc)` from a pre-baked sorted list, override resolution, in-process/subprocess routing, concurrency serialization).
- `src/core/hooks/runner-subprocess.ts` — `HookSubprocessRunner`. JSON-line wire format via `split2` (5.3M weekly DL, Bun-compatible, backpressure-aware). Process-group spawn + group-kill timeout escalation. EPIPE → `E_HOOK_FAILED { outcome: "crashed-before-payload" }`. stderr rate limit (10 KB/s) + stdout token bucket (50 KB/s + 200 records/s, drop after 100 consecutive parse failures). Strip `\r` after split for Windows CRLF safety. Strips `RN_DEV_HOOK_*` env on spawn; uses explicit `RN_DEV_*` allowlist.
- `src/core/hooks/audit-writer.ts` — `HookAuditWriter` (audit-policy decisions in one reviewable place; failures audited, successes not, override registrations always audited).
- `src/core/hooks/manager.ts` — `HookManager` thin facade composing the four classes. `extends EventEmitter`, emits `hooks/fired`, `hooks/registered`, `hooks/orphaned`. Public API uses `HookContracts` from `@rn-dev/config` for typed `fire<S>(slot, payload)` dispatch.
- `src/core/hooks/path-resolver.ts` — resolve script paths against config-file dir; `realpathSync` + prefix check. `E_HOOK_PATH_OUTSIDE_PROJECT` on bypass.

**Parser inlined into runner-subprocess.ts** (~40 lines, three discriminator kinds: `ack` / `log`/`progress` / `result`). Extract only when a second consumer appears — code-simplicity finding 4.

#### Result termination protocol (Explore #2)

Parser switches to "post-result sink" after first `{kind:"result"}` record; subsequent records logged but not collected. Second `result` → `E_HOOK_FAILED { outcome: "multiple-results" }`. Override hooks: first record MUST be `{kind:"ack", replaced: true}` — missing ack on first non-ack record → hard fail, no fall-back to built-in step.

#### Security showstoppers (these MUST land in H1 — the plan calls them out as gating items)

- **Curated allowlist for `kind: "built-in-privileged"`** at `src/modules/built-in-allowlist.ts` matched against `manifest.id`. Without this, any 3p manifest can self-declare in-process and bypass subprocess isolation.
- **Prototype-pollution defense** in the parser:
  ```typescript
  const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const parsed = JSON.parse(line, (k, v) => POLLUTION_KEYS.has(k) ? undefined : v);
  ```
  Then `Object.freeze(record.data)` before forwarding. The cited `parseSubscribePayload` idiom only narrows shape — it is NOT a pollution defense.
- **`ValidatedProfile` branded type** — `HookManager.fire()` accepts `ValidatedProfile` only, not `Profile`. Every entry point (RPC handler, MCP tool, in-process call) re-runs `validateProfile` to mint the branded type.
- **Final-env `checkEnv` after merge** — runner's pre-spawn env composition runs `checkEnv` against the *final* env dict (after hook-entry-supplied keys are merged), not just against `profile.env`.
- **`profile.name` newline+CR rejection** — patch [src/daemon/profile-guard.ts:72-75](../../src/daemon/profile-guard.ts) to reject `\n` and `\r` in name (parity with `checkAbsolutePath`). Required because name flows into `RN_DEV_PROFILE_JSON` env var; embedded newlines desync the JSON-line parser.
- **Path TOCTOU re-check** — registry caches `(absolutePath, lstat.dev+ino)` from boot; re-`realpathSync` at fire time; mismatch → `E_HOOK_FAILED { outcome: "path-mutated" }`, skip + audit.
- **`config-file realpath` check before dynamic import** — stat config file before `import("./rn-dev.config.ts")`; reject if `realpath(configFile)` is not under `realpath(projectRoot)`. Apply this in `loadConfig` (`@rn-dev/config`) — H0 implemented `loadConfig` but did not add this check; add it in H1 alongside the other path checks.

#### Daemon-lifecycle defenses

- **Hook orphan-sweep on daemon boot** (todo #003) — mirrors [src/daemon/orphan-sweep.ts](../../src/daemon/orphan-sweep.ts). Scans for stray hook process groups (sentinel env-var marker `RN_DEV_HOOK_PGID=<daemon-pid>` set on every hook spawn), SIGKILLs orphans before booting the new session. Linux uses `setpriv --pdeathsig SIGKILL` when available. macOS has no `pdeathsig` equivalent — documented as best-effort with the orphan-sweep as the safety net at next daemon boot.
- Test: `tests/electron-smoke/hook-orphan.spec.ts` SIGKILLs the daemon mid-fire of a sleeping hook, boots a fresh daemon, asserts `process.kill(-pgid, 0)` throws `ESRCH` within 2s.

#### Concurrency + performance

- **Concurrent fire queue** with depth cap 10. Overflow → `E_HOOK_FAILED { outcome: "queue-full" }`, **always audited** (security-sentinel finding 10).
- **Empty-registry fast path** — `HookManager.fire()` short-circuits when `registrations.length === 0`: no await, no audit, no event emit. Pre-bake the sorted registration list per `<id>/<name>` at registration time; rebuild only on register/unregister.

#### Boot-phase determinism

- **Three-phase session boot** (todo #011):
  - Phase 1 = register all built-in capabilities (no hook fires).
  - Phase 2 = construct HookManager + walk `consumes.hooks` from project config + active module manifests; mark orphans.
  - Phase 3 = fire `session/init`.
- Vitest asserts via boot-trace that all built-in capabilities are registered before any `session/init` listener invocation.

#### `session` built-in module

- New built-in-privileged module owning `session/init` + `session/profile-changed`. (`session/shutdown` deferred.)
- `session/init` fires from [src/core/session/boot.ts](../../src/core/session/boot.ts) at the end of `bootSessionServices`, in Phase 3 above.
- `session/profile-changed` fires from a new daemon RPC `session/profile-update` (handler added in this phase). The handler revalidates the profile via `validateProfile` then dispatches the hook.

#### Audit log

- New `kind: "hook"` variant per the AuditHookInput shape in §"Architecture". `~/.rn-dev/audit.log` writes go through the host-internal `AuditLog.append()` API only — modules NEVER write it.

#### Test infrastructure (hoisted from H7 per todo #015)

- `@rn-dev/module-sdk` test helpers:
  - `runHookInProcess(manifest, hookName, payload)` — invokes a registered in-process hook with a typed payload, captures result/logs without spawning.
  - `MockHookRuntime<S extends keyof HookContracts>` — captures fires, exposes `fires[]` for assertions with full type inference.
- These ship in H1 (not H7) so H5 module authors writing 3p hooks have test infra at H5 time. Documentation lives in H7.

#### Debug API

- `dumpRegistry()` internal-only method on `HookManager` exposing the registry's contribution-points and registrations Map for vitest assertions. Not part of the public MCP surface (todo #008 — testability).

#### Facade preservation tests (todo #002)

- `hook-manager-facade.test.ts` snapshots facade method names + signatures.
- `expectTypeOf<HookManager['fire']>().parameter(0).toEqualTypeOf<keyof HookContracts>()` pins the typed dispatch shape. ~30 LOC combined.

#### Cross-class integration tests (todo #009)

- `hooks-dispatcher.contract.test.ts` — register out-of-order; assert dispatcher invokes in `(priority desc, registrationOrder asc)` from the pre-baked sorted list (no re-sort).
- `hooks-audit-writer.policy.test.ts` — spy on AuditWriter; additive successful fire produces zero `append` calls; failure + override registration produce exactly one each.
- `hooks-runner-dispatcher-backpressure.test.ts` — fire registration A (slow subprocess) + B (fast in-process) against different tuples; assert B completes before A.

### Test layer for H1

vitest:
- HookManager registry construction over arbitrary `provides`/`consumes` graphs (property-based with `fast-check` if available, hand-written otherwise).
- Subprocess runner: success, exit !== 0, timeout reaped (assert process group dies), JSON-line buffer split mid-message, malformed records dropped, `__proto__` rejection, multiple `result` rejected.
- In-process runner: success, throw → fail, capability registry plumbing.
- Path resolver: relative resolution, symlink traversal blocked, `~` rejected.
- Audit log: failures audited, successes not, override registrations always audited.
- Env-var passthrough: profile with `LD_PRELOAD` rejected at `validateProfile` boundary BEFORE reaching hook spawn (regression test mirroring [src/daemon/__tests__/session-boot.test.ts:212](../../src/daemon/__tests__/session-boot.test.ts)).
- Boot-trace assertion: built-in capabilities registered before `session/init`.
- Facade preservation + cross-class integration tests above.

### How to verify before pushing

Per CLAUDE.md three-layer verification standard:
1. **`npx vitest run`** — H1 tests + the existing 1083 baseline must pass.
2. **`npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json`** — clean (treat the 149 pre-existing `src/ui/**` errors as the baseline; H1 must not increase the count).
3. **Playwright Electron smoke** — H1 introduces the daemon RPC `session/profile-update` and the orphan-sweep, both of which only surface in a real daemon process. Run `REAL_BOOT_SMOKE=1 npx playwright test` per [memory/test_strategy_gap.md](../../memory/test_strategy_gap.md). The hook-orphan spec (`tests/electron-smoke/hook-orphan.spec.ts`) is part of this gate.

### Workflow shape

1. Read the H1 plan section in detail. Cross-reference relevant todos in `todos/` for findings.
2. Use TodoWrite to break H1 into sub-tasks. Suggested ordering (each commit-sized):
   - **a.** Extract `src/core/spawn-utils.ts` from `module-host/manager.ts`. Verify module-host tests still pass.
   - **b.** Add `src/modules/built-in-allowlist.ts` + the `ValidatedProfile` branded type. These are pure additions; commit before HookManager so subsequent commits can reference them.
   - **c.** Patch `profile-guard.ts` newline+CR rejection. Add config-file `realpath` check inside `@rn-dev/config`'s `loadConfig`.
   - **d.** Build `HookRegistry` + `HookAuditWriter` first (no dispatch yet). Tests cover registry construction + did-you-mean.
   - **e.** Build `HookSubprocessRunner` with the parser inlined + prototype-pollution defense + result-termination protocol. Tests cover all 5 outcome subkinds.
   - **f.** Build `HookDispatcher` + the `HookManager` facade composing the four. Tests cover ordering, queue cap, empty-registry fast path.
   - **g.** Wire orphan-sweep + `RN_DEV_HOOK_PGID` sentinel. Add the playwright spec.
   - **h.** Wire `session` built-in module + `session/init` + `session/profile-changed` + `session/profile-update` daemon RPC.
   - **i.** Add three-phase boot trace and the boot-trace assertion.
   - **j.** Add `runHookInProcess` + `MockHookRuntime` test helpers to `@rn-dev/module-sdk`.
3. Use Conventional Commits per category, e.g. `feat(hooks): extract spawn-utils + ModuleHost migration`, `feat(hooks): HookSubprocessRunner with prototype-pollution defense`, `feat(daemon): session/profile-update RPC + session built-in module`.
4. The H1 PR (when you're ready to push) should reference the plan and call out the 7 security showstoppers in its description so reviewers can spot-check each.

### What NOT to do this session

- Do NOT wrap Builder/Clean/Metro/DevTools/Preflight as built-in modules. That's H2/H3. The `built-in-allowlist.ts` ships in H1 but populated only with the `session` module; H2 adds `build`, etc.
- Do NOT add MCP tools. `hooks-diagnose` + `hooks-config-validate` are H2; the rest are H6.
- Do NOT extend the `consumes.hooks` validation to walk active modules' `provides.hooks` — that's H5 (3p surface).
- Do NOT alter Builder concurrency, Metro lifecycle, or DevTools internals.
- Do NOT relitigate the hardcoded `custom` override slot, the `session/shutdown` deferral, or the no-fall-back-on-missing-ack rule.

### Watch out for (lessons from H0)

- **Vite import-analysis wraps `SyntaxError` from dynamic imports.** vitest tests that exercise `loadConfig` parse-failure paths will see a generic `Error` with message starting `"Failed to parse source for import analysis…"`, not a real `SyntaxError`. The H0 `isParseError` heuristic in `packages/config/src/define-config.ts` already handles this — if you write similar dynamic-import code in H1, copy that pattern.
- **The `npm run typecheck` baseline is 149 errors, all in `src/ui/**` and `src/cli/commands.ts`.** None are H0/H1 territory. Don't try to fix them. Just don't add new ones in your touched files.
- **`@rn-dev/config` scaffolds `.mjs` not `.ts`** for H0. H2 (which introduces the daemon's Bun-backed `.ts` loader) should switch the scaffolder + remove the "needs a TS loader" branch in `runConfigValidate`. H1 doesn't need to touch this.
- **`vitest.global-setup.ts` builds both workspace packages.** If you add a third workspace package whose `main` points at `dist/`, add it to the build list there.
- **Auto-mode is comfortable for plan-editing but the user default-accepts security/architecture findings.** When the H1 plan reads "showstopper", treat it as a hard requirement — do not skip or defer.

### Open questions to flag if they arise

- If `split2` doesn't play nicely with Bun's child_process (Explore #2 verified Bun-compatibility but H1 is the first real exercise), pause and ask before swapping for a hand-rolled splitter.
- If the H1 LOC count comes in over ~2,500 (rough budget), pause and ask whether to split the SRP classes across two PRs.
- If the orphan-sweep test `tests/electron-smoke/hook-orphan.spec.ts` is flaky on macOS (no `pdeathsig`), flag it — the test must be deterministic; flakiness here masks a real safety regression.
- The H0 implementation surfaced a small heuristic for parse errors under vitest's vite-wrapped dynamic imports. If H1's subprocess parser hits a similar wrapper edge case, document the workaround in the same place rather than scattering matchers.

Today is 2026-05-03.

---

## Notes for the resumer (you, picking this up)

- **The previous worktree at `.claude/worktrees/zen-nash-73c0a1` was deleted** mid-session. Branch `claude/zen-nash-73c0a1` survives in the main repo's git database with the 5 H0 commits. Create a fresh worktree off it for H1 work.
- **Nothing has been pushed.** When you finish H1 and are ready, decide whether to push H0 + H1 as one stack (5 + N commits) or split into two PRs. The plan's review history is best served by one PR per phase.
- **The 04-30 plan + the H0 next-session prompt + all 15 review todos are now committed at `83ecb80`** (first commit of the current branch). They are NOT on `main` yet.
- Memory file `h0_implementation_complete.md` has the full H0 verification baseline and deviation list — start there for context, not from scratch.
