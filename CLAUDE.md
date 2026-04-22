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
