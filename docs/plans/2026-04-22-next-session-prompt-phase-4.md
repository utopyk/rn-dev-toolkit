# Next-Session Prompt — Module System Phase 4 (Electron panels)

**Paste the block below at the start of the next session.**

---

We're continuing the third-party module system for rn-dev-cli. PR [#2](https://github.com/utopyk/rn-dev-cli/pull/2) on `feat/module-system-phase-0` now contains **Phases 0, 0.5, 1, 2, 3a, 3b, 3c, 3d** — 23 commits, ~170 new tests, all shipped on 2026-04-22. Phase 3d (`tools/listChanged` + SDK `runModule()`) unblocked the two Phase 4 prerequisites the earlier handoff called out.

Before writing any code:

1. Read `docs/plans/2026-04-22-module-system-phase-3d-handoff.md` for the latest state (what shipped, contract decisions, remaining deferred items).
2. Skim earlier per-phase handoffs only if you need to understand *why* a specific decision was made:
   - `docs/plans/2026-04-22-module-system-phase-2-handoff.md` (subprocess host, RPC, capability registry)
   - `docs/plans/2026-04-22-module-system-phase-3b-handoff.md` (tools/call end-to-end)
   - `docs/plans/2026-04-22-module-system-phase-3c-handoff.md` (enable/disable persistence)
3. Check the plan's Phase 4 section at `docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md`.

### Branching — FIRST QUESTION TO MARTIN

PR #2 is stacked very high (8 phases, 23 commits). Martin already chose "keep stacking" for 3d. Before Phase 4, ask:

> **"Phase 4 is ~3–5 days of Electron work. Squash-merge PR #2 to main and branch Phase 4 fresh, or keep stacking?"**

The Phase 3d handoff suggests splitting now. If he splits:

```bash
# Assuming PR #2 gets squash-merged as commit X on main
git checkout main && git pull
git checkout -b feat/module-system-phase-4
```

If he continues to stack: stay on `feat/module-system-phase-0`.

```bash
gh pr view 2 --json state -q .state
```

- If `MERGED`: split.
- If `OPEN` + Martin says keep stacking: continue.

### Phase 4 scope — Electron panel contributions (~3–5 days)

Deliberate pivot from the brainstorm's `<webview>` to `WebContentsView` (Electron 30+, 2026-recommended).

1. **`electron/panel-bridge.ts`** — host-side registry. Given a manifest with `contributes.electron.panels[]`, create a `WebContentsView` per panel with:
   - `partition: 'persist:mod-<id>'`
   - `preload: electron/preload-module.js` (single preload, receives `moduleId` + `hostApi[]` via query params)
   - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`
   - Added to the main window's `contentView` tree, repositioned on renderer layout events.
   - Audit-log cross-module postMessage sends per Revision Log.

2. **`electron/preload-module.ts`** — per-module preload. `contextBridge.exposeInMainWorld('rnDev', ...)` exposing ONLY the methods the manifest's `hostApi[]` allowlist declared. Method calls route through `ModuleHostManager.<managed>.rpc.sendRequest("host/<method>", args)` — which requires…

3. **Daemon-side `host/*` RPC handlers** (on each managed module's `rpc`). Resolve via the capability registry with the module's granted permissions. This is the piece that makes `host.capability<T>(id)` actually do something; currently `HostApi` is type-only.

4. **`renderer/components/ModulePanel.tsx`** — generic `WebContentsView` embedder that resizes on layout changes and focuses on click.

5. **`renderer/App.tsx` refactor** — build view map from `invoke('modules:list')` instead of the hardcoded `ViewTab` switch. Remove the `ViewTab` union; `string` is fine.

6. **Security controls (Revision Log):**
   - `panel-bridge.ts` enforces no cross-module delivery.
   - Every cross-channel send audit-logged.
   - Matches the S1–S6 controls from the DevTools plan applied per-module.

### Leverage Phase 3d work

- **Module authors build panels using `runModule({ manifest, tools, onConnection? })`** — if a panel needs extra RPC methods beyond `tool/*`, `onConnection` is the escape hatch. The SDK already handles stdio framing; Phase 4 only adds the *Electron-side* plumbing.
- **`tools/listChanged` already works** — when a new module installs or an existing one crashes, MCP clients re-handshake within ~10ms. Phase 4 should mirror this on the Electron side: the renderer's view map should rebuild when the daemon emits a module-change event. Reuse the `modules/subscribe` IPC the Phase 3d commit introduced; do NOT introduce a second subscription mechanism.

### Do NOT do

- Marketplace / install flow / `@npmcli/arborist` — Phase 6.
- Device Control adapters — Phase 7+.
- Module signing (`manifest.signature`) — V2.
- Sandbox enforcement (`manifest.sandbox`) — V2.
- Progress-token streaming on cold-start — still deferred (low priority).
- Per-activation-event routing (`onMcpTool:<pattern>`) — still deferred.

### Permanent contract rules (unchanged — do not drift)

- `<moduleId>__<tool>` for 3p / flat for built-ins.
- SDK exports `host.capability<T>(id: string)` — not hardcoded names.
- Manifest at `rn-dev-module.json` at package root.
- Schema is additive-only within 1.x.
- `ModuleHostManager` lives in the daemon — Electron main + MCP server are clients.
- Per-module Electron partition `persist:mod-<id>` + dedicated preload.
- `destructiveHint: true` tools require confirmation (`--allow-destructive-tools` OR `permissionsAccepted[]`).
- **NEW (Phase 3d):** `IpcMessageEvent.onClose` is required; subscription handlers detach on socket close.
- **NEW (Phase 3d):** `runModule()` is the supported contribution surface for 3p authors; `onInitialize` + `onConnection` are escape hatches.

### Success criteria for Phase 4

- A fixture module declaring `contributes.electron.panels[]` renders an embedded `WebContentsView` in the GUI.
- `rnDev.<method>` calls from the panel reach the module subprocess over RPC.
- Panel resize + focus work.
- Manual playwright-electron smoke test (or `bun run dev:gui` manual check) confirms no regression to existing panels (Dev Space, Settings, Lint/Test, Metro Logs, DevTools Network).
- Renderer sidebar re-renders when a module is installed / crashed / toggled (reuses `modules/subscribe`).

### Verification commands

```bash
# Unit + integration tests
npx vitest run

# Type check (baseline: 154 errors, unchanged since Phase 0.5)
npx tsc --noEmit | grep -c "error TS"

# Production build
bun run build

# Sanity-check MCP stdio transport (from Phase 3d session):
bun run src/index.tsx mcp   # pipe JSON-RPC; verify tools.listChanged: true capability

# Echo fixture sanity check (validates SDK dist + runModule):
# Write a minimal driver that spawns `node test/fixtures/echo-module/index.js`
# and sends `initialize` over stdio. Expected: { moduleId: "echo", sdkVersion: "0.1.0", ... }.
```

### When done

Per phase:
1. Commit with Conventional Commits + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
2. Write `docs/plans/2026-04-??-module-system-phase-4-handoff.md` matching the existing format.
3. Push; verify PR is clean.

Remember:
- `vitest run`, not `bun test`.
- `bun run build` for production bundle verification.
- tsc baseline is 154 errors (unchanged since Phase 0.5). Any new errors in your own code = red flag.
- 18 pre-existing test failures in `src/core/__tests__/{clean,preflight,project}.test.ts` — unrelated, chip tracked separately.
- `.claude/` is gitignored.
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it before each test run.
