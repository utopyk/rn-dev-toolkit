# Module System — Phase 6 → Phase 7 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 6 session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 6

Four coherent units, split into four per-phase commits:

1. **Pre-work refactors** (parked from the Phase 5c review, done first so Phase 6 code lands against the tightened foundation).
   - Arch P1-1 — `createModuleSystem()` factory. One call-site owns capability + host + built-in + Marketplace wiring; both `start-flow.ts` and `electron/module-system-bootstrap.ts` delegate. Accepts optional `CapabilityRegistry` / `ModuleRegistry` injection so callers can pre-stamp metro/artifacts or legacy Ink modules.
   - Kieran P1-3 — `useIpc<T>(channel): Promise<T>`. The invoke hook is generic with a `T = unknown` default; the `useIpcOn` hook picks up the same T. All six renderer call sites dropped their `as TypedReply` casts in favor of `invoke<T>(...)` at the use site.
2. **Marketplace install/uninstall core** — curated registry fetcher, pacote-backed tarball verification, arborist-backed dep reify, rollback-on-failure, full MCP dispatch coverage.
3. **Electron consent dialog + Marketplace UI** — renderer consent modal with permission gloss, source verification (SHA + registry URL), first-3p acknowledgment gate; Marketplace panel's Action column is back with Install/Uninstall buttons + status toast.
4. **Security P1-1** — split host-UI trust into `canRead` (wildcard on host) vs. `canWrite` (host-writable allowlist). A renderer XSS on the host UI can no longer rewrite every installed 3p module's config — the blast radius is now `allowHostWrite`-declared moduleIds only (just `settings` today).

---

## Scope that shipped

| Concern | Shipped |
|---------|---------|
| Arch P1-1 — `createModuleSystem()` factory | ✅ `src/modules/create-module-system.ts` + 4 tests; both bootstrap callers delegate |
| Kieran P1-3 — `useIpc<T>` generic | ✅ both hooks typed; 6 renderer call sites migrated; baseline tsc 149 unchanged |
| Curated registry schema + SHA-256 pin fetcher | ✅ `RegistryFetcher` with host-baked SHA pin + 1h cache + tamper-safe read; 10 tests |
| Arborist-backed installer | ✅ `installModule` — pacote tarball + SHA verify → extract → optional arborist reify with `ignoreScripts: true` → manifest validate → register; full rollback on every failure path |
| Uninstaller | ✅ `uninstallModule` — subprocess teardown → registry unregister → `rm -rf`; `keepData` accepted for MCP parity (retention GC deferred) |
| `modules/install` + `modules/uninstall` MCP actions | ✅ added to `dispatchModulesAction`; exported for direct Electron reuse |
| `marketplace/list` + `marketplace/info` MCP actions | ✅ same dispatcher; `list` returns installed/available annotations + registry SHA |
| Electron IPC layer | ✅ `electron/ipc/modules-install-register.ts` — six new ipcMain channels with eager-register / `getDeps()` lazy-fill pattern; audit sink routes outcomes through `service:log` |
| Consent dialog | ✅ `ConsentDialog.tsx` — source, permission gloss (adb/simctl/idb/fs/network), tarball + registry SHA-256, "I trust the author" required toggle, first-3p acknowledgment with explicit copy |
| Marketplace Action column | ✅ built-ins: "system, uninstallable"; installed 3p: Uninstall; available-to-install rows below with Install; status toast |
| Security P1-1 — host read vs. write split | ✅ `canRead` / `canWrite` + `allowHostWrite(id)` allowlist; `modules:config-set` now uses `canWrite`; `settings` is the only host-writable module |

---

## Files touched

### New

