# Module System — Phase 3b → Phase 3c Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 3b session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 3b

The end-to-end **tools/call proxying path** for 3p module tools:

```
MCP agent → tools/call "echo__ping" → MCP server (src/mcp/module-proxy.ts)
         → IPC "modules/call" (src/app/modules-ipc.ts on the daemon)
         → ModuleHostManager.acquire() (Phase 2)
         → managed.rpc.sendRequest("tool/ping", args)  (vscode-jsonrpc)
         → subprocess handler returns { pong: true, echoed: args }
         → daemon returns { kind: "ok", result }
         → MCP server maps to { structuredContent: result }
         → MCP client sees a normal tools/call response
```

Plus the `destructiveHint` gating, module filtering via
`--enable-module` / `--disable-module`, and the module-tool description
decoration (DevTools S6 ethos codified at the MCP boundary).

### Commits

| Commit | Scope |
|--------|-------|
| `b951306` | `modules/call` IPC action + MCP `module-proxy.ts` + `tools/list` composition + echo-fixture `tool/ping` handler + 18 new tests |

### Verification

- **vitest:** 539 passed / 18 pre-existing unrelated failures. +18 new
  tests from Phase 3b (5 dispatcher + 13 proxy).
- **tsc:** 154 errors (unchanged baseline).
- **bun run build:** green.

---

## Files touched this session

| File | Change |
|------|--------|
| `src/app/modules-ipc.ts` | Added `modules/call` action + `RegisteredModuleRow.tools` so MCP clients register contributions in one IPC round-trip. |
| `src/mcp/module-proxy.ts` | **New** — `discoverModuleContributedTools(ctx, flags)` + handler plumbing, destructiveHint gate, description decoration. |
| `src/mcp/__tests__/module-proxy.test.ts` | **New** — 13 tests. |
| `src/mcp/server.ts` | Composes `[...builtInTools, ...moduleTools]` at startup. |
| `src/app/__tests__/modules-ipc.test.ts` | +5 tests for `modules/call` success/error/FAILED paths. |
| `test/fixtures/echo-module/index.js` | Added `tool/ping` + `tool/explode` handlers for dispatcher tests. |

---

## Permanent contract decisions made in Phase 3b

1. **Wire-format for subprocess tool calls:** host → module sends a JSON-RPC
   request named `tool/<name>` where `<name>` is the bare tool suffix (for
   3p: the part after `<moduleId>__`). Bare means: `echo__ping` on the MCP
   surface becomes `tool/ping` on the wire. Keeps the subprocess API
   prefix-free.
2. **`permissionsAccepted` is stripped before proxying.** It is an MCP-
   transport concern; the module subprocess never sees it. Prevents a
   module from accidentally exfiltrating the consent envelope.
3. **`tools/list` snapshots on MCP startup.** No per-request IPC round-trip.
   This means new modules installed after MCP starts aren't visible until
   the client disconnects/reconnects OR a `tools/listChanged` notification
   arrives (Phase 3c). Trade-off: fast `tools/list`, stale view on drift.
4. **Module-proxy fallback is silent.** No IPC → zero module tools in the
   list, same as how `devtools-network-*` tools silently omit when their
   flag is off. This keeps MCP sessions against projects without a daemon
   from erroring — they just see built-ins.
5. **Every module tool description is decorated with a security warning.**
   The prompt-injection warning (DevTools S6) is automatic at the MCP
   boundary; module authors don't have to opt in. `[destructive]` prefix is
   automatically added for `destructiveHint: true` tools.

### modules/call response contract

```ts
type Response =
  | { kind: "ok"; result: unknown }
  | {
      kind: "error";
      code:
        | "MODULE_UNAVAILABLE"
        | "MODULE_ACTIVATION_TIMEOUT"
        | "E_MODULE_CALL_FAILED";
      message: string;
    };
```

All three error codes are from the Phase 1 `ModuleErrorCode` enum plus
the new `E_MODULE_CALL_FAILED` which isn't in the enum today — added
here as a catch-all for tool-runtime errors that don't map cleanly to a
more specific code. Phase 3c should promote this into
`ModuleErrorCode` if it stays.

---

## Deliberately deferred to Phase 3c (or later)

These are plan items Phase 3 called for that I intentionally did NOT
build. All are safe-to-skip in the sense that nothing downstream today
requires them, but each should land before the feature set is complete.

