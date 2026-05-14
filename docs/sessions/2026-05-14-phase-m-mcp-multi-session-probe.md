# Phase M — MCP multi-session client + PROBE=1 verification — Session Handoff (2026-05-14)

## What landed

- `e6c016d` feat(mcp): Phase M1 — McpContext sessions Map + per-tool sessionId routing + `resolveSession` DR-2 helper
- `c5a0aed` feat(mcp): Phase M2 — `rn-dev/list-sessions` queries daemon `sessions/list` RPC
- `84e349d` feat(mcp): Phase M3 — `rn-dev/start-session` accepts `profileName` for cold-start + additional-attach, `ctx.attachSession` callback wires new session into shell
- `6ca4c3f` feat(mcp): Phase M4 — `rn-dev/stop-session` destructive gating + `permissionsAccepted`
- `79455a9` feat(mcp): Phase M5 — `rn-dev/audit-tail` readback tool over `~/.rn-dev/audit.log`
- `7d14c0a` test(mcp): Phase M6 — 3 PROBE=1 specs (cold-start / build-multi / devtools-multi)
- `feb63e1` docs: Phase M complete — consolidated solution doc at `docs/solutions/2026-05-16-phase-m-mcp-multi-session.md`
- `75e6cc8` test(mcp): Phase M6 — cold-start probe writes its own throwaway profile (fresh acme has zero profiles on disk)
- `c464d4d` fix(mcp): Phase M1 follow-up — thread sessionId into RPC payloads (PROBE-surfaced wire-contract gap)

**Total: 9 commits, 27 commits ahead of origin (local-only per [memory/workflow_local_only_personal_account.md](../../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/workflow_local_only_personal_account.md)).**

## Decisions made

- **Scope: full M1-M6 per § C2 deepening insights**, not the brief's shorter M1-M3 shape. Trade-off: ~2-3 days vs ~1.5 days. Reasoning: deepening's per-tool audit + audit-tail + cold-start `profileName` close real parity gaps that the brief's coarser "every tool gets sessionId?" approach left open.
- **Reload/dev-menu lose untargeted fallbacks.** Pre-M1 these tools fell through to raw `adb shell input keyevent 82` and metro HTTP `/reload` when the daemon path failed. Under multi-session both fallbacks would silently target whichever app the device was showing — wrong session. M1 makes the daemon RPC the single source of truth; `E_NO_SESSION` if no daemon attached.
- **Metro-status returns `E_NO_SESSION` instead of `{ status: "not-running" }`** when no session attached. Pre-M1 silent fallthrough hid the distinction between "no session" and "session has no metro." Multi-session needs the contract explicit.
- **Module-proxied tools (`devtools-network__*`, `metro-logs__*`) get same `sessionId?` schema injection as built-ins**, via shared `withSessionIdProp` + `resolveSession` exports from tools.ts. Saves a duplicate helper in module-proxy.ts.
- **Audit-tail's `sessionId` filter is forward-compat**, documented as such. v1 audit entries don't carry sessionId so the filter returns `[]` until session-scoped audit kinds (`session-start`, `session-stop`, …) are added.
- **Stop-session destructive gating matches `modules-config-set` pattern** (per-call `permissionsAccepted` or global `--allow-destructive-tools`). Parity with the existing destructive surface — agents know the shape.

## Verification needed before next slice

**PROBE=1 verification status (2026-05-14, acme + iPhone UDID `00008130-001A653A3E11001C`):**

| Probe | Status | Duration | Notes |
|---|---|---|---|
| `probe-cold-start-mcp` | ✅ PASS (2/2) | 11s | Discovery loop + destructive gate |
| `probe-real-build-mcp-multi` | ✅ PASS | 47s | After `c464d4d` fix. Both sessions ack `{ok:true}`, BuilderClient rings independent (500 events each), E_SESSION_AMBIGUOUS works |
| `probe-real-devtools-mcp-multi` | ❌ FAIL | 8s | **Both sessions return same `proxyPort: 50638` — module subprocess state shared across sessions** |

Re-run command:
```bash
PROBE=1 npx vitest run \
  src/mcp/__tests__/probe-cold-start-mcp.spec.ts \
  src/mcp/__tests__/probe-real-build-mcp-multi.spec.ts \
  src/mcp/__tests__/probe-real-devtools-mcp-multi.spec.ts
```

**Phase M acceptance NOT met until devtools-multi goes green.** Per user feedback (see [memory/feedback_parallel_instance_requirement.md](../../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/feedback_parallel_instance_requirement.md)): the application is built for 4 concurrent sessions (1-2 real devices + 2-3 emulators), human + AI in parallel. Cross-session contamination of module state is a BLOCKER, not an architectural footnote.

**Standard gate (non-PROBE, runs in <30s):**
```bash
npx vitest run                                   # expect 1468 pass + 6 skipped
npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l  # expect 4
npx tsc --noEmit -p electron/tsconfig.json       # expect clean
npm run test:smoke                                # expect 13 pass + 4 skipped
```