| File | Purpose |
|------|---------|
| `src/modules/create-module-system.ts` | Shared factory — capability registry + host manager + four built-in manifests + Marketplace registration. |
| `src/modules/__tests__/create-module-system.test.ts` | 4 tests — injected registry/capabilities, worktreeKey exposure, built-in set. |
| `src/modules/marketplace/registry.ts` | `modules.json` schema + `RegistryFetcher` with SHA pin + 1h cache + tamper-safe read. |
| `src/modules/marketplace/installer.ts` | `installModule` / `uninstallModule` + fresh-host ack helpers. |
| `src/modules/marketplace/__tests__/registry.test.ts` | 10 tests — SHA pin, tamper bypass, cache TTL, schema validation. |
| `src/modules/marketplace/__tests__/installer.test.ts` | 11 tests — happy path, SHA mismatch, permission gate, rollback, already-installed, arborist branch, fetch/extract failures. |
| `electron/ipc/modules-install-register.ts` | ipcMain registrar — six channels: install / uninstall / marketplace:list|info / acknowledge-third-party / has-third-party-ack. |
| `renderer/components/ConsentDialog.tsx` + `.css` | Install consent modal — source audit, permission gloss, trust toggle, first-3p ack. |
| `docs/plans/2026-04-22-module-system-phase-6-handoff.md` | This document. |

### Modified

| File | Change |
|------|--------|
| `src/app/start-flow.ts` | Uses `createModuleSystem`; drops the hand-rolled capability + built-in registrations; publishes `hostVersion` on the bus. |
| `src/app/service-bus.ts` | New `hostVersion` topic — IPC registrars thread it through without re-reading `package.json`. |
| `src/app/modules-ipc.ts` | Four new dispatcher cases: `modules/install`, `modules/uninstall`, `marketplace/list`, `marketplace/info`. `ModulesIpcOptions` gains `registryFetcher` / `pacote` / `arboristFactory` injection points. All four action handlers exported for direct Electron reuse. |
| `electron/module-system-bootstrap.ts` | Uses `createModuleSystem`; publishes `hostVersion` + exposes it in the bootstrap result. |
| `electron/ipc/index.ts` | Wires `registerModulesInstallHandlers()` + declares `allowHostWrite('settings')` on the sender registry. |
| `electron/ipc/modules-config-register.ts` | `modules:config-get` uses `canRead`; `modules:config-set` uses `canWrite` — the Phase 6 security split. |
| `electron/ipc/modules-panels-register.ts` | `modules:host-call` uses `canRead` (semantic rename; host-call is panel-driven so the host branch stays permissive). |
| `electron/panel-sender-registry.ts` | Split `canAddress` into `canRead` + `canWrite` + `allowHostWrite(id)`; deprecated `canAddress` as a `canRead` alias so stragglers compile. |
| `electron/preload.cjs` | Added 6 Phase 6 channels to `INVOKE_EXACT`. |
| `renderer/hooks/useIpc.ts` | Both hooks typed with `<T = unknown>` generic; `useIpcOn` picks `args[0]` and hands it to the typed handler. |
| `renderer/App.tsx`, `renderer/components/ModuleConfigForm.tsx`, `renderer/views/DevToolsView.tsx`, `renderer/views/Marketplace.tsx`, `renderer/views/NewInstanceDialog.tsx`, `renderer/views/Wizard.tsx` | Migrated every `invoke` call to `invoke<T>(...)`; dropped `as ReplyType` casts. |
| `renderer/views/Marketplace.tsx` + `.css` | Action column restored + available-to-install section + consent flow + status toast. |
| `electron/__tests__/panel-sender-registry.test.ts` | +4 tests for the read/write split. |
| `package.json` / `bun.lock` | Added `@npmcli/arborist@9.4.3`, `pacote@21.5.0`, `@types/pacote`. |

---

## Verification

