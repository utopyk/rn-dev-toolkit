# Module System — Phase 9 → Phase 10 Handoff

**Written:** 2026-04-23
**By:** Claude (Phase 9 session)
**For:** The next Claude (or human) continuing this feature

**Phase 9 shipped as PR [#8](https://github.com/utopyk/rn-dev-cli/pull/8), squash-merged to `main` on 2026-04-23 as commit `241b482`.**

---

## What shipped in Phase 9

First built-in → 3p migration. The DevTools Network capture surface moved
out of the host daemon and into a workspace-packaged subprocess module:
`@rn-dev-modules/devtools-network` at `modules/devtools-network/`. Five
MCP tools now wire through the 3p module-proxy path; the old
`rn-dev/devtools-network-*` and `rn-dev/devtools-status` tools plus the
`devtools-ipc` unix-socket dispatcher and the `devtools-dto` file are
retired.

1. **`modules/devtools-network/` — new workspace package.**
   Manifest contributes 5 MCP tools (`devtools-network__status`,
   `__list`, `__get`, `__select-target`, `__clear`) + one Electron panel
   (`Network`) + a `captureBodies: boolean` config schema. Runs as a
   Node subprocess via `runModule()` like `device-control`. DTO
   redaction (S5) ported from the retired `src/mcp/devtools-dto.ts` and
   now lives at `modules/devtools-network/src/dto.ts`; `projectMeta()`
   centralizes the `bodyCapture: "mcp-redacted"` envelope rewrite so
   `status` and `list` can't disagree.

2. **`src/core/devtools/host-capability.ts` — new `devtools` host
   capability.** The module subprocess calls `ctx.host.capability
   <DevtoolsHostCapability>("devtools")` to reach the live
   `DevToolsManager`; permission `devtools:capture` gates access.
   Caller-supplied `worktreeKey` is validated against an allowlist —
   unknown keys silently fall back to the daemon's `defaultWorktreeKey`
   so a module with the permission can't read/mutate another worktree's
   capture state (Security P0-2 from review).

3. **Retirements.** `src/modules/built-in/devtools-network.ts`,
   `src/app/devtools-ipc.ts` + its test, `src/mcp/devtools-dto.ts` + its
   test, `buildDevtoolsNetworkTools` + `buildDevtoolsStatusTool` +
   `CAPTURE_META_SCHEMA` + `S6_WARNING` in `src/mcp/tools.ts`,
   `McpFlags.enableDevtoolsMcp` / `.mcpCaptureBodies`, and the
   `--enable-devtools-mcp` / `--mcp-capture-bodies` CLI flags +
   `emitSecurityBanner`. The S6 prompt-injection warning moved into
   each tool's `description` in `modules/devtools-network/rn-dev-module.json`.

4. **Security hardening landed alongside the extraction**
   (pre-merge review P0/P1 fixes):
   - `rn-dev/modules-config-set` is now `destructiveHint`-gated —
     requires `permissionsAccepted: ["rn-dev/modules-config-set"]` or
     `--allow-destructive-tools`. Closes the exfiltration chain where
     an MCP agent could flip `captureBodies: true` and read raw bodies.
   - Every successful / denied config write appends to
     `~/.rn-dev/audit.log` with patch key names (never values).
   - `config.json` writes use mode `0o600`; module dirs `0o700`.
   - `startServicesAsync` emits a warning line per module carrying a
     sensitive permission (`devtools:capture`, `exec:adb`,
     `exec:simctl`) — restores S7 operator-visibility after
     `emitSecurityBanner`'s removal.
   - Module-scoped `tsc --noEmit -p modules/devtools-network/tsconfig.json`
     now clean; tool-handler wrappers narrow `Record<string, unknown>`
     into precise arg types defensively.

5. **Registry fixture updates.**
   `docs/fixtures/modules.json` now lists two entries
   (`device-control` + `devtools-network`). Tarball at
   `docs/fixtures/devtools-network-0.1.0.tgz` (SHA-256
   `06da3c4930d6dca21a4fdb5ea2081bf290e973ea198f912f443f1633a04edf34`).

---

## Files touched

### New

| File | Purpose |
|------|---------|
| `modules/devtools-network/package.json` | Workspace package metadata |
| `modules/devtools-network/rn-dev-module.json` | Manifest (5 tools, 1 panel, 1 config key, `devtools:capture` permission, `onStartup` activation) |
| `modules/devtools-network/tsconfig.json` | Mirrors device-control |
| `modules/devtools-network/build.ts` | Bun native build to `dist/index.js` |
| `modules/devtools-network/src/index.ts` | `runModule()` entry; narrows `Record<string, unknown>` args into precise handler shapes |
| `modules/devtools-network/src/tools.ts` | 5 tool handlers + shared `resolveCapability` + `readCaptureBodies` typeguard + `extractFilter` (validates `since` cursor + bounds `limit`) |
| `modules/devtools-network/src/dto.ts` | Ported DTO redaction + new `projectMeta()` helper |
| `modules/devtools-network/src/types.ts` | Host-type mirrors (no `NetworkCursorBrand` — branded host type is intentionally not duplicated) |
| `modules/devtools-network/src/host-capability.ts` | Module-side interface mirror of `DevtoolsHostCapability` |
| `modules/devtools-network/src/__tests__/dto.test.ts` | 7 tests, ported from retired `src/mcp/__tests__/devtools-dto.test.ts` |
| `modules/devtools-network/src/__tests__/parity.test.ts` | Single `expectTypeOf().toMatchTypeOf()` block covering 7 host types |
| `modules/devtools-network/panel/index.html` | Polling network-list panel (2s interval) |
| `modules/devtools-network/panel/panel.js` | Calls own `list` + `clear` tools via `rnDev.callTool` |
| `docs/fixtures/devtools-network-0.1.0.tgz` | Committed tarball (`bun pm pack` output) |
| `src/core/devtools/host-capability.ts` | Capability impl + interface + `AllowedWorktreeKeys` |
| `src/core/devtools/__tests__/host-capability.test.ts` | 11 tests — worktree allowlist, fallback, empty-id guards |

### Deleted

| File | Reason |
|------|--------|
| `src/modules/built-in/devtools-network.ts` | Retired built-in TUI view |
| `src/app/devtools-ipc.ts` | `devtools/*` unix-socket dispatcher no longer has callers |
| `src/app/__tests__/devtools-ipc.test.ts` | Tests the retired dispatcher |
| `src/mcp/devtools-dto.ts` | DTO layer moved into `modules/devtools-network/src/dto.ts` |
| `src/mcp/__tests__/devtools-dto.test.ts` | Renamed-and-ported to `modules/devtools-network/src/__tests__/dto.test.ts` |

### Modified

| File | Change |
|------|--------|
| `src/app/start-flow.ts` | Registers `devtools` capability; drops `devtoolsNetworkModule` import + registration; emits sensitive-permission warning lines; drops `registerDevtoolsIpc` call |
| `src/app/modules-ipc.ts` | `applyConfigSet` now appends a `config-set` audit entry (`getDefaultAuditLog().append(...)`) on ok + error paths |
| `src/mcp/tools.ts` | Removed `buildDevtoolsNetworkTools` / `buildDevtoolsStatusTool` / `CAPTURE_META_SCHEMA` / `S6_WARNING` / devtools-type imports. Added `destructiveHint` gate on `rn-dev/modules-config-set` + strips `permissionsAccepted` before forwarding. Stale comment block refactored to describe the remaining shared IPC helpers. |
| `src/mcp/server.ts` | `parseFlags` no longer accepts `--enable-devtools-mcp` / `--mcp-capture-bodies`; `emitSecurityBanner` deleted. |
| `src/mcp/__tests__/{tools,parse-flags,module-proxy,subscribe-to-module-changes}.test.ts` | Drop retired flag fixtures + devtools-specific describe blocks. `tools.test.ts` asserts 30 tools by default (was 31). |
| `src/cli/commands.ts` | Drops `--enable-devtools-mcp` + `--mcp-capture-bodies` options |
| `src/modules/config-store.ts` | `write()` uses mode `0o600`; module dir `mkdirSync` uses mode `0o700` |
| `src/modules/index.ts` | Drops `devtoolsNetworkModule` export |
| `README.md` | Complete rewrite of the DevTools Network + Modules section — new tool names, install-consent flow, `captureBodies` config semantics, `permissionsAccepted` contract for destructive config writes |
| `docs/fixtures/modules.json` | Adds `devtools-network` entry + SHA |

---

## Verification

- **vitest:** 786 passed / 0 failed.
- **tsc (root):** 150 — **no change** vs. Phase 8.
- **tsc (renderer):** 1 — unchanged.
- **tsc (module-scoped, `-p modules/devtools-network/tsconfig.json`):** 0 errors in module source. (Pre-existing SDK ajv import error surfaces on the same command but is out of scope — filed as Kieran P2 follow-up; see Phase 10.)
- **`bun run build`:** green.
- **`bun run modules/devtools-network/build.ts`:** green (8.4 KB output).
- **Manual smoke:** not run in this session. Recommended before the next release cut:
  - Start the GUI; install `devtools-network` via Marketplace; confirm it shows as subprocess kind in `rn-dev module list` with the Network panel registered.
  - Fire fetches; confirm `devtools-network__list` returns entries via MCP and the Electron panel renders them on its 2-second poll.
  - `rn-dev/modules-config-set { moduleId: "devtools-network", patch: { captureBodies: true } }` WITHOUT `permissionsAccepted` — must return `E_DESTRUCTIVE_REQUIRES_CONFIRM`. WITH `permissionsAccepted: ["rn-dev/modules-config-set"]` — must write, audit log grows.
  - `tail -f ~/.rn-dev/audit.log | jq .` during install/uninstall/config-set — entries must include `kind`, `moduleId`, `outcome`, and (for config-set) `patchKeys`.

---

## Permanent contract decisions made in Phase 9

- **3p prefix policy IS the built-in-retirement convention.**
  `rn-dev/devtools-network-*` → `devtools-network__*` — every subsequent
  built-in-to-3p migration changes MCP wire names the same way. Agents
  re-discover via `tools/listChanged`.
- **`captureBodies` moves from CLI flag to per-module config.** Every
  future security-sensitive module toggle lives in the module's
  `contributes.config.schema` + reads via `ctx.config` in handlers —
  never a new MCP-server CLI flag. Gate writes with `destructiveHint`.
- **Module-boundary type mirroring pattern.**
  `modules/devtools-network/src/types.ts` duplicates host types + a
  `parity.test.ts` with `expectTypeOf().toMatchTypeOf()` asserts
  bidirectional structural equivalence (minus branded types like
  `NetworkCursor` which deliberately can't be replicated across the
  boundary). Pattern is for v1. When a second devtools-* module lands
  (`devtools-console`, `devtools-performance`), extract a shared
  types-only `@rn-dev/module-sdk-devtools` subpath package.
- **`devtools` host capability is singleton + worktree-allowlist
  gated.** Multi-worktree daemons thread their allowlist via the
  optional third `AllowedWorktreeKeys` arg to
  `createDevtoolsHostCapability`. Caller-supplied keys outside the
  allowlist silently fall back to the default (fail-safe, no error
  surface to exploit).
- **`rn-dev/modules-config-set` is always `destructiveHint`.** The
  patch is shallow-merged into persisted JSON under `~/.rn-dev/modules/`;
  any key can be a security toggle. Always require confirmation.
- **Audit log kinds stable within v1.** `install` / `uninstall` /
  `config-set` / `host-call` / `panel-bridge` — no renames within
  v1.x. `config-set` entries record `patchKeys` (not values) so
  secrets don't leak into the log.
- **Config files are `0o600`, module dirs are `0o700`.** POSIX best
  effort; Windows gets whatever `fs` provides.
- **Startup emits a warning line per module carrying a sensitive
  permission** (`devtools:capture` / `exec:adb` / `exec:simctl` today).
  Future sensitive permissions append to the `SENSITIVE_PERMS` set in
  `src/app/start-flow.ts`.

---

## Deferred items (Phase 9 → Phase 10 and beyond)

### Reviewer follow-ups intentionally deferred

From the Phase 9 review round:

- **Arch P1-1 — agent discoverability regression.** When
  `devtools-network` isn't installed, no tool hints that installing it
  is the fix. Options: (a) add `modules/available` meta-tool that
  enumerates the registry fixture, (b) mention installable-module names
  in the `rn-dev/modules-list` description trailer. Option (a) preferred
  for Phase 10.
- **Arch P1-2 — capability-boundary validation.** `DevtoolsHostCapability`
  checks `requestId` / `targetId` for non-empty, but not the wire-level
  `inputSchema` minimum lengths — duplicate concern but cheap to add if
  a second consumer of the capability appears.
- **Arch P2-1 — split `devtools:capture` into `:read` / `:mutate`.**
  Compounds the Phase 7 parked `canInvoke` / `canRead` concern. Do
  before a second consumer requests the permission.
- **Kieran P1 #6 — shared `@rn-dev/module-sdk-devtools` types
  subpath package.** Triggered the moment a second devtools-* module
  lands; deferring to that PR.
- **Kieran P2 #9 — type `selectTarget` / `clear` returns as
  `CaptureMeta`** (currently `unknown` at module tool layer).
- **Kieran P2 #10 — extract `registerHostCapabilities(capabilities,
  deps)` helper** out of `startServicesAsync` (now ~260 LOC).
- **Kieran P2 #11 — `index.ts` regex entry-detection guard** →
  `import.meta.main` or canonical ESM idiom.
- **Security P2-1 — permission allowlist + unknown-permission
  warning** at `register()` time.
- **Security P2-2 — CI re-pack + byte-compare for
  `docs/fixtures/*.tgz`** or CODEOWNERS gate.
- **Security P2-3 — lint every tool description on a
  sensitive-permission module for the S6 warning substring.**
- **Security P3-1 — de-detailed capability-unavailable error
  message** (module currently leaks "capability missing vs. permission
  denied" information; the host-side RPC already gives the same
  indistinguishable error intentionally).
- **Simplicity P3 — drop `escapeHtml` in panel** in favor of
  DOM-builder style for the one remaining `innerHTML` template.
- **Simplicity P2 — module `index.ts:38` regex entry gate** (same
  as Kieran P2 #11).

### Carry-overs from Phase 7/8 review still parked

- Kieran TS P2-4 — `args as Parameters<typeof fn>[0]` casts in
  `modules/device-control/src/index.ts`.
- Simplicity P1-5 — extract `resolveAppId(adapter, args)` shared
  between `launchApp` + `uninstallApp`.
- Simplicity P2-6 — trim `modules/device-control/src/exec.ts`'s
  4-way discriminated union to `ok | not-found | failed`.
- Simplicity P2-8 — drop `<ul>` in
  `renderer/src/components/UninstallConfirmDialog.tsx`.
- Kieran TS P1 (from Phase 8) — streaming `verify()` in
  `src/core/audit-log.ts` (currently reads whole log into memory).
- Arch P1 (from Phase 8) — `scanUserGlobalModules`
  static-vs-instance split.
- Arch P2 (from Phase 8) — `applyManifestChange(opts, { kind, … })`
  helper to dedup register/unregister + event emission across
  `rescanAction` / `installAction` / `uninstallAction`.
- Kieran P3 (from Phase 8) — cycle guard in
  `canonicalize` (throws on `data: circular`).
- Kieran P2 (from Phase 8) — `reply.payload as {...}` ad-hoc casts in
  `src/cli/module-commands.ts` — extract helper if 5+ duplicates.
- Security P1 (from Phase 8) — Electron tsc gap fix (extend `tsconfig`
  `include` to cover `electron/` OR add `electron/tsconfig.json` with
  its own CI check). Phase 8 P0 slipped because of this gap.

### Non-review work still deferred

- **Retention + GC sweep for `keepData: true`.** Since Phase 6.
- **Detached Ed25519 signature verification** of `modules.json`.
- **Marketplace panel "Rescan now" button.**
- **Option (b) sidebar** — renderer-native vs. sandboxed panel kind
  branching.
- **Publish `@rn-dev-modules/devtools-network` + `@rn-dev-modules/device-control`
  to real npm + bake `EXPECTED_MODULES_JSON_SHA256` pin.**

---

## Where the module system stands (end of Phase 9)

- **Phase 0–3d** (PR #2): foundation.
- **Phase 4 + 5a + 5b** (PR #3): Electron panels, per-module config,
  built-in manifest-ification + Marketplace stub.
- **Phase 5c** (PR #4): review follow-ups + Electron bootstrap + renderer
  panels + Settings migration + Quick Mode.
- **Phase 6** (PR #5): Marketplace install/uninstall + consent UX +
  curated registry + host-read/write split.
- **Phase 7** (PR #6): Device Control v0.1 + registry fixture + CLI
  parity + install/uninstall event kinds + `modules:call-tool`.
- **Phase 8** (PR #7): HMAC AuditLog + `modules/rescan` + `rn-dev module
  rescan` CLI.
- **Phase 9** (PR #8): First built-in → 3p migration — DevTools
  Network extraction + `devtools` host capability + retired CLI
  security flags + destructive-config gate + audit-log coverage for
  config writes.

**Test totals:** 786 passed / 0 failed. tsc: 150 root / 1 renderer.
`bun run build`: green.

---

## What's next

Ask Martin:

> **"Phase 9 done — DevTools Network is now 3p + security exfiltration
> chain closed. Phase 10 candidates: (a) second built-in extraction
> (Metro Logs → `@rn-dev-modules/metro-logs`) to re-exercise the
> migration pattern, (b) the reviewer-deferred cleanup bundle
> (streaming `verify()`, Electron tsc gap, `scanUserGlobalModules`
> split, agent discoverability meta-tool, `devtools:capture` read/mutate
> split, permission allowlist warning), or (c) publish
> `@rn-dev-modules/*` to real npm + bake the first production
> `EXPECTED_MODULES_JSON_SHA256`."**

My recommendation is (b) — the deferred bundle. Phase 8 P0 slipped
because `electron/` isn't in tsc's rootDir; Phase 9 would have slipped
for the same reason if the reviewer hadn't caught the module tsc gap.
Closing the cleanup bundle before another phase lands keeps the review
surface manageable.
