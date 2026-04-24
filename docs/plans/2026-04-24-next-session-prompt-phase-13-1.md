# Next-Session Prompt — Phase 13.1 (Daemon Binary + Lifecycle Primitives)

**Paste the block below at the start of the next session.**

---

We're starting Phase 13 of the module system for rn-dev-cli — the
**daemon refactor**. A design spec was brainstormed + reviewed on
2026-04-24 and sits on branch `design/daemon-refactor`:

- **Spec**: `docs/superpowers/specs/2026-04-24-daemon-refactor-design.md`

**Context (one-paragraph recap):** today the TUI path creates an
`IpcServer` socket at `<project>/.rn-dev/sock` and exposes all
services behind it (good), but the Electron GUI re-implements service
orchestration in-process without any socket (bad — MCP and CLI can't
see GUI sessions). That was surfaced when we wired
`claude mcp add rn-dev ...` and the MCP tools returned
`{error: "no-session"}` even while the GUI was actively capturing
logs + network activity. The refactor unifies under a **per-worktree
detached daemon** that owns all services; Electron/TUI/MCP become
equal thin clients. Session survives GUI quits. See the spec for the
full architecture.

## This session: Phase 13.1 only

Scope — fully additive, nothing in the existing tree uses the daemon
yet:

1. New `src/daemon/` folder with:
   - `index.ts` — daemon entry. `fork + setsid + chdir + close stdio`
     (detach); `flock` on pid file; `IpcServer` listen; `SIGTERM` +
     `SIGINT` handlers for graceful shutdown; `--foreground` flag
     that skips the detach for debug.
   - `spawn.ts` — **client-side primitive** `connectToDaemon(worktree)`
     returning `IpcClient`. Auto-spawns daemon if socket missing or
     stale. Used by Electron/TUI/MCP in later phases; not yet wired.
   - `supervisor.ts` — placeholder; session logic lands in 13.2.
   - `session.ts` — placeholder.
   - `__tests__/` — integration tests #1 and #2 (see below).
2. New CLI command `rn-dev daemon <worktree>` in `src/cli/commands.ts`
   — hidden from `--help` (infra command). Also optional
   `rn-dev daemon-shutdown <worktree>` helper that sends `daemon/shutdown`.
3. RPCs implemented:
   - `daemon/ping` — returns `{daemonVersion, hostRange}`.
   - `daemon/shutdown` — graceful exit; unlinks pid + sock.
4. Test fixture: `test/fixtures/minimal-rn/` — stub RN project
   (barebones `package.json`, Metro config, empty entry file). Just
   enough for later phases; Phase 13.1 only uses it as a worktree
   argument, doesn't boot Metro.
5. Helper `test/helpers/spawnTestDaemon.ts` — returns
   `{ client, stop }`; used by all five integration tests across
   Phase 13.

## Merge gate for 13.1

Both integration tests pass, end-to-end, against a real daemon
process:

### Test #1 — Daemon lifecycle

- Spawn `rn-dev daemon <fixture>` directly.
- Assert `<fixture>/.rn-dev/sock` + `.rn-dev/pid` files appear within 5s.
- Send `daemon/ping` over the socket → assert
  `{daemonVersion, hostRange}` response.
- `SIGTERM` → assert both files unlinked + exit(0).

### Test #2 — Second-spawn detection (flock arbitration)

- Spawn daemon A → wait for ready.
- Attempt to spawn daemon B on the same worktree.
- Assert B exits silently (non-zero) with stderr error along
  "already running, pid=N".
- Verify pid file still references A and A is unaffected.
- Reuse `src/core/module-host/lockfile.ts` pattern for the
  `flock(LOCK_EX)` on pid file.

## Verification before PR

- vitest: new `src/daemon/__tests__/` suites pass; existing suite
  unchanged (873/0 baseline pre-Phase-12.1 → 883/0 after 12.1 → will
  grow by the number of new tests).
- `bun run typecheck`: still green (150/0/0/0/0).
- `bun run build`: green.
- Manual smoke: `bun run /path/to/src/daemon/index.ts <some-dir>` +
  `rn-dev daemon-shutdown <some-dir>` round-trips cleanly.

## TDD discipline