- **vitest:** 736 passed / 0 failed (+29 since PR #4 merged — 4 factory, 10 registry, 11 installer, 4 sender-registry).
- **tsc (root):** 149 — unchanged baseline.
- **tsc (renderer):** 3 — unchanged baseline (pre-existing `InstanceLogs.sections` + env typing).
- **bun run build:** green.
- **Manual GUI smoke:** blocked — needs a human + a working Metro setup. The Phase 6 prompt called for running Quick Mode + walking Install → consent → spawn → Uninstall. Recommend Martin runs this before merge; there is no installable test 3p module in the curated registry yet (see "Deferred items").

---

## Permanent contract decisions made in Phase 6

- **`modules.json` schema v1** — `{ version: 1, modules: [{ id, npmPackage, version, tarballSha256, description, author, permissions[], homepage? }] }`. Additive-only within v1.x; schema version bump required for breaking changes.
- **Host-baked SHA pin** — `EXPECTED_MODULES_JSON_SHA256` is a constant in `src/modules/marketplace/registry.ts`. Empty string means "dev mode — accept any". Production host releases replace it as part of the release flow. `RN_DEV_MODULES_REGISTRY_URL` env var overrides the default URL; no corresponding `RN_DEV_EXPECTED_SHA` env override today (fetch accepts `--accept-registry-sha` per the original plan, not yet CLI-wired).
- **Install location** — extracted tarball contents live directly at `~/.rn-dev/modules/<id>/` (same layout `loadUserGlobalModules` scans). No indirection file. Arborist reifies deps into `<id>/node_modules/` when the package declares any.
- **`--ignore-scripts`** — the installer ALWAYS passes `ignoreScripts: true` to arborist. Lifecycle scripts (`preinstall`, `postinstall`, etc.) never run for 3p modules in v1. Enforced by the single `arboristFactory` call-site — nothing else reaches arborist.
- **Tarball SHA-256 verification** — performed by the installer, not by pacote. `pacote.tarball()` returns the bytes, host computes SHA-256, compares to registry entry before extract. Mismatch returns `E_INTEGRITY_MISMATCH` and rolls back any temp state.
- **Permission consent** — `permissionsAccepted[]` on the install request must contain EVERY string in `entry.permissions`. Subset → `E_PERMISSION_DENIED`. Superset is OK (forward-compat for modules whose permission declarations shrink across versions).
- **First-3p acknowledgment** — one-time `~/.rn-dev/.third-party-acknowledged` flag. GUI consent dialog walks a separate checkbox the first time; MCP callers pass `thirdPartyAcknowledged: true` after pre-touching the file (headless CI pattern).
- **Manifest-id guard** — the registry entry's `id` must match the extracted `rn-dev-module.json`'s `id`. A registry-compromise that swaps packages under a trusted id is rejected with `E_MANIFEST_ID_MISMATCH`.
- **Already-installed** — re-install without uninstall is rejected with `E_ALREADY_INSTALLED`. Silent overwrite could upgrade permissions under the user's nose.
- **`keepData` uninstall flag** — accepted on the MCP surface; retention + GC sweep is Phase 6+ follow-up, so today it's a no-op (everything is deleted either way). The flag is declared here so forward-compatible agents don't need to re-code.
- **Host UI trust — read vs. write** — `canRead` wildcard for host senders; `canWrite` gated on `allowHostWrite(id)` allowlist. Panel senders constrained to own moduleId in both directions. `settings` is the only host-writable module today — future host-native panels that need cross-module writes extend the allowlist.
- **`useIpc<T>` default is `unknown`** — call sites must pass the reply type explicitly. Prevents silent `any` leaks through the IPC boundary; the migration cost was worth it.
- **`createModuleSystem()` is the single bootstrap entry** — TUI and Electron paths both delegate. New built-ins ship their manifest + register once in the factory; the two callers never diverge again.

---

## Deferred items (Phase 6 → Phase 7 and beyond)

1. **Populate the curated registry.** `DEFAULT_REGISTRY_URL` points at `rn-dev/rn-dev-modules-registry` which doesn't exist yet. Phase 7's Device Control module will be the first entry; until then the Marketplace "Available to install" section shows a registry-unreachable banner in a clean install.
2. **Bake `EXPECTED_MODULES_JSON_SHA256`.** Currently empty = dev mode. Set in the first host release that ships a real curated registry. Plan has this as a constant + optional `--accept-registry-sha` override flag on the CLI (not wired yet).
3. **CLI parity** — `rn-dev module {install, uninstall, list, enable, disable, restart}`. The MCP actions exist; wire the CLI commands to call through the unix socket.
4. **Retention + GC sweep for `keepData: true`.** `~/.rn-dev/modules/<id>/data/` preserved for 30 days; startup sweep purges expired dirs. Today the flag is accepted but everything is deleted.
5. **`--accept-registry-sha <sha>` CLI override.** `RegistryFetcher.fetch({expectedSha})` accepts it; no CLI surface yet.
6. **MCP `tools/listChanged` notification on install/uninstall/enable/disable/crash/recover.** Event is emitted on the module-events bus already; the MCP server needs to forward it as a `notifications/tools/list_changed`.
7. **Host-side integration test** — install a real tarball fixture via a local `file://` registry → spawn → module subprocess responds → uninstall. Today we have unit tests with stubbed pacote; an end-to-end test using a small fixture module would catch regressions the unit tests miss (e.g. arborist + pacote interaction at the package.json level).
8. **Arch P1-2 — `useModuleConfig(moduleId, scope)` hook.** Still deferred from Phase 5c. A per-module settings drawer off a Marketplace row click would be the second consumer; that UX didn't land in Phase 6 so the hook extraction stays waiting.
9. **HMAC-chained `AuditLog.append()`.** `service:log` is still the audit sink for install/uninstall too; retire all `service:log` audit writers together when `AuditLog` lands.
10. **Registry signature verification (v1.1).** The plan reserves a detached Ed25519 signature on `modules.json` checked against a host-baked pubkey. Schema is additive-ready; implementation deferred.

---

## Where the module system stands (end of Phase 6)

- **Phase 0–3d** (squashed PR #2): foundation.
- **Phase 4 + 5a + 5b** (squashed PR #3): Electron panels, per-module config, built-in manifest-ification + Marketplace stub.
- **Phase 5c** (squashed PR #4): review follow-ups + Electron bootstrap + renderer panels + Settings migration + Quick Mode.
- **Phase 6** (this PR): Marketplace install/uninstall + consent UX + curated registry + host-read/write split + Arch P1-1 factory + Kieran P1-3 generic.

**Test totals:** 736 passed / 0 failed. tsc: 149 root / 3 renderer. `bun run build`: green.

---

## What's next

Ask Martin:

> **"Phase 6 done. Phase 7 is Device Control (first real 3p module) — also unlocks populating the curated registry + exercising the arborist path against a real tarball. Or pivot to MCP `tools/listChanged` + option (b) sidebar + the parked Arch P1-2 hook?"**

Phase 7 natural sequence:
- Publish `@rn-dev-modules/device-control` v0.1.0 to npm (Android adb + iOS simctl subset).
- Add the first `modules.json` entry pointing at it + compute its tarball SHA-256 + bake the `EXPECTED_MODULES_JSON_SHA256` pin into the next host release.
- Wire the CLI `rn-dev module install` subcommand.
- Ship the `tools/listChanged` forwarder so MCP clients live-update when a module installs.

If Martin wants polish before Phase 7:
- **Arch P1-2** — `useModuleConfig(moduleId, scope)` hook (open + discover per-module config drawers from a Marketplace row click).
- **MCP `tools/listChanged`** — small, independent, unblocks agent-native install flow.
- **Retention + GC for `keepData`** — today's no-op is a latent footgun.

---

## Useful commands

```bash
# Phase 6-specific tests
npx vitest run \
  src/modules/__tests__/create-module-system.test.ts \
  src/modules/marketplace/__tests__/registry.test.ts \
  src/modules/marketplace/__tests__/installer.test.ts \
  electron/__tests__/panel-sender-registry.test.ts

# Full suite — expect 736 / 0
npx vitest run

# Type check — baseline 149 root / 3 renderer
npx tsc --noEmit | grep -c "error TS"
(cd renderer && npx tsc --noEmit | grep -c "error TS")

# Production build
bun run build

# Manual GUI smoke — Phase 6 MUST smoke the install flow end-to-end.
# Use Quick Mode to skip xcodebuild.
# 1. Set the profile mode to `quick` (wizard → build mode → Quick).
# 2. Run `bun run dev:gui`.
# 3. Open Marketplace. Today the "Available to install" section shows a
#    registry-unreachable banner because the default URL points at a repo
#    that doesn't exist yet. To smoke a real install, either:
#      (a) Set RN_DEV_MODULES_REGISTRY_URL to a file:// URL pointing at a
#          local modules.json stub + a local tarball, OR
#      (b) Wait for Phase 7 when device-control gets published to npm
#          and the registry populates.
# 4. For the uninstall path, install anything manually into
#    ~/.rn-dev/modules/<id>/ (copy a fixture) + restart the host — the
#    Uninstall button works on whatever loadUserGlobalModules picked up.
bun run dev:gui
```
