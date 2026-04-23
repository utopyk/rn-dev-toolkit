# Next-Session Prompt — Module System Phase 9 (DevTools Network extraction + review polish)

**Paste the block below at the start of the next session.**

---

We're continuing the module system for rn-dev-cli. **Phase 8 shipped in PR #7 (squash-merged to `main` on 2026-04-22 as commit 0a4cc6d).** Phase 9 is the first built-in→3p migration (DevTools Network → `@rn-dev-modules/devtools-network`) plus the Phase 7/8 review follow-ups parked for bundling.

### Before writing any code

1. Read `docs/plans/2026-04-22-module-system-phase-8-handoff.md` — **Deferred items** is the Phase 9 punch list.
2. Skim `docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md` **Phase 9** section if it exists, or the module-system plan's "migrating built-ins to 3p" notes.
3. `git log origin/main --oneline -5` — confirm stacking on Phase 8's squash-merge.
4. Skim `src/modules/built-in/devtools-network.ts` + the MCP tool definitions in `src/mcp/tools.ts` under `buildDevtoolsMcpTools` — the scope of the migration surface.

### Branching

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-9
```

Target < 2500 line insertions — mostly moving existing devtools-network code into its new 3p package + adjusting wire names.

### Phase 9 scope

#### Primary — DevTools Network 3p extraction

1. **`modules/devtools-network/` — new workspace package.**
   - Manifest `rn-dev-module.json` id `devtools-network`, 3p-packaged (same install flow as `device-control`).
   - Rename all MCP tool wire names from `rn-dev/devtools-network-*` → `devtools-network__*` (3p prefix policy). Tool semantics + inputSchemas unchanged.
   - Subprocess entry via `runModule()`.
   - Keep the DTO redaction logic (S5: bodies redacted unless `--mcp-capture-bodies` is on) — port the security flag through as a per-module config option.
   - Electron panel (if any) — port the existing renderer panel to the new 3p preload surface; use `rnDev.callTool("list", ...)` rather than direct IPC.

2. **Retire the built-in.**
   - Delete `src/modules/built-in/devtools-network.ts` + its references in `src/mcp/tools.ts` + the `createDevtoolsMcpTools` wiring.
   - Update tool-count assertions in `src/mcp/__tests__/tools.test.ts` (currently 29 / 31 / 33 / 35 per flag combo — will drop by the count of devtools-network tools).

3. **Add to `docs/fixtures/modules.json` + recompute SHA.**
   - `bun pm pack` the new module, compute tarball SHA-256, update fixture, commit tarball.
   - The fixture now lists two modules (device-control + devtools-network).

4. **Parity test.**
   - Capture one request via the built-in (before deletion on a feature branch snapshot) vs. the extracted 3p; DTO shapes must match byte-for-byte. This is the "prove the packaging pipeline" check from Phase 7's handoff.

#### Secondary — review follow-ups parked from Phase 7 + 8

From Phase 7 PR #6 review:
- **Kieran TS P2-4** — `args as Parameters<typeof fn>[0]` casts in `modules/device-control/src/index.ts`.
- **Simplicity P1-5** — extract `resolveAppId(adapter, args)` shared between `launchApp` and `uninstallApp` in `modules/device-control/src/tools.ts`.
- **Simplicity P2-6** — trim `exec.ts`'s 4-way discriminated union to `ok | not-found | failed` if the 3-way split isn't load-bearing at any caller.
- **Simplicity P2-8** — drop the `<ul>` details in `UninstallConfirmDialog.tsx` (subtitle already covers files+subprocess).
- **Security P2** — committed tarball in `docs/fixtures/` is a reviewer blind spot; CI re-pack + byte-compare OR CODEOWNERS.
- **Arch P2** — `host-call` still uses `canRead` for write-shaped capability methods.

From Phase 8 PR #7 review:
- **Kieran TS P1** — streaming `verify()` (currently reads whole log into memory).
- **Arch P1** — `scanUserGlobalModules` static-vs-instance split. Either pure function `scanManifests()` + `registry.applyScan(result)`, or `registry.scan()` + `registry.applyScan()` instance methods.
- **Arch P2** — `applyManifestChange(opts, { kind, …})` helper to dedup the register/unregister + event-emission pattern across `rescanAction` / `installAction` / `uninstallAction`.
- **Security P1** — add integration test coverage for `setupIpcBridge` — current rootDir doesn't type-check Electron, which is how the Phase 8 P0 slipped. Consider extending `tsconfig.json` `include` to cover `electron/` or creating `electron/tsconfig.json` with its own ci check.
- **Kieran P3** — cycle guard in `canonicalize` (throws on `data: circular`).
- **Kieran P2** — `reply.payload as {...}` ad-hoc casts in `module-commands.ts`; extract a small helper if 5+ duplicates feel load-bearing.

#### Do NOT do (Phase 8 deferred but not Phase 9)

- **`keepData` retention + GC sweep.** Still its own PR.
- **Detached Ed25519 signature verification** of `modules.json`. v1.1 path.
- **Publishing to real npm.** Separate ops task.
- **Option (b) sidebar** — still waits for a 3rd renderer-native built-in.

### Permanent contract rules (unchanged from Phase 8 — do not drift)

All from the Phase 8 handoff, plus:
- **Audit log NDJSON schema is stable within v1.** Additive-only.
- **`audit.log.1` → `.2` → `.3` rotation chain with `rotateKeep: 3` default.** Operators wanting archival subscribe to `'rotated'`.
- **Discriminated-union `AuditEntryInput`.** New subsystems add a variant; no `Record<string, unknown>` bag.
- **`modules/rescan` is idempotent + non-destructive.** Never deletes disk state.
- **Tool name migration (built-in → 3p) REQUIRES the `<moduleId>__` prefix.** `rn-dev/devtools-network-*` becomes `devtools-network__*`. Agents discover the new names via `tools/listChanged`.

### Verification commands

```bash
# Unit + integration tests — expect 808+ passing / 0 failed (will dip
# during the devtools-network tool count update, then land back in the
# green as the new tests replace them)
npx vitest run

# Type check — baselines 150 root / 1 renderer
npx tsc --noEmit | grep -c "error TS"
(cd renderer && npx tsc --noEmit | grep -c "error TS")

# Production build
bun run build

# Packaging parity smoke
bun run modules/devtools-network/build.ts
(cd modules/devtools-network && bun pm pack)
# Update docs/fixtures/modules.json with the new entry + SHA
# Run the GUI, walk Marketplace install, confirm devtools-network
# appears in modules/list with subprocess kind + panel available.

# End-to-end network capture parity
# Start a dev session, fire a fetch, compare the DTO captured via the
# 3p tools to the DTO shape documented in Phase 3d — fields must match.
bun run dev:gui
```

### When done

1. Commit with Conventional Commits + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
2. Write `docs/plans/2026-04-??-module-system-phase-9-handoff.md`.
3. Push, open PR, run parallel reviewers, fix P0/P1, squash-merge.
4. Ask Martin whether Phase 10 (signed `modules.json` + `keepData` retention + GC) is next, or pivot to publishing `@rn-dev-modules/*` to real npm and baking the first production `EXPECTED_MODULES_JSON_SHA256`.

Remember:
- `vitest run`, not `bun test`.
- `bun run build` for production verification.
- Baselines: **808+ / 0** vitest, **150** tsc root, **1** tsc renderer, `bun run build` green.
- `.claude/` is gitignored.
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it.
- Use Quick Mode when smoke-testing non-install paths.
