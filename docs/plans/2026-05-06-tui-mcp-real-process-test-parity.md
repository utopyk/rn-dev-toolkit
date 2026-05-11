# TUI + MCP real-process test parity

**Status:** M1 + M2 landed (MCP at parity); T1 (TUI) next.
**Date:** 2026-05-06
**Updated:** 2026-05-06 (post-M2)
**Predecessor:** the discussion that produced this doc — Electron has three test layers (vitest + tsc + playwright real-e2e), MCP has *one* real-process test, TUI has *zero*. The H2-followup memory entry exists because the green test pipeline missed bugs that manual acme verification surfaced. Same risk applies to MCP and TUI today.

## What "real-process parity" means

A test layer that:

1. **Spawns the actual production binary** as a subprocess (not in-process module imports).
2. **Drives it through its real wire protocol** (stdio JSON-RPC for MCP, ANSI-encoded keystrokes/output for TUI).
3. **Asserts on observable end-state** (RPC responses for MCP, screen buffer / file system / spawned-daemon state for TUI).
4. **Tears down cleanly** — no leaked daemons, no leaked subprocesses, no leftover sockets.

The Electron probe ([tests/electron-real-e2e/probe-real-build.spec.ts](../../tests/electron-real-e2e/probe-real-build.spec.ts)) is the reference. It catches what the in-process integration tests can't: process-boot ordering bugs, IPC framing mismatches, daemon disconnect races.

## Current state

### MCP — one real-process test exists

- [src/mcp/__tests__/session-logs-e2e.test.ts](../../src/mcp/__tests__/session-logs-e2e.test.ts) spawns the MCP server as a child via `StdioClientTransport`, drives via SDK `Client`, asserts `rn-dev/session-logs` round-trips fake-boot daemon log lines.
- Helper: [test/helpers/spawnMcpServer.ts](../../test/helpers/spawnMcpServer.ts) — production-quality, pairs with `spawnTestDaemon`.
- The other ~10 MCP test files exercise tool handlers in-process against mocked context — they prove handler logic but not server boot, stdio framing, or `connectToDaemonSession` startup ordering.
- 30+ tools registered ([src/mcp/tools.ts](../../src/mcp/tools.ts)) — only `rn-dev/session-logs` has real-process coverage.

### TUI — zero real-process tests

- Only [src/ui/__tests__/theme-provider.test.tsx](../../src/ui/__tests__/theme-provider.test.tsx) exists (one component, jsdom).
- Production entry: `rn-dev start` → [src/app/start-flow.ts](../../src/app/start-flow.ts) → React + OpenTUI render of [src/app/App.tsx](../../src/app/App.tsx).
- Surface: 7 wizard steps + MainLayout + DevSpaceView + LogViewer + Modal + SearchableList + ProfileBanner + ShortcutBar + StatusBar.
- `node-pty` is NOT a current dep — would need to be added.
- OpenTUI 0.1.x is alpha-grade — its ANSI output may not parse cleanly with off-the-shelf libraries.

## Phase M1 — MCP real-process gate expansion

**Cost:** small. Same pattern as session-logs-e2e, ~50 lines of test per scenario, helpers already in place.

### M1a — boot + tool listing
Spawn MCP against an empty fake-boot daemon. Assert `client.listTools()` returns the expected 30+ tool names. Catches: server fails to boot, tool registry assembly broken.

### M1b — `rn-dev/build` round-trip (fake-boot)
With `RN_DEV_DAEMON_BOOT_MODE=fake`, call `rn-dev/build` and assert it returns a structured result without errors. Catches: build-action wiring drifts away from the daemon's RPC schema.

### M1c — read-tool happy paths
`rn-dev/list-devices`, `rn-dev/get-profile`, `rn-dev/list-profiles`, `rn-dev/list-worktrees` against a fixture worktree. Asserts the read-side tools that agents actually use most return useful data. Catches: profile-store / device-list contract drift.

### M1d — session lifecycle
Call `rn-dev/start-session` then `rn-dev/stop-session`, assert state transitions. Catches: lifecycle wiring drift between MCP-shaped clients and the daemon's session machinery.

### M1e — error-path round-trip
Call `rn-dev/build` with malformed args; assert MCP returns a valid SDK error response (not a crashed transport). Catches: handler exceptions that break the transport instead of returning a structured error.

