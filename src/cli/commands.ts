import { Command } from "commander";
import { detectProjectRoot, getCurrentBranch, getWorktrees } from "../core/project.js";
import { ProfileStore } from "../core/profile.js";
import { CleanManager } from "../core/clean.js";
import { createDefaultPreflightEngine } from "../core/preflight.js";
import { listDevices } from "../core/device.js";
import { IpcClient } from "../core/ipc.js";
import { registerModuleCommands } from "./module-commands.js";
import path from "path";
import gradientString from "gradient-string";
import type { Platform, RunMode } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireProjectRoot(): string {
  const projectRoot = detectProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error("Not inside a React Native project");
    process.exit(1);
  }
  return projectRoot;
}

// ---------------------------------------------------------------------------
// createProgram
// ---------------------------------------------------------------------------

export function createProgram(): Command {
  const program = new Command();

  // Pre-rendered ANSI Shadow figlet — embedded to avoid runtime font file dependency
  const BANNER = [
    "██████╗ ███╗   ██╗      ██████╗ ███████╗██╗   ██╗",
    "██╔══██╗████╗  ██║      ██╔══██╗██╔════╝██║   ██║",
    "██████╔╝██╔██╗ ██║█████╗██║  ██║█████╗  ██║   ██║",
    "██╔══██╗██║╚██╗██║╚════╝██║  ██║██╔══╝  ╚██╗ ██╔╝",
    "██║  ██║██║ ╚████║      ██████╔╝███████╗ ╚████╔╝ ",
    "╚═╝  ╚═╝╚═╝  ╚═══╝      ╚═════╝ ╚══════╝  ╚═══╝  ",
  ].join("\n");

  program
    .name("rn-dev")
    .description("React Native developer CLI")
    .configureOutput({
      writeOut: (str: string) => {
        if (str.trim() === "0.1.0") {
          const gradient = gradientString("cyan", "magenta", "yellow");
          process.stdout.write("\n" + gradient(BANNER) + "\n\n");
          process.stdout.write("  v0.1.0 — React Native Developer CLI\n\n");
        } else {
          process.stdout.write(str);
        }
      },
    })
    .version("0.1.0");

  // Start command — the main entry point
  program
    .command("start")
    .description("Start development session")
    .option("-i, --interactive", "Force interactive wizard")
    .option("-p, --profile <name>", "Load specific profile")
    .option("--worktree <path>", "Specify worktree")
    .option("--platform <platform>", "ios, android, or both")
    .option("--mode <mode>", "dirty, clean, or ultra-clean")
    .option("--port <port>", "Metro port", parseInt)
    .option("--theme <name>", "Theme name")
    .action(async (options) => {
      const { startFlow } = await import("../app/start-flow.js");
      await startFlow(options);
    });

  // Profiles
  program
    .command("profiles")
    .description("List profiles")
    .action(async () => {
      const projectRoot = requireProjectRoot();
      const store = new ProfileStore(
        path.join(projectRoot, ".rn-dev", "profiles")
      );
      const profiles = store.list();

      if (profiles.length === 0) {
        console.log("No profiles found. Run 'rn-dev start -i' to create one.");
        return;
      }

      console.log("\nProfiles:\n");
      for (const p of profiles) {
        const defaultTag = p.isDefault ? " (default)" : "";
        const worktreeTag = p.worktree ? ` [${p.worktree}]` : "";
        console.log(
          `  ${p.name}${defaultTag}${worktreeTag} — ${p.platform} / ${p.mode} / port ${p.metroPort}`
        );
      }
      console.log();
    });

  program
    .command("profiles:default <name>")
    .description("Set default profile for current worktree+branch")
    .action(async (name) => {
      const projectRoot = requireProjectRoot();
      const store = new ProfileStore(
        path.join(projectRoot, ".rn-dev", "profiles")
      );
      const branch = getCurrentBranch(projectRoot) ?? "main";
      store.setDefault(name, null, branch);
      console.log(`Profile "${name}" set as default for branch "${branch}"`);
    });

  // Devices
  program
    .command("devices")
    .description("List available devices")
    .option("--platform <platform>", "ios, android, or both", "both")
    .action(async (options) => {
      const platform = (options.platform ?? "both") as Platform;
      const devices = listDevices(platform);

      if (devices.length === 0) {
        console.log("No devices found.");
        return;
      }

      console.log("\nDevices:\n");
      for (const d of devices) {
        const runtime = d.runtime ? ` (${d.runtime})` : "";
        console.log(
          `  [${d.type}] ${d.name} — ${d.status}${runtime}  (${d.id})`
        );
      }
      console.log();
    });

  // Worktrees
  program
    .command("worktrees")
    .description("List git worktrees and their session status")
    .action(async () => {
      const projectRoot = requireProjectRoot();
      const worktrees = getWorktrees(projectRoot);

      if (worktrees.length === 0) {
        console.log("No worktrees found (or not a git repository).");
        return;
      }

      console.log("\nWorktrees:\n");
      for (const wt of worktrees) {
        const mainTag = wt.isMain ? " (main)" : "";
        console.log(`  ${wt.branch}${mainTag} — ${wt.path}`);
      }
      console.log();
    });

  // Clean
  program
    .command("clean")
    .description("Run clean operations")
    .option("--mode <mode>", "dirty, clean, or ultra-clean", "clean")
    .option("--platform <platform>", "ios, android, or both", "both")
    .action(async (options) => {
      const projectRoot = requireProjectRoot();
      const mode = (options.mode ?? "clean") as RunMode;
      const platform = (options.platform ?? "both") as Platform;
      const cleaner = new CleanManager(projectRoot);

      console.log(`\nRunning ${mode} clean for ${platform}...\n`);
      const results = await cleaner.execute(
        mode,
        platform,
        (step, status) => {
          console.log(`  [${status}] ${step}`);
        }
      );

      const passed = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      console.log(`\nDone: ${passed} passed, ${failed} failed.\n`);
    });

  // Preflight
  program
    .command("preflight")
    .description("Run preflight checks")
    .option("--fix", "Auto-fix fixable issues")
    .option("--platform <platform>", "ios, android, or both", "both")
    .action(async (options) => {
      const projectRoot = requireProjectRoot();
      const platform = (options.platform ?? "both") as Platform;
      const engine = createDefaultPreflightEngine(projectRoot);
      const checks = engine.getChecksForPlatform(platform);
      const config = {
        checks: checks.map((c) => c.id),
        frequency: "once" as const,
      };
      const results = await engine.runAll(platform, config);

      console.log("\nPreflight results:\n");
      let hasFailures = false;
      for (const [id, result] of results) {
        const icon = result.passed ? "PASS" : "FAIL";
        console.log(`  [${icon}] ${id}: ${result.message}`);
        if (result.details) {
          console.log(`         ${result.details}`);
        }
        if (!result.passed) hasFailures = true;
      }

      if (options.fix && hasFailures) {
        console.log("\nAttempting auto-fixes...\n");
        for (const [id, result] of results) {
          if (!result.passed) {
            const fixed = await engine.fix(id);
            console.log(`  [${fixed ? "FIXED" : "SKIP"}] ${id}`);
          }
        }
      }

      console.log();
    });

  // Metro control
  program
    .command("reload")
    .description("Reload the running app")
    .action(async () => {
      const projectRoot = requireProjectRoot();
      const client = new IpcClient(
        path.join(projectRoot, ".rn-dev", "sock")
      );
      const isRunning = await client.isServerRunning();
      if (!isRunning) {
        console.error("No running rn-dev session found");
        process.exit(1);
      }
      await client.send({
        type: "command",
        action: "reload",
        id: Date.now().toString(),
      });
      console.log("Reload sent");
    });

  program
    .command("dev-menu")
    .description("Open device dev menu")
    .action(async () => {
      const projectRoot = requireProjectRoot();
      const client = new IpcClient(
        path.join(projectRoot, ".rn-dev", "sock")
      );
      const isRunning = await client.isServerRunning();
      if (!isRunning) {
        console.error("No running rn-dev session found");
        process.exit(1);
      }
      await client.send({
        type: "command",
        action: "dev-menu",
        id: Date.now().toString(),
      });
      console.log("Dev menu command sent");
    });

  // Tools
  program
    .command("lint")
    .description("Run project linter")
    .action(async () => {
      const projectRoot = requireProjectRoot();
      const { execSync } = await import("child_process");
      try {
        execSync("npx eslint .", {
          cwd: projectRoot,
          stdio: "inherit",
        });
      } catch {
        process.exit(1);
      }
    });

  program
    .command("typecheck")
    .description("Run TypeScript type checking")
    .action(async () => {
      const projectRoot = requireProjectRoot();
      const { execSync } = await import("child_process");
      try {
        execSync("npx tsc --noEmit", {
          cwd: projectRoot,
          stdio: "inherit",
        });
      } catch {
        process.exit(1);
      }
    });

  // Module system (install / uninstall / list / enable / disable / restart)
  registerModuleCommands(program);

  // MCP server
  program
    .command("mcp")
    .description("Start MCP server (stdio transport)")
    .action(async () => {
      const { startMcpServer } = await import("../mcp/index.js");
      await startMcpServer();
    });

  return program;
}
