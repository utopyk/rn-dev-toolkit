# Brainstorm: Third-Party Module System + Device Control (first 3p module)

**Date:** 2026-04-21
**Status:** Brainstorm — ready for `/workflows:plan`

## What We're Building

Two things, co-developed:

1. **A third-party module system** for the RN dev toolsuite. Modules are npm packages that declare capabilities via a manifest and contribute **MCP tools (required)**, **Electron UI (required)**, and **Terminal TUI panels (optional)**. Modules run in their own subprocesses and talk to the host over a typed RPC bridge. A built-in **Marketplace module** discovers modules from a curated GitHub-hosted `modules.json` and installs them with a permission-consent dialog.

2. **The first third-party module: `@rn-dev-modules/device-control`.** An open-source, agent-native, Maestro-inspired module for driving **Android emulators** (v1 platform scope). Exposes MCP tools as primitives the agent composes (screenshot, accessibility tree, tap, swipe, type, launch app, logs) plus a flow-recording feature that produces replayable artifact files. Lives in its own npm package from day one to dogfood the 3p contract.

**Target users.** RN developers driving their dev loop through agents (MCP) and a GUI (Electron), plus module authors who want to extend the toolsuite without forking it.

**Non-goals for v1.**
- iOS Simulator, physical Android, physical iOS (v2+)
- Full Maestro YAML DSL compatibility (primitives + recorded flows only)
- Paid/signed modules, ratings, analytics (v2+)
- Workspace-scoped install (v2+)
- Manifest-declared capabilities enforced by a runtime sandbox (v1 treats manifest permissions as advisory + consent UI; subprocess isolation is the enforcement)

## Why This Approach

The toolsuite already has a "module" abstraction (`RnDevModule` in `src/core/types.ts`) but it's Ink-only — MCP tools and Electron views are hardcoded. The `DevTools Network` agent-native feature currently underway is hand-wiring the three-surface pattern for a first-party module; generalizing that pattern *is* this brainstorm.

Two forces shape the design:

- **Agent-native is the core value prop.** MCP is the primary contract; the Electron UI is the secondary consumer of the same module. That's why MCP is required and TUI is optional, and why the MCP server can spawn module subprocesses standalone (no GUI required for headless/CI use).
- **Third-party code is a trust boundary.** A marketplace of modules from arbitrary authors demands (a) isolation (subprocess per module), (b) declared permissions visible at install time, and (c) a curated registry to raise the floor. This maps onto proven industry patterns (VSCode extensions, Chrome DevTools extensions, Figma plugins) rather than novel ones.

**Sequencing: co-evolved monorepo.** Host, `@rn-dev/module-sdk`, and `@rn-dev-modules/device-control` live together (bun workspaces). The SDK shape is driven by what a real module needs — not a speculative spec. The Marketplace starts as a read-only browser over `modules.json` with a copy-paste install command; the GUI install + consent dialog lands in the next slice.

## Key Decisions

