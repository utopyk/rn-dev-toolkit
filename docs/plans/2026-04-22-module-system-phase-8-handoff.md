# Module System — Phase 8 → Phase 9 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 8 session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 8

Two coherent units bundled into one PR. DevTools Network 3p extraction
deferred to Phase 9 — it deserves its own migration PR with careful
review, and bundling it here would push the change size past the 2500
line target and blur the review focus.

1. **HMAC-chained `AuditLog.append()`.** All four existing audit sinks
   (`panel-bridge`, `host-call`, `config-set`, `install`/`uninstall`)
   now route through `src/core/audit-log.ts` → `~/.rn-dev/audit.log`.
   The service-log UX pane is preserved via a single `auditLog.on("appended", …)`
   listener that renders each entry as a human-readable line. HMAC key
   lives at `~/.rn-dev/audit.key` (mode 600), auto-generated on first
   use. Tamper detection via `verify()` — returns `{ ok, failedAt, reason }`.
   Rotation at 10MB → `audit.log.1`; the chain continues across files.

2. **`modules/rescan` IPC action + `rn-dev module rescan` CLI.** Diffs
   `~/.rn-dev/modules/` against the live `ModuleRegistry`, applies
   adds / removes / updates, fires `install` / `uninstall` module-events
   per change. Closes the UX loop Phase 7's CLI install opened: a
   running daemon picks up out-of-band module file changes without a
   restart. CLI-install path already goes through the daemon
   (`modules/install` IPC), so rescan is primarily for recovery + agent-
   driven resync — one more `modules/*` action agents can reach over
   the unix-socket transport.

Plus the plumbing — `ModuleRegistry.scanUserGlobalModules()` static
helper (returns candidates without mutating the registry) that
`loadUserGlobalModules` now delegates to.

---

## Scope that shipped

| Concern | Shipped |
|---------|---------|
| `src/core/audit-log.ts` | HMAC-SHA256 chain, append-only, file rotation, lazy key gen, append serialization via promise chain |
| `src/core/__tests__/audit-log.test.ts` | 10 tests — monotonic seq, chain continuity, tamper detection (kind + hash), concurrent serialization, cross-file rotation verify, daemon-restart chain resume |
| Electron audit wiring | `electron/ipc/index.ts` — one `auditLog.on("appended")` subscription fans out to `service:log`; all four existing `service:log` audit sinks now call `auditLog.append()` |
| `modules/rescan` IPC action | `src/app/modules-ipc.ts:rescanAction` + dispatcher branch + `MODULES_ACTIONS` + type union |
| `ModuleRegistry.scanUserGlobalModules` | Static non-mutating scan; `loadUserGlobalModules` now composes on top |
| `src/app/__tests__/modules-rescan.test.ts` | 6 tests — added/removed/updated/no-op/rejected/built-in-skip |
| `rn-dev module rescan` CLI | `src/cli/module-commands.ts` — dispatches `modules/rescan` over daemon IPC, pretty-prints counts + per-path rejections |

---

## Files touched

### New

| File | Purpose |
|------|---------|
| `src/core/audit-log.ts` | `AuditLog` class — append, verify, rotate, EventEmitter for UX mirror |
| `src/core/__tests__/audit-log.test.ts` | Full coverage of the chain invariants |
| `src/app/__tests__/modules-rescan.test.ts` | Diff semantics + event emission coverage |
| `docs/plans/2026-04-22-module-system-phase-8-handoff.md` | This document |

### Modified

| File | Change |
|------|--------|
| `electron/ipc/index.ts` | Imports `getDefaultAuditLog`; subscribes once + mirrors to `service:log`; the four `service:log` audit sinks migrated to `auditLog.append()`; `formatAuditEntry` + `mapHostCallOutcome` helpers added |
| `src/app/modules-ipc.ts` | New `rescanAction` + `ModuleRescanResult` + `"modules/rescan"` in `ModulesIpcAction`/`MODULES_ACTIONS`; `ModuleRegistry` import widened from type-only to value |
| `src/modules/registry.ts` | New static `scanUserGlobalModules`; `loadUserGlobalModules` delegates |
| `src/cli/module-commands.ts` | New `rescan` sub-command + wiring; standalone-install hint updated to reflect daemon-preferred behavior |
| `src/cli/__tests__/module-commands.test.ts` | Test count updated to include `rescan` |

