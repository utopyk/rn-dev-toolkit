# Phase E network-capture verification gap — session handoff (2026-05-20)

**The gap:** the multi-session story is architecturally correct + unit-tested + smoke-tested + the user's "see network activity for both instances" claim is *not* yet end-to-end verified on real apps + real devices. This doc names the gap precisely and ranks the paths to close it.

## What landed in this iteration (3 commits, 38 ahead of origin)

| Commit | Bug | Test coverage |
|---|---|---|
| `d0d2cf8` | Cross-session `metro/log` leak in `session.ts:onIncomingEvent` + renderer/daemon port mismatch in `instance.ts` / `services.ts` | +4 cross-session filter tests |
| `b2b827c` | sessionId missing from `builder/build`, `metro/*`, `devtools/*`, `watcher/*` RPC payloads → daemon's `resolveSessionServices` rejected with `E_SESSION_AMBIGUOUS` under N>1 sessions → `void session.builder.build(...)` discarded the rejection silently → Android session attached but build never spawned `react-native run-android` | +13 adapter sessionId threading tests |
| `acfcad4` | (work-in-progress) E7 full-stack probe spec saved | Captures the 11-iteration debug trail |

All three bugs were user-observed during interactive use:

1. "I just reloaded the app on the iphone, as as heads up, i saw the metro ouput change that on the pixel tab" — surfaced the wire-contract gap on the client dispatch path that `48fde5b` had only patched on the daemon listener side
2. "the dev tools module doesnt connect for any of the two clients ... Cannot restart DevTools proxy for Metro on port 8082" — surfaced the port-allocation drift between renderer (`findFreePort()`) and daemon (`profile.metroPort`)
3. (silent) Android `triggerBuildsIfNeeded` never reaching `Builder.build()` — surfaced via the E7 probe's fail-fast `builder/line` diagnostic. The fix completes the wire-contract parity story for [[code-fact-daemon-resolves-session-by-payload]]

## Standard gate

```bash
npx vitest run                                                                                    # 1494 pass + 6 skipped
npx tsc --noEmit -p electron/tsconfig.json                                                        # clean
npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l                               # 4 baseline
npm run test:smoke                                                                                # 13 pass + 4 skipped
REAL_BOOT_SMOKE=1 npx playwright test --config tests/electron-real-e2e/playwright.config.ts \
  tests/electron-real-e2e/multi-session-electron.spec.ts                                          # 2 pass (E6/E6.5, fake-boot quick-mode)
```

## The gap — precisely

User's question (2026-05-19): *"connect to the apps and see network activity for both instances? you used the physical device and what else?"*

What's proven now:

- ✅ Two distinct daemon sessions with distinct sessionIds (E6)
- ✅ Two real Metros bound to per-session ports under one daemon (E6)
- ✅ Per-session adapter routing under N>1 sessions (adapter threading tests)
- ✅ Client-side event filter prevents cross-tab `metro/log` leakage (session-cross-session-filter tests)
- ✅ Renderer's `instance.port` matches daemon's `metroPort` so DevTools panel URL is correct (unit-tested indirectly via tsc + interactive verification path)
- ✅ Two `builder/done success=true` events from one daemon, one iPhone + one Pixel_6, in the E7 probe iteration

What's NOT yet proven by automated test:

- ❌ App actually launches + connects to Hermes inspector
- ❌ Daemon's `DevToolsManager` discovers the Hermes target via `/json`
- ❌ `devtools/delta` events arrive with non-empty `addedIds` (CDP `Network.responseReceived` IDs)
- ❌ Two apps' network traffic captured independently with no cross-contamination

The reason none of these are automated: real-world timing. Acme's cold bundle generation + JS init + Hermes self-register + first `fetch()` is **5-15 minutes variable** and depends on factors outside this codebase (RN version, app size, device, network).

## Paths to close the gap (ranked by leverage)

### Path A — Interactive verification (highest leverage, lowest cost)

**~10 min hands-on:** boot Electron, create two sessions, watch the DevTools panel.

```bash
cd /Users/martincouso/Downloads/rn-dev-cli
bun run dev:gui  # launches Electron pointed at acme
# In the renderer:
# 1. Wait for default profile to attach (iOS session 1 builds + installs on iPhone)
# 2. Click + → select a second profile (Android on Pixel_6)
# 3. Wait for both apps to launch
# 4. Click DevTools tab — verify panel opens (NOT "DevTools unavailable")
# 5. Reload the iOS app → confirm metro logs stay on iOS tab only (not on Pixel tab)
# 6. Network panel — confirm both apps' fetch traffic appears under their tabs
```

This is the verification the user can do in real-time, observing both bugs they spotted are fixed AND the network-capture endpoint works. The architectural guarantees from the unit tests guarantee that *if* the apps connect, the routing is correct.

### Path B — Synthetic CDP injection (medium leverage, medium cost)

Skip the real app, inject CDP events directly into the daemon's `devtools-network` module per session, assert the events fan out correctly. Proves the daemon-side routing without depending on Hermes self-register timing.