| Area | Decision | Rationale |
|---|---|---|
| Required surfaces | Electron + MCP required; TUI optional | Agent-native first; GUI is the primary user surface. TUI is a power-user bonus. |
| Distribution | npm packages + curated `modules.json` on GitHub | Zero ops; PR-based moderation; low friction for authors. |
| Manifest | Declarative-only (`rn-dev-module.json`) | VSCode-style `contributes` + `activationEvents` + `permissions`. Enforcement via consent UI + subprocess isolation, not runtime capability API. |
| Electron UI | Webview panels + simple declarative slots | Matches VSCode/Chrome DevTools/Figma industry pattern. Runtime-installable without host rebuild. Declarative slots (sidebar icon, status badge) handle simple contributions. |
| Process model | Subprocess per module (Extension Host style) | Crash isolation, security boundary, clean lifecycle for long-running device streams. |
| MCP runtime | MCP server spawns the subset of module subprocesses whose tools are used | Works headless (CI, pure-MCP agents). Same spawn code as the GUI host. |
| Activation | Always-on in GUI, lazy (per activation event) in MCP-only mode | Pragmatic: interactive users want zero latency; agents can tolerate first-call spawn. |
| Install scope | User-global default (`~/.rn-dev/modules/`), per-project override via `package.json#rn-dev.plugins` | VSCode-style DX + project escape hatch. |
| Registry | GitHub repo with `modules.json` | Zero ops, accountable via GitHub, easy to fork/mirror. |
| Author SDK | Split: `rn-dev-module.json` + entry code from `@rn-dev/module-sdk` | Matches VSCode. Static manifest enables cheap tool-discovery without spawning the module. |
| Install trust | Electron install flow shows declared permissions + Install/Cancel dialog | Visible consent at install time. Permissions are advisory but surfaced. |
| Device Control platforms (v1) | Android Emulator **and iOS Simulator** | Both simulator targets cover the typical RN dev workflow. Physical devices deferred to v2. |
| Device Control API | Primitives + recorded flows in **both** canonical JSON and Maestro-compatible YAML export | Agents compose primitives. Flows readable/writable by humans and agents. JSON is the source of truth; YAML is an export facade for Maestro corpus compatibility. |
| Device Control packaging | Standalone npm package from day one | Forces the 3p contract to be real; no quiet coupling to host internals. |
| Marketplace module kind | **Privileged built-in, always on** | Avoids the bootstrap paradox. Honest about its host-level permissions. |
| Module scope | Manifest declares `scope: "global" \| "per-worktree"` | Device Control is global (one ADB/simctl daemon per user). Metro/DevTools remain per-worktree. Host spawns one subprocess per scope unit. |
| Electron embedding tech | `<webview>` for all module panels | Consistent with existing `DevToolsView.tsx`/Fusebox pattern. Strong isolation, good video decode perf. |
| Module ↔ module | **Hybrid**: manifest `uses: [...]` for host-brokered RPC capability access; MCP tools remain the agent-facing composition surface | E2E/tutorial modules can call Device Control's RPC directly (typed, rich subscriptions, panel reuse). Agents compose via MCP tools. Dependencies appear in install consent dialog. |
| Module storage | Private namespace `~/.rn-dev/modules/{id}/data/` free; shared ArtifactStore via `permissions: ['fs:artifacts']` | Browser/OS-style. Most modules never need shared access. |
| Sequencing | Co-evolved monorepo (Approach A) | SDK shaped by real module needs; end-to-end demo earliest. |

## Architecture Sketch (to inform the plan)

```
rn-dev-cli/                               (monorepo root, bun workspaces)
├── host/                                 (current src/ + electron/ + renderer/)
│   ├── src/core/module-host/             NEW: subprocess manager, IPC bridge
│   ├── src/core/module-registry.ts       EXTEND existing registry.ts: manifest load, permission check, activation events
│   ├── src/mcp/server.ts                 CHANGE: spawn needed module subprocesses, proxy ListTools/CallTool
│   ├── renderer/marketplace/             NEW: built-in marketplace panel (browse + install)
│   └── electron/webview-bridge.ts        NEW: host <-> module webview postMessage RPC
├── packages/
│   └── module-sdk/                       NEW: @rn-dev/module-sdk
│       ├── manifest.schema.json          JSON Schema for rn-dev-module.json
│       ├── types.ts                      Module author types (McpTool, ElectronPanel, Lifecycle)
│       └── host-rpc.ts                   Typed RPC client modules use to call host capabilities
└── modules/
    └── device-control/                   NEW: @rn-dev-modules/device-control (first 3p)
        ├── rn-dev-module.json            Manifest: id, version, hostRange, contributes, permissions, activationEvents
        ├── src/index.ts                  Activate, register tools, expose panel URL
        ├── src/android/{adb,uiautomator,screenshot,input}.ts
        ├── renderer/                     Tiny Vite bundle → webview HTML
        └── flows/                        Recorded flow artifact format
```

