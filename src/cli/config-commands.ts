// `rn-dev config {init, validate}` CLI — Phase H0 scaffolder + validator.
//
// `init` writes a starter `rn-dev.config.mjs` and runs the project's package
// manager to add `@rn-dev/config` as a devDependency, so the scaffolded
// config doesn't fail its own dynamic import on the first session boot
// (closes todo #004).
//
// `validate` dynamic-imports the config and runs `validateConfig` from
// `@rn-dev/config`. It is the H0 acceptance gate: `rn-dev config init`
// followed by `rn-dev config validate` must succeed in an empty directory.
//
// Note on `.mjs` vs `.ts`: H0 ships `.mjs` because the daemon (which loads
// `.ts` via Bun) does not exist yet. H2 will introduce daemon integration
// and switch the scaffold to `.ts`. The shape of the file is identical;
// the extension is the only thing that changes.

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_FILE_BASENAMES = [
  "rn-dev.config.mjs",
  "rn-dev.config.mts",
  "rn-dev.config.ts",
  "rn-dev.config.js",
] as const;

const STARTER_CONFIG = `/**
 * rn-dev project config — see https://rn-dev.dev/docs/hooks for the full
 * reference. Hooks are keyed on '<moduleId>/<hookName>' (e.g. 'build/pre').
 *
 * Each entry can be:
 *   - a string (shorthand for { script: <string> }), or
 *   - { script, onFail?, timeoutMs?, priority? } for subprocess hooks, or
 *   - { fn, onFail?, timeoutMs?, priority? } for in-process hooks (project
 *     hooks only — function references can't ship inside .mjs without a
 *     runtime; for now use script entries).
 *
 * Built-in modules ship in Phase H2/H3. The slot keys below are illustrative:
 * uncomment and replace the script paths with your project's hooks.
 */
import { defineConfig } from "@rn-dev/config";

export default defineConfig({
  hooks: {
    // 'build/pre': './bin/swap-firebase.sh',
    // 'build/post': { script: './bin/wipe.sh', onFail: 'warn', timeoutMs: 30000 },
    // 'metro/post-start': './bin/start-mock-server.sh',
    // 'session/init': './bin/print-banner.sh',
  },

  // Opt in to a 3p module's <id>/custom override slot:
  // allowModuleOverrides: ['my-custom-builder'],

  // Opt in to a 3p module's onFail: 'hard' on non-override slots:
  // allowModuleHardFails: ['my-strict-validator'],
});
`;

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

interface DetectedPackageManager {
  pm: PackageManager;
  source: "lockfile" | "default";
}

function detectPackageManager(projectDir: string): DetectedPackageManager {
  const candidates: Array<[string, PackageManager]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [lockfile, pm] of candidates) {
    if (existsSync(path.join(projectDir, lockfile))) {
      return { pm, source: "lockfile" };
    }
  }
  return { pm: "npm", source: "default" };
}

function installCommand(
  pm: PackageManager,
): { cmd: string; args: (pkg: string) => string[] } {
  switch (pm) {
    case "bun":
      return { cmd: "bun", args: (pkg) => ["add", "--dev", pkg] };
    case "pnpm":
      return { cmd: "pnpm", args: (pkg) => ["add", "--save-dev", pkg] };
    case "yarn":
      return { cmd: "yarn", args: (pkg) => ["add", "--dev", pkg] };
    case "npm":
      return { cmd: "npm", args: (pkg) => ["install", "--save-dev", pkg] };
  }
}

