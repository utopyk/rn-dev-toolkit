# Redux Inspection Module — Brainstorm

**Date:** 2026-06-17
**Status:** Brainstorm — design exploration before a plan doc. No code yet.
**Why now:** Debugging the media-editors feature (and acme work generally) needs Redux visibility — current state, the action stream, and what each action changed — available to **both** a human (Electron/TUI) and an agent (MCP), on all clients. Acme is `@reduxjs/toolkit` 2.11.1 + `redux` 4.2.1 + `redux-thunk`, store built in `src/store/configureStore.ts`. The action stream is real and busy (we watched `[AccountRestorationMiddleware] SET_CURRENT_COMPANY`, pending-intents restoration, etc. fly past in the console).

**Decided direction (this brainstorm's premise):** a proper third-party-style module that ships **its own Redux store enhancer**, decoupled from Reactotron. Not the Reactotron-listener approach (couples us to Reactotron + port 9090), not the CDP `store-on-global` poll (hacky, coarse). The app opts in by adding one rn-dev enhancer to its store; rn-dev owns the transport end to end. This mirrors how Reactotron, Flipper, and Redux DevTools all work — an intentional app-side hook + a host-side viewer — but the hook and the viewer are both ours.

---

## 1. Goal

Give agents and humans the same Redux picture, with parity:
- **Current state** — full tree or a slice at a path (`auth`, `conversations.byId.CO…`).
- **Action stream** — a ring of recent actions with type, payload, timestamp, and the state **diff** each one produced.
- **Action detail** — one action's payload + before/after diff.
- Live in the Electron "Redux" panel and TUI; every read also a `redux__*` MCP tool.

Non-goals (v1): time-travel/dispatch-from-tool (replaying or injecting actions — that's a mutating, higher-risk follow-up), action *filtering by middleware* config, persistence across restarts.

---

## 2. Architecture — two halves

### 2a. App-side enhancer (`@rn-dev-modules/redux` client export)
A tiny store enhancer the app adds intentionally, dev-only:

```ts
// configureStore.ts (dev only)
import { rnDevReduxEnhancer } from '@rn-dev-modules/redux/enhancer'
const enhancer = __DEV__ ? rnDevReduxEnhancer() : undefined
```

- Subscribes to dispatch (wraps the store) and emits `{ action, stateAfter | stateDiff, ts }` over a websocket to rn-dev.
- Dev-only, tree-shaken from release (same posture as the worklets/devtools concerns).
- Zero coupling to Reactotron; the app keeps Reactotron too if it wants — they're independent.

### 2b. Host module (`modules/redux/`)
Standard module-system subprocess (mirrors `devtools-network` almost exactly):
- Hosts the WS ingest endpoint, buffers into a ring (cursor/`since` semantics like `devtools-network`'s capture list).
- Contributes `redux__*` MCP tools + an Electron "Redux" panel + optional TUI view.
- Manifest at `modules/redux/rn-dev-module.json`; `redux__<tool>` naming (double-underscore, 3p-prefix policy); `permissions: ["network:inbound"]` (advisory v1); `activationEvents: ["onStartup"]`.

**Why an enhancer, not middleware:** an enhancer sees the full `(state, action)` post-reduction and can compute the diff; thunks/middleware sit earlier and don't see final state. RTK's `configureStore` takes `enhancers`; the legacy `createStore` acme uses (`legacy_createStore`) takes an enhancer directly — so it fits acme's existing `configureStore.ts` cleanly.

---

## 3. The hard part — transport + session identity

Multi-session is the production target (4 concurrent: real devices + emulators, human + AI). An action stream arriving from device X must bind to the **right** rn-dev session, with no cross-talk — the same discipline as `payload.sessionId` routing in the daemon and per-target capture in devtools-network.

**Proposed:** derive the ingest endpoint from the dev server the app already loaded its bundle from.
- The app knows its Metro host/port at runtime via RN's `getDevServer()` (dev-only). Each rn-dev session owns a Metro port (8081–8099) 1:1.
- rn-dev allocates a **redux-ingest port paired to each session's Metro port** (e.g. a fixed offset, or a value Metro serves on a small rn-dev endpoint). The enhancer reads the dev-server host, resolves the paired ingest port, and connects there.
- Result: the app connected to Metro on port P streams Redux to the rn-dev session that owns P. Session binding falls out of the existing Metro-port-per-session model — no manual config, no handshake token to manage.

**Open question O1:** exact port-pairing scheme (offset vs Metro-served discovery vs the enhancer hitting a single rn-dev port and identifying itself with the Metro port it loaded from). Lean: enhancer connects to one daemon-owned redux port and announces `{ metroHost, metroPort }` in the WS hello; rn-dev maps metroPort → sessionId. Keeps one listener, routes by announced identity. Decide in the plan.

**Open question O2:** physical iOS over LAN — same ATS/local-network constraints we hit for Metro capture. The enhancer's WS to the Mac's LAN IP is subject to the app's ATS + iOS Local Network permission, exactly like the Metro connection. Likely "just works" wherever Metro already reaches (it's the same host), but call it out and verify on a real device.

---

## 4. Capture model

- **Actions:** ring buffer of `{ seq, ts, type, payload, diff }`. `redux__actions { since?, limit?, typeFilter? }` returns a page + a cursor, mirroring `devtools-network__list`'s `since`/`oldestSequence`/eviction semantics so agents can poll incrementally.
- **State:** `redux__state { path? }` returns the current tree or a slice at a dot/bracket path. Read live (the enhancer keeps the latest snapshot host-side, updated per action) — no round-trip to the device.
- **Diffs:** computed host-side from consecutive snapshots, OR sent by the enhancer (cheaper on the host, but more app CPU). Lean: enhancer sends shallow-ish structural diffs; host stores latest full snapshot + per-action diff. Decide in plan (O3).
- **Volume:** RTK apps dispatch a lot. Ring cap + payload/state size caps (like devtools-network's body truncation), with `evictedCount`/`truncatedCount` in the status meta.

---

## 5. Security / redaction — FIRST CLASS (do not defer)

Acme is a payments app. Redux state **will** contain customer PII, business data, auth tokens, and payment-adjacent fields. Streaming raw state to an agent's context (or to disk) is the dangerous default. Reuse the devtools-network precedent (`mcp-redacted` body mode + the `redact.ts` header model) and go further:

- **Default `mcp-redacted`:** MCP `redux__state` / `redux__actions` return structure with leaf **values redacted** by default; the human Electron panel can show more (local trust boundary), the agent gets shape + types, not values, unless explicitly opted in.
- **Deny/allow paths** in module config: always-redact key patterns (`*token*`, `*password*`, `*secret*`, `*authorization*`, `*card*`, `email`, `phone`), plus a project allow-list for slices safe to reveal in full (e.g. `ui`, `navigation`).
- **Never persist raw state** to `~/.rn-dev` or the audit log; the audit log records *that* a redux read happened, never the values.
- **Enhancer-side pre-redaction option:** for the most sensitive shops, redact on-device before it leaves the app, so raw values never cross the wire.

**Black/white-list model (decided 2026-06-17):**
- **Whitelist (allow-list)** — slices/paths explicitly safe to expose to agents in full (e.g. `ui`, `navigation`, feature flags). Anything **not** whitelisted is returned structure-only (keys + types, values redacted). So the agent default is "shape, not values," and the whitelist opts specific slices into full visibility.
- **Blacklist (deny-list)** — key patterns always redacted, **even inside a whitelisted slice** (`*token*`, `*password*`, `*secret*`, `*authorization*`, `*card*`, `email`, `phone`). Defense in depth: a slice someone whitelisted today that later grows a sensitive field still won't leak it.
- Net: agent sees a value only if its path is under the whitelist **and** no blacklist pattern matches; everything else is structure-only. The human Electron panel can default looser (local trust boundary) but honors the blacklist.
- Both lists live in module config (`~/.rn-dev/modules/redux/config.json`), per-project.

This is the part most likely to be wrong-by-omission, so it leads the plan, not trails it.

---

## 6. MCP tools (agent-native parity)

- `redux__status` — connected? which session/app? ring stats, redaction mode, dropped/evicted counts.
- `redux__state { path?, reveal? }` — current state (redacted by default).
- `redux__actions { since?, limit?, typeFilter? }` — action page + cursor.
- `redux__action { seq }` — one action: payload + before/after diff.
- `redux__clear` — reset the ring.
- (v2, mutating, gated) `redux__dispatch` / time-travel — explicitly out of v1.

Everything the panel shows is reachable here (parity rule).

---

## 7. Electron panel + TUI

- **Electron "Redux" panel** (`panel/index.html` + `panel.js`, static webview like devtools-network): split view — action list (type, ts, diff summary) on the left, state tree / selected-action diff on the right. Reuses the panel-bridge + `modules:call-tool` plumbing already in place.
- **TUI view** optional per the module rules; a compact action tail + `state <path>` command is enough for v1.

---

## 8. Distribution of the enhancer

**The testing worry, resolved (decided 2026-06-17): no published package is needed to battle-test.** The enhancer is a self-contained ~100-line TS file (a dispatch wrapper + a small WS client + the hello handshake). For the local phase:

1. **Vendor the file** into acme (e.g. `src/dev/rn-dev-redux-enhancer.ts`), kept out of git via `.git/info/exclude` — the exact local-first pattern already used for the rn-dev skill and the worklets patch.
2. **One dev-only line** in `configureStore.ts`:
   ```ts
   import { rnDevReduxEnhancer } from './dev/rn-dev-redux-enhancer'
   // ... in the enhancer list, dev-only:
   __DEV__ ? rnDevReduxEnhancer() : undefined
   ```
   Kept as a local working-tree edit during battle-test (same as the worklets patch is a local patch). It is plain TS, so Metro bundles it — no build step, no npm install, no `file:` dependency in the committed `package.json`.
3. The host module can also **serve the current enhancer file** over its endpoint (so the vendored copy can be refreshed from the running rn-dev), but that is a convenience, not a requirement.

**Team rollout (later):** publish `@rn-dev-modules/redux` exposing `/enhancer`, swap the vendored import for the package import, drop the exclude line. Same arc as the rn-dev-as-primary-tooling plan: local-first to prove it, package to ship it.

- **Version handshake:** the WS hello carries the enhancer version; the host warns on mismatch (like `DAEMON_VERSION`), which matters precisely because a vendored copy can drift from the host.

---

## 9. Module-system compliance checklist

- Manifest `rn-dev-module.json` at module root; `redux__<tool>` names (3p double-underscore); MCP tools + Electron panel both contributed (parity).
- Runs as its own subprocess (vscode-jsonrpc framing); never writes the audit log directly.
- `permissions` advisory v1, surfaced in the install-consent dialog.
- 3-layer + real-boot test parity (no gaps — see §11).

---

## 10. Why not the alternatives (recorded for the plan)

- **Reactotron listener:** zero app change for acme today, but couples rn-dev to Reactotron's protocol + port 9090, clashes with the real Reactotron desktop, and only works for Reactotron-instrumented apps. Rejected as the primary design; could be a *secondary* adapter later.
- **CDP `Runtime.evaluate` on a global store:** general and reuses the DevTools proxy, but needs the store on a global + an action-emit shim, and polling state is coarser than an enhancer's exact `(action, state)` stream. The enhancer gives strictly better fidelity for a comparable app-side cost.

---

## 11. Test strategy (must match `feedback_test_parity_no_gaps`)

1. **vitest:** ring/cursor/eviction + redaction (deny-path patterns, `mcp-redacted` default, allow-list reveal) as pure units; the WS ingest framing; session routing (announced metroPort → sessionId) as a pure reconcile like `planSessionReconcile`.
2. **tsc:** 4 baseline + 0 electron.
3. **fake-boot smoke:** panel renders, no boot regression.
4. **real-boot probe (the gate):** add the enhancer to the acme store, build via rn-dev, dispatch real actions, assert `redux__actions`/`redux__state` return them through MCP **and** the Electron panel shows them — multi-session (two apps, no cross-talk), and verify redaction actually hides a known-sensitive slice.

---

## 12. Open questions

**Decided 2026-06-17:**
- **O4 — redaction:** black/white-list model (§5). Whitelist opts slices into full agent visibility; blacklist force-redacts patterns even inside whitelisted slices; everything else structure-only by default.
- **O5 — distribution:** vendored self-contained file + one dev-only line, git-excluded, for the local phase; publish `@rn-dev-modules/redux` for team rollout (§8). No package needed to test.
- **O6 — classification:** third-party-style module (`redux__*`, manifest, subprocess), mirroring devtools-network.

**Still open for the plan:**
- **O1** Port-pairing / session-identity scheme — lean: one daemon-owned redux port, enhancer announces `{ metroHost, metroPort }` in the WS hello, host maps `metroPort → sessionId`.
- **O2** Physical-iOS reachability of the ingest WS (ATS / Local Network — same envelope as Metro; verify on a real device).
- **O3** Diff computed host-side (from consecutive snapshots) vs sent by the enhancer — lean: enhancer sends shallow structural diffs, host keeps the latest full snapshot.

---

## 13. Recommended next step

O4/O5/O6 are decided; O1/O3 have working leans (enough to plan around) and O2 is a verify-on-device item. Ready to promote to a plan doc (`docs/plans/2026-…-feat-redux-module.md`).

Build sequence: redaction (black/white list) + ring + WS ingest (host) → vendored enhancer + session routing → `redux__*` MCP tools → Electron panel → real-boot probe against acme (dispatch real actions, assert MCP + panel see them, two sessions no cross-talk, a known-sensitive slice stays redacted). Local-first in the media-editors worktree (vendored enhancer, git-excluded) to battle-test, then package `@rn-dev-modules/redux` for team rollout — same arc as the rn-dev-as-primary-tooling setup.
