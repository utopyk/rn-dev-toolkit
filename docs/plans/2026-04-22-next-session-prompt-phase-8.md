# Next-Session Prompt — Module System Phase 8 (modules/rescan + HMAC audit log + DevTools Network extraction)

**Paste the block below at the start of the next session.**

---

We're continuing the module system for rn-dev-cli. **Phase 7 shipped in PR #6 (squash-merged to `main` on 2026-04-22 as commit d2f141d).** Phase 8 closes the install-flow UX loop, retires the temporary `service:log` audit sinks, and proves the packaging pipeline by migrating DevTools Network from a built-in into a 3p module.

### Before writing any code

1. Read `docs/plans/2026-04-22-module-system-phase-7-handoff.md` — the **Deferred items** section is the Phase 8 punch list. The **Permanent contract decisions** section locks the contract.
2. Skim the original `docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md` **Phase 8** section.
3. `git log origin/main --oneline -5` — confirm you're stacking on Phase 7's squash-merge.

### Branching

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-8
```

Target < 2500 line insertions — the audit log is a new subsystem; the rescan path is surgical; the DevTools Network migration should be mostly moving files rather than writing new ones.

### Phase 8 scope

#### Primary

1. **`modules/rescan` IPC action.** Today CLI install prints "no daemon was running — start one to load the new module" and the GUI install flow relies on the daemon's startup-time `loadUserGlobalModules` scan. Phase 8 wires a `modules/rescan` action on the daemon that:
   - Re-walks `~/.rn-dev/modules/`.
   - Compares against the live `ModuleRegistry`.
   - Registers newly-seen manifests + unregisters vanished ones.
   - Fires `modules-event` for each change so the MCP `tools/listChanged` and Electron `modules:event` subscribers update.
   - Returns `{ added: [...], removed: [...], rejected: [...] }`.
   - CLI `module install` + `module uninstall` daemon paths call it automatically after their round-trip so a running session stays in sync.

2. **HMAC-chained `AuditLog.append()`.** Current state: install/uninstall/host-call/config-set all route through `service:log` as a UX-grade breadcrumb. Phase 8 adds a proper audit log at `~/.rn-dev/audit.log` with:
   - HMAC-SHA256 chain per entry — tampering a prior line invalidates the chain.
   - `AuditLog.append({ kind, moduleId, outcome, ... })` API used by all four existing sinks in one swap.
   - Rotate-on-size (e.g. 10MB → `audit.log.1`).
   - Test harness with deterministic clock + key injection.
   - Retire every `service:log` audit call in the same PR — leaving half the sinks on the old path is a footgun.

3. **DevTools Network extraction — `@rn-dev-modules/devtools-network`.** The first built-in-to-3p migration. Current: `src/modules/built-in/devtools-network.ts` + the MCP tool definitions in `src/mcp/tools.ts`. Migration plan:
   - Move the network capture logic into `modules/devtools-network/` as a subprocess module (same pattern as `device-control`).
   - Keep the MCP tool wire names (`rn-dev/devtools-network-*`) identical — agents don't notice.
   - Update the curated registry fixture to list it.
   - Delete the built-in. No renderer-side changes should be needed (Marketplace already lists 3p modules with the same rowFor projection).
   - Prove the packaging pipeline end-to-end: `bun pm pack` → SHA-pin in fixtures/modules.json → install via Marketplace flow → MCP clients see the same tool list.

#### Secondary — review follow-ups parked from Phase 7

From PR #6 review (all P2 that felt worth bundling):

- **Kieran TS P2-4** — `args as Parameters<typeof fn>[0]` casts in `modules/device-control/src/index.ts`. Either make `runModule`'s tools generic over a schema-to-type map, or keep the casts with a short note referencing the manifest inputSchema as the trust boundary.
- **Simplicity P1-5** — extract `resolveAppId(adapter, args)` shared between `launchApp` and `uninstallApp` in `modules/device-control/src/tools.ts`.
- **Simplicity P2-6** — trim `exec.ts`'s 4-way discriminated union to `ok | not-found | failed` if the 3-way split isn't load-bearing at any caller (verify first).
- **Simplicity P2-8** — drop the `<ul>` details in `UninstallConfirmDialog.tsx` if the subtitle already covers files+subprocess. Keep the reinstall note.
- **Security P2** — committed tarball in `docs/fixtures/` is a reviewer blind spot. Options: CI check that re-packs and byte-compares; CODEOWNERS entry for `docs/fixtures/*.tgz`; or generate the tarball at test time and commit only the sources + a hash.
- **Arch P2** — `host-call` still uses `canRead` for write-shaped capability methods. Consider a `canInvoke` predicate or per-capability read/write annotations.

#### Do NOT do (Phase 7 deferred but not Phase 8)

- **`keepData` retention + GC sweep.** Per-module data dir preservation + 30-day TTL + startup sweep. Separate PR.
- **Detached Ed25519 signature verification** of `modules.json`. v1.1 path.
- **Option (b) sidebar** — drive off `modules:list-panels` + branch on `kind`. Defer until a 3rd renderer-native built-in motivates it.
- **Physical iOS device support via `idb`.** Device-control v0.2 work.

### Permanent contract rules (unchanged from Phase 7 — do not drift)

All from the Phase 7 handoff's "Permanent contract decisions" section, plus:

- `<moduleId>__<tool>` for 3p / flat for built-ins. Migrating a built-in to 3p REQUIRES renaming every tool to carry the `<id>__` prefix — the MCP wire names change.
- `destructiveHint: true` tools require confirmation on both the MCP surface (`permissionsAccepted[toolName]`) and the panel surface (`{ confirmed: true }` in `rnDev.callTool`). The gate added to `modules:call-tool` in Phase 7 must not be bypassable.
- `typeText`, `launchApp`, etc. naming — adapter methods stopped shadowing TS keywords. New adapters + tool handlers follow the same convention.
- `adb shell` argument quoting — any free-form text landing in a shell argv MUST be single-quoted with `'\''` escapes. See `modules/device-control/src/android-adapter.ts:typeText`.

### Verification commands

```bash
# Unit + integration tests — expect 790+ passing / 0 failed
npx vitest run

# Type check — baselines 150 root / 1 renderer
npx tsc --noEmit | grep -c "error TS"
(cd renderer && npx tsc --noEmit | grep -c "error TS")

# Production build
bun run build

# Audit log — write 100 events, chain-verify, tamper one, assert invalid
npx vitest run src/core/__tests__/audit-log.test.ts

# End-to-end install + rescan — start a daemon, install device-control via
# CLI, confirm the daemon sees it without restart.
bun run dev                  # starts the TUI + daemon
# In another terminal:
rn-dev module install device-control --yes
rn-dev module list            # should include device-control
rn-dev module restart device-control
rn-dev module uninstall device-control
rn-dev module list            # should no longer include it
```

### When done

1. Commit with Conventional Commits + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
2. Write `docs/plans/2026-04-??-module-system-phase-8-handoff.md`.
3. Push.
4. Open a PR from `feat/module-system-phase-8`.
5. Ask Martin whether Phase 9 (signed registry + `keepData` retention) is next, or pivot to publishing `@rn-dev-modules/*` to real npm + baking the first prod `EXPECTED_MODULES_JSON_SHA256`.

Remember:
- `vitest run`, not `bun test`.
- `bun run build` for production verification.
- Baselines: **790+ / 0** vitest, **150** tsc root, **1** tsc renderer, `bun run build` green.
- `.claude/` is gitignored.
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it.
- All module state under `~/.rn-dev/modules/<id>/`. `~/.rn-dev/audit.log` is Phase 8's new file.
- Use **Quick Mode** when smoke-testing non-install paths.