1. **`tools/listChanged` notification emission.** Requires:
   - A subscription channel from daemon → MCP ("modules changed").
   - MCP server uses `Server.notification(...)` per MCP spec.
   - Triggers: module install/uninstall/enable/disable, crash-to-FAILED,
     recover-from-FAILED.
   Implementation sketch: add a subscribe-style IPC action that streams
   events; `server.ts` forwards to the MCP transport.

2. **`modules/enable` + `modules/disable` MCP tools with persistence.**
   `McpFlags.disabledModules` already provides a per-invocation override.
   What's missing is a runtime toggle that survives restarts. Simple path:
   a `~/.rn-dev/modules/<id>/disabled.flag` file — `ModuleRegistry.loadUserGlobalModules`
   skips registration when the flag is present.

3. **Streaming progress token on cold-start.** The plan says "emit MCP
   progress token immediately so clients see spawn latency". Phase 3b
   just awaits the IPC response. For modules with long
   handshake/activation, clients get no progress feedback. Add via MCP's
   progress protocol (`server.sendProgress`).

4. **Per-activation-event spawn routing.** `onMcpTool:<pattern>` activation
   events aren't checked — any call to `<id>__<tool>` just acquires the
   module regardless. Today that works because `moduleHost.acquire()`
   spawns on demand either way, but a module that declared only
   `onMcpTool:echo__ping` in activation events SHOULD refuse calls to
   `echo__other` unless another activation event matched. Consider moving
   activation-event matching into the daemon's `modules/call` path.

5. **MCP spec version pin (`2025-11-25`).** The `Server` constructor
   already gets `capabilities: { tools: {} }` but doesn't pin the spec
   version. Low-risk add.

6. **SDK `module-runtime.ts`.** Still missing — echo fixture uses
   vscode-jsonrpc directly. Module authors currently have no SDK
   helper for `defineModule({ tools, panels, activate })` with a real
   listen loop. This is the Phase 3c bit that makes 3p authoring
   ergonomic.

7. **`ModuleErrorCode.E_MODULE_CALL_FAILED`.** New string added inline in
   `modules-ipc.ts`; should be promoted into the SDK enum.

---

## Key decisions carried forward

All Phase 0/0.5/1/2/3a decisions still apply. Phase 3b adds:

- **Daemon is the only party that speaks to module subprocesses.** MCP
  never calls `moduleHost.acquire()` directly — only via IPC. This keeps
  "who can spawn subprocesses" answerable in one place and makes MCP-
  headless-without-daemon work by design (zero module tools, no zombie
  children).
- **MCP module-proxy is a thin passthrough.** No caching of results, no
  argument rewriting (besides stripping `permissionsAccepted`), no
  retries. If logic needs to grow (e.g. per-tool fallback), it should go
  on the daemon side.
- **Tool metadata authority is the manifest.** `description`, `inputSchema`,
  `destructiveHint` are frozen at manifest-load time on the daemon. The
  MCP server sees a shallow copy via `RegisteredModuleRow.tools[]`. Any
  change requires manifest reload + `tools/listChanged`.

---

## What's next — Phase 4 (or Phase 3c if 3b needs polish)

Per the plan, Phase 4 is **Electron panel contributions (WebContentsView
pivot).** That unblocks the GUI half of the module system: a 3p module
declares `contributes.electron.panels[]`, the host embeds a
`WebContentsView` with a sandboxed preload exposing `rnDev.<method>`
allowlist.

Prerequisites I'd want to tackle first:

- `tools/listChanged` emission. Electron's module-install flow will want
  to trigger it so the MCP surface stays fresh.
- `modules/enable`/`modules/disable` persistence. The Electron "Retry"
  button and sidebar toggle need this.
- SDK `module-runtime.ts`. Electron module authors need the same module-
  side RPC runtime that MCP module authors need.

Consider landing those as a Phase 3c commit before starting Phase 4.

### Rough size estimate

- Phase 3c (listChanged + enable/disable persistence + SDK runtime): ~1–2 days
- Phase 4 (Electron panel contributions): ~3–5 days, mostly because
  WebContentsView on Electron 30+ has surface area to learn

---

## Environment notes

- Node ≥18; bun for install + build + dev; vitest for tests.
- Branch: `feat/module-system-phase-0` (stacked commits — PR #2 now
  contains Phases 0/0.5/1/2/3a/3b).
- No new runtime deps this session.
