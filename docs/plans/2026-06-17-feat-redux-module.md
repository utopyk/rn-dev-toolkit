# Plan: Redux inspection module

**Date:** 2026-06-17
**Status:** Plan — ready to implement. Supersedes the design exploration in `docs/brainstorms/2026-06-17-redux-module-brainstorm.md` (read that for the rejected alternatives + rationale).
**Branch/worktree:** `main`, repo root (per the single-branch rule). Local-only.

## Problem

Agents and humans have no Redux visibility in acme. The action stream + state are the single most useful debugging surface for an RTK app (acme: `@reduxjs/toolkit` 2.11 + `redux` 4.2 + thunk, store in `src/store/configureStore.ts`), and we have nothing for it — Metro logs show `console.*`, network capture shows requests, but state transitions are invisible.

## Goal / non-goals

**Goal:** current state, the action stream, and per-action diffs, available on all clients with parity — `redux__*` MCP tools for agents, an Electron "Redux" panel + TUI tail for humans. Redaction-safe by default (acme state holds customer PII + payment data).

**Non-goals (v1):** dispatching/replaying actions or time-travel (mutating, higher-risk — a v2 behind explicit gating); middleware-level filtering config; persistence across restarts.

## Architecture — mirror the metro-logs template

`metro-logs` is the closest existing module: a **host-side store fed by a stream**, exposed via a **host capability**, read by a **thin module subprocess** that contributes MCP tools + an Electron panel. Redux is the same shape; the only new infra is the ingest transport (a websocket the app's enhancer connects to, vs Metro stdout).

```
acme app (dev)                rn-dev daemon (per session)              clients
─────────────────               ───────────────────────────             ───────
rnDevReduxEnhancer()  ──WS──▶   ReduxIngestServer                        MCP: redux__* tools
  (vendored file,               → maps hello.metroPort → sessionId       Electron: "Redux" panel
   dispatch wrapper)            → ReduxStore[session] (ring + snapshot)   TUI: action tail
                                → `redux` host capability + daemon RPCs
```

- **Host (`src/core/redux/`)** — `ReduxStore` (per-session ring of actions + latest state snapshot + cursor, modeled on `MetroLogsStore`), `redact.ts` (black/white list), `ingest.ts` (WS server), `host-capability.ts`, `types.ts`.
- **Module (`modules/redux/`)** — manifest + subprocess + `redux__*` tools (read via `ctx.host.capability("redux")`) + `dto.ts` (redaction projection at the MCP boundary) + `panel/` (the Electron "Redux" panel, static webview like devtools-network's).
- **Enhancer** — a self-contained `enhancer.ts` (vendored into acme for the local phase; published as `@rn-dev-modules/redux/enhancer` later).

## Load-bearing decisions (from the brainstorm)

1. **Redaction = black/white list, redacted-by-default for agents.**
   - Whitelist (allow paths, e.g. `ui`, `navigation`) → returned in full to agents.
   - Everything else → structure-only (keys + types, values redacted).
   - Blacklist (patterns `*token*` / `*password*` / `*secret*` / `*authorization*` / `*card*` / `email` / `phone`) → force-redacted **even inside whitelisted slices**.
   - Net visibility for an agent value: `path ∈ whitelist AND no blacklist match`. The Electron panel may default looser (local trust boundary) but still honors the blacklist. Raw state is **never** persisted to `~/.rn-dev` or the audit log; the audit records the read, not values.
2. **Third-party-style module** (`redux__*` double-underscore names, manifest, subprocess) like devtools-network.
3. **Session identity by announced metroPort.** The enhancer reads its dev-server host via `getDevServer()` and opens the WS to a single daemon-owned ingest port, announcing `{ metroHost, metroPort, enhancerVersion }` in the hello. The daemon maps `metroPort → sessionId` (it already owns that mapping via `MetroManager`), keying the ReduxStore by session — same routing discipline as `payload.sessionId` everywhere else. No cross-session leakage.
4. **Distribution: vendored-first.** A ~100-line self-contained file + one dev-only line in `configureStore.ts`, git-excluded, for the battle-test. Publish the package for team rollout. WS hello carries the enhancer version; host warns on mismatch.

## Phases

Each phase is independently committable and gated (vitest + tsc; renderer/electron phases also smoke).

### P1 — Host data plane (pure, no transport)
- `src/core/redux/types.ts` — `ReduxAction { seq, ts, type, payload, diff }`, `ReduxStateSnapshot`, `ReduxCaptureMeta { worktreeKey, bufferEpoch, oldestSequence, lastEventSequence, evictedCount, truncatedCount, redactionMode }`, filter/cursor types (mirror `metro-logs/types.ts`).
- `src/core/redux/buffer.ts` — `ReduxStore`: `append(session, action, stateSnapshot)`, `latest(session)`, `list(session, { since, limit, typeFilter })`, `clear(session)`, ring cap + payload/state size caps with `evictedCount`/`truncatedCount`. Per-session (`Map<SessionId, …>`).
- `src/core/redux/redact.ts` — `redactState(state, { whitelist, blacklist, mode })` + `redactActionPayload(...)`. Pure.
- **Tests:** `buffer.test.ts` (ring/cursor/eviction/caps), `redact.test.ts` (whitelist reveal, blacklist force-redact inside whitelist, default structure-only). All pure.

### P2 — WS ingest + session routing
- `src/core/redux/ingest.ts` — `ReduxIngestServer`: binds one daemon-owned port, accepts enhancer WS connections, parses the hello, resolves `metroPort → sessionId` via a callback the daemon supplies (reads `MetroManager`), routes each `{action, state/diff}` frame into `ReduxStore[session]`. Drops/720 logs frames whose metroPort matches no live session. Defensive parse (untrusted external input — treat per the module security posture).
- Wire into `src/core/session/boot.ts` next to `MetroLogsStore` (create the store + ingest, feed on frame, expose on the boot result like `metroLogsStore`).
- **Open O1 settled here:** single ingest port + announced metroPort. Port number: allocate one daemon-scoped port (not per-session) — routing is by announcement, not by port.
- **Tests:** integration with a fake enhancer WS client: connect, announce a known metroPort, send actions, assert they land in the right session's store and NOT in another session's.

### P3 — Host capability + daemon RPCs
- `src/core/redux/host-capability.ts` — `createReduxHostCapability(store)` exposing `status/list/latest/clear` (mirror `metro-logs/host-capability.ts`).
- Register in `src/core/session/boot.ts` + `src/modules/create-module-system.ts` (the capability-registration site).
- Daemon RPCs in `src/daemon/client-rpcs.ts`: `redux/status|actions|state|action|clear` (for the Electron adapter path; the module reads via the capability). Add to the RPC allow-list array + the switch.
- **Tests:** capability returns store data; RPC roundtrip (extend `client-rpcs.test.ts`).

### P4 — Module subprocess + MCP tools
- `modules/redux/rn-dev-module.json` — manifest: `id: "redux"`, `redux__status|state|actions|action|clear` tools (with `readOnlyHint: true`; untrusted-content note in descriptions like device-control), Electron panel `{ id: "redux", title: "Redux", webviewEntry: "panel/index.html", hostApi: ["redux"] }`, `permissions: ["network:inbound"]`, `activationEvents: ["onStartup"]`.
- `modules/redux/src/{index,tools,host-capability,types,dto}.ts` — tools resolve `ctx.host.capability("redux")`; `dto.ts` applies the redaction projection at the MCP boundary (default `mcp-redacted`, like devtools-network's body gate).
- `modules/redux/build.ts` + `package.json` (mirror devtools-network).
- Symlink into `~/.rn-dev/modules/redux` for dev (like the others).
- **Tests:** `tools.test.ts` (each tool, redaction default, whitelist reveal), `dto.test.ts`.

### P5 — Electron "Redux" panel (parity)
- `modules/redux/panel/{index.html,panel.js}` — static webview via the existing modules-panels bridge (no renderer change needed; surfaces automatically in the sidebar like devtools-network's Network panel). Split view: action list (type, ts, diff summary) + state tree / selected-action diff. Honors the blacklist; can reveal more than the agent default.
- **Tests:** smoke (panel renders, no boot regression).

### P5b — TUI tail (optional, small)
- A compact action tail + `state <path>` in the TUI module view. Defer if time-boxed; parity rule is satisfied by panel + MCP.

### P6 — Enhancer (client)
- `modules/redux/enhancer.ts` — self-contained: store enhancer wrapping dispatch, computes a shallow diff, opens the WS, sends the hello + frames, reconnects on drop. Zero deps beyond a WS (use RN's global `WebSocket`).
- Vendor into acme (`src/dev/rn-dev-redux-enhancer.ts`, git-excluded) + one dev-only line in `configureStore.ts`.
- **Open O3 settled here:** enhancer sends shallow structural diffs; host keeps the latest full snapshot.

### P7 — Real-boot probe (the gate)
- `tests/electron-real-e2e/redux-capture.spec.ts` (or an MCP probe under `src/mcp/__tests__/`): vendor the enhancer into the acme media-editors worktree, build via rn-dev, dispatch real actions, assert:
  (a) `redux__actions`/`redux__state` return them through MCP;
  (b) the Electron "Redux" panel shows them;
  (c) two sessions (device + emulator) — no cross-talk;
  (d) a known-sensitive slice (e.g. anything matching the blacklist) is redacted in the MCP output;
  (e) **O2 verified:** the ingest WS reaches a physical iPhone over LAN (same ATS/Local-Network envelope as Metro — if it fails, document the enhancer-side pre-redaction + a localhost/USB fallback).

### P8 — Team rollout (later, not this pass)
- Publish `@rn-dev-modules/redux` exposing `/enhancer`; swap acme's vendored import for the package; drop the exclude line.

## Multi-session

The 4-concurrent target (real devices + emulators, human + AI) is handled by P2's announced-metroPort routing: each app's enhancer announces the Metro port it loaded from, the daemon maps it to the session, and the ReduxStore is per-session. A real-boot two-session assertion (P7c) is the gate — never accept a cross-session-contamination "footnote" (per `feedback_parallel_instance_requirement`).

## Security

- Redaction (above) is implemented in P1 and enforced at the MCP boundary in P4 — values are gone before they reach an agent's context.
- The ingest WS accepts untrusted frames from the app: defensive parse, size caps, no `eval`, frames that don't match a live session are dropped. The enhancer is the app's own opt-in code (trust boundary is the developer's own store), but the host treats every frame as untrusted external input.
- Optional enhancer-side pre-redaction (redact before it leaves the device) for the most sensitive shops — config flag, P6 stretch.

## Test strategy (parity, per `feedback_test_parity_no_gaps`)

1. **vitest:** P1 pure (buffer/redact), P2 ingest+routing integration, P3 capability+RPC, P4 module tools+dto.
2. **tsc:** 4 baseline (excl `src/ui`) + 0 electron — new RPC payloads, capability types, manifest tool shapes.
3. **fake-boot smoke:** panel renders, watcher/boot unaffected.
4. **real-boot probe:** P7 (a–e). This is the merge gate.

## Risks / cautions

- **Ingest port reachability on physical iOS (O2).** Same ATS/Local-Network envelope as Metro; likely fine wherever Metro reaches, but unproven — P7e gates it, with enhancer-side pre-redaction as the fallback if the WS can't cross.
- **Action volume.** RTK apps dispatch heavily; ring caps + size caps + `evictedCount` in meta prevent unbounded memory and oversized MCP responses.
- **Redaction wrong-by-omission.** The default is structure-only for agents; a slice is only revealed by explicit whitelist. Erring toward over-redaction is correct for a payments app.
- **Enhancer/host version drift** (vendored copy). WS-hello version handshake + a host warning.

## Sequencing summary

P1 → P2 → P3 → P4 → P5 → P6 → P7, each committed + gated. Local-first in the media-editors worktree (vendored enhancer, git-excluded) to battle-test; P8 packages it for the team. Same arc as the rn-dev-as-primary-tooling setup.
