---
title: rn-dev-cli hook system — per-module contribution points + `rn-dev.config.ts`
type: feat
status: active
date: 2026-04-30
origin: docs/brainstorms/2026-04-29-acme-dev-cli-research.md
---

# rn-dev-cli hook system — per-module contribution points + `rn-dev.config.ts`

## Enhancement Summary

**Deepened on:** 2026-05-01
**Sections enhanced:** Overview, Technical Approach, Implementation Phases (H0–H7), Acceptance Criteria, What we are NOT doing
**Reviewers consulted:** architecture-strategist, security-sentinel, code-simplicity-reviewer, agent-native-reviewer, kieran-typescript-reviewer, pattern-recognition-specialist, performance-oracle
**Research:** Prior art across VSCode / Vite / Rollup / esbuild / Webpack / Eclipse / WebExtensions; Bun runtime TS-import + JSON-line backpressure / prototype-pollution defenses
**Skill applied:** agent-native-architecture

### Top showstoppers folded in (BEFORE H2 ships)

1. **Curated allowlist for `kind: "built-in-privileged"`** — without this, any 3p manifest can self-declare in-process and bypass subprocess isolation. Registry MUST reject `built-in-privileged` for any manifest not in the host's compiled-in allowlist (security-sentinel finding 5).
2. **Prototype-pollution defense is real, not type narrowing** — the `parseSubscribePayload` idiom only narrows shape; it does NOT defend against `__proto__` / `constructor` keys. H1 parser MUST use a `JSON.parse` reviver that returns `undefined` for those keys, then `Object.freeze(data)` before forwarding (security-sentinel finding 4).
3. **`onFail: 'hard'` from 3p modules is privilege escalation** — a marketplace module with `consumes.hooks: { 'build/pre': { onFail: 'hard' } }` can permanently break every project's build. Add `allowModuleHardFails: ['<id>']` opt-in alongside `allowModuleOverrides`. Default: 3p `onFail: 'hard'` is downgraded to `'warn'` (architecture-strategist finding 6 + security-sentinel finding 5).
4. **`ValidatedProfile` branded type at every `HookManager.fire()` entry** — prevents agent-supplied payloads (e.g. via `hooks/run --real`) from bypassing `validateProfile` (security-sentinel finding 2).
5. **`hooks/run --real` requires explicit dev-mode gate** — define `RN_DEV_DAEMON_MODE=dev|prod` env (default `prod`); reject `mode: "real"` with `E_HOOK_RUN_REAL_DENIED` in production. Document gate mechanism — there is NO precedent in [src/mcp/tools.ts](../../src/mcp/tools.ts) (security-sentinel finding 8).
6. **Path TOCTOU re-check at fire time** — registry caches `(absolutePath, lstat.dev+ino)` from boot; re-`realpathSync` at fire time; mismatch → `E_HOOK_PATH_MUTATED`, skip + audit (security-sentinel finding 1).
7. **`profile.name` newline+CR rejection** — currently allows up to 256 chars including newlines, which can desync the JSON-line parser. Patch [src/daemon/profile-guard.ts:72-75](../../src/daemon/profile-guard.ts:72) in H0/H1 (security-sentinel finding 3).
8. **HookManager SRP split** — break into `HookRegistry` (data + validation), `HookDispatcher` (fire ordering + override resolution + concurrency), `HookSubprocessRunner`, `HookAuditWriter`, plus a thin `HookManager` facade. The vitest matrix at H1 already telegraphs this split (architecture-strategist finding 2).
9. **Builder event-stream `source: 'builtin' | 'override'` discriminator** — without it, audit-log readers and MCP agents can't distinguish "build failed" from "override hook crashed" (architecture-strategist finding 5).
10. **Concurrent fire queue with depth cap (10) + overflow audited** — current "serialize" prose leaves silent-drop ambiguity (security-sentinel finding 10).

### Simplifications adopted (cuts)