## Parked / known issues

- **TUI's existing adapters (`builder-adapter.ts`, `metro-adapter.ts`, `devtools-adapter.ts`) don't thread sessionId in their RPC payloads.** Pre-existing, fine today because TUI is single-session and the daemon's back-compat fallback covers them. Phase T will need this same fix when it goes multi-session. Tracked at [code_fact_daemon_resolves_session_by_payload.md](../../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/code_fact_daemon_resolves_session_by_payload.md).
- **Daemon registry integration test flake** (`src/daemon/__tests__/registry.test.ts > findActiveDaemons surfaces a live daemon and skips a stale entry`) fails sporadically under full-suite vitest parallel load, passes in isolation. Pre-existing, unrelated to MCP.
- **Pre-existing smoke-suite daemon leaks** — D7's own teardown asserts no-leak; smoke (`tests/electron-smoke/`) still leaks. Retrofit deferred.
- **D7 release-walk-under-real-3p-module follow-up** — needs a curated 3p module on disk.

## Next-session prompt

```
Pick up at: root-cause + fix per-session module subprocess isolation, then re-run all 3 PROBE=1 specs green.
Session doc: docs/sessions/2026-05-14-phase-m-mcp-multi-session-probe.md
Repo: /Users/martincouso/Downloads/rn-dev-cli, branch main @ c464d4d, 27 commits ahead of origin (local-only, do not push).

Phase M code (M1-M6) is landed. PROBE=1 status against acme:
- probe-cold-start-mcp ✅ PASS
- probe-real-build-mcp-multi ✅ PASS (after sessionId-in-payload fix c464d4d)
- probe-real-devtools-mcp-multi ❌ FAIL — both sessions return same proxyPort=50638

The fail is the BLOCKER. Per memory/feedback_parallel_instance_requirement.md, rn-dev's
multi-session target is 4 concurrent instances (1-2 real + 2-3 emulators); shared module
subprocess state across sessions breaks that flow. Do NOT proceed to Phase E until
devtools-multi probe passes.

Before starting:
- pkill -9 -f "src/index.tsx daemon"; lsof -aP -i :8081/8082/8099/8100 -sTCP:LISTEN -t | xargs -r kill -9
- Re-run all 3 PROBE specs from acme (cwd doesn't matter, probes hardcode ACME path):
    PROBE=1 npx vitest run src/mcp/__tests__/probe-cold-start-mcp.spec.ts src/mcp/__tests__/probe-real-build-mcp-multi.spec.ts src/mcp/__tests__/probe-real-devtools-mcp-multi.spec.ts
  Expect cold-start + build-multi green; devtools-multi fail with proxyPort matching across sessions.
- Read docs/sessions/2026-05-14-phase-m-mcp-multi-session-probe.md end-to-end.

Highest-leverage investigation order (per memory/code_fact_module_host_per_session.md 2026-05-14 update):
  1. registerModulesIpc dual-listener race — both sessions' modules dispatchers attach to the same ipc.on("message"), both fire on every modules/call. Whichever manager replies first wins. (src/app/modules-ipc.ts:1184)
  2. ModuleRegistry.loadUserGlobalModules filesystem cache or scopeUnit="global" key collision (src/modules/registry.ts).
  3. Module subprocess port allocator — does devtools-network's proxy bind a deterministic port or ephemeral? If deterministic, two subprocess instances would EADDRINUSE one of them.

Concrete first step:
  Read src/app/modules-ipc.ts:1048-1200 (registerModulesIpc) and observe how a second session's
  dispatcher interacts with the existing listener. Add console.log to both managers to see which
  one actually handles the modules/call response when two sessions are attached.

Fallback if module-system fix grows beyond one session:
  - Land just the smallest scope-isolated fix that produces distinct proxyPorts across two sessions
  - Document the rest as a separate plan
  - Re-run PROBE=1 to confirm devtools-multi green
  - Then proceed to Phase E

Parked:
- Phase E (renderer multi-session UI), ~3-4 days, unblocks after probes green
- Phase T (TUI multi-session), can defer
- TUI adapter sessionId-in-payload fix (Phase T prerequisite)
- Smoke-suite daemon leaks
```

## Related memories

- [[phase-m-complete]] — Phase M state + commit list + open blocker
- [[code-fact-daemon-resolves-session-by-payload]] — the wire-contract fix that landed during M6 PROBE
- [[code-fact-module-host-per-session]] — extended 2026-05-14 with the subprocess-state-sharing finding
- [[feedback-parallel-instance-requirement]] — user's 4-instance use case framing
- [[real-boot-is-the-only-gate]] — both M-phase bugs only surfaced under PROBE=1, not unit/integration
- [[feedback-test-parity-no-gaps]] — never accept a probe gap; build the fix
- [[workflow-local-only-personal-account]] — no push, no PR, no review chain on this account
- [[single-branch-single-worktree]] — main only, no sibling branches