Design points the plan must resolve:

- **Manifest schema** — fields for `contributes.mcp.tools[]` (name, description, inputSchema), `contributes.electron.panels[]` (id, title, icon, webviewEntry), `contributes.tui.views[]`, `permissions[]` (adb, net:port, fs:path, exec:binary), `activationEvents[]` (`onStartup`, `onMcpTool:*`, `onElectronPanel:*`, `onWorktreeOpen`).
- **Module RPC protocol** — likely JSON-RPC 2.0 over stdio (host→module) and postMessage (module webview→host). Define `host.capabilities` (metro state, profile store, artifact store, log emitters the module can read/subscribe to).
- **Migration of existing built-in modules** — `dev-space`, `metro-logs`, `lint-test`, `settings`, and the upcoming `devtools-network` stay built-in (in-process, privileged) but SHOULD be expressible in the same manifest-driven shape so there's one conceptual model. Extraction is optional later.
- **Service Bus generalization** — today typed to `metro/builder/watcher/worktreeKey`. Needs to accept module-contributed topics (namespaced by module id) without becoming untyped.
- **Permission enforcement philosophy** — manifest permissions are (a) surfaced to the user at install, (b) NOT sandboxed by the subprocess runtime in v1 (Node has no built-in perm model). Subprocess isolation covers crashes + port scoping; strict capability-gating is a v2 concern.
- **Host SDK versioning** — `hostRange` in manifest; host refuses to activate modules outside the range. Deprecation policy: minor-version SDK additions, major-version breaking changes.

## Validation Strategy

The Device Control module is the contract validator:

1. If we can't implement a useful Device Control module against the SDK, the SDK is wrong.
2. If Device Control needs to reach around the SDK into host internals, the SDK is incomplete — add capabilities, don't break the contract.
3. Record two canonical agent flows early ("log in to sample RN app", "tap through onboarding") as replay artifacts; these double as E2E tests for the module system itself.

## Resolved Questions

1. **Marketplace module identity** → **Privileged built-in, always on.** Lives in-host; can't be uninstalled.
2. **Webview embedding** → **`<webview>` for all module panels**, matching `DevToolsView.tsx`.
3. **Flow recording format** → **Both canonical JSON + Maestro YAML export.** JSON is source of truth; YAML is export for Maestro corpus compatibility.
4. **Storage access** → **Private namespace free, shared ArtifactStore permission-gated** (`permissions: ['fs:artifacts']`).
5. **Multi-worktree semantics** → **Manifest declares `scope: 'global' | 'per-worktree'`.** Device Control is global; Metro/DevTools-style modules are per-worktree.
6. **v1 platform scope** → **Android Emulator + iOS Simulator.** Physical devices deferred to v2.
7. **Module dependencies** (new, surfaced during brainstorm) → **Hybrid**: manifest `uses: [...]` grants host-brokered RPC access for rich in-module composition; MCP tools remain the agent-facing composition surface.

## Open Questions (for the plan to resolve)

- **Manifest JSON Schema** — final field list for `contributes`, `permissions`, `activationEvents`, `uses`, `scope`, `hostRange`.
- **Host ↔ module RPC protocol** — JSON-RPC 2.0 over stdio is the likely choice; confirm during plan phase.
- **Existing built-in module migration** — `dev-space`, `metro-logs`, `lint-test`, `settings`, `devtools-network` stay built-in but should adopt the same manifest shape for conceptual unity. Extraction is optional.
- **ServiceBus generalization** — currently typed for fixed topics; needs module-namespaced topics without losing type safety.
- **SDK versioning policy** — `hostRange` semver behavior, deprecation windows, minor/major SDK changes.
- **Device mirror transport** — how to stream the emulator frame buffer into the webview efficiently (WebRTC, MJPEG, raw frames?). Implementation detail for the Device Control plan, not the module system plan.