- **12 → 7 error codes.** Collapse `E_CONFIG_PARSE_FAILED` + `E_CONFIG_THREW` + `E_CONFIG_SHAPE_INVALID` → one `E_HOOK_CONFIG_INVALID { cause }`. `E_HOOK_MULTIPLE_OVERRIDE`, `E_HOOK_MULTIPLE_RESULTS`, `E_HOOK_CRASHED_BEFORE_PAYLOAD`, `E_HOOK_CYCLE_DETECTED` become `outcome` strings on a single `E_HOOK_FAILED`. `E_UNKNOWN_HOOK_PHASE` collapses into `E_HOOK_NAME_UNDECLARED`. Prefix policy enforced: every new code starts with `E_HOOK_*`.
- **Drop `priority` from user-visible schema.** Internal default rule: project hooks before 3p hooks (single `source` discriminator, not numeric). Add field when first asked.
- **Drop `provides.overrideHook?: string` configurability.** Hardcode `custom` as the convention.
- **Drop `parallel: true` reservation.** Don't reserve fields you don't honor in v1.
- **Drop `extra-checks` as a hook namespace.** Preflight checks are *data*, not events. `PreflightEngine.register()` already handles this; modules contribute checks via that API. `modules/preflight/provides.hooks` keeps only `before-checks`, `after-checks`.
- **Drop ack-fall-through.** Override hook missing `{kind:"ack"}` first → hard fail, not silent fall-back to built-in step. Falling back hides bugs.
- **Drop `rn-dev migrate onSaveAction → hooks` CLI helper** from H7. Migration guide is cheaper than maintaining an AST rewriter.
- **Inline `parser.ts` into `runner-subprocess.ts`** for v1 (~40 lines, three discriminator kinds — extract when a second consumer appears).
- **Defer 1 of 3 `session/*` hooks.** H1 ships `session/init` AND `session/profile-changed` (the latter has a real consumer in H6's `rn-dev/session-profile-update` MCP tool, which closes the acme Firebase-swap workflow without requiring daemon restart). Only `session/shutdown` is deferred until a consumer asks. Namespace capped at exactly three; module keeps the name `session` (rename to `daemon-lifecycle` reverted per ce:review meta-pass — speculative naming churn).
- **Collapse `hooks-history` into `hooks-list?include=history&since=<ts>`** — one tool surface instead of two.

### New work added by review (additions)

- **TypeScript: `HookContracts` registry** — module-augmentable map of slot → `{ payload, result }`. `defineConfig` is generic over installed modules' `provides.hooks`; project gets autocomplete for `'build/pre' | 'clean/pre' | …`. Closes the magic-string risk (kieran finding 2 + 7).
- **TypeScript: `HookEntry` discriminated union with explicit `fn` branch** — `string | { script } | { fn }`. In-process function callbacks become the documented default; subprocess scripts are the escape hatch (kieran finding 3 + performance finding 3).
- **TypeScript: `HookRecord` discriminated union with `null` fallthrough** in the parser signature — pin in H0, not deferred (kieran finding 5).
- **TypeScript: `OverrideSlotOf<M>` derived type** — gates `allowModuleOverrides` at the type layer, not just runtime (kieran finding 6).
- **TypeScript: `phase: \`${string}/${string}\`` template-literal type** everywhere `phase: string` appeared — manifest validator, audit entry, registry Map keys, MCP tool inputs (kieran finding 4).
- **TypeScript: lockstep CI check** ajv-validating fixture round-trip + `expectTypeOf<ModuleManifest>().toMatchTypeOf<FromSchema<typeof schema>>()`. Prevents hand-written/JSON drift (kieran "Critical TS additions" #5).
- **Audit fields: `code?: string`, `payloadDigest`, `payloadKeys`, `correlationId`** — parity with existing audit variants + agent forensics (pattern-recognition finding 5 + agent-native finding 6).
- **Event surface: `hooks/registered`, `hooks/orphaned`, `hooks/permission-granted`, `hooks/config-reloaded`, `hooks/timed-out`, `hooks/override-claimed`** — agents subscribed via `events/subscribe` get the full kind vocabulary (agent-native finding 8). (`hooks/override-fell-through` removed per ce:review meta-pass — missing ack is hard fail, not fall-back.)
- **Agent-native MCP additions (highest leverage):**
  - `rn-dev/hooks-config-read` / `hooks-config-write` / `hooks-config-validate` — outcome-shaped, idempotent edits via AST-level patches; closes the agent self-modifying loop (agent-native skill gap **a + e**).
  - `rn-dev/hooks-suggest` — walks `package.json`, `bin/`, `.env*`; returns candidate registrations with confidence + rationale (agent-native skill gap **c**).
  - `rn-dev/hooks-diagnose-all` — sweep mode of `hooks-diagnose` (agent-native finding 3).
  - `rn-dev/hooks-repair` — structured fix payload composable with `hooks-config-write` (agent-native skill gap **d**).
  - `rn-dev/hooks-overrides` — list currently-active 3p override registrations + when granted (agent-native finding 4).
  - `rn-dev/hooks-catalog` — installed-but-inactive + marketplace-available hooks (agent-native finding 9).
  - `rn-dev/session-profile-update` — fires `session/profile-changed` (agent-native finding 5).
- **Wire-format library: `split2`** for backpressure-aware JSON-line parsing. Add to workspace deps. Avoid `event-stream` (deprecated). Strip `\r` after split for Windows CRLF safety (Explore #2).
- **`HookManager` extends `EventEmitter`** — pattern parity with all other managers (pattern-recognition finding 1).
- **Capability naming: `HookHostCapability` + `createBuildHostCapability`/`createCleanHostCapability` etc.** — subsystem-first matches existing capabilities. Register with permission gate `host:hooks:dispatch`. Add capability ids to [src/core/module-host/capabilities.ts:58 KNOWN_CAPABILITIES](../../src/core/module-host/capabilities.ts:58) typo-detector (pattern-recognition finding 10).
- **Module path: rename H3's `modules/devtools/` to `modules/devtools-core/`** — disambiguate from existing `modules/devtools-network/` (pattern-recognition finding 8).
- **Module wrap layout enforced via `modules/_template/`** — six-entry layout (`src/`, `panel/`, `build.ts`, `package.json`, `tsconfig.json`, `rn-dev-module.json`) per existing `modules/device-control/` (pattern-recognition finding 2).
- **Prior-art adoptions:** hook schema `version: "1.0.0"` per `provides.hooks` entry; `maxRegistrations: number` (default 16) per contribution point; explicit upfront contribution-point existence validation (Explore #1).

### Performance budget (added section)

- Empty-registry `build/pre` overhead < 1ms (synchronous fast path; no audit, no event emit).
- One project-only in-process hook < 50ms total fan-out.
- One project + one 3p subprocess hook < 250ms total fan-out (one fork+exec ~30ms + JSON-line round-trip).
- `build/pre` → `Builder.build()` invocation gap, fixture trivial hook < 500ms (NFR; tighten to < 300ms once H2 measures real cold-spawn on macOS arm64).
- Metro `post-start` fan-out, 1 project hook < 100ms.
- Audit append per failed hook < 5ms p95 single-daemon, < 50ms p95 4-daemon contention.
- `hooks/list` MCP response (50 modules × 3 hooks) < 50ms serialization, < 80KB payload.
- Config compile cold < 200ms; warm (cached at `.rn-dev/config.cache.js` keyed on `(sourceMtime, hostVersion, bunVersion)`) < 10ms.
- Override-mode line latency, hook→subscriber < 2ms p95.
- Registry rebuild at session boot < 50ms for 1000 registrations.
- Stdout token bucket: 50 KB/s + 200 records/s per hook; drop unparseable records after 100 consecutive failures.

Add `tests/electron-smoke/perf.spec.ts` gated by `PERF_GATE=1` so CI doesn't flake on noisy runners but local + nightly enforces.

### Phase-ordering changes

- **H0 absorbs `rn-dev config init` scaffolder** + the TypeScript contracts (`HookContracts`, `HookEntry` union, `HookRecord`, `OverrideSlotOf`, lockstep CI check) + the prototype-pollution reviver spec.
- **H1 absorbs the SRP split** (4 classes + facade), `split2` adoption, the curated `built-in-privileged` allowlist, and `ValidatedProfile` branded-type plumbing.
- **H2 absorbs the dev-mode gate** (`RN_DEV_DAEMON_MODE`), the `source: 'builtin' | 'override'` Builder event discriminator, and `hooks-config-validate` (alongside the already-hoisted `hooks-diagnose`).
- **H4 simplified** — drop ack-fall-through, hardcode `custom` slot, single override allowed.
- **H5 absorbs `allowModuleHardFails`** in addition to `allowModuleOverrides`.
- **H6 expands MCP surface** — add `hooks-config-read/write/validate`, `hooks-suggest`, `hooks-diagnose-all`, `hooks-repair`, `hooks-overrides`, `hooks-catalog`, `session-profile-update`. (`hooks-diagnose` and `hooks-config-validate` already shipped in H2.)
- **H7 unchanged** beyond dropping the migration CLI helper.

The enhanced plan still has 8 phases; merging would cut depth where the showstoppers need it most. Net delta: roughly -35 lines of speculative spec, +180 lines of security/TS/agent-native deliverables. Critical-path work for H2 is now explicitly enumerated.

---

## Overview

This plan implements §6 of [docs/brainstorms/2026-04-29-acme-dev-cli-research.md](../brainstorms/2026-04-29-acme-dev-cli-research.md), refined by an architectural decision recorded mid-planning: **hooks are per-module contribution points, not a global lifecycle enum.**

A hook is a tuple `(<module-id>, <hook-name>)`. Each module's manifest declares two paired surfaces:

- `provides.hooks: string[]` — names this module exposes. Resolved as `<this-module-id>/<name>` in the registry.
- `consumes.hooks: Record<'<other-module-id>/<name>', HookEntry>` — registrations into other modules' namespaces.

Every lifecycle subsystem becomes a built-in module that declares its own hooks. `Builder` exposes `build/pre`, `build/post`, `build/custom`. `CleanManager` exposes `clean/pre`, `clean/post`, `clean/custom`. `MetroManager` exposes `metro/pre-start`, `metro/post-start`, `metro/pre-stop`. A new `session` built-in module owns daemon-lifecycle events (`session/init`, `session/profile-changed`, `session/shutdown`) that aren't tied to a single subsystem.

Built-in modules run **in-process** (extending the existing `built-in-privileged` carve-out at [src/core/module-host/manager.ts:235](../../src/core/module-host/manager.ts:235)). Third-party modules continue running as subprocesses via vscode-jsonrpc. The HookManager dispatches across both via a single contribution-point registry keyed on the manifest, not the process model.

Project consumers register hooks via a published `@rn-dev/config` package and an `rn-dev.config.ts` at the project root.

## Problem Statement

rn-dev-cli has shipped a daemon, a module system, an MCP server, an Electron GUI, and a TUI. The architectural infrastructure is solid, but it has no integration story for the project-specific glue real React Native teams write today. The acme brainstorm (§2) identifies eleven such gaps — `.env` block switching, Firebase config swap, stale-state escalation, build-error summarization, preflight auto-fix, local-package linking, port-reachability probes, and others. Most are project-specific. Without an extension surface for project-specific glue, every consuming team will fork rn-dev-cli's `bin/` rather than adopt it.

The brainstorm's §6 proposes a build-step hook system. The original §6 modeled hooks as a fixed lifecycle enum (`preBuild | preClean | onLaunch | …`). That model has two problems:

1. **It creates a parallel taxonomy next to the module system.** Modules are the existing extension surface (manifest schema, registry, capability registry, subprocess isolation, audit log). A second taxonomy for hooks would duplicate the loader, the security model, the audit policy, and the agent-native MCP surface.

2. **It assumes all subsystems share a uniform pre/post/custom shape.** They don't. Metro's lifecycle is `start → status → log → stop`, not `clean → install → build → launch`. Forcing every subsystem into a shared enum either bloats the enum or limits what each subsystem can express.

The per-module contribution-point model resolves both. Each module declares the hooks that fit its lifecycle. A registry built from active modules' `provides.hooks` is the single source of truth for "what hooks exist." Project configs and 3p modules register against `<module-id>/<hook-name>` pairs and are validated at config-load time against that registry.

## Terminology

Terms used consistently throughout this plan:

- **Contribution point** — a named slot a module exposes via `provides.hooks`. Identified as `<module-id>/<name>`.
- **Slot** — synonym for contribution point (acceptable in casual prose).
- **Registration** — a hook entry that consumes a contribution point. Sources: project (`rn-dev.config.ts`) or 3p module manifest (`consumes.hooks`).
- **Fire** — the public verb consumers use: `HookManager.fire('build/pre', payload)`. Always async.
- **Dispatch** — the internal act of `HookDispatcher` routing a fire to one of its registrations via the appropriate runner.
- **Override slot** — the `custom` slot (hardcoded). A registration here replaces the built-in step body for that subsystem; `pre` and `post` slots still fire around it.
- **Source** — origin of an event or registration: `'builtin' | 'override' | 'project' | 'module:<id>'`.

The term "phase" is reserved for the implementation phases (H0–H7) of THIS plan. Hook lifecycle points are "slots" or "contribution points," never "phases."

## Why not just modules? (Quick anchor for fresh readers)

A natural question: if hooks are per-module contribution points, why not implement them as plain RPC calls between modules? Answer (full version in §"Alternatives Considered" Alternative C):

1. **Project hooks travel with the repo, not npm.** A `bin/swap-firebase.sh` registered at `build/pre` is project-private code under PR review — not a module a marketplace could distribute.
2. **Activation cost.** Modules use vscode-jsonrpc + long-lived subprocesses. Hooks are short-lived; a 100ms `bin/check-token.sh` shouldn't pay framing overhead.
3. **Permission model.** Modules require consent dialogs. Hooks run with the developer's terminal privileges (the developer authored them).

The hook system's *machinery* IS shared with the module system (process-group spawning, audit logging, capability registry). The *contract* differs: lighter framing, project-scoped, no MCP surface for project hooks themselves.

## Proposed Solution

A multi-PR phased rollout that lands the contribution-point model end-to-end with `Builder` as the first wrapped subsystem, then expands across the remaining lifecycle subsystems.

The phases are sized to be one session each, with explicit test layers per phase. Each phase that touches the daemon's IPC surface or supervisor state is gated by the three-layer verification standard from [CLAUDE.md](../../CLAUDE.md) (vitest + tsc + Playwright Electron smoke), with `REAL_BOOT_SMOKE=1` required for the phases identified in [docs/solutions/](../../docs/solutions/) institutional learnings as belonging to the same risk class as the validateProfile P0 closes.

## Technical Approach

### Architecture

#### Manifest schema (additive)

`rn-dev-module.json` gains two optional top-level fields. Both default to `{}` for modules that don't participate in hooks.

```jsonc
{
  "id": "build",
  "name": "Build",
  "version": "1.0.0",
  "kind": "built-in-privileged",
  "provides": {
    "hooks": ["pre", "post", "custom"]
  },
  "consumes": {
    "hooks": {
      "session/init": { "script": "./hooks/init.js", "onFail": "warn" }
    }
  }
}
```

Both fields are validated against the JSON schema at [packages/module-sdk/manifest.schema.json](../../packages/module-sdk/manifest.schema.json). Unknown slots raise `E_HOOK_NAME_UNDECLARED`. The override-hook name is **hardcoded as `custom`** — recognized by the registry's resolver as the override point.

#### Project config

`@rn-dev/config` is a published workspace package exposing `defineConfig`, types, and the JSON schema. A consuming RN app drops `rn-dev.config.ts` at its project root:

```typescript
import { defineConfig } from "@rn-dev/config";

export default defineConfig({
  hooks: {
    "build/pre": "./bin/swap-firebase.sh",
    "clean/post": { script: "./bin/wipe-derived-data.sh", onFail: "warn", timeoutMs: 60_000 },
    "metro/post-start": "./bin/start-mock-server.js",
  },
  allowModuleOverrides: ["acme-firebase"],
});
```

Loaded at session boot via Bun's runtime dynamic import (the daemon already runs under Bun in dev; production-distributed bundles compile via `bun build` per [build.ts](../../build.ts)). Parsing failures return `E_HOOK_CONFIG_INVALID { cause: 'parse-failed' | 'threw' | 'shape-invalid' }` carrying a code-frame line:column pointer.

#### HookManager — the contribution-point registry

`src/core/hooks/manager.ts` owns:

- Registry construction at session boot. Walks active modules; collects their `provides.hooks` into a `Map<'<id>/<name>', HookContributionPoint>`; collects project-config + module-manifest `consumes.hooks` into a `Map<'<id>/<name>', HookRegistration[]>`.
- Validation. References to unknown contribution points fail at config-load (hard — the session doesn't boot). Built-in modules' `provides.hooks` always exist; 3p `consumes.hooks` referencing an inactive optional module are marked `orphaned` and skipped at fire time with a one-time warn (lets optional deps work).
- Dispatch. `manager.fire('<id>/<name>', payload)` sorts registrations by `(priority desc, registrationOrder asc)` (default project priority `100`, default 3p priority `0`), runs them according to the target's `kind`:
  - **In-process target** (built-in module): dispatch via direct method call against the host capability the built-in registered.
  - **Subprocess target** (3p module): dispatch via vscode-jsonrpc notification.
- Override resolution. A target's `custom` slot (hardcoded — `provides.overrideHook?` configurability dropped per code-simplicity review) replaces the built-in step body. Pre/post hooks around the override still fire — the override replaces the step, not the surrounding fan-out.
- Failure semantics per [§6.5 of the brainstorm](../brainstorms/2026-04-29-acme-dev-cli-research.md). Per-entry `onFail: 'hard' | 'warn' | 'retry'` with phase defaults. Retry uses exponential backoff (1s, 2s, 4s, capped at 30s). Hard failures abort the calling site's RPC.
- Concurrency. Fires of the same `(moduleId, hookName, scopeUnit)` tuple are serialized. Different tuples fire in parallel.

#### Subprocess hook contract

Spawned with the same primitives as the existing module-host subprocess:

- POSIX detached process group for group-kill on timeout.
- Linux `setpriv --pdeathsig SIGKILL` when available.
- Timeout escalation: SIGTERM → 1s grace → SIGKILL of the whole group.
- Strip `RN_DEV_HOOK_*` env vars from inherited environment before spawn (re-entrancy injection guard).

Wire format:

- **stdin**: single JSON line, then EOF. Payload: `{ phase, moduleId, hookName, profile, hostVersion, ...phaseArgs }`. Profile is the validated `Profile` type (already gated by [src/daemon/profile-guard.ts validateProfile](../../src/daemon/profile-guard.ts)). No newlines reach the wire because `validateProfile` rejects them at the boundary.
- **stdout**: stream of newline-delimited JSON records, each one of:
  - `{ "kind": "log", "level": "info" | "warn" | "error", "message": string }`
  - `{ "kind": "result", "data": object }` — at most one per fire; multiple records → `E_HOOK_FAILED { outcome: "multiple-results" }`.
  - `{ "kind": "ack", "replaced": true }` — emitted as the FIRST record by an override hook to claim the step. If absent before the first non-`ack` record, the override is treated as not-claimed and the daemon falls back to the built-in step.
  - Anything that fails the discriminator narrowing is forwarded as a `log`-level info line (mirrors `parseSubscribePayload` at [src/daemon/index.ts:653](../../src/daemon/index.ts:653) idiom).
- **stderr**: forwarded as warn-level logs, rate-limited at 10 KB/s per hook, truncated with `[truncated]` marker.
- **exit code**: `0` = success; non-zero = failure.

#### In-process hook contract

A built-in module registers in-process hook handlers via an `HostHookCapability` that the HookManager dispatches against:

```typescript
interface HostHookCapability {
  fireHook(name: string, payload: HookPayload): Promise<HookResult>;
}
```

Built-in modules implement this against their existing EventEmitter machinery. Failure is `throw` → equivalent to subprocess non-zero exit; return value → equivalent to `{ kind: "result", data: ... }`.

#### Path resolution and traversal guard

Hook script paths in project configs and 3p manifests are resolved against the config-file's containing directory. After resolution, `fs.realpathSync` is applied and the result must `startsWith(projectRoot + path.sep)` (or, for 3p hooks, the module's package root). Failure: `E_HOOK_PATH_OUTSIDE_PROJECT`. Symlink-realpath is required because the symlink-then-prefix-check pattern alone is bypassable (`bin/x.sh -> ../../../etc/passwd` defeats `startsWith`).

#### Audit log integration

[src/core/audit-log.ts AuditEntryInput](../../src/core/audit-log.ts) gains:

```typescript
export interface AuditHookInput {
  kind: "hook";
  phase: string; // "<moduleId>/<hookName>"
  source: "project" | `module:${string}`;
  scriptOrSymbol: string;
  durationMs: number;
  exitCode: number;
  outcome: AuditOutcome; // ok | error | denied
}
```

Entries are appended for failures (hard or warn that escalated), every override-hook registration (so the audit log records when a 3p module gained the right to replace a built-in step), and every `<id>/custom` override fire. Successful additive hook fires are NOT audited — volume is too high; the build log captures stdout/stderr for replay.

#### MCP tool surface

Added to [src/mcp/tools.ts](../../src/mcp/tools.ts):

- `rn-dev/hooks-list` → returns `{ provides: ContributionPoint[], registrations: Registration[], orphaned: string[] }`. Filterable by `?moduleId=`.
- `rn-dev/hooks-run` → invokes a single hook with a synthetic payload (default) or the real next-fire payload (`mode: "real"`). Restricted to dev-mode daemons.
- `rn-dev/hooks-last-status` → most recent in-memory invocation per registration. Volatile across daemon restart.
- (`hooks-history` collapsed into `hooks-list?include=history&since=<ts>` — see H6.)
- `rn-dev/hooks-diagnose` → for a `<moduleId>/<hookName>` reference, returns: `{ registered, pathResolved, scriptExists, scriptExecutable, schemaValid, didYouMean? }`. Mirrors the human "did-you-mean" diagnostics for agent-driven debugging.

### Implementation Phases

#### Phase H0: Manifest schema + `@rn-dev/config` + `rn-dev config init` scaffolder

**Deliverables:**

- `packages/config/` — new bun workspace. `defineConfig` helper, types, JSON Schema. Published `@rn-dev/config`. Tiny package: types + `defineConfig` is identity-with-validation. No daemon dependency; consuming projects can install it without rn-dev-cli.
- [packages/module-sdk/manifest.schema.json](../../packages/module-sdk/manifest.schema.json) — additive `provides.hooks` (array of strings; per-item: `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, max 64 chars, `uniqueItems: true`, empty array allowed) and `consumes.hooks` (`Record<'<id>/<name>', HookEntry>`). `additionalProperties: false` is preserved. Override-slot name is hardcoded `custom`; no `provides.overrideHook?` field.
- [packages/module-sdk/src/types.ts](../../packages/module-sdk/src/types.ts) — paired type updates to `ModuleManifest`. `defineHook()` typed wrapper for in-process implementations.
- New error codes in [packages/module-sdk/src/errors.ts](../../packages/module-sdk/src/errors.ts) — consolidated 7-code set (matches Research Insights below): `E_HOOK_TARGET_UNKNOWN`, `E_HOOK_NAME_UNDECLARED`, `E_HOOK_PATH_OUTSIDE_PROJECT`, `E_HOOK_OVERRIDE_NOT_PERMITTED`, `E_HOOK_CONFIG_INVALID` (with `cause: 'parse-failed' | 'threw' | 'shape-invalid' | 'config-load-timeout'`), `E_HOOK_FAILED` (with `outcome: 'multiple-override' | 'multiple-results' | 'crashed-before-payload' | 'cycle-detected' | 'path-mutated' | 'queue-full' | 'timeout' | 'script-unreadable'`), `E_HOOK_RUN_REAL_DENIED`.
- `rn-dev config init` CLI command that:
  - Scaffolds a starter `rn-dev.config.ts` with examples for the most-used hooks (validates the schema before writing).
  - **Detects the project's package manager via lockfile (`bun.lock` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm) and runs `<pm> install --save-dev @rn-dev/config@^<hostMinor>`** (todo #004 — without this, the scaffolded config fails its own dynamic import on the first session boot with `MODULE_NOT_FOUND`).
  - Acceptance test: `rn-dev config init` in an empty dir produces a project where `rn-dev config validate` succeeds without further setup.

**Test layer:**

- vitest only. No daemon integration yet.
- `defineConfig` happy-path + each rejection class (single `E_HOOK_CONFIG_INVALID` with `cause` field).
- Manifest validator: provides + consumes round-trips, rejects on malformed names.
- `rn-dev config init` writes a parseable file.
- **Lockstep CI check** (vitest task): ajv-validates a fixture against `manifest.schema.json`; `expectTypeOf<ModuleManifest>().toMatchTypeOf<FromSchema<typeof schema>>()`.

### Research Insights (H0)

**TypeScript contracts (kieran):**
- `HookContracts` is a module-augmentable map: `interface HookContracts { 'build/pre': { payload: BuildPrePayload; result: void }; ... }`. Each built-in module module-augments it; 3p modules can too via `declare module '@rn-dev/config'`. `HookManager.fire<S extends keyof HookContracts>(slot: S, payload: HookContracts[S]['payload']): Promise<HookContracts[S]['result']>` — closes the `payload: unknown` leak everywhere except inside the parser.
- `defineConfig` is generic over a `BuiltInModules` const-tuple: `defineConfig<const M extends readonly ModuleManifest[] = readonly BuiltInModules[]>(cfg: { hooks?: Partial<Record<HookSlotsOf<M[number]>, HookEntry>>; ... })`. Projects get autocomplete for `'build/pre' | 'clean/pre' | …` and typos compile-error.
- `HookEntry` is a discriminated union (no tag — discriminated by key presence). String is sugar for `{ script }`. Function is for in-process project hooks (config is `.ts` so closures are free):

  ```typescript
  // Sugar — defaults onFail = phase default, timeoutMs = phase default
  defineConfig({ hooks: { 'build/pre': './bin/swap-firebase.sh' } });

  // Subprocess script with explicit options
  defineConfig({
    hooks: {
      'clean/post': { script: './bin/wipe-derived-data.sh', onFail: 'warn', timeoutMs: 60_000 },
    },
  });

  // In-process function — fastest, no fork+exec cost
  defineConfig({
    hooks: {
      'metro/post-start': {
        fn: async (payload) => { await startMockServer(payload.port); },
        onFail: 'hard',
      },
    },
  });
  ```
- `OverrideSlotOf<M>` derived type: `M['provides'] extends { overrideHook: infer O extends string } ? \`${M['id']}/${O}\` : \`${M['id']}/custom\``. Gates `allowModuleOverrides` and override registrations at the type layer — runtime check still required, but type errors catch most slips.

**Package shape (kieran):**
- `packages/config/package.json` — `"type": "module"`, `"sideEffects": false`, exports map with `types` first; `defineConfig` is identity (no validation at call site — daemon validates at boot). Zero-runtime + tree-shakeable confirmed in H0 review.

**Error code consolidation (code-simplicity):**
- 12 → 7 codes: `E_HOOK_TARGET_UNKNOWN`, `E_HOOK_NAME_UNDECLARED`, `E_HOOK_PATH_OUTSIDE_PROJECT`, `E_HOOK_OVERRIDE_NOT_PERMITTED`, `E_HOOK_CONFIG_INVALID`, `E_HOOK_FAILED` (with `outcome` strings: `multiple-override` | `multiple-results` | `crashed-before-payload` | `cycle-detected` | `path-mutated` | `queue-full` | `timeout`), `E_HOOK_RUN_REAL_DENIED`. Plus `E_HOOK_VERSION_MISMATCH` if hook schema versioning ships in v1 (see Prior Art).

**Prior art adoption (Explore #1 — VSCode/Vite/Rollup/esbuild/Webpack/Eclipse):**
- Hook schema `version: "1.0.0"` per `provides.hooks` entry. Rejected with `E_HOOK_VERSION_MISMATCH` + did-you-mean-closest-compatible suggestion.
- `maxRegistrations: number` (default 16) per contribution point. Prevents runaway plugin proliferation; 17th rejected at config-load.
- Validate contribution-point existence upfront (config-load, not fire-time). Rollup learned this via cycles; Eclipse via schema mismatch.

#### Phase H1: HookManager + spawn primitives extraction + lifecycle namespace bootstrap

**Deliverables:**

- `src/core/spawn-utils.ts` — extract `wrapChild`, `buildSpawnCommand`, and the `setpriv` cache from [src/core/module-host/manager.ts:71-119](../../src/core/module-host/manager.ts:71). Generalize `buildSpawnCommand` to take `{ command, args }`. ModuleHost imports from the new module so no behavior change for existing module-host tests.
- **Hook orphan-sweep on daemon boot** (todo #003 — closes the daemon-SIGKILL gap). Mirrors the existing module orphan-sweep at [src/daemon/orphan-sweep.ts](../../src/daemon/orphan-sweep.ts): scans for stray hook process groups (identified by a sentinel env-var marker `RN_DEV_HOOK_PGID=<daemon-pid>` set on every hook spawn), SIGKILLs orphans before booting the new session. Linux uses `setpriv --pdeathsig SIGKILL` when available (kernel kills the hook the instant the daemon dies). macOS has no `pdeathsig` equivalent; documented as best-effort with the orphan-sweep as the safety net at next daemon boot. Test: `tests/electron-smoke/hook-orphan.spec.ts` SIGKILLs the daemon mid-fire of a sleeping hook, boots a fresh daemon, asserts `process.kill(-pgid, 0)` throws `ESRCH` within 2s.
- `src/core/hooks/manager.ts` — HookManager class. Subprocess + in-process dispatch paths, contribution-point registry, ordering by `(priority desc, registrationOrder asc)`, override resolution, retry with exponential backoff, audit log integration.
- `src/core/hooks/runner-subprocess.ts` — subprocess hook invoker. JSON-line wire format via **`split2` library** (5.3M weekly DL, Bun-compatible, backpressure-aware — Explore #2). Process-group spawn + group-kill timeout escalation. EPIPE → `E_HOOK_FAILED { outcome: "crashed-before-payload" }`. stderr rate limit (10 KB/s) + stdout token bucket (50 KB/s + 200 records/s, drop after 100 consecutive parse failures). Strip `\r` after split for Windows CRLF safety. Strips `RN_DEV_HOOK_*` env on spawn; uses explicit `RN_DEV_*` allowlist.
- **Parser inlined into `runner-subprocess.ts`** (code-simplicity finding 4) — three discriminator kinds, ~40 lines. Extract when a second consumer appears.
- **Prototype-pollution defense (security-sentinel finding 4 — showstopper)** — the parser MUST use a `JSON.parse` reviver that returns `undefined` for `__proto__`, `constructor`, `prototype` keys. After parse, `Object.freeze(record.data)` before forwarding. The cited `parseSubscribePayload` idiom only narrows shape — it is NOT a pollution defense.
  ```typescript
  const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const parsed = JSON.parse(line, (k, v) => POLLUTION_KEYS.has(k) ? undefined : v);
  ```
- **Result termination protocol** (Explore #2) — parser switches to "post-result sink" after first `{kind:"result"}` record; subsequent records logged but not collected. Second `result` → `E_HOOK_FAILED { outcome: "multiple-results" }`. Override hooks: first record MUST be `{kind:"ack", replaced: true}` — missing ack on first non-ack record → hard fail (NO silent fall-back to built-in step; the fall-back would hide bugs per code-simplicity finding 3).
- `src/core/hooks/path-resolver.ts` — resolve script paths against config-file dir; `realpathSync` + prefix check. `E_HOOK_PATH_OUTSIDE_PROJECT` on bypass.
- New audit log variant `kind: "hook"` per AuditHookInput above.
- A `session` built-in module owning `session/init` + `session/profile-changed` at H1 (`session/shutdown` deferred until a consumer asks). Hook namespace is **explicitly capped at 3** (`init`, `profile-changed`, `shutdown`). Anything else (e.g. `worktree/added`, `marketplace/install-completed`) gets its own built-in module, not this one. `session/init` fires from [src/core/session/boot.ts](../../src/core/session/boot.ts) at the end of `bootSessionServices`. `session/profile-changed` fires from a new daemon RPC `session/profile-update` (handler added in this phase) which revalidates the profile via `validateProfile` then dispatches the hook.
- **HookManager SRP split** (architecture-strategist finding 2): `HookRegistry` (pure data — `provides`/`consumes` map, validation, did-you-mean, orphan tracking, zero I/O), `HookDispatcher` (fire ordering, override resolution, in-process/subprocess routing, concurrency serialization), `HookSubprocessRunner` (already broken out as `runner-subprocess.ts`), `HookAuditWriter` (audit-policy decisions in one reviewable place). `HookManager` becomes a thin facade composing the four. Public API stays the same.
- **Facade public-API preservation tests** (todo #002 — closes silent regression risk for H2 callers like [src/daemon/client-rpcs.ts:130](../../src/daemon/client-rpcs.ts:130)): `hook-manager-facade.test.ts` snapshots facade method names + signatures; `expectTypeOf<HookManager['fire']>().parameter(0).toEqualTypeOf<keyof HookContracts>()` pins the typed dispatch shape. ~30 LOC combined.
- **Cross-class integration tests** (todo #009 — fills the seam between the 4 SRP classes that the per-class vitest matrix doesn't reach):
  - `hooks-dispatcher.contract.test.ts` — register out-of-order, assert dispatcher invokes in `(priority desc, registrationOrder asc)` from the pre-baked sorted list (no re-sort).
  - `hooks-audit-writer.policy.test.ts` — spy on AuditWriter; additive successful fire produces zero `append` calls; failure + override registration produce exactly one each.
  - `hooks-runner-dispatcher-backpressure.test.ts` — fire registration A (slow subprocess) + B (fast in-process) against different tuples; assert B completes before A.
- **`HookManager extends EventEmitter`** — pattern parity with `MetroManager`/`DevToolsManager`/`ModuleHostManager`. Emits `hooks/fired`, `hooks/registered`, `hooks/orphaned` topics on its own bus.
- **Curated allowlist for `kind: "built-in-privileged"`** (security-sentinel finding 5 — showstopper) — the registry MUST reject `built-in-privileged` for any manifest not in the host's compiled-in allowlist. Without this, any 3p manifest can self-declare in-process and bypass subprocess isolation. Allowlist lives at `src/modules/built-in-allowlist.ts` and is matched against `manifest.id`.
- **`ValidatedProfile` branded type** (security-sentinel finding 2 — showstopper) — `HookManager.fire()` accepts `ValidatedProfile` only, not `Profile`. Every entry point (RPC handler, MCP tool, in-process call) re-runs `validateProfile` to mint the branded type. Closes the agent-supplied-payload bypass.
- **Final-env `checkEnv` after merge** (security-sentinel finding 3) — runner's pre-spawn env composition runs `checkEnv` against the *final* env dict (after hook-entry-supplied keys are merged), not just against profile.env. `RN_DEV_*` env passthrough uses an explicit allowlist, not denylist.
- **`profile.name` newline+CR rejection** (security-sentinel finding 3) — patch [src/daemon/profile-guard.ts:72-75](../../src/daemon/profile-guard.ts:72) to reject `\n` and `\r` in name (parity with `checkAbsolutePath`). Required because name flows into `RN_DEV_PROFILE_JSON` env var; embedded newlines desync the JSON-line parser on the receiving end.
- **Path TOCTOU re-check** (security-sentinel finding 1) — registry caches `(absolutePath, lstat.dev+ino)` from boot; re-`realpathSync` at fire time; mismatch → `E_HOOK_FAILED { outcome: "path-mutated" }`, skip + audit.
- **`config-file realpath` check before dynamic import** (security-sentinel finding 1, third bullet) — stat config file before `import("./rn-dev.config.ts")`; reject if `realpath(configFile)` is not under `realpath(projectRoot)`.
- **Concurrent fire queue** with depth cap 10; overflow → `E_HOOK_FAILED { outcome: "queue-full" }`, **always audited** (security-sentinel finding 10).
- **Empty-registry fast path** (performance-oracle finding 1) — `HookManager.fire()` short-circuits when `registrations.length === 0`: no await, no audit, no event emit. Pre-bake the sorted registration list per `<id>/<name>` at registration time; rebuild only on register/unregister.
- **Deterministic boot-phase split** (todo #011 — closes capability registration race): session boot runs in three explicit phases. Phase 1 = register all built-in capabilities (no hook fires). Phase 2 = construct HookManager + walk `consumes.hooks` from project config + active module manifests; mark orphans. Phase 3 = fire `session/init`. Vitest asserts via boot-trace that all built-in capabilities are registered before any `session/init` listener invocation.
- **`dumpRegistry()` debug API** (todo #008 — testability) — internal-only method on `HookManager` exposing the registry's contribution-points and registrations Map for vitest assertions. Not part of the public MCP surface.
- **`@rn-dev/module-sdk` test helpers** (todo #015 — hoisted from H7): `runHookInProcess(manifest, hookName, payload)` invokes a registered in-process hook with a typed payload and captures result/logs without spawning. `MockHookRuntime<S extends keyof HookContracts>` captures fires and exposes `fires[]` for assertions with full type inference. Both ship as part of `@rn-dev/module-sdk` so H5 module authors writing 3p hooks have test infra at H5 time, not H7.

**Test layer:**

- vitest:
  - HookManager registry construction over arbitrary `provides`/`consumes` graphs (property-based with `fast-check` if available, hand-written otherwise).
  - Subprocess runner: success, exit !== 0, timeout reaped (assert process group dies), JSON-line buffer split mid-message, malformed records dropped, `__proto__` rejection, multiple `result` rejected.
  - In-process runner: success, throw → fail, capability registry plumbing.
  - Path resolver: relative resolution, symlink traversal blocked, `~` rejected.
  - Audit log: failures audited, successes not, override registrations always audited.
  - Env-var passthrough: profile with `LD_PRELOAD` rejected at `validateProfile` boundary BEFORE reaching hook spawn (regression test mirroring [src/daemon/__tests__/session-boot.test.ts:212](../../src/daemon/__tests__/session-boot.test.ts:212)).
- tsc clean across `src/` and `electron/tsconfig.json`.

#### Phase H2: Wrap `Builder` as built-in module — E2E milestone

**Deliverables:**

- `modules/build/` — new built-in-privileged module. Manifest declares `provides.hooks: ['pre', 'post', 'custom']`. Module index wraps the existing [src/core/builder.ts Builder](../../src/core/builder.ts) class behind a `BuildHostCapability` (subsystem-first naming).
- **`HookHostCapability` interface + `createBuildHostCapability` factory introduced HERE** (todo #006 — was forward-referenced in H3; hoisted to H2 because Builder wrap is the first consumer). H3 then adds the remaining factories (Clean/Metro/DevTools-core/Preflight). Permission gate `host:hooks:dispatch`; capability id added to [src/core/module-host/capabilities.ts:58 KNOWN_CAPABILITIES](../../src/core/module-host/capabilities.ts:58) typo-detector.
- Move `SessionServices.builder` to lazy-resolve via `moduleHost.getBuiltIn('build')` so the built-in module is the single source of truth (no second instance). Existing daemon callsites at [src/daemon/client-rpcs.ts:130-137](../../src/daemon/client-rpcs.ts:130) keep their typed shortcut — the lazy resolution happens internally.
- `client-rpcs.ts builder/build` handler fires `build/pre` via the HookManager BEFORE invoking `services.builder.build(parsed.opts)`, and `build/post` AFTER `Builder` emits `done`. Hook failures in `pre` with `onFail: 'hard'` reject the RPC with `{ code: 'E_HOOK_FAILED', phase: 'build/pre' }`.
- Builder concurrency guard at [src/core/builder.ts:64-78](../../src/core/builder.ts:64) preserved; the wrapped capability flips `process` to non-null before delegating.
- Daemon emits `hooks/fired` session events on every hook completion (success and fail), riding the existing `events/subscribe` channel. Adds visibility for the acme-style "did my hook just run?" UX without needing to grep the daemon log.
- `examples/firebase-swap/rn-dev.config.ts` minimal version — a project config registering a `build/pre` script that writes a sentinel file (used by the e2e test).
- `tests/electron-smoke/fixtures/smoke-rn-with-hooks/` — new fixture parallel to `smoke-rn`. Contains an `rn-dev.config.ts` with a `build/pre` hook running `node -e "console.log(JSON.stringify({kind:'result',data:{ok:true}}))"` (Node-only, no shell — Windows-portable).
- `rn-dev/hooks-diagnose` + `rn-dev/hooks-config-validate` MCP tools — hoisted from H6 because agent-driven debugging during the e2e milestone needs both. `hooks-config-validate` runs `tsc --noEmit` against the user's `rn-dev.config.ts` with the daemon's `BuiltInModules` types injected via a generated `node_modules/@rn-dev/config/types-augment.d.ts` (todo #013 — catches typos like `'build/before'` at validate time, not at first hook fire). Reports TS errors in JSON-line format pointing at file:line:col.
- **`RN_DEV_DAEMON_MODE=dev|prod` dev-mode gate** (security-sentinel finding 8 — showstopper) — env var set at boot, default `prod`. Production daemons reject `hooks/run` with `mode: "real"` and reject `hooks/run` synthetic-mode entirely with `E_HOOK_RUN_REAL_DENIED`. Document precedent — there is none in [src/mcp/tools.ts](../../src/mcp/tools.ts) today; this scaffolding lands here and other dev-only tools will adopt it.
- **Builder event `source: 'builtin' | 'override'` discriminator** (architecture-strategist finding 5 — showstopper) — every `line`/`progress`/`done` event Builder emits gets a `source` field. Built-in events stamp `'builtin'`; override-synthesized events stamp `'override'`. Lets audit-log readers and MCP agents distinguish "build failed" from "override hook crashed" by the time the event reaches a consumer.
- **`SessionServices.builder` lazy-resolve via `ModuleRegistry.getBuiltIn<T>(id)`** (architecture-strategist finding 4) — NOT on `ModuleHostManager`; that class's `acquire()` already throws `E_BUILT_IN_NOT_SPAWNABLE` for built-in-privileged manifests. Keeping `getBuiltIn` separate preserves the carve-out invariant at the type level.
- **`ModuleRegistry.getBuiltIn<T>(id: string): T`** — single-source-of-truth resolver for in-process built-in capabilities. Type-parameterized so callers get the concrete capability interface back.

**Test layer:**

- vitest: `modules/build/__tests__/` — wrapping preserves Builder behavior; pre/post fire in correct order; concurrency guard fires once; `build/custom` placeholder rejected at registration (override semantics arrive in H4).
- tsc clean.
- Playwright fake-boot smoke ([tests/electron-smoke/smoke.spec.ts](../../tests/electron-smoke/smoke.spec.ts)) — new spec asserting build flow with hook fires.
- **REAL_BOOT_SMOKE=1** ([tests/electron-smoke/real-boot.spec.ts](../../tests/electron-smoke/real-boot.spec.ts)) — required gate per the institutional learning that synthetic tests miss daemon-protocol regressions.
- Assertions on the fixture e2e test:
  - Hook subprocess spawned + exited 0.
  - No audit entry on success path.
  - Audit entry of `kind: "hook"` on the deliberate failure path.
  - Builder `started`/`done` events still fire.
  - Hook stdin payload contained the validated profile JSON.
  - `build/pre`-to-`build`-start latency under 500ms for the trivial fixture.

#### Phase H3: Wrap CleanManager / MetroManager / DevToolsManager / PreflightEngine as built-in modules

**Deliverables:**

- `modules/clean/` — `provides.hooks: ['pre', 'post', 'custom']`. Wraps [src/core/clean.ts CleanManager](../../src/core/clean.ts).
- `modules/metro/` — `provides.hooks: ['pre-start', 'post-start', 'pre-stop', 'post-stop']`. Wraps [src/core/metro.ts MetroManager](../../src/core/metro.ts). Each is fired at the corresponding lifecycle point in [src/core/session/boot.ts](../../src/core/session/boot.ts).
- `modules/devtools-core/` (renamed per pattern-recognition finding 8 to disambiguate from existing `modules/devtools-network/`) — `provides.hooks: ['pre-start', 'post-start']`. Wraps [src/core/devtools.ts DevToolsManager](../../src/core/devtools.ts).
- `modules/preflight/` — `provides.hooks: ['before-checks', 'after-checks']`. Wraps [src/core/preflight.ts PreflightEngine](../../src/core/preflight.ts). **`extra-checks` is NOT a hook namespace** (code-simplicity finding 5) — preflight checks are *data*, not events. Modules contribute checks via the existing `PreflightEngine.register()` exposed as a capability.
- **`modules/_template/`** — six-entry layout reference (`src/`, `panel/`, `build.ts`, `package.json`, `tsconfig.json`, `rn-dev-module.json`) per existing `modules/device-control/`. New built-in wraps copy from this template (pattern-recognition finding 2).
- **Remaining capability factories** — `createCleanHostCapability` / `createMetroHostCapability` / `createDevtoolsCoreHostCapability` / `createPreflightHostCapability`. (`HookHostCapability` interface + `createBuildHostCapability` factory shipped in H2.) Subsystem-first naming matches `createMetroLogsHostCapability` / `createDevtoolsHostCapability` precedent (pattern-recognition finding 10). Permission gate `host:hooks:dispatch`. Capability ids added to [src/core/module-host/capabilities.ts:58 KNOWN_CAPABILITIES](../../src/core/module-host/capabilities.ts:58) typo-detector.

**Test layer:**

- vitest per module, mirroring H2's pattern.
- tsc clean.
- Playwright fake-boot smoke for cross-module session boot ordering.
- **REAL_BOOT_SMOKE=1** — supervisor-lifecycle changes are the same risk class as H2.

#### Phase H4: Override semantics for `<module-id>/custom`

> Anchor: H2 introduced a `source: 'builtin' | 'override'` field on every Builder event. H4 wires the override path that produces `source: 'override'` — when a project (or opted-in 3p module) registers against the `custom` slot, the registration replaces the built-in step body, and its stdout records become the synthesized event stream.

**Deliverables:**

- HookManager override resolver — when a registration target's hook name matches the target module's override slot (**hardcoded `custom`** — code-simplicity finding 11; `provides.overrideHook?` configurability dropped), the dispatcher invokes the registration FIRST, expects an `{ kind: 'ack', replaced: true }` record before any other record, then routes subsequent stdout records as Builder/Clean events. **No fall-back on missing ack** (code-simplicity finding 3) — missing ack = hard fail. Falling back hides bugs.
- Builder/Clean "passthrough mode": when an override is registered, the built-in's `<X>Capability.run()` becomes a routing function that wraps the override's stdout into the existing event emissions (`line`, `progress`, `done`) — each stamped with `source: 'override'` per H2's discriminator.
- **Single override allowed** (code-simplicity finding 3) — multiple overrides → `E_HOOK_FAILED { outcome: "multiple-override" }` at registration. Project + 3p both register override → project wins; 3p shadowed (audit entry, warn log).
- Override mid-execution crash → synthesize `done { success: false, source: 'override', errors: [{ summary: 'override hook crashed', ... }] }`. `post` still fires so cleanup hooks run.
- **Override line-event fast path** (performance finding 7) — `{kind:"line", text}` records bypass JSON re-parse on the way to subscribers; emit `text` directly into the broadcast.

**Test layer:**

- vitest: ack-first protocol enforcement; missing-ack triggers fall-through-to-built-in (project hook didn't claim override); multi-override rejection.
- tsc clean.
- Playwright fake-boot — override Builder runs; override emits synthetic done; subscribers see the override's output.
- **REAL_BOOT_SMOKE=1** — override path replaces the production build flow.

#### Phase H5: 3p module hook surface + `allowModuleOverrides` security gate

**Deliverables:**

- [src/modules/registry.ts loadSingleManifest](../../src/modules/registry.ts) — extend manifest validation to walk `consumes.hooks`. References to active modules' undeclared hooks: `E_HOOK_NAME_UNDECLARED`. References to inactive optional modules: marked `orphaned`, registration kept with one-time warn at activation; firing skipped.
- Override-hook gate: a 3p `consumes.hooks` entry against the `custom` slot is loaded but NOT registered unless the project's `rn-dev.config.ts` lists the module ID in `allowModuleOverrides`. Audit entry of `kind: "hook"` records the registration decision (always-audited per H1's policy).
- **`allowModuleHardFails` second gate** (architecture-strategist finding 6 + security-sentinel finding 5 — showstopper) — `onFail: 'hard'` from a 3p module against any non-override slot is downgraded to `'warn'` unless the project's `rn-dev.config.ts` also lists the module ID in `allowModuleHardFails: ['<id>']`. Audit-log every downgrade. Closes the privilege-escalation surface where a marketplace module breaks every project's build by registering an unconditionally-failing pre-hook.
- Cycle detection — registry maintains a per-fire call stack; firing a hook already on the stack raises `E_HOOK_FAILED { outcome: "cycle-detected" }`. No upfront static cycle detection.
- Property test against pathological registration graphs.

**Test layer:**

- vitest: 3p-module-with-override-no-opt-in is rejected at registration; same module IS registered when project opts in; orphaned 3p references are silent until target activates; cycle detection triggers on synthetic A→B→A graph.
- tsc clean.
- Playwright fake-boot — 3p module fixture with a `consumes.hooks: { 'build/pre': ... }` registration fires correctly during build.
- **REAL_BOOT_SMOKE=1** — registry walks production manifests.

#### Phase H6: Remaining MCP surface (expanded for agent-native parity)

**Deliverables:**

Read-side (extends H2's `hooks-diagnose` + `hooks-config-validate`):
- `rn-dev/hooks-list` — `{ provides, registrations: Registration[], orphaned, overrides }`. Filterable via `?moduleId=`, `?summary=true` (just `<id>/<name>` strings + counts), and `?include=history&since=<ts>` (collapses former `hooks-history` per code-simplicity finding 8). Each `Registration` includes `{ target, source, priority, registrationOrder, scriptOrSymbol, pathResolved, scriptHash, lastFiredAt?, lastExitCode?, orphaned, isOverride, onFail }` per Explore #1 recommendation 5.
- `rn-dev/hooks-run` — synthetic payload by default; opt-in `mode: "real"` gated by `RN_DEV_DAEMON_MODE=dev` (rejected with `E_HOOK_RUN_REAL_DENIED` in production).
- `rn-dev/hooks-last-status` — in-memory only.
- `rn-dev/hooks-diagnose-all` (agent-native finding 3) — sweep mode of `hooks-diagnose`. Returns `{ entries, unresolvedReferences, orphanedRegistrations, pathTraversalRejections }`. No args.
- `rn-dev/hooks-overrides` (agent-native finding 4) — purpose-built read returning `{ moduleId, targetHook, registeredAtSessionStartIso, mostRecentAuditEntryId, permittedByConfigPath }[]`.
- `rn-dev/hooks-catalog` (agent-native finding 9) — `{ active, installedInactive, marketplaceAvailable }`. Marketplace tier reuses the existing curated `modules.json` SHA-pinned fetch — read manifests' `provides.hooks` without activating.

Write-side (closes the agent self-modifying loop — agent-native skill gaps **a + e**):
- `rn-dev/hooks-config-read` — returns `{ parsed: RnDevConfig, raw: string, filePath: string }`.
- `rn-dev/hooks-config-write` — accepts `{ op: "register" | "remove" | "set-priority", reference, script?, onFail?, timeoutMs? }`. AST-level edit via the project's TS compiler, validates against the contribution-point registry BEFORE writing, writes atomically. Returns `{ written, validationErrors, requiresDaemonRestart: true, diff }`. Restricted to `RN_DEV_DAEMON_MODE=dev`.
- (`hooks-config-validate` already shipped in H2.)
- `rn-dev/hooks-suggest` (agent-native skill gap **c**) — walks `package.json` scripts, `bin/`, `.env*`, active module manifests; returns `[{ reference, candidate, reason, confidence }]`. Makes the system discoverable to a fresh agent.
- `rn-dev/hooks-repair` (agent-native skill gap **d**) — given a `<moduleId>/<hookName>` reference, returns `{ proposal: HookConfigEdit, rationale }` composable directly with `hooks-config-write`. Builds on `hooks-diagnose`.
- `rn-dev/session-profile-update` (agent-native finding 5) — revalidates profile via `validateProfile`, persists, fires `session/profile-changed`. Documents that `session/start` fires `session/init`, NOT `session/profile-changed`.

Event surface (extends `events/subscribe` per agent-native finding 8):
- Stable kind vocabulary: `hooks/fired`, `hooks/failed`, `hooks/timed-out`, `hooks/orphaned-skipped`, `hooks/override-claimed`, `hooks/registered`, `hooks/permission-granted`, `hooks/config-reloaded`. Each event payload includes `correlationId` linking pre/post pairs and tying to audit entries. (No `hooks/override-fell-through` — missing-ack is `hooks/failed` per H4 hard-fail policy.)

**Test layer:**

- vitest: each tool's payload schema; `hooks-run` runs against fixture; `hooks-list?include=history` queries a fixture audit log.
- tsc clean.
- Playwright smoke: GUI calls `hooks-list` via MCP and renders results in a panel.

#### Phase H7: Documentation, examples, deprecation guides

**Deliverables:**

- `examples/firebase-swap/` — full acme-style env-driven Firebase config swap. Project `rn-dev.config.ts` registers `build/pre` and `session/profile-changed` hooks. Documented in the example README.
- `docs/guides/hook-system.md` — user-facing guide covering the contribution-point model, manifest fields, project config shape, error catalog, security posture.
- `docs/guides/onSaveAction-migration.md` — migration path from [OnSaveAction](../../src/core/types.ts:28) to a future `watcher/on-change` hook (not implemented in this plan; declared as a follow-up). Hand-migration only; no CLI helper (code-simplicity finding 10 — `OnSaveAction` is a few lines in a config; AST rewriter not worth maintaining).
- `@rn-dev/module-sdk` test helpers (`runHookInProcess`, `MockHookRuntime`) documentation only. **Helpers themselves ship in H1** (todo #015 — they test contracts defined in H0/H1; building them in H7 means H1 can't dogfood them and H5 module authors lack test infra).
- **Error catalog reference page** auto-generated from [packages/module-sdk/src/errors.ts](../../packages/module-sdk/src/errors.ts) into `docs/guides/hook-errors.md` (todo #015 — addresses the missing user-discoverable error vocabulary).
- **`@rn-dev/config` package README** with `defineConfig` API + JSON schema link.

**Test layer:**

- vitest covers the example's `rn-dev.config.ts` parses cleanly. (Migration CLI helper dropped per code-simplicity review; manual migration only.)
- Smoke test the example fixture loads + runs.

## Alternative Approaches Considered

### A: Fixed lifecycle enum (the brainstorm's original §6 model)

A `HookPhase` union (`preBuild | preClean | onLaunch | …`) with hooks dispatched by phase name. **Rejected** because it creates a parallel taxonomy next to the module system and assumes every subsystem fits a uniform pre/post/custom shape. See Problem Statement.

### B: All modules run as subprocesses, including built-ins

Total uniformity — every module dispatches via vscode-jsonrpc, no `built-in-privileged` carve-out. **Rejected** because the hot-path cost is real (Metro logs, DevTools CDP frames, Builder line-by-line streaming would all cross a process boundary), and the trust boundary doesn't exist (built-ins ship inside the host's npm package). The carve-out at [src/core/module-host/manager.ts:235](../../src/core/module-host/manager.ts:235) already encodes this trade-off; we lean into it rather than removing it.

### C: Hooks as a degenerate case of modules (the brainstorm's §6.6 rejected option)

Make every hook entry an npm module. **Rejected by the brainstorm** for distribution reasons (project hooks travel with the repo, not the npm registry) and activation cost (vscode-jsonrpc framing is overkill for a 100ms `bin/check-token.sh`). This plan keeps that rejection.

### D: YAML config instead of TypeScript

`rn-dev.config.yaml` instead of `rn-dev.config.ts`. **Rejected** to match the discipline of [vite.config.ts](https://vitejs.dev) / [playwright.config.ts](https://playwright.dev). TypeScript gives us type safety and IDE autocomplete; YAML loses both.

### E: Hot-reload of `rn-dev.config.ts`

Watch the config file and re-register hooks on save. **Rejected** for v1 — same posture as `vite.config.ts`. Daemon restart is the supported config-change path. Re-registration mid-session has too many failure modes (in-flight hooks, partial state).

## System-Wide Impact

### Interaction Graph

```
rn-dev.config.ts edit
  └─ daemon restart required (no hot reload)
     └─ session/init fires
        └─ HookManager registry rebuilt from active modules
           └─ project hooks registered, validated against contribution points
              └─ 3p hooks registered (orphaned for inactive targets)

builder/build RPC arrives at client-rpcs.ts:130
  └─ HookManager.fire("build/pre", payload)
     └─ Project hooks dispatch first (priority 100)
        └─ 3p hooks dispatch second (priority 0)
           └─ All complete OR onFail=hard aborts
              └─ Builder.build() invoked normally
                 └─ Builder emits line/progress/done events
                    └─ HookManager.fire("build/post", payload)
                       └─ Same dispatch order
                          └─ Audit entries on failures
                             └─ session events emit hooks/fired records
```

### Error & Failure Propagation

- Hook subprocess non-zero exit → `HookManager` raises `HookFailureError(phase, exitCode, durationMs)` → calling site (`client-rpcs.ts builder/build`) handles per `onFail` policy. `hard` → reply `{ code: "E_HOOK_FAILED" }`; `warn` → log + audit + continue; `retry` → exponential backoff loop.
- Hook timeout → SIGTERM → 1s grace → SIGKILL of process group → same failure path as non-zero exit, with `exitCode: -1` and `outcome: "error"` in audit entry.
- Hook stdin EPIPE (subprocess crashed before reading) → `E_HOOK_FAILED { outcome: "crashed-before-payload" }` → same failure path, with `exitCode: -2` and a distinct audit reason.
- Multiple `result` records → hook marked failed (`E_HOOK_FAILED { outcome: "multiple-results" }`), regardless of exit code. Rationale: indicates a buggy hook that should be fixed, not silently last-wins'd.
- Override hook crashes mid-execution → synthesize `done { success: false }` with the hook crash as the error; pre/post still fire so cleanup runs.

### State Lifecycle Risks

- HookManager registry is rebuilt on every session boot; no cross-session state in v1. `last-status` is in-memory and volatile; durable history is in the audit log.
- Override-hook registration is recorded in the audit log on every session boot. A 3p module gaining/losing override permission across daemon restarts produces a clear durable trail.
- A built-in module's `provides.hooks` namespace is reachable only while that module is `active`. If a built-in fails to activate (rare — they're in-process), pending registrations against its namespace are marked `orphaned` and skipped at fire time. The session does NOT fail to boot. This matches the existing module-host's "soft-degrade" behavior for non-essential modules.

### API Surface Parity

Three consumer surfaces all go through the same HookManager:

1. Project `rn-dev.config.ts` `hooks` field (this plan, primary surface).
2. 3p module manifest `consumes.hooks` (this plan, H5).
3. MCP `rn-dev/hooks-run` for agent-driven invocation (this plan, H2 + H6).

The TUI and Electron GUI surfaces consume hook events via the existing `events/subscribe` channel (extended with `hooks/fired` events in H2). No separate dispatch path.

### Integration Test Scenarios

1. **Project hook fires in deterministic order before 3p hooks.** Project registers `build/pre` priority `100` (default); 3p module registers `build/pre` priority `0` (default). Assertion: project hook completes before 3p hook starts. (vitest + smoke fixture in H2 + H5.)
2. **Override claims, then crashes.** Project `build/custom` emits `{ kind: 'ack', replaced: true }`, then exits 1. Assertion: built-in step is NOT invoked (no fall-back), `done` event has `success: false`, `build/post` still fires. (vitest + smoke in H4.)
3. **Optional 3p module deactivated; project hook against its namespace.** Project `acme-firebase/before-swap` registered; `acme-firebase` not installed. Assertion: session boots cleanly, registration marked `orphaned`, one-time warn at session boot, fire is silently skipped. (vitest in H5.)
4. **Profile with `env: { LD_PRELOAD: 'evil' }` reaches a hook spawn.** Assertion: `validateProfile` rejects BEFORE the hook spawn — RPC reply `{ code: "E_RPC_INVALID_PAYLOAD" }`. Hook subprocess never starts. (vitest mirroring [src/daemon/__tests__/session-boot.test.ts:212](../../src/daemon/__tests__/session-boot.test.ts:212).)
5. **Path-traversal symlink bypass.** Project hook script `./bin/x.sh` is a symlink to `../../etc/passwd`. Assertion: `realpathSync` + prefix check rejects with `E_HOOK_PATH_OUTSIDE_PROJECT` at config-load — session does NOT boot. (vitest in H1.)

## Acceptance Criteria

### Functional Requirements

- [ ] `provides.hooks` and `consumes.hooks` fields added to manifest schema; loader rejects unknown slot names with `E_HOOK_NAME_UNDECLARED`.
- [ ] `@rn-dev/config` workspace ships `defineConfig` + types + JSON schema; published as workspace package.
- [ ] `rn-dev config init` scaffolds a starter `rn-dev.config.ts` with examples.
- [ ] HookManager dispatches in-process and subprocess hooks via a single registry keyed on `<module-id>/<hook-name>`.
- [ ] Builder, CleanManager, MetroManager, DevToolsManager, PreflightEngine all wrapped as built-in-privileged modules with manifests declaring their hook namespaces.
- [ ] `session` built-in module owns `session/init` and `session/profile-changed` in v1; `session/shutdown` declared in the namespace but deferred until a consumer asks.
- [ ] `build/pre` from a project `rn-dev.config.ts` fires before `Builder.build()` invocation in the daemon's `builder/build` RPC handler.
- [ ] Override hooks (`<module-id>/custom`) replace built-in step body; `pre`/`post` around the override still fire.
- [ ] 3p override-hook registrations require explicit project opt-in via `allowModuleOverrides`; bypass attempts rejected with `E_HOOK_OVERRIDE_NOT_PERMITTED`.
- [ ] MCP tools `rn-dev/hooks-list` (with `?include=history` filter — collapses former standalone `hooks-history`), `rn-dev/hooks-run`, `rn-dev/hooks-last-status`, `rn-dev/hooks-diagnose` registered.
- [ ] Audit log gains `kind: "hook"` variant; failures and override-hook registrations always audited; successful additive runs not audited.

### Non-Functional Requirements

- [ ] Hook subprocess timeout reaps the entire process group (no orphaned grandchildren).
- [ ] Hook stdin payload passes profile via JSON-line + structured env vars; never via argv.
- [ ] Hook stdout parser drops `__proto__` / `constructor.prototype` keys silently (prototype-pollution guard).
- [ ] Hook script paths resolved via `realpathSync` + prefix check against `projectRoot` (or module package root for 3p hooks).
- [ ] No `any` / `unknown` in production code; runtime parsers narrow at the boundary mirroring [parseSubscribePayload](../../src/daemon/index.ts:653).
- [ ] `build/pre`-to-`build`-start latency for a trivial hook fixture under 500ms.
- [ ] stderr from a fork-bombed hook rate-limited at 10 KB/s; truncated with `[truncated]` marker.

### Quality Gates

- [ ] H0–H7 each: vitest run green; tsc clean across `src/` and `electron/tsconfig.json`.
- [ ] H2, H3, H4, H5: Playwright fake-boot smoke green AND `REAL_BOOT_SMOKE=1 npx playwright test` green (per [test_strategy_gap memory](file:///Users/martincouso/.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/test_strategy_gap.md)).
- [ ] H6: GUI MCP-call test asserts hook list renders.
- [ ] `tests/electron-smoke/perf.spec.ts` green under `PERF_GATE=1` for the budgets in the Enhancement Summary's "Performance budget" section.
- [ ] No `--no-verify` / `--no-gpg-sign` commits.

### TypeScript Quality Gates

- [ ] No `phase: string` anywhere. All slot references use `\`${string}/${string}\`` template-literal type.
- [ ] No `payload: unknown` outside the parser. `HookManager.fire<S extends keyof HookContracts>` enforces typed payloads at the boundary.
- [ ] `expectTypeOf<ModuleManifest>().toMatchTypeOf<FromSchema<typeof manifestSchema>>()` passes in the H0 lockstep CI test.
- [ ] `defineConfig` typo for `'build/before'` (instead of `'build/pre'`) fails to compile when project imports the daemon's `BuiltInModules` type.
- [ ] `@rn-dev/config` ships with `"sideEffects": false` and exports map; bundle size < 5KB minified.

## Success Metrics

- A consuming acme-style team can paste a single `rn-dev.config.ts` registering `build/pre`, `clean/post`, `metro/post-start` hooks and have them fire correctly on the next `rn-dev start` (measured manually against the acme-mobile-app fixture in [docs/.../environment_setup.md](file:///Users/martincouso/.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/environment_setup.md)).
- Time-to-first-hook-fire for a fresh project (`npm install rn-dev-cli` → `rn-dev config init` → paste config → `rn-dev start` → hook runs) under 5 minutes for someone reading the docs cold.
- Zero regressions in the existing module-system test suite — hook registry sits alongside the module-host without disrupting it.
- Audit log volume per session unchanged for sessions with no hook failures (success path is silent by policy).

## Dependencies & Prerequisites

- Bun 1.3.13+ (per the per-machine setup memory). Required at runtime for `rn-dev.config.ts` dynamic import.
- Node 22.17.0+ (per `.node-version` pin).
- Existing module-host machinery from Phases 0–13 of the [module system plan](2026-04-21-feat-module-system-and-device-control-plan.md) — H1 lifts spawn primitives from it.
- Existing audit log infrastructure ([src/core/audit-log.ts](../../src/core/audit-log.ts)).
- Existing `built-in-privileged` carve-out at [src/core/module-host/manager.ts:235](../../src/core/module-host/manager.ts:235).
- Existing `validateProfile` security boundary ([src/daemon/profile-guard.ts](../../src/daemon/profile-guard.ts)).

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Hook subprocess fork-bomb | Low | High (resource exhaustion) | Process-group group-kill on timeout. Documented as known limitation; rlimit-via-prlimit on Linux is a v2 ask. |
| 3p module hijacks build via override | Low (gated) | High | `allowModuleOverrides` opt-in. Override registrations always audited. |
| Path-traversal via symlink | Medium (acme-style repos use symlinks heavily) | High | `realpathSync` + prefix check at config-load. |
| Stale `consumes.hooks` reference after target rename | Medium | Low | Hard-fail at config-load with `did-you-mean` Levenshtein suggestion. Inactive optional targets are soft-skip. |
| `customBuild` hook crashes mid-execution, leaves Builder in inconsistent state | Low | Medium | Synthesize `done { success: false }`. Builder concurrency guard prevents second build from starting. `post` hook fires for cleanup. |
| Hot-path latency from registry dispatch | Medium | Low | In-process built-ins bypass JSON serialization. 3p hooks are subprocess; latency is dominated by fork+exec, not by registry overhead. Profile if measured >5ms registry overhead per fire. |
| Hook config drift between dev (Bun) and CI (Node) | Medium | Medium | `pickDaemonInterpreter` already handles bun/node split. `@rn-dev/config` workspace is pure types + identity helper — works under both. Document as part of H7 guide. |
| Daemon shutdown delayed by long `session/shutdown` hook | Low | Medium | Default `timeoutMs: 3000` for shutdown hooks; no retry; `onFail: 'warn'`. Documented. |
| **Daemon SIGKILL leaves hook process group as zombie** (kernel doesn't run dispose path) | Medium | High | Hook orphan-sweep at next daemon boot scans for stray groups via `RN_DEV_HOOK_PGID` sentinel + SIGKILLs them; Linux uses `setpriv --pdeathsig SIGKILL`. macOS = best-effort sweep only. Mirrors [src/daemon/orphan-sweep.ts](../../src/daemon/orphan-sweep.ts) for modules. Test in H1. |
| **Module-host vs hook-host shutdown handler race** ([manager.ts:221-223](../../src/core/module-host/manager.ts:221) `process.exit`/`SIGINT`/`SIGTERM`) | Medium | High | HookManager registers via `process.once('SIGTERM', …)` with explicit ordering: module-host first (drains JSON-RPC), HookManager second (drains hook subprocesses), AuditWriter last. Document ordering invariant in `src/core/spawn-utils.ts`. |
| **Multi-daemon concurrent audit-log fire** under [active-daemon registry](../../src/daemon/registry.ts) | High (3+ worktrees is acme norm) | Medium | Audit log already uses HMAC-chained fcntl-locked writes; H1 adds explicit lock-fairness assertion in perf spec under 4-daemon `build/pre` contention. |
| **`@rn-dev/config` version skew** (project pinned 1.0.0, daemon ships 2.0.0 with breaking type changes) | Medium | High | Version-handshake at boot — daemon reads config package's `package.json` version, rejects with `E_HOOK_CONFIG_INVALID { cause: 'version-mismatch', expected, got, migrationDoc }`. Mirrors [PR #25 version handshake](https://github.com/anthropics/rn-dev-cli/pull/25). |
| **Hook script unreadable mid-session** (`chmod 000`, `rm`, fs unmount) | Low-medium | Medium | Path TOCTOU re-check (line 318) covers mutation; `fs.accessSync(path, R_OK \| X_OK)` at fire-time covers readability; on `EACCES`/`ENOENT` → `E_HOOK_FAILED { outcome: "script-unreadable" }`. |
| **Slow `rn-dev.config.ts` dynamic import blocks daemon boot** (network-bound module) | Medium | High (boot timeout) | 5s wall-clock timeout on initial `import("./rn-dev.config.ts")`; on timeout → `E_HOOK_CONFIG_INVALID { cause: 'config-load-timeout' }`; daemon boots with empty registry + one-time warn. |
| **`allowModuleOverrides` typo silently strips** (schema `additionalProperties: false`) | Medium | Medium | `defineConfig` validates known top-level keys at import time; unknown key → log warn `[rn-dev] ignored unknown config key 'allowModuleOverride' — did you mean 'allowModuleOverrides'?` (Levenshtein-1 suggestion). |
| **Hook script needs Bun, project on plain Node — `ENOENT` confusion** | Medium | Low | Wrap spawn errors: on `ENOENT` of the interpreter, raise `E_HOOK_INTERPRETER_MISSING { interpreter, hint: 'install bun or use a Node-compatible script' }` instead of letting the kernel error bubble. |
| **Old daemon reads new manifest with `provides.hooks`/`consumes.hooks`** | Medium | High (uninstallable) | Mandate `host-version-range >= <plan's host minor>` on every hook-bearing manifest; manifest validator emits `E_HOST_RANGE_REQUIRED` if missing. Old daemons reject with clear "host too old" error rather than silent strip. (todo #005) |
| **3p override module rebrand silently shadows** (`allowModuleOverrides: ['acme-firebase']` after rename to `@acme/firebase`) | Low | Medium | If `allowModuleOverrides` lists an ID with no matching active module, emit `hooks/orphaned` event + warn at session boot, parity with orphaned `consumes.hooks` references. |

## Resource Requirements

- 8 single-session phases (H0–H7), each sized for ~1 day of work. Sequential because of dependencies (H2 depends on H0+H1; H3 on H2; H4 on H3; H5 on H1+H4; H6 on everything; H7 ties off).
- No external infrastructure (no marketplace API changes, no registry changes).
- No additional dependencies beyond the existing workspace stack.

## Future Considerations

- **`watcher/on-change` hook** — supersedes the existing [OnSaveAction](../../src/core/types.ts:28) surface. Migration helper ships in H7; the hook itself is a follow-up plan.
- **SHA-pinned hook script integrity** — opt-in `sha256` field on hook entries for paranoid teams. Not in v1 because `@npmcli/arborist --ignore-scripts` already covers the npm-postinstall vector for 3p modules.
- **DAG hook scheduling / parallel fan-out** — current dispatch is serial within a `(moduleId, hookName)` tuple. A future `parallel: true` opt-in could fan out independent registrations against the same target.
- **Cross-language hooks (native-binding API)** — v1 hooks are any executable with the JSON-line stdio contract. A future native-binding API for hot-path hooks is out of scope.
- **Hook artifact persistence** — hook `result.data` is event-only in v1. A future `fs:artifacts`-permission-scoped persistence path is out of scope.
- **Hot-reload of `rn-dev.config.ts`** — not in v1 (per Alternative E). Future work could add it via the existing FileWatcher infrastructure.

## Documentation Plan

- [docs/guides/hook-system.md](../guides/hook-system.md) — primary user guide. Covers the contribution-point model, project config shape, manifest fields, error catalog, security posture, examples.
- [docs/guides/onSaveAction-migration.md](../guides/onSaveAction-migration.md) — declared in H7; full implementation in a follow-up plan.
- `examples/firebase-swap/` — acme-style env-driven Firebase config swap. Full project skeleton.
- `examples/local-package-link/` — acme's `--use-local-packages` workflow. Hook registers against `pre-install` (placeholder until a future `install` built-in module).
- `@rn-dev/config` package README — `defineConfig` API + JSON schema link.
- `@rn-dev/module-sdk` README update — `provides.hooks` + `consumes.hooks` documentation; `runHookInProcess` + `MockHookRuntime` test helpers.

## What we are NOT doing

- **Sandboxing.** Hooks run with the developer's terminal privileges. Trust model: "you authored these scripts." Same posture as acme's `bin/` and as the existing `OnSaveAction` surface. The defense is curated registry + subprocess isolation for 3p modules + consent dialogs + the audit log — unchanged from Phase 6 of the module system.
- **Hot-reload of `rn-dev.config.ts`.** Daemon restart required. Matches `vite.config.ts` ergonomics.
- **Distribution of hook scripts via npm.** Project hooks travel with the repo; module hooks travel with the module npm package. Standalone "hook packages" are out of scope.
- **YAML / JSON config files.** TypeScript-only for type safety + IDE autocomplete.
- **Per-line / per-frame / per-event hooks** (performance finding 2 — explicit guardrail). No `metro/log`, no `devtools/cdp-frame`, no `builder/line` hook namespace. Streaming surfaces are subscribe-only via `events/subscribe`. A future PR adding `metro/log` looks innocent and silently adds unbounded fan-out cost — the rule is here to block that PR review.
- **`Bun.Transpiler`-based config compile under plain Node.** Daemon under Node receives an `E_HOOK_RUNTIME_BUN_REQUIRED` error if a `.ts` config is encountered. Production-distributed bundles already compile via `bun build`; the dev path requires Bun anyway. Node 22 LTS does NOT have stable `--experimental-strip-types`; Node 23 does — a future minor can flip support when the project's pinned Node bumps.
- **Hook discovery beyond explicit registration.** No "scan the project for `bin/*.sh` and auto-wire them" — every hook is named in either `rn-dev.config.ts` or a module manifest.
- **Telemetry / metrics export.** Audit log is the durable record; Prometheus / OpenTelemetry export is out of scope.
- **Multi-project hooks.** One config per project root. A monorepo with multiple RN apps gets multiple config files, one per app dir.
- **Pre-Phase-13.5 back-compat shims.** Plan assumes the daemon model. Older session/start callers go through the existing pre-13.5 path.
- **`OnSaveAction` deprecation in this plan.** Stays alongside hooks. Migration helper ships in H7; full deprecation is a follow-up.
- **Cross-language hook contracts.** v1 hook scripts are any executable with the JSON-line stdio contract. No native-binding API.
- **Hook DAG / parallel fan-out.** Serial within `(moduleId, hookName)` in v1. Parallel opt-in is a follow-up.
- **`Bun.Transpiler`-based config compile under plain Node.** Daemon under Node receives an `E_HOOK_RUNTIME_BUN_REQUIRED` error if a `.ts` config is encountered. Production-distributed bundles already compile via `bun build`; the dev path requires Bun anyway.
- **Hook artifact persistence beyond the audit log.** Result data is event-only.

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-04-29-acme-dev-cli-research.md](../brainstorms/2026-04-29-acme-dev-cli-research.md). Key decisions carried forward:
  - Two extension surfaces, one runtime (project + 3p modules) — refined to per-module contribution points (settled mid-planning).
  - Subprocess flavor with JSON-line stdio contract (§6.4).
  - Per-phase `onFail` semantics with retry/warn/hard (§6.5).
  - Audit log policy (failures + override registrations only) (§6.7).
  - Hooks share the module-host's process-group spawning, audit logging, and capability registry (§6.6 — refined to "share the manifest contract; built-ins run in-process").
  - Non-goal: sandboxing (§6.6).

### Internal References

- Existing module system plan: [docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md](2026-04-21-feat-module-system-and-device-control-plan.md).
- Module host manager: [src/core/module-host/manager.ts](../../src/core/module-host/manager.ts) — spawn primitives, `built-in-privileged` carve-out at lines 235-239.
- Daemon RPC dispatch: [src/daemon/client-rpcs.ts](../../src/daemon/client-rpcs.ts) — `builder/build` handler at lines 130-137.
- Builder: [src/core/builder.ts](../../src/core/builder.ts) — concurrency guard at lines 64-78.
- Profile validation: [src/daemon/profile-guard.ts](../../src/daemon/profile-guard.ts) — `validateProfile`, `checkAbsolutePath`, `checkEnv`.
- Subscribe payload parser idiom: [src/daemon/index.ts:653](../../src/daemon/index.ts:653) — `parseSubscribePayload` shape to mirror.
- Audit log: [src/core/audit-log.ts](../../src/core/audit-log.ts) — `AuditEntryInput` discriminated union to extend.
- Manifest SDK: [packages/module-sdk/](../../packages/module-sdk/) — `manifest.schema.json`, `define-module.ts`, `errors.ts`.
- Existing fixture: [tests/electron-smoke/fixtures/smoke-rn/](../../tests/electron-smoke/fixtures/smoke-rn/) — pattern to mirror for `smoke-rn-with-hooks`.
- Test strategy gap memory: real-boot smoke is the merge gate for daemon-protocol PRs.

### External References

- vscode-jsonrpc — used by 3p module subprocess RPC. Hook subprocess runner uses lighter JSON-line framing instead.
- Bun runtime dynamic import — `await import("./rn-dev.config.ts")` works directly under Bun.
- `@npmcli/arborist --ignore-scripts` — existing 3p module install posture; hook system inherits.

### Related Work

- Phase 13.6 PR-C (multiplexed daemon channel) — recently merged ([commit ff230b0](https://github.com/anthropics/rn-dev-cli/commit/ff230b0)).
- Recent merges (PR-C aftermath) — [PRs #24, #25, #28, #29](https://github.com/anthropics/rn-dev-cli/pulls?q=is%3Amerged+sort%3Aupdated-desc).
