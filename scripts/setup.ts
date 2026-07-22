#!/usr/bin/env bun
// One-command machine setup for rn-dev.
//
// Usage:
//   bun scripts/setup.ts [--app /path/to/rn-app]...
//
// What it does, in order:
//   1. `bun install` at the repo root (workspaces cover packages/* + modules/*).
//   2. `npm install` in renderer/ (the renderer keeps its own npm tree).
//   3. `bun run build` — host CLI + daemon + compiled Electron main to dist/.
//   4. Builds every module workspace that ships a rn-dev-module.json.
//   5. Symlinks each module into ~/.rn-dev/modules/<id> (the daemon's
//      discovery dir — see src/modules/registry.ts scanUserGlobalModules).
//   6. For each --app: registers the rn-dev MCP server for that project in
//      Claude Code (local scope, via `claude mcp add`), unless already present.
//
// Idempotent: installs and builds re-run (cheap when warm — deliberately not
// skipped, stale installs have burned us before), correct symlinks are left
// alone, existing MCP registrations are never clobbered.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface SetupArgs {
  apps: string[];
  help: boolean;
}

export function parseSetupArgs(argv: string[]): SetupArgs {
  const args: SetupArgs = { apps: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--app") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--app requires a path argument");
      }
      args.apps.push(value);
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg} (see --help)`);
    }
  }
  return args;
}

export type LinkAction =
  | { kind: "create" }
  | { kind: "skip"; reason: string }
  | { kind: "replace"; from: string }
  | { kind: "warn-skip"; reason: string };

/**
 * Decide what to do with ~/.rn-dev/modules/<id> given what's already there.
 * Real directories are never touched — they may be a marketplace install or
 * hold per-module config.json; replacing them is a data-loss hazard.
 */
export function decideLinkAction(
  linkPath: string,
  targetDir: string,
): LinkAction {
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return { kind: "create" };
  }
  if (stat.isSymbolicLink()) {
    let current: string;
    try {
      current = realpathSync(linkPath);
    } catch {
      // Dangling symlink — replace it.
      return { kind: "replace", from: "<dangling>" };
    }
    if (current === realpathSync(targetDir)) {
      return { kind: "skip", reason: "already linked" };
    }
    return { kind: "replace", from: current };
  }
  return {
    kind: "warn-skip",
    reason: `${linkPath} exists and is not a symlink (marketplace install or config dir?) — leaving it alone`,
  };
}

export interface DiscoveredModule {
  id: string;
  dir: string;
}

/** Every modules/* workspace that ships a rn-dev-module.json manifest. */
export function discoverModules(root: string): DiscoveredModule[] {
  const modulesDir = join(root, "modules");
  const found: DiscoveredModule[] = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(modulesDir, entry.name);
    const manifestPath = join(dir, "rn-dev-module.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      id?: string;
    };
    if (typeof manifest.id !== "string" || manifest.id.length === 0) {
      throw new Error(`${manifestPath} has no "id" field`);
    }
    found.push({ id: manifest.id, dir });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function run(command: string, args: string[], cwd: string): void {
  console.log(`\n$ ${command} ${args.join(" ")}  (${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function commandExists(command: string): boolean {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function registerMcp(appPath: string, warnings: string[]): void {
  const app = resolve(appPath);
  if (!existsSync(join(app, "package.json"))) {
    warnings.push(`--app ${app}: no package.json there — skipped MCP registration`);
    return;
  }
  if (!commandExists("claude")) {
    warnings.push(
      `--app ${app}: \`claude\` CLI not found — register manually:\n` +
        `    cd ${app} && claude mcp add rn-dev -- ${process.execPath} ${join(repoRoot, "dist/index.js")} mcp`,
    );
    return;
  }
  const existing = spawnSync("claude", ["mcp", "get", "rn-dev"], {
    cwd: app,
    stdio: "ignore",
  });
  if (existing.status === 0) {
    console.log(`  ${app}: rn-dev MCP server already registered — skipped`);
    return;
  }
  run(
    "claude",
    ["mcp", "add", "rn-dev", "--", process.execPath, join(repoRoot, "dist/index.js"), "mcp"],
    app,
  );
}

const HELP = `rn-dev machine setup

Usage: bun scripts/setup.ts [--app /path/to/rn-app]...

Options:
  --app <path>   RN app repo to register the rn-dev MCP server for
                 (Claude Code local scope). Repeatable — pass once per
                 worktree. Omit to skip MCP registration.
  -h, --help     Show this help.
`;

function main(): void {
  const args = parseSetupArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (process.platform === "win32") {
    throw new Error("setup.ts supports macOS/Linux only (symlink layout)");
  }
  if (!commandExists("bun")) {
    throw new Error("bun is required — install from https://bun.sh first");
  }

  const warnings: string[] = [];

  console.log("── 1/6 install root dependencies");
  run("bun", ["install"], repoRoot);

  console.log("\n── 2/6 install renderer dependencies");
  run("npm", ["install"], join(repoRoot, "renderer"));

  console.log("\n── 3/6 build host (CLI + daemon + Electron main)");
  run("bun", ["run", "build"], repoRoot);

  console.log("\n── 4/6 build modules");
  const modules = discoverModules(repoRoot);
  for (const mod of modules) {
    run("bun", ["run", "build.ts"], mod.dir);
  }

  console.log("\n── 5/6 link modules into ~/.rn-dev/modules");
  const linkRoot = join(homedir(), ".rn-dev", "modules");
  mkdirSync(linkRoot, { recursive: true });
  for (const mod of modules) {
    const linkPath = join(linkRoot, mod.id);
    const action = decideLinkAction(linkPath, mod.dir);
    switch (action.kind) {
      case "create":
        symlinkSync(mod.dir, linkPath);
        console.log(`  ${mod.id}: linked → ${mod.dir}`);
        break;
      case "replace":
        unlinkSync(linkPath);
        symlinkSync(mod.dir, linkPath);
        console.log(`  ${mod.id}: re-linked (was ${action.from}) → ${mod.dir}`);
        break;
      case "skip":
        console.log(`  ${mod.id}: ${action.reason}`);
        break;
      case "warn-skip":
        warnings.push(`${mod.id}: ${action.reason}`);
        break;
    }
  }

  console.log("\n── 6/6 register MCP server for app repos");
  if (args.apps.length === 0) {
    console.log("  no --app given — skipped (re-run with --app <path> to register)");
  } else {
    for (const app of args.apps) registerMcp(app, warnings);
  }

  console.log("\n✔ setup complete");
  console.log(`  modules linked: ${modules.map((m) => m.id).join(", ")}`);
  if (warnings.length > 0) {
    console.log("\n⚠ warnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log(`
Next steps:
  - Launch the GUI:            cd ${repoRoot} && npm run dev:gui
  - Verify modules load:       cd <your-app> && bun ${join(repoRoot, "dist/index.js")} module list
  - Restart any open Claude Code sessions in the app repo to pick up the MCP server.
`);
}

if (import.meta.main) {
  main();
}
