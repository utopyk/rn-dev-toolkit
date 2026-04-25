# rn-dev-cli — Claude / agent guidance

React Native developer toolsuite. Terminal TUI (OpenTUI/Ink-style), Electron GUI, and an MCP server share one core. This file documents conventions so agents match the project's style on first try.

## Repo shape

- **Monorepo via bun workspaces.** Workspaces: `packages/*` (SDKs and libraries) and `modules/*` (third-party-packaged modules).
- Host code lives at the repo root: `src/` (core + TUI), `electron/` (main/preload/IPC), `renderer/` (Electron renderer React app).
- Docs live under `docs/{brainstorms,plans,solutions}/`. Filename convention: `YYYY-MM-DD-<topic>.md`.

## Conventions

- **TypeScript, ESM, NodeNext-style**. Relative imports use `.js` extension (even though source is `.ts`), per ESM NodeNext rules.
- **No `any`, no `unknown`** in production code unless you have a specific reason and a comment explaining it. The single existing escape hatch is in `src/app/service-bus.ts` — match that style if another is truly needed.
- **Colocated tests** under `src/**/__tests__/*.test.ts`. Don't create a top-level `tests/` directory.
- **Test runner: `vitest run`** (not `bun test`). `bun test` has issues with `vi.mock`; `npm test` / `npm run test` now runs vitest.
- **Build: `bun run build`** (uses `build.ts` with Bun's native bundler). The older `esbuild.config.ts` was deleted in Phase 0 of the module-system work — use `build.ts`.
- **Commits: Conventional Commits.** `feat(devtools): ...`, `fix(mcp): ...`, `refactor(electron): ...`, `docs: ...`.

## Verification standard for renderer-touching changes

Every change that touches `renderer/`, `electron/`, or any IPC handler MUST pass three layers before push. The split exists because each layer catches a different bug class — skipping any one of them ships a regression that the next layer would have caught.

1. **`npx vitest run`** — fast (≈25s). Catches TDZ, render crashes, type-narrowing slips, undefined-prop crashes, dispatcher contract drift. Renderer components MUST have a colocated `__tests__/*.test.tsx` that mounts the component in jsdom with a stubbed `window.rndev` IPC bridge. See [renderer/components/__tests__/ModuleConfigForm.test.tsx](renderer/components/__tests__/ModuleConfigForm.test.tsx) for the pattern: stub bridge with `vi.fn()` invoke + a manual `emit()` for IPC events.
2. **`npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json`** — catches type drift in IPC payload shapes that vitest's mocks can paper over.
3. **`npx playwright test`** (alias: `npm run test:smoke`) — slow (≈15-50s). Catches what only surfaces in a real Electron + daemon process pair: IPC handler shape mismatches, daemon spawn failures, boot-window races, "blank screen" tree crashes. The smoke suite at [tests/electron-smoke/smoke.spec.ts](tests/electron-smoke/smoke.spec.ts) boots Electron via `_electron.launch()` against a tmpdir fixture (`tests/electron-smoke/fixtures/smoke-rn`), forces `RN_DEV_DAEMON_BOOT_MODE=fake` so no real Metro is spawned, and asserts each tab (Marketplace, Settings) renders its happy-path content.

Do not push renderer/electron changes without all three green. The pattern of "vitest + tsc green, then ship and discover the renderer goes blank" is the failure mode this rule exists to prevent.

## Module system (in flight)

See [docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md](docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md) for the full plan. Headline rules agents should follow when touching module-related code:

- **Manifest lives at `rn-dev-module.json`** at the module package root (VSCode-style), NOT in `package.json`.
- **Tool-name prefix policy:** built-in modules keep flat namespace (`metro/*`, `devtools/*`, `modules/*`, `marketplace/*`). Third-party modules MUST use `<moduleId>__<tool>` (double underscore). Manifest load rejects non-compliant 3p with `E_TOOL_NAME_UNPREFIXED`.
- **Every module must contribute MCP tools + an Electron UI panel** (TUI views are optional). Agent-native parity: anything a user can do via the GUI, an agent must be able to do via MCP.
- **Modules run as their own Node subprocess** (VSCode Extension Host style). Host spawns via `vscode-jsonrpc` stdio framing.
- **Manifest `permissions[]` are advisory in v1** — surfaced in the install consent dialog, not sandbox-enforced. Subprocess isolation + curated registry + consent UI are the v1 enforcement story.

## Patterns to mirror

- **Per-worktree state machines** follow the `MetroManager` / `DevToolsManager` pattern: `EventEmitter` + `Map<worktreeKey, State>` + explicit state transitions. See [src/core/metro.ts](src/core/metro.ts) and [src/core/devtools.ts](src/core/devtools.ts).
- **ServiceBus** at [src/app/service-bus.ts](src/app/service-bus.ts) is the non-React → React propagation layer. Extend its types when adding new topics rather than introducing a parallel bus.
- **IPC** between MCP server and host uses the JSON-line Unix-domain-socket protocol in [src/core/ipc.ts](src/core/ipc.ts). Module host subprocesses use `vscode-jsonrpc` Content-Length framing instead — don't mix.
- **Electron IPC** is split under `electron/ipc/` (Phase 0.5 split — January 2026). Add new handlers to an appropriate file there; don't revive the god-file pattern.

## Security posture

- Do NOT add runtime `eval`, `Function(string)`, or dynamic `require(userInput)`.
- Module subprocess spawning uses detached process groups (macOS/Linux) or Windows Job Objects — preserve these when editing `src/core/module-host/`.
- `~/.rn-dev/audit.log` is an HMAC-chained append-only log. Modules never write it. Writes go through the host-internal `AuditLog.append()` API only.
- `modules.json` from the registry is SHA-pinned per host release — do not add code that blindly trusts the fetched JSON.
- `@npmcli/arborist` is always configured with `--ignore-scripts` when installing third-party modules.