### M1f — module flags
Spawn MCP with `--enable-module:devtools-network` against a daemon with the module loaded; assert `rn-dev/modules-list` reflects the enable state. Catches: argv-parse → module-proxy contract drift.

### M1g — destructive consent gate
Call `rn-dev/modules-config-set` without `permissionsAccepted`; assert the server responds with the consent-required error. Then call again with `--allow-destructive-tools` set; assert success. Catches: a security regression that would let agents silently flip security toggles.

**Order:** M1a first (one-line scaffolding for everything else). M1b–M1g can land in parallel commits.

## Phase T1 — TUI real-process harness

**Cost:** medium. Foundation work has no precedent in this repo, so the first 2–3 sub-phases are about building the harness; coverage comes after.

### T1a — node-pty + screen reconstruction
Add `node-pty` to devDependencies. Build [test/helpers/spawnTuiHarness.ts](../../test/helpers/spawnTuiHarness.ts) that:
- Spawns `bun run src/index.tsx start --interactive` against a tmpdir worktree fixture.
- Captures pty output stream.
- Reconstructs an 80×24 screen buffer using a minimal ANSI/CSI parser (or a vetted library — `node-ansiparser` and `xterm-headless` are candidates worth a 30-min spike).
- Exposes: `screen()`, `send(keys)`, `wait(predicate, timeout)`, `stop()`.

**Risk:** OpenTUI may emit non-standard CSI sequences. If the off-the-shelf parsers struggle, fall back to **stream-substring matching** — assert that `<accumulated stdout>.includes(...)` rather than reconstructing a screen buffer. Less precise but unblocks coverage.

**Decision rule:** spike each parser for 30 min against a known wizard-step-1 capture. Pick the one that yields a sane buffer; fall back to substring matching if neither does. Document the choice in the helper file.

### T1b — wizard step 1 boots
Spawn the harness, wait for "Worktree" prompt visible, assert the worktree picker rendered. Catches: TUI fails to boot, theme initialization throws, `start-flow` wiring rot.

### T1c — wizard happy path → profile written
Send keystrokes through all 7 wizard steps (`WorktreeStep` → `BranchStep` → `PlatformStep` → `ModeStep` → `DeviceStep` → `OnSaveStep` → `PreflightStep`), assert `.rn-dev/profiles/*.json` is written with expected contents. Catches: any wizard regression that breaks profile creation — the H2 wizard scheme picker bug would have been caught here.

### T1d — main layout transitions
After wizard, assert `DevSpaceView` renders, panels are visible, status bar shows daemon state. Catches: post-wizard handoff regressions.

### T1e — modal + searchable list keystroke contracts
Trigger a modal (e.g., the destructive-action confirm), assert text + button focus, send Enter/Esc, assert modal closes. Same for SearchableList scrolling. Catches: keyboard-handler regressions that crash the TUI under normal use.

### T1f — log viewer scroll + dirty-mode build trigger (real-boot variant, gated)
Run with `REAL_BOOT_TUI=1` against the acme fixture. Assert build progress lines appear in the log panel within 60s. Mirrors the Electron real-e2e probe. **Long-running** (~5 min) — gate it behind an env flag, like the existing `REAL_BOOT_SMOKE`.

**Order:**
- T1a is gating — nothing else can land without the harness.
- T1b is the cheapest first test, validates the harness end-to-end.
- T1c is the highest-value-per-effort test (catches wizard regressions).
- T1d–T1f are incremental coverage, can land independently after T1c.

## Risks + open questions

1. **OpenTUI ANSI parseability** (T1a). If neither parser handles it, the harness falls back to substring matching, which is weaker but workable. Spike before committing to the harness shape.
2. **Test runtime budget.** M1a–M1g are each ~1-2s (fake-boot daemon). T1b–T1e are ~2-5s each. T1f is gated. CI total stays under 60s for the non-real-boot tier.
3. **Daemon leaks** (the loose end we just fixed in `probe-real-build`). Both M1 and T1 must call the same kill-pid-then-rmSync teardown. The `spawnTestDaemon.stop()` helper already does this for M1. T1's harness needs equivalent logic for the daemon Electron / the TUI spawns.
4. **OpenTUI's interaction with `node-pty`.** OpenTUI may set raw mode aggressively or write to `/dev/tty` directly; if it does, pty capture misses output. Mitigation: spike T1a with a hello-world OpenTUI app first.

