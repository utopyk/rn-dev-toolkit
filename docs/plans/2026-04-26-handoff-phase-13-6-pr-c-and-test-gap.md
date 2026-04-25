# Handoff — Phase 13.6 PR-C shipped, real-boot regression + test-gap surfaced

**Date:** 2026-04-25
**Predecessor:** [PR #24](https://github.com/utopyk/rn-dev-cli/pull/24) merged as [`7a466b2`](https://github.com/utopyk/rn-dev-cli/commit/7a466b2)
**Next-session prompt:** [`2026-04-26-next-session-prompt-phase-13-6-followup.md`](2026-04-26-next-session-prompt-phase-13-6-followup.md) — already drafted, but UPDATE it with the items below before the next session.

---

## What shipped this session

**Phase 13.6 PR-C** — multiplexed daemon channel + MCP-as-daemon-client. Lean D design: events/subscribe socket multiplexes filtered events + bidirectional RPCs gated by `supportsBidirectionalRpc: true` flag. Spec at [`docs/superpowers/specs/2026-04-25-multiplexed-daemon-channel-design.md`](../superpowers/specs/2026-04-25-multiplexed-daemon-channel-design.md); plan at [`docs/superpowers/plans/2026-04-25-multiplexed-daemon-channel-plan.md`](../superpowers/plans/2026-04-25-multiplexed-daemon-channel-plan.md).

**Wire changes:**
- `events/subscribe { profile, kinds?, supportsBidirectionalRpc? }` — new optional fields
- New error codes: `E_RPC_NOT_AUTHORIZED`, `E_SUBSCRIBE_INVALID_KINDS`
- `RN_DEV_HOSTCALL_BIND_GATE` flipped **default-on** (was env-opt-in)
- `IpcClient.subscribe` returns `{ initial, send, close }` — multiplexer
- `DaemonSession.client` narrowed to `IpcSender` via deferred-proxy pattern
- MCP server flipped from raw IpcClient → `connectToDaemonSession({ kinds: ["modules/*"] })`
- `connectToDaemonSession` auto-appends `session/status` to caller-supplied kinds (so boot handshake completes)
- `ModuleHostClient` constructor split to `(sender, rawClient, idGen)` — `subscribeToEvents()` keeps using rawClient for independent panel-bridge stream
- New `bindSender(moduleId)` method on `ModuleHostClient`
- Electron panel IPC handler: bind-on-first-host-call per moduleId

**Reviewer round** (Kieran TS + Architecture + Security + Simplicity, 4 parallel agents):
- 4 P0s, all fixed pre-merge (most critical: Security found Node EventEmitter has no propagation-stop, so the bidirectional gate was BYPASSABLE for the entire `modules/*` + `marketplace/*` surface — `subscribeRegistry` plumbed into `registerModulesIpc`)
- 8 P1s applied
- Several P2s deferred to follow-up (cosmetic field renames, `tryIpcAction` helper, layer-placement debate on session/status auto-append)

**Final automated state:**
- vitest **1014/1014**
- tsc root 149 (pre-existing wizard, unchanged)
- tsc electron 0
- bun build green
- playwright **10/10**

---

## Bugs surfaced AFTER merge (not caught by the test grid)

### Bug 1: Real `npm run dev:gui` boot fails to attach daemon session

**Symptom:**
- `cd /Volumes/external-disk/Projects/rn-dev-cli && npm run dev:gui`
- Select a profile via the wizard
- Tool output: `Failed to attach daemon session: connectToDaemonSession: session did not reach "running" within 30000ms`

**What we know:**
- The 30s timeout fires in `src/app/client/session.ts::connectToDaemonSession` waiting for the `session/status: running` edge
- Either the boot is hanging, or the running event isn't reaching the renderer
- This is a REAL-boot regression. Playwright `RN_DEV_DAEMON_BOOT_MODE=fake` smoke passes 10/10; that path bypasses the supervisor's actual Metro/devtools/builder boot chain
- Likely candidates (untested):
  - The deferred-proxy timing (resolvedSend wired AFTER subscribe response — could events arriving with the response race?)
  - The new pre-dispatch bidirectional check accidentally rejecting an event-routing message
  - `connectToDaemonSession`'s auto-append of `session/status` to kinds interacting with another code path
  - Phase 13.5 PR-A's supervisor.attach refcount under real boot — fake-boot might not exercise the same code paths
  - A subtle issue in `handleEventsSubscribe`'s listener registration ordering after our changes

**Diagnostic methods to try first:**
- Run daemon directly: `bun run dist/index.js daemon /Users/martincouso/Documents/Projects/movie-nights-club --foreground` and watch stdout
- Check `~/.rn-dev/registry.json` to see if a daemon registered after `dev:gui`
- Add `console.log` to `src/daemon/index.ts::handleEventsSubscribe` (parseKinds → register → attach call → attach result) and `src/daemon/supervisor.ts::attach` (state transitions)
- Add `console.log` to `src/app/client/session.ts::connectToDaemonSession` (incoming events with kind)

**Do NOT bypass:** the bidirectional gate, the kinds filter, or the gate-default-on flip. Those are correctness-critical. The fix should preserve them.

### Bug 2: Settings shows stale "no default profile" after wizard completes

**Symptom:** Settings tab shows `Failed to load config: E_CONFIG_SERVICES_PENDING: No default profile is configured for this project. Run the setup wizard to create one.`

**What we know:**
- This is the older `currentAbortReason` from the initial no-profile launch sticking around (set in `electron/ipc/index.ts::abortModulesClient`)
- Cleared on a successful `setModulesClient`
- Since Bug 1 prevents a successful `setModulesClient`, the abort reason persists
- **This bug is downstream of Bug 1** — fixing Bug 1 likely fixes Bug 2. But verify after the fix; the abort-reason-clearing path may have its own issue.

---

## Test-strategy gap (the deeper problem)

The test grid I built is **too synthetic to catch real-world regressions.** Every layer was running `RN_DEV_DAEMON_BOOT_MODE=fake`:

- Playwright smoke: fake daemon, no real Metro spawn
- Keystone integration test (`mcp-as-daemon-client.test.ts`): fake daemon
- Channel-identity test: fake daemon
- Bidirectional enforcement test: fake daemon
- All session-multiplex / session-disconnect / session-release tests: fake daemon

The grid proves **"the wire shape works"** but never proves **"a real boot reaches running."**

Reviewer subagents read code, not behavior. They're great at type drift, dead code, layering. They can't catch "supervisor-attach + multiplex-channel interaction silently breaks the running edge in production." Adding more reviewer agents would NOT have caught Bug 1. Adding a real-boot smoke would.

### What "real test" needs to look like

A smoke that:
- Boots an actual RN app (the movie nights app — see below)
- Targets a running iOS Simulator OR Android emulator
- Asserts `connectToDaemonSession` reaches `running` (not just gets a subscribe ack)
- Asserts `metro/log` events flow through the multiplexed channel
- Asserts a `modules/host-call` round-trips through the bind-sender → host-call binding-identity path against a real registered module
- Optionally: asserts `instances:create` after a no-profile launch attaches cleanly without restart (Bug 2 regression net)

### The movie nights app (already wired)

`electron/main.ts:92` has the hardcoded fallback:
```typescript
?? await detectProjectRoot('/Users/martincouso/Documents/Projects/movie-nights-club')
```

This is Martin's RN test app — already the default project root when `RN_DEV_PROJECT_ROOT` env is unset and `process.cwd()` doesn't resolve to an RN project. The next-session smoke should target it (or a copy) running against a booted simulator/emulator.

### Test-grid additions to make

1. **Real-boot smoke** — `tests/electron-smoke/real-boot.spec.ts` (new file). Skip on CI without a simulator; run locally. Boots Electron WITHOUT `RN_DEV_DAEMON_BOOT_MODE=fake`, against a real RN fixture (movie nights or a smaller copy), with a simulator already running. Asserts the running edge reaches the renderer within a generous timeout (90s).
2. **Daemon-direct boot test** — `src/daemon/__tests__/real-boot.test.ts`. Spawns the daemon as a foreground subprocess (not the fake-boot path), subscribes via raw IpcClient, waits for `session/status: running`, asserts metro is genuinely listening on the profile port. Slow (~30s) but pinned.
3. **Modify the existing keystone test** to optionally run against real boot (env-gated) so the binding-identity property is verified end-to-end.

### Reviewer-pattern lesson

The 4-reviewer parallel round is high-value for code quality and architectural integrity. **It is not a substitute for a real-app smoke test.** Future PRs that touch the daemon boot path or wire protocol need a real-boot smoke as their merge gate, not just the synthetic test grid.

---

## What I did this session

1. **Brainstormed** the multiplexed channel design with Martin (Lean D vs sibling RPC vs no-flag — settled on Lean D for refcount-invariant preservation)
2. **Wrote spec + plan** with reviewer rounds (single-agent reviewers caught minor clarifications)
3. **Implemented PR-C in 12 commits + 6 fix commits** via subagent-driven development:
   - Phase 1 (daemon-side): `SubscribeRegistry`, kinds parser/matcher, `handleEventsSubscribe` integration, pre-dispatch enforcement, admin-action rejections
   - Phase 2 (client multiplexer): `IpcClient.subscribe` send/correlate/timeout/close-mid-flight/orphan/concurrent
   - Phase 3 (DaemonSession): flag + kinds option, deferred-proxy pattern, adapter narrowing, `ModuleHostClient` constructor split
   - Phase 4 (gate flip): default-on, env-flag-as-off-switch
   - Phase 5 (MCP): flip to `connectToDaemonSession`, drop standalone `subscribeToModuleChanges`
   - Auto-append `session/status` to kinds filter (design discovery during keystone test)
   - Drop unused `boundModules` cache (YAGNI — MCP doesn't actually call host-call)
   - Sidebar aria-labels + Electron user-data-dir isolation (playwright fix during Task 4.2)
4. **Reviewer round** (Kieran TS + Architecture + Security + Simplicity in parallel)
5. **Fixed 4 P0s + 8 P1s pre-merge** in 6 commits (most critical: Security gate-bypass via EventEmitter)
6. **Squash-merged** PR #24 as `7a466b2`
7. **Wrote** [next-session prompt](2026-04-26-next-session-prompt-phase-13-6-followup.md) for follow-up items
8. **Surfaced the test-strategy gap** (this doc) when Martin manually tested `npm run dev:gui` and the daemon attach failed

## What's left (UPDATED)

### Now blocking — fix before more PR-C-derivative work

1. **Bug 1: Real-boot daemon attach failure.** Identify root cause and fix. Manual `npm run dev:gui` against `movie-nights-club` must reach `running`.
2. **Real-boot smoke test.** Add to `tests/electron-smoke/` or a new directory. Targets a running simulator + the movie nights app. Becomes the merge gate for PR-E and any future daemon-protocol change. (See "Test-grid additions to make" above for shape.)
3. **Bug 2 verification.** After Bug 1 is fixed, confirm Settings clears its abort reason on successful boot. If not, investigate `electron/ipc/index.ts::setModulesClient`'s clearing path.

### Phase 13.6 follow-up (queued in `2026-04-26-next-session-prompt-phase-13-6-followup.md`)

Lower priority than the bugs above:

- **PR-E** packaged Electron daemon entry (~30 LOC, deferred from 13.5)
- **`instance:retryStep`** daemon RPC (P0 user-visible, deferred from 13.5)
- **PR-C reviewer follow-ups** (cosmetic field rename, `tryIpcAction` helper, session/status auto-append layer debate, teardown-ordering test)
- **`session/start` migration** (Simplicity P0-3 carry-cost from PR-A)
- **Pid-recycling defense + consumer-side socket validation** (PR-B reviewer carry-overs)
- **Audit-log lifecycle entries** (PR-A + PR-B reviewer carry-overs)
- **IpcServer.stop's 500ms grace** investigation (PR-A reviewer carry-over)
- Various P2 advisory items in PR #24's comment

### Original plan, deeper backlog

- **Phase 12 Option C** npm publishing (DNS-blocked on `rn-tools.com` + `@rn-dev-modules` scope setup)
- **Phase 12.2** bootstrap-surface bundle (`loadModuleManifest`/`isModuleEntry`/`requireCapability` SDK extractions)
- **Phase 13 D** prototype-chain hardening across narrowers (Security P2 carryover from earlier phases)
- **Phase 12 Option A** Lint & Test 3p extraction
- **Phase 12 Option B** `keepData` retention + GC sweep
- **Original plan Phases 9–11** (flow recording + Maestro YAML export, `uses:` module deps, polish/docs/threat model)

---

## Suggested next-session opening

```
We need to fix a real-world regression introduced by Phase 13.6 PR-C
(merged 2026-04-25 as 7a466b2, PR #24).

Symptoms:
  1. `npm run dev:gui` → select profile → 30s timeout:
     "connectToDaemonSession: session did not reach 'running' within 30000ms"
  2. Settings shows stale E_CONFIG_SERVICES_PENDING (downstream of #1)

The PR-C test grid is too synthetic — every test runs against
RN_DEV_DAEMON_BOOT_MODE=fake. The real Metro/devtools/builder/watcher
boot chain isn't exercised. Reviewer subagents (Kieran TS, Architecture,
Security, Simplicity, all parallel) didn't catch this — they read code,
not behavior.

Read the handoff:
docs/plans/2026-04-26-handoff-phase-13-6-pr-c-and-test-gap.md

Tasks for this session:
  1. Reproduce the failure (npm run dev:gui against
     /Users/martincouso/Documents/Projects/movie-nights-club, which
     electron/main.ts:92 already hardcodes as the dev fallback)
  2. Diagnose the root cause (likely candidates listed in the handoff)
  3. Fix it (without bypassing PR-C's correctness properties: bidirectional
     gate, kinds filter, gate-default-on)
  4. Add a real-boot smoke test that would have caught this (covering
     real Metro spawn + reaching the running edge + at least one
     host-call binding-identity round-trip). Targets a running
     simulator + the movie nights app.
  5. Verify Bug 2 (Settings stale abort reason) is fixed by Bug 1's fix.

After bug + smoke test land, queue Phase 13.6 PR-E (packaged Electron
daemon entry) + instance:retryStep, with the new real-boot smoke as
the merge gate.
```

---

## References

- PR #24: https://github.com/utopyk/rn-dev-cli/pull/24 (merged as `7a466b2`)
- Spec: [`docs/superpowers/specs/2026-04-25-multiplexed-daemon-channel-design.md`](../superpowers/specs/2026-04-25-multiplexed-daemon-channel-design.md)
- Plan: [`docs/superpowers/plans/2026-04-25-multiplexed-daemon-channel-plan.md`](../superpowers/plans/2026-04-25-multiplexed-daemon-channel-plan.md)
- Phase 13.5 handoff (predecessor): [`2026-04-25-module-system-phase-13-5-handoff.md`](2026-04-25-module-system-phase-13-5-handoff.md)
- Phase 13.6 follow-up prompt: [`2026-04-26-next-session-prompt-phase-13-6-followup.md`](2026-04-26-next-session-prompt-phase-13-6-followup.md)
- Movie nights app fallback: `electron/main.ts:92` — hardcodes `/Users/martincouso/Documents/Projects/movie-nights-club`
