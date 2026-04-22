# Next-Session Prompt — Module System Phase 7 (Device Control + registry population)

**Paste the block below at the start of the next session.**

---

We're continuing the third-party module system for rn-dev-cli. **Phase 6 shipped in PR #5 (squash-merged to `main` on 2026-04-22 as commit 17ca626).** Phase 7 is the first real 3p module + the registry entries + CLI + host-release bits that finish Phase 6's install flow end-to-end.

### Before writing any code

1. Read `docs/plans/2026-04-22-module-system-phase-6-handoff.md` — **Deferred items** section is the Phase 7 punch list; **Permanent contract decisions made in Phase 6** locks the contract you're building against.
2. Skim the original `docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md` **Phase 7: Device Control** section (module architecture + adapter split between Android adb + iOS simctl/idb).
3. `git log origin/main --oneline -5` — confirm you're stacking on PR #5's squash merge.

### Branching

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-7
```

Target < 2500 line insertions — device-control module is new code but lives in its own `modules/device-control/` package, not extending host code.

### Phase 7 scope — Device Control + registry population

#### Primary

1. **`modules/device-control/` — new workspace package.**
   - Manifest at `rn-dev-module.json` with id `device-control` (first-party-by-ownership, but ships as 3p-packaged so the install flow gets exercised).
   - Tools prefixed `device-control__*`: `list`, `screenshot`, `tap`, `swipe`, `type`, `launch-app`, `logs-tail`. Destructive (`install-apk`, `uninstall-app`) ship with `destructiveHint: true`.
   - Subprocess entry — uses `runModule()` from `@rn-dev/module-sdk`.
   - Android adapter: wraps `appium-adb` for shell/input; `adbkit` for framebuffer streaming.
   - iOS Simulator adapter: wraps `xcrun simctl` for lifecycle + input + accessibility-tree.
   - Electron panel: `device-control/panel/index.html` with a live device list + screenshot preview.
   - Emits MCP `tools/listChanged` when the device list changes.

2. **Populate `modules.json`.** Create `rn-dev-modules-registry` repo (or a fixture committed to this repo under `docs/fixtures/` for Phase 7 until the remote repo exists). Entry:

   ```json
   {
     "id": "device-control",
     "npmPackage": "@rn-dev-modules/device-control",
     "version": "0.1.0",
     "tarballSha256": "<computed from bun pm pack output>",
     "description": "Agent-native device control — adb/simctl, screenshots, taps, flows.",
     "author": "rn-dev",
     "permissions": ["exec:adb", "exec:simctl", "network:outbound"],
     "homepage": "https://github.com/rn-dev/rn-dev-modules/tree/main/device-control"
   }
   ```

3. **Bake `EXPECTED_MODULES_JSON_SHA256`** in `src/modules/marketplace/registry.ts` for the Phase 7 host release. The empty-string warning from Phase 6 goes away once this lands.

4. **CLI parity — `rn-dev module {install, uninstall, list, enable, disable, restart}`.** Commands dispatch to the unix-socket MCP actions that Phase 6 added. Wire under `src/cli/commands.ts` + tests.

5. **MCP `tools/listChanged` forwarder.** The module-events bus already fires `install` / `uninstall` / `enabled` / `disabled` / `crashed` / `failed` events. Phase 6 handed these to Electron and MCP subscribers directly; Phase 7 wires the MCP server to also emit a `notifications/tools/list_changed` whenever a relevant event lands so agents re-discover without polling.

#### Secondary — review follow-ups parked from Phase 6

From PR #5 review (all P1 or P2 that felt worth bundling):

- **Arch P1-2** — extract `registerWithLazyDeps<TDeps>({ required, register, buildDeps })` abstraction. Phase 7 adds the 4th Electron IPC registrar (device-control panel bridge), which crosses the "abstract now" threshold the Phase 6 review flagged.
- **Kieran P2-3** — extract `ModuleRegistry.loadSingleManifest(path, opts)` helper. The installer's scratch-registry pattern was acceptable but fragile when a sibling module has a broken manifest; the helper is a few lines and kills the fragility.
- **Kieran P2-1** — widen MCP reply types beyond `{ code: string }` into proper error-code unions. Low-cost; renderer + tests get exhaustiveness checks.
- **Kieran P2-4** — replace `window.confirm` on uninstall with a styled modal matching the consent dialog polish.
- **Simplicity P1 #1** — if still warranted, `RegistryFetcher` class → plain `fetchRegistry()` function. Class has no instance state; function is more honest. Judgment call.

#### Do NOT do (Phase 6 deferred but not Phase 7)

- **`keepData` retention + GC sweep.** Per-module data dir preservation + 30-day TTL + startup sweep. Separate PR.
- **HMAC-chained `AuditLog.append()`.** Still separate; swap ALL `service:log` audit sinks at once when it lands.
- **Detached signature verification** of `modules.json` (Ed25519 against a host-baked pubkey). v1.1 path.
- **Option (b) sidebar** — drive off `modules:list-panels` + branch on `kind`. Needs `electronPanel` schema extension. Defer until a 3rd renderer-native built-in motivates it.

### Permanent contract rules (unchanged from Phase 6 — do not drift)

All from the Phase 6 handoff's "Permanent contract decisions" section. Highlights:

- `<moduleId>__<tool>` for 3p / flat for built-ins.
- SDK exports `host.capability<T>(id)` generic.
- Manifest at `rn-dev-module.json` at package root.
- Schema additive-only within 1.x.
- `ModuleHostManager` lives in the daemon.
- Per-module Electron partition `persist:mod-<id>` + dedicated preload.
- `destructiveHint: true` tools require confirmation.
- `runModule()` is the supported contribution surface.
- Electron preloads are self-contained `.cjs` files.
- `setModuleConfig` is async + per-module serialized.
- `CapabilityRegistry` reserves `log` + `appInfo`.
- Channel allowlist in `electron/preload.cjs` is the closed set — adding = edit this file.
- Settings built-in schema mirrored in renderer with a parity test.
- **Install flow contracts:** SHA-pinned `modules.json`; tarball SHA-256 verification before extract; arborist with `--ignore-scripts` only; rollback on every failure; manifest-id must match registry-entry id; `~/.rn-dev/.third-party-acknowledged` is advisory UX not a security boundary; host URL schemes restricted to https (prod) + https/file/http-localhost (dev).
- **Host trust tiers:** `canRead` wildcard host; `canWrite` host-allowlisted (today: `settings` + `marketplace`). New host-native write paths extend `allowHostWrite(...)`.

### Verification commands

```bash
# Unit + integration tests — expect 737+ passing / 0 failed
npx vitest run