## Order of work — what comes next

1. **Land M1a + M1b** as the smallest possible MCP-coverage commit. Validates the pattern scales beyond session-logs.
2. **Spike T1a** for half a day to pick the ANSI parsing approach. **STOP** at the spike result — share findings before proceeding to T1b.
3. After spike: T1b–T1c land (wizard happy path coverage).
4. M1c–M1g land in parallel as separate commits.
5. T1d–T1e land as separate commits.
6. T1f deferred until M1 + T1a–T1e are stable.
7. **Then** H3 starts.

## Out of scope

- Snapshot testing of TUI screen buffers. Brittle, hides intent. Prefer assertion-based tests.
- Replacing the existing `mcp-as-daemon-client.test.ts` integration test. It's faster and covers complementary territory (multi-client coexistence inside a single vitest process). Both layers stay.
- Cross-platform CI runners (Windows/Linux). Out of scope until somebody actually runs CI there.

---

## Post-landing notes — what M1 + M2 actually shipped (2026-05-06)

### M1 (closed)

| Sub-phase | What landed | Bugs surfaced + fixed |
|---|---|---|
| M1a | Tool-listing real-process gate | — |
| M1b | Read-tool round-trip (list-profiles/get-profile/list-worktrees) | Missing `await` on `getWorktrees`/`listDevices`/`bootDevice`/`getCurrentBranch` in 8+ MCP and CLI handlers; unbound `flags` reference in `buildModulesLifecycleTools` |
| M1c | modules-list daemon-RPC round-trip | Lifecycle naming-mismatch identified (resolved in M2-prereq) |
| M1d | Unknown-tool error path survives without tearing transport | — |
| M1e | Consent gate + `--allow-destructive-tools` flag | Commander rejected MCP flags as "too many arguments" — `--allow-destructive-tools` and `--enable-module:*` were unusable in practice |

### M2 (closed)

| Sub-phase | What landed | Bugs surfaced + fixed |
|---|---|---|
| M2-prereq | Session lifecycle (`start-session`/`stop-session`/`list-sessions`) wired to actual daemon RPCs (`session/start`/`session/stop`/`session/status`) | Hyphen-vs-slash RPC name mismatch; agents could not start/stop sessions through MCP |
| M2a | rn-dev/build refactored to use daemon's builder/build RPC (no longer blocks MCP for 10+ min on execSync); BuilderClient gains a 500-entry event ring; new `rn-dev/build-status` tool surfaces line/progress/done events to agents; `builder/*` added to MCP's events/subscribe kinds filter | macOS `/private/var` ↔ `/var` symlink trap in daemon's projectRoot validator (real users on iCloud/Documents would have hit this) |
| M2a-probe | PROBE-gated `probe-real-build-mcp.spec.ts` mirrors the Electron probe — spawns MCP against acme, polls build-status every 10s for 12 min | not run yet — set `PROBE=1` to invoke |
| M2b | Module-contributed tools proxy (`<moduleId>__<tool>`) round-trip via modules/host-call. Two new env-var test seams (`RN_DEV_DAEMON_TEST_EXTRA_MANIFEST`, `RN_DEV_TEST_BUILTIN_ALLOWLIST`) so subprocess daemons can register synthetic manifests without subprocess module loading | — |

### Still open

- **Real devtools network capture through MCP.** Requires real-boot mode + an installed `@rn-dev-modules/devtools-network` in the project + a running app emitting traffic. M2b's module-proxy test pins the wire shape; a separate real-boot probe (analog of `probe-real-build-mcp.spec.ts` but for devtools) is the next layer. Not blocking; flagged for follow-up.
- **Long-tail tool e2e.** ~10 tools shell out (`run-lint`, `run-typecheck`, `clean`, `install-deps`, `select-device`, `boot-device`, etc.) and don't have dedicated probes. The patterns from M1a–M2b cover their wire shapes; per-tool tests would be over-engineering.
- **TUI (T1).** Untouched. Spike + harness + wizard coverage remains.
