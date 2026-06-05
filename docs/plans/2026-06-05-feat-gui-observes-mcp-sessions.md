# Feature spec — GUI observes agent/MCP-driven sessions ("watch the AI work")

**Date:** 2026-06-05
**Status:** spec / design (not yet implemented)
**Origin:** user question during the multi-session Android capture verification — "if an LLM uses the MCP client, do I get to see it through the Electron app somehow?" Today the answer is **no**; this spec closes that gap.

## Problem

rn-dev runs **one daemon per project**, shared by all clients (TUI, Electron GUI, MCP server). An LLM driving the tool over MCP (`rn-dev/start-session`, `rn-dev/build`, `devtools-network__*`) creates real daemon sessions with real Metro + DevTools capture. But the **Electron GUI never surfaces those sessions** — so a human cannot watch, inspect, or take over what an agent is doing.

This is the *reverse* of the project's agent-native parity principle (CLAUDE.md: "anything a user can do via the GUI, an agent must be able to do via MCP"). That principle is GUI → agent. This spec is **agent → GUI observability**: anything an agent does in the daemon, a human can observe in the GUI.

## Current state (verified 2026-06-05)

- **Shared daemon.** MCP server + Electron both connect to the same per-project daemon socket. ✓
- **`sessions/list` RPC already exists** on the daemon (MCP's `rn-dev/list-sessions` and the E7 probe both use it). Returns `[{ sessionId, profileName, worktreeKey, status, services }]`. ✓
- **Renderer has no session sync.** The Electron renderer builds tabs only from its own `instances:create` / `instances:remove` IPC (`renderer/App.tsx:521,547,491`). There is **no `sessions/list` IPC handler in the Electron bridge** (`electron/ipc/`) and no renderer code that lists daemon sessions. So externally-created sessions are invisible. ✓ (this is the gap)
- **Per-instance keying.** Electron IPC handlers resolve a session via `instanceId → getSessionRecordForInstance(instanceId) → sessionId` (`electron/ipc/index.ts:77`). A renderer "instance" (tab) is bound to a sessionId it created.
- **Attach-by-id exists.** `connectToDaemonSession` supports attaching to an existing session via `events/subscribe { sessionId }` (used by the E7 probe and the MCP path). So a renderer tab *can* bind to a session it didn't create.
- **Daemon broadcasts every session's events** (`builder/*`, `metro/log`, `devtools/delta`, `devtools/status`, `modules/*`) to subscribers, each tagged with its `sessionId` (`src/daemon/supervisor.ts`). The client-side cross-session filter (`src/app/client/session.ts:327`) drops events whose `sessionId` ≠ the subscription's bound session — so observing session X requires a subscription bound to X.
- **DevTools per session.** Each session has its own `DevToolsManager` + CDP proxy (per-session port). `renderer/views/DevToolsView.tsx` takes a `metroPort` prop and loads the embedded RN DevTools (Fusebox) through that session's proxy.

## Goal / non-goals

**Goal:** a human in the Electron GUI can see sessions started by *any* client (especially an LLM over MCP), and inspect each one's Metro logs + DevTools/Network — live, read-only — and optionally take it over.

**Non-goals (v1):** multi-user/remote observation; replaying historical agent runs; editing the agent's prompt from the GUI.

## Design (phased)

### Phase 1 — read-only observability (the headline)

1. **List all daemon sessions in the renderer.** Add an Electron IPC handler `sessions:listAll` → daemon `sessions/list`. Renderer polls it (e.g. every 1–2 s) or, better, the Electron main subscribes once and pushes updates. Each entry carries `sessionId`, `profileName`, `status`, and `services.metroPort`.
2. **Classify origin without a daemon change (v1).** The renderer already knows the sessionIds of the tabs it created. Any `sessions/list` entry whose sessionId is **not** one of its own = an **external** session (agent/CLI). (Phase 3 adds an explicit origin tag.)
3. **Surface external sessions in the UI.** Recommended: render them as **tabs with an "agent" badge** (distinct color/icon) so the existing per-tab surfaces (Metro Logs, DevTools) work uniformly. Alternative: a dedicated "Sessions" sidebar panel listing all daemon sessions with origin + status, click-to-open.
4. **Observe events read-only.** For an opened external session, the renderer attaches an `events/subscribe { sessionId }` subscription (reusing the attach-by-id path) and feeds the existing per-tab adapters → renders that session's **Metro logs** and **DevTools/Network** (point `DevToolsView` at the session's `metroPort`). No mutating controls (Reload/DevMenu/Build hidden or disabled) while in observe mode.
5. **Lifecycle.** When `sessions/list` no longer contains the observed sessionId (agent stopped it), mark the tab "ended" and stop its subscription gracefully.