# Type check — baselines 149 root / 3 renderer
npx tsc --noEmit | grep -c "error TS"
(cd renderer && npx tsc --noEmit | grep -c "error TS")

# Production build
bun run build

# Install flow smoke — Phase 7 MUST walk the real end-to-end install.
# 1. `bun run build:sdk && cd modules/device-control && bun pm pack`
#    → produces the tarball. Compute sha256.
# 2. Update the modules.json fixture with the computed SHA.
# 3. Set RN_DEV_MODULES_REGISTRY_URL=file:///path/to/modules.json and
#    RN_DEV_EXPECTED_SHA=<fixture sha> (or leave empty for dev-warn).
# 4. `bun run dev:gui` in Quick Mode. Open Marketplace → Available to
#    install → click Install on device-control. Walk the consent
#    dialog, confirm the subprocess spawns + appears in the registered
#    list + tools/list exposes device-control__* entries.
# 5. `rn-dev module uninstall device-control` from another terminal.
#    Verify teardown + directory removal + tools/listChanged fires.
bun run dev:gui
```

### When done

1. Commit with Conventional Commits + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
2. Write `docs/plans/2026-04-??-module-system-phase-7-handoff.md`.
3. Push.
4. Open a PR from `feat/module-system-phase-7`.
5. Ask Martin whether Phase 8 (DevTools Network extension as the second 3p module + HMAC audit log) is next, or pivot to the option-(b) sidebar schema extension.

Remember:
- `vitest run`, not `bun test`.
- `bun run build` for production verification.
- Baselines: **737+ / 0** vitest, **149** tsc root, **3** tsc renderer, `bun run build` green.
- `.claude/` is gitignored.
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it.
- All module state under `~/.rn-dev/modules/<id>/` — `disabled.flag` + `config.json` + installed package tree + (Phase 7) device-control will ship with deps under `<id>/node_modules/` via arborist.
- Use **Quick Mode** when smoke-testing non-install paths. The install smoke needs the full dev-gui boot; device-control smoke doesn't require a build, just the subprocess + IPC response.