---

## Verification

- **vitest:** 806 passed / 0 failed (+16 since PR #6 — 10 audit-log, 6 rescan).
- **tsc (root):** 150 — unchanged (0 new errors; `ModuleRegistry` value-import is fully typed).
- **tsc (renderer):** 1 — unchanged pre-existing baseline.
- **bun run build:** green.
- **Manual smoke:** not run in this session. Recommended before merge:
  - Start the GUI, exercise install/uninstall, verify `~/.rn-dev/audit.log` grows with structured entries + the service-log pane still shows human-readable lines.
  - From another terminal: `rn-dev module rescan` against a running daemon. Make/remove a module dir manually; rerun rescan; confirm the live registry + MCP `tools/listChanged` converge.

---

## Permanent contract decisions made in Phase 8

- **`~/.rn-dev/audit.log` schema is stable.** NDJSON lines with
  `{ ts, seq, kind, moduleId, outcome, code?, data?, prevHash, hash }`.
  Additive-only within v1 — new fields are OK, removals or renames
  require a major schema bump (which the file format doesn't encode;
  the plan is to emit a `schema: "v2"` field on the first post-bump
  entry and branch in `verify()`).
- **HMAC key at `~/.rn-dev/audit.key`, mode 600, 64 random bytes.**
  Lazy-generated on first use. Tests inject keys directly via the
  `AuditLog({ key: Buffer })` option; they never touch the default path.
- **Seq resets per file; prevHash continues across files.** The chain
  is file-agnostic so `audit.log.1` + `audit.log` can be verified as
  one unit. Seq is operator-ergonomic — "see entry N in the active
  log" is unambiguous without file-coordinate context.
- **AuditLog is singleton via `getDefaultAuditLog()`.** Only one daemon
  process writes; there is no cross-process locking. If a future phase
  lets a sidecar write, the AuditLog grows an advisory lockfile before
  we widen the writer set.
- **Audit kinds are namespaced by subsystem.** Current set:
  `install` / `uninstall` / `config-set` / `host-call` / `panel-bridge`.
  New subsystems add their own kinds. Agents + post-mortem tools
  filter on `kind`; the outcome axis is 3-valued (`ok` / `error` /
  `denied`) so dashboards don't sprawl.
- **`modules/rescan` is idempotent + non-destructive.** Running it
  twice in a row produces no events on the second call. Never deletes
  disk state — only updates the in-memory registry. CLI `install` /
  `uninstall` paths are still the canonical way to mutate disk.
- **Version changes trigger uninstall + install event pair.** A
  `device-control@0.1.0 → 0.2.0` swap emits both events so any
  subscriber that caches per-version state invalidates cleanly.
- **`scanUserGlobalModules` is static + non-mutating.** Callers can
  diff against any source without risking double registration.

---

## Deferred items (Phase 8 → Phase 9 and beyond)

1. **DevTools Network extraction to `@rn-dev-modules/devtools-network`.**
   Originally Phase 8 primary — deferred to keep this PR focused.
   First built-in→3p migration, so it needs careful review of the
   packaging pipeline + tool-name transition (`rn-dev/devtools-network-*`
   → `devtools-network__*` per the 3p prefix policy).
2. **Retention + GC sweep for `keepData: true`.** Still on the list
   since Phase 6.
3. **Detached Ed25519 signature verification** of `modules.json`.
4. **Parked P2s from the Phase 7 review:**
   - Kieran TS P2-4 — `args as Parameters<typeof fn>[0]` casts in
     `modules/device-control/src/index.ts`.
   - Simplicity P1-5 — extract `resolveAppId(adapter, args)`.
   - Simplicity P2-6 — trim `exec.ts`'s 4-way discriminated union.
   - Simplicity P2-8 — drop `<ul>` details in `UninstallConfirmDialog.tsx`.
   - Security P2 — committed tarball in `docs/fixtures/` is a reviewer
     blind spot; CI re-pack + byte-compare or CODEOWNERS.
   - Arch P2 — `host-call` uses `canRead` for write-shaped capability
     methods; consider `canInvoke` predicate.
5. **Marketplace panel rescan trigger.** Today the panel subscribes to
   `modules:event` and re-fetches on any event. An explicit "Rescan
   now" button would let users force a sync from the UI — currently
   only the CLI exposes it.
6. **Option (b) sidebar** — renderer-native vs. sandboxed panel kind
   branching. Defer until a 3rd renderer-native built-in motivates it.

---

## Where the module system stands (end of Phase 8)

- **Phase 0–3d** (squashed PR #2): foundation.
- **Phase 4 + 5a + 5b** (squashed PR #3): Electron panels, per-module
  config, built-in manifest-ification + Marketplace stub.
- **Phase 5c** (squashed PR #4): review follow-ups + Electron bootstrap
  + renderer panels + Settings migration + Quick Mode.
- **Phase 6** (squashed PR #5): Marketplace install/uninstall + consent
  UX + curated registry + host-read/write split.
- **Phase 7** (squashed PR #6): Device Control v0.1 + registry fixture
  + CLI parity + install/uninstall event kinds + `modules:call-tool`
  + Kieran P2-3/P2-4.
- **Phase 8** (this PR): HMAC AuditLog + `modules/rescan` + `rn-dev
  module rescan` CLI.

**Test totals:** 806 passed / 0 failed. tsc: 150 root / 1 renderer.
`bun run build`: green.

---

## What's next

Ask Martin:

> **"Phase 8 done — audit log + rescan. Phase 9 is the built-in→3p
> migration (DevTools Network → `@rn-dev-modules/devtools-network`),
> or do you want to pivot to `keepData` retention + GC, or publish
> `@rn-dev-modules/device-control` to real npm first?"**

Phase 9 natural sequence if we do the migration:
- Move `src/modules/built-in/devtools-network.ts` + associated MCP tool
  definitions into `modules/devtools-network/`. Same `runModule()`
  pattern as `device-control`.
- Rename `rn-dev/devtools-network-*` tool names to
  `devtools-network__*` per the 3p prefix policy. Agents will need to
  re-discover — `tools/listChanged` already handles this.
- Add the module to `docs/fixtures/modules.json` + recompute SHA.
- Delete the built-in + its renderer references if any.
- Parity test: capture one request through the migrated module + the
  built-in, confirm identical DTO shape.

---

## Useful commands

```bash
# Phase 8-specific tests
npx vitest run \
  src/core/__tests__/audit-log.test.ts \
  src/app/__tests__/modules-rescan.test.ts

# Full suite — expect 806 / 0
npx vitest run

# Type check — baselines 150 root / 1 renderer
npx tsc --noEmit | grep -c "error TS"
(cd renderer && npx tsc --noEmit | grep -c "error TS")

# Production build
bun run build

# Audit log smoke
bun run dev:gui
# In another terminal — observe the audit log grow as you click around:
tail -f ~/.rn-dev/audit.log | jq .

# Rescan smoke — requires a running daemon (`rn-dev start` in another shell)
rn-dev module list            # baseline
mkdir -p ~/.rn-dev/modules/phantom && echo '{"id":"phantom","version":"0.1.0","hostRange":">=0.1.0","scope":"global"}' > ~/.rn-dev/modules/phantom/rn-dev-module.json
rn-dev module rescan          # should report +1 added
rn-dev module list            # phantom now visible
rm -rf ~/.rn-dev/modules/phantom
rn-dev module rescan          # should report -1 removed
```