### Phase 2 — take over an agent session

Promote an observed (read-only) session to a full interactive tab: the renderer creates a normal instance **bound to the existing sessionId** (attach-by-id) and enables the mutating controls (Reload, DevMenu, Build, Stop). Needs a clear control model — read-only by default; "Take over" is an explicit user action. Concurrency: agent + human acting on the same session simultaneously is possible; v1 keeps it simple (no lock — last action wins; surface a banner "also controlled by an agent").

### Phase 3 — origin labels + agent task context

Tag session origin at `session/start` (new optional `origin: "gui" | "cli" | "mcp"` + free-text `label`, e.g. the agent's task summary). The MCP `start-session` tool sets `origin: "mcp"` + a label from the agent. The GUI shows the label ("Agent: investigating damage-screen bug") on the tab. Removes the v1 heuristic (step 2) in favor of authoritative origin.

## Key files

- **New:** `electron/ipc/sessions.ts` (or extend an existing ipc file) — `sessions:listAll` handler wrapping daemon `sessions/list`.
- **Renderer:** `renderer/App.tsx` (tab model: external/observed instances), `renderer/components/InstanceTabs.tsx` (agent badge), a new `renderer/views/SessionsView.tsx` if going the panel route; reuse `DevToolsView.tsx` + Metro logs view for observed sessions.
- **Client:** reuse `connectToDaemonSession` attach-by-id; no daemon change for Phase 1.
- **Phase 3:** `src/daemon/index.ts` (session/start mints + stores origin/label), `src/daemon/client-rpcs.ts` / `sessions/list` payload (include origin/label), `src/mcp/tools.ts` (`start-session` sets origin/label).

## Relationship to the event-push stall (Task 7)

Task 7 (the `builder/line`/`done` stall under build flood) is on the **MCP-server** event path (its `BuilderClient` ring). The renderer subscribes **raw** to the daemon socket (the E7 probe proved this path delivers `builder/done` + `devtools/delta` reliably). So **Phase 1 GUI observation is NOT blocked by #7.** Caveat: observing an agent's heavy build streams the full line firehose to the renderer — fine, but worth a throttle/virtualized log view. (Fixing #7 is still independently worthwhile for agents that watch builds via `rn-dev/build-status`.)

## Risks / open questions

- **Two Fusebox frontends on one proxy?** The agent (MCP) uses `devtools-network__list`, not Fusebox; the GUI observing opens Fusebox through the same per-session proxy. Only one Fusebox attaches → expected to be fine; verify the proxy tolerates a downstream Fusebox connect while the module is also reading captures.
- **Control concurrency (Phase 2):** agent + human acting on the same session. v1: no lock, surface a "shared with agent" banner. Revisit if it causes confusion.
- **Polling vs push for `sessions/list`:** push (main subscribes once, forwards deltas) is cleaner than renderer polling; decide during implementation.
- **Consent/safety:** showing all daemon sessions to the GUI is same-user/same-project — no new trust boundary (`sessions/list` is already exposed to MCP). No change to the audit log or module-consent story.

## Test strategy (per the project's 3-layer + real-boot standard)

1. **vitest** — `electron/ipc/__tests__/sessions.test.ts` (handler maps daemon `sessions/list`); `renderer/.../__tests__/*.test.tsx` mounting the external-session tab/panel from a stubbed `window.rndev` bridge.
2. **tsc** — IPC payload shapes (sessions/list entry, origin/label).
3. **fake-boot smoke** — renderer renders an external-session tab from a stubbed sessions/list.
4. **real-boot probe (gated)** — an MCP client (`spawnMcpServer`) starts a session against acme; the GUI lists it, opens it read-only, and renders its Metro logs + a `devtools/delta`-backed Network view. This is the agent→GUI observability counterpart to `multi-session-android-capture.spec.ts`.

## Estimate

- Phase 1 (read-only observe): ~2–3 days.
- Phase 2 (take-over): ~1–2 days.
- Phase 3 (origin labels): ~1 day.

Phase 1 alone answers the user's question and is independently shippable.