function findConfigFile(projectDir: string): string | null {
  for (const basename of CONFIG_FILE_BASENAMES) {
    const candidate = path.join(projectDir, basename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readPackageVersion(): string {
  // The CLI is bundled, so __dirname can't help; read this package's manifest
  // from the workspace by walking up. As a fallback, default to 0.1.0.
  try {
    const here = new URL(".", import.meta.url).pathname;
    let dir = here;
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "rn-dev-cli" && typeof pkg.version === "string") {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return "0.1.0";
}

function hostMinor(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match ? `${match[1]}.${match[2]}.0` : "0.1.0";
}

interface InitOptions {
  path?: string;
  force?: boolean;
  pm?: PackageManager;
  /** When true, skip the package-manager install step (used by tests). */
  skipInstall?: boolean;
}

export interface InitResult {
  configPath: string;
  packageManager: PackageManager;
  installRan: boolean;
  installSucceeded: boolean;
  installCommand: string;
}

export function runConfigInit(options: InitOptions): InitResult {
  const projectDir = path.resolve(options.path ?? process.cwd());
  const configPath = path.join(projectDir, "rn-dev.config.mjs");

  if (!options.force) {
    const existing = findConfigFile(projectDir);
    if (existing !== null) {
      throw new Error(
        `Refusing to overwrite existing ${path.relative(projectDir, existing)}. Pass --force to replace it.`,
      );
    }
  }

  writeFileSync(configPath, STARTER_CONFIG);

  const detected =
    options.pm !== undefined
      ? { pm: options.pm, source: "lockfile" as const }
      : detectPackageManager(projectDir);

  const cliVersion = readPackageVersion();
  const targetSpec = `@rn-dev/config@^${hostMinor(cliVersion)}`;
  const { cmd, args } = installCommand(detected.pm);
  const fullCommand = `${cmd} ${args(targetSpec).join(" ")}`;

  if (options.skipInstall === true) {
    return {
      configPath,
      packageManager: detected.pm,
      installRan: false,
      installSucceeded: false,
      installCommand: fullCommand,
    };
  }

  const result = spawnSync(cmd, args(targetSpec), {
    cwd: projectDir,
    stdio: "inherit",
  });
  return {
    configPath,
    packageManager: detected.pm,
    installRan: true,
    installSucceeded: result.status === 0,
    installCommand: fullCommand,
  };
}

interface ValidateOptions {
  path?: string;
}

export interface ValidateResult {
  configPath: string;
  ok: boolean;
  message: string;
}

export async function runConfigValidate(
  options: ValidateOptions,
): Promise<ValidateResult> {
  const projectDir = path.resolve(options.path ?? process.cwd());
  const configFile = findConfigFile(projectDir);
  if (configFile === null) {
    return {
      configPath: projectDir,
      ok: false,
      message: `No rn-dev config found in ${projectDir}. Run \`rn-dev config init\` to scaffold one.`,
    };
  }

  // .ts/.mts files require a TS loader (bun or tsx). The H0 scaffolder
  // emits .mjs, so a .ts here means the user customized it; surface a
  // clear hint instead of a confusing parse error.
  if (/\.m?ts$/.test(configFile)) {
    return {
      configPath: configFile,
      ok: false,
      message: `${path.basename(configFile)} requires a TypeScript loader. Run with bun or tsx, or rename to .mjs for H0.`,
    };
  }

  // Lazy-import to keep the CLI startup snappy and to keep the workspace
  // dep on @rn-dev/config local to this command.
  const { loadConfig } = await import("@rn-dev/config");
  try {
    await loadConfig(pathToFileURL(configFile).href);
  } catch (err) {
    return {
      configPath: configFile,
      ok: false,
      message: (err as Error).message ?? String(err),
    };
  }
  return {
    configPath: configFile,
    ok: true,
    message: `${path.basename(configFile)} is valid.`,
  };
}

export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("Manage the project's rn-dev.config.* file");

  config
    .command("init")
    .description("Scaffold rn-dev.config.mjs and add @rn-dev/config as a devDependency")
    .option("--path <dir>", "Project directory (default: cwd)")
    .option("--force", "Overwrite an existing config file")
    .option(
      "--pm <pm>",
      "Force the package manager (bun, pnpm, yarn, npm)",
    )
    .option("--skip-install", "Skip the package-manager install step")
    .action(async (opts: {
      path?: string;
      force?: boolean;
      pm?: PackageManager;
      skipInstall?: boolean;
    }) => {
      try {
        const result = runConfigInit({
          path: opts.path,
          force: opts.force === true,
          pm: opts.pm,
          skipInstall: opts.skipInstall === true,
        });
        console.log(`Scaffolded ${result.configPath}`);
        if (result.installRan) {
          console.log(
            result.installSucceeded
              ? `Ran: ${result.installCommand}`
              : `Install failed (${result.installCommand}). Run it manually.`,
          );
          if (!result.installSucceeded) process.exitCode = 1;
        } else {
          console.log(
            `Skipped install. To finish setup, run: ${result.installCommand}`,
          );
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  config
    .command("validate")
    .description("Validate the project's rn-dev.config.* file")
    .option("--path <dir>", "Project directory (default: cwd)")
    .action(async (opts: { path?: string }) => {
      const result = await runConfigValidate({ path: opts.path });
      if (result.ok) {
        console.log(result.message);
      } else {
        console.error(result.message);
        process.exit(1);
      }
    });
}