- First commit on the feature branch: the two integration tests
  written and **failing** (daemon doesn't exist yet).
- Implementation commits follow. Do not land the branch until both
  are green.

## After merging 13.1

- Write `docs/plans/2026-04-??-phase-13-1-daemon-lifecycle-handoff.md`.
- Run parallel reviewers (Kieran TS + Architecture + Security +
  Simplicity). Apply P0/P1. Squash-merge.
- Queue `docs/plans/2026-04-??-next-session-prompt-phase-13-2.md`
  for **Phase 13.2 — services move into the daemon**.

## Branching

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-13-1-daemon-lifecycle
```

The `design/daemon-refactor` branch holds the spec; it's been
pushed for visibility but isn't required to merge before coding
begins. If you want the spec in main: `git checkout main &&
git merge --no-ff design/daemon-refactor` OR open it as a
design-only PR and merge. Either is fine.

## Baselines to match or improve on

- vitest: **883 / 0** (pre-13.1)
- tsc root: **150** (pre-existing wizard errors)
- tsc electron: **0**
- tsc per-module (3): **0 / 0 / 0**
- `bun run build`: green
- `bun run typecheck`: green

## Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- `.claude/` and SDK `dist/` are gitignored.
- Every 3p tool wire name carries the `<moduleId>__` prefix.
- `config-set` audit entries record patch *keys*, never *values*.
- Module subprocesses use detached process groups (signal isolation).
  Daemon will use `prctl(PR_SET_PDEATHSIG)` on Linux for child cleanup
  on ungraceful daemon death; macOS has no direct equivalent so an
  orphan-sweep-on-spawn complements it. Neither lands in 13.1 —
  that's 13.2 (when the daemon starts owning module subprocesses).
- The spec's success criterion #1 (`grep` for `new MetroManager` etc.
  outside `src/daemon/`) will NOT pass at end of 13.1 — those still
  live in their current places. 13.1 ships the empty-but-working
  daemon; 13.2 moves the services in.

---

## The full queue (what else is left besides daemon refactor)

Organized by what unlocks/blocks what.

### Can ship in parallel with daemon refactor (in-repo, no external deps)

- **Phase 12.2 — bootstrap-surface bundle.** `loadModuleManifest` +
  `isModuleEntry` + `requireCapability` SDK extractions + `MAX_LIST_LIMIT`
  dedup. Reviewer-recommended follow-ups from PR #11 + #12. Prompt at
  [docs/plans/2026-04-23-next-session-prompt-phase-12-2.md](2026-04-23-next-session-prompt-phase-12-2.md).
- **Phase 13 D — prototype-chain hardening.** `hasOwnProperty.call`
  gating across all SDK narrowers. Security P2 follow-up from PR #11;
  follow-up task chip already spawned.

### Blocked on Martin's external setup

- **Phase 12 Option C — npm publishing.** Blocked on:
  1. `@rn-dev-modules` scope registered on npmjs.org.
  2. `rn-tools.com` DNS live with a static host serving `modules.json`.
  3. Version decision (publish at `0.1.0` vs cut `0.0.1`/pre-release).
  Full steps documented in
  [docs/plans/2026-04-23-next-session-prompt-phase-12.md](2026-04-23-next-session-prompt-phase-12.md)
  under "If Option C (npm publishing)".

### Deferred from Phase 12 picks

- **Phase 12 Option A — Lint & Test 3p extraction.** The last
  TUI-only built-in with a clear MCP surface. Completes the
  built-in → 3p migration for all three log/capture modules.
- **Phase 12 Option B — `keepData` retention + GC sweep.** Today's
  uninstall flow leaks configs + auth + registry cache. Ops task.

### From the original 12-phase plan, not yet touched

- **Plan Phase 9 — Flow recording + replay + Maestro YAML export.**
  Agent-native recorder layered on top of device-control. Big feature.
- **Plan Phase 10 — `uses:` module dependencies.** Cross-module RPC
  via `host.call`. Manifest schema reserved since Phase 1; runtime
  not implemented.
- **Plan Phase 11 — polish, docs, threat model.** User-facing
  README, module author guide, public threat model doc.

### Honest architectural state after Phase 13 daemon refactor ships

The module system's contract + runtime + security posture + topology
will all be done. What's left is ergonomics (12.2), publishing (12-C),
one more migration (Option A), one ops task (Option B), two big
features (Plan 9 flow recording, Plan 10 `uses:`), and documentation
(Plan 11). None is a structural risk.