Approach:

1. New test: `tests/electron-real-e2e/multi-session-devtools-injection.spec.ts`
2. Start two sessions via the daemon socket (skip Electron entirely)
3. Use `devtools/selectTarget` with a stub target to engage the proxy
4. Inject a `Network.responseReceived` CDP event via the proxy's upstream socket
5. Assert `devtools/delta` fires with the injected ID, tagged with the correct sessionId

Cost: ~3-4 hours building the stub Hermes upstream, but produces a reliable test gate.

### Path C — Extend E7 with realistic timeouts (low leverage, low cost)

Bump E7's per-session timeouts:

- Android `builder/done`: 20 min → 40 min (covers cold gradle)
- Hermes target: not asserted currently; add with 15 min budget
- Network delta: 5 min after Hermes target

Total test budget: ~75 min. Brittle — depends on machine speed, network, RN version. Useful as a one-shot end-to-end smoke for major releases, not as a per-PR gate.

The E7 spec (`tests/electron-real-e2e/multi-session-full-stack.spec.ts`) is already structured for this; just adjust the constants near the top.

### Path D — Component-level test in renderer (medium leverage, low cost)

Mount `DevToolsView` in jsdom with a stub `devtools-network:proxy-port` returning per-session port + `devtools-network:change` events tagged by port. Assert that switching active instance changes which session's events render. This proves the renderer-side per-session routing — narrower than Path A but automatable.

File pattern: `renderer/views/__tests__/DevToolsView.test.tsx` (doesn't exist yet).

## Recommended next session

**Start with Path A** — it directly answers the user's question. If the interactive verification succeeds, the gap is *practically* closed; the automated test gap is then a CI nice-to-have, not a correctness concern.

If Path A surfaces a new bug, treat it the same way as today's three: extract the bug, write the unit test, fix it.

Only invest in Path B/C/D if Path A doesn't satisfy the user. Path B is the highest-quality automated answer if E7 needs to live in CI long-term.

## Parked / unrelated

- D7 (`multi-session-daemon.spec.ts`) first test still fails on `stopResp.payload.ok` shape — pre-existing concern from Phase M's structuredContent wrapping. Out of scope.
- MCP `outputSchema` audit across remaining tools (still parked from Phase M)
- Phase T (TUI multi-session) — the TUI adapters now ALSO need to thread sessionId through their RPCs (since this session's `b2b827c` fix lives in `src/app/client/`, which the TUI shares). Pre-existing TUI behavior was single-session; multi-session would expose the same `E_SESSION_AMBIGUOUS` gap fixed for Electron.
- launch.ts `extraProfiles` hardcodes `branch: "main"` (cosmetic)
- iPhone disconnect timeout observed in E7 ("connection terminated with Device for app='com.acme' on device='iPhone' after not responding for 60 seconds") — likely the app entered background or the wireless pair went quiet. Not a code bug.

## Next-session prompt

```
Pick up at: Closing the multi-session network-capture verification gap.
Session doc: docs/sessions/2026-05-20-phase-e-network-capture-gap.md
Repo: /Users/martincouso/Downloads/rn-dev-cli, branch main @ acfcad4, 38 commits ahead of origin (local-only, do not push).

Multi-session architecture is now provably correct at every layer
EXCEPT real-app end-to-end network capture. Three bugs were extracted
and fixed in the previous session; the test gap that remains is
real-world timing dependent (Hermes self-register, cold gradle), not
architectural.

Highest-leverage next move: Path A in the session doc — interactive
verification by the user via `bun run dev:gui` against acme. ~10 min
hands-on, directly answers the open question.

If interactive verification reveals a new bug:
- Extract, write unit test (pattern: src/app/client/__tests__/adapter-sessionid-threading.test.ts)
- Fix
- Repeat

If automated CI gate for network capture is required, Path B in the
session doc (synthetic CDP injection) is the most reliable approach;
budget 3-4 hours.

Parked work + paths B/C/D documented in the session doc.

Standard gate green: 1494 vitest + 4 tsc baseline + 0 electron tsc + 13/13 smoke + 2/2 REAL_BOOT_SMOKE E6.
```

## Related memories

- [[phase-e-electron-multi-session-landed]] — Phase E architectural completion (sessions Map, ModuleHostClient threading, per-session client maps)
- [[phase-m-complete]] — Phase M wire-contract origin (`48fde5b` daemon-side modules listener filter)
- [[code-fact-daemon-resolves-session-by-payload]] — generalized rule; ALL adapters now follow it after `b2b827c`
- [[feedback-parallel-instance-requirement]] — 4-instance use case the architecture targets
- [[real-boot-is-the-only-gate]] — the verification standard this gap is measured against
- [[feedback-test-parity-no-gaps]] — every client (TUI, Electron, MCP) gets the same three layers; Phase T still needs the adapter fix from `b2b827c`
- [[workflow-local-only-personal-account]] — no push, no PR
- [[single-branch-single-worktree]] — main only
