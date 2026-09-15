import {
  existsSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "fs";
import { join, resolve, sep } from "path";
import { homedir, tmpdir } from "os";
import { createHash } from "crypto";
import { execShellAsync, execAsyncSafe } from "./exec-async.js";
import type { Platform, RunMode } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CleanStep {
  name: string;
  description: string;
  action: () => Promise<{ success: boolean; output: string }>;
  platform: "ios" | "android" | "all";
  mode: RunMode[];
}

export interface CleanResult {
  step: string;
  success: boolean;
  output: string;
  skipped?: boolean;
}

// ---------------------------------------------------------------------------
// Helper: run a shell command safely
// ---------------------------------------------------------------------------

async function run(
  cmd: string,
  options: { cwd?: string; ignoreFailure?: boolean; timeout?: number } = {}
): Promise<{ success: boolean; output: string }> {
  try {
    const output = await execShellAsync(cmd, {
      cwd: options.cwd,
      timeout: options.timeout ?? 120000, // 2 minutes default
    });
    return { success: true, output: (output ?? "").trim() };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as any)?.stderr ?? '';
    const stdout = (err as any)?.stdout ?? '';
    const fullOutput = [msg, stderr, stdout].filter(Boolean).join('\n');

    if (options.ignoreFailure) {
      return { success: true, output: fullOutput };
    }
    return { success: false, output: fullOutput };
  }
}

// ---------------------------------------------------------------------------
// Helper: remove a directory path (no-op if absent)
// ---------------------------------------------------------------------------

function removeDir(
  dirPath: string
): { success: boolean; output: string } {
  try {
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
      return { success: true, output: `Removed ${dirPath}` };
    }
    return { success: true, output: `${dirPath} not found, skipping` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: msg };
  }
}

// ---------------------------------------------------------------------------
// Helper: detect package manager
// ---------------------------------------------------------------------------

export function detectPackageManager(
  projectRoot: string
): "npm" | "yarn" | "pnpm" {
  // 1. Check packageManager field in package.json (most reliable)
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
    if (typeof pkg.packageManager === "string") {
      if (pkg.packageManager.startsWith("yarn")) return "yarn";
      if (pkg.packageManager.startsWith("pnpm")) return "pnpm";
      if (pkg.packageManager.startsWith("npm")) return "npm";
    }
  } catch {}

  const hasPackageLock = existsSync(join(projectRoot, "package-lock.json"));
  const hasYarnLock = existsSync(join(projectRoot, "yarn.lock"));
  const hasPnpmLock = existsSync(join(projectRoot, "pnpm-lock.yaml"));

  // 2. Only one lockfile — easy
  if (hasPnpmLock && !hasYarnLock && !hasPackageLock) return "pnpm";
  if (hasYarnLock && !hasPackageLock) return "yarn";
  if (hasPackageLock && !hasYarnLock) return "npm";

  // 3. Both package-lock.json and yarn.lock exist — need heuristics
  if (hasPackageLock && hasYarnLock) {
    // Check for npm's internal lockfile inside node_modules (npm creates this, yarn doesn't)
    if (existsSync(join(projectRoot, "node_modules", ".package-lock.json"))) {
      return "npm";
    }
    // Check for yarn's integrity file (yarn creates this, npm doesn't)
    if (existsSync(join(projectRoot, "node_modules", ".yarn-integrity"))) {
      return "yarn";
    }
    // Check which lockfile is newer
    try {
      const { statSync } = require("fs");
      const npmTime = statSync(join(projectRoot, "package-lock.json")).mtimeMs;
      const yarnTime = statSync(join(projectRoot, "yarn.lock")).mtimeMs;
      if (npmTime !== yarnTime) {
        return npmTime > yarnTime ? "npm" : "yarn";
      }
    } catch {}
    // Same timestamp (e.g., git checkout) — default to npm (more common in RN projects)
    return "npm";
  }

  return "npm";
}

/**
 * Returns all detected package managers for the project.
 * Useful for showing a selection to the user when ambiguous.
 */
export function detectAllPackageManagers(
  projectRoot: string
): Array<{ name: "npm" | "yarn" | "pnpm"; detected: boolean; reason: string }> {
  const result: Array<{ name: "npm" | "yarn" | "pnpm"; detected: boolean; reason: string }> = [];

  if (existsSync(join(projectRoot, "package-lock.json"))) {
    result.push({ name: "npm", detected: true, reason: "package-lock.json found" });
  }
  if (existsSync(join(projectRoot, "yarn.lock"))) {
    result.push({ name: "yarn", detected: true, reason: "yarn.lock found" });
  }
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) {
    result.push({ name: "pnpm", detected: true, reason: "pnpm-lock.yaml found" });
  }
  if (result.length === 0) {
    result.push({ name: "npm", detected: false, reason: "default (no lockfile found)" });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: read bundle ID
// ---------------------------------------------------------------------------

export function readBundleId(
  projectRoot: string,
  platform: Platform
): string | null {
  if (platform === "android" || platform === "both") {
    const buildGradle = join(
      projectRoot,
      "android",
      "app",
      "build.gradle"
    );
    if (existsSync(buildGradle)) {
      try {
        const content = readFileSync(buildGradle, "utf8");
        const match = content.match(/applicationId\s+["']([^"']+)["']/);
        if (match) return match[1];
      } catch {
        // ignore
      }
    }
  }

  if (platform === "ios" || platform === "both") {
    // Try ios/*.xcodeproj/project.pbxproj
    const iosDir = join(projectRoot, "ios");
    if (existsSync(iosDir)) {
      try {
        const entries = readdirSync(iosDir);
        for (const entry of entries) {
          if (entry.endsWith(".xcodeproj")) {
            const pbxproj = join(iosDir, entry, "project.pbxproj");
            if (existsSync(pbxproj)) {
              const content = readFileSync(pbxproj, "utf8");
              const match = content.match(
                /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/
              );
              if (match) return match[1].trim();
            }
          }
        }
      } catch {
        // ignore
      }

      // Fallback: read from ios/*/Info.plist
      try {
        const entries = readdirSync(iosDir);
        for (const entry of entries) {
          const infoPlist = join(iosDir, entry, "Info.plist");
          if (existsSync(infoPlist)) {
            const content = readFileSync(infoPlist, "utf8");
            const match = content.match(
              /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/
            );
            if (match) return match[1].trim();
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Xcode process utilities
// ---------------------------------------------------------------------------

export async function isXcodeRunning(): Promise<boolean> {
  try {
    const result = await execAsyncSafe("pgrep -x Xcode", {
      timeout: 15000,
    });
    return (result.stdout ?? "").trim().length > 0 && result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function killXcode(): Promise<boolean> {
  try {
    await execShellAsync("killall Xcode", {
      timeout: 15000,
    });
    // Poll up to 5 seconds for Xcode to exit
    const deadline = Date.now() + 5000;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    while (Date.now() < deadline) {
      if (!(await isXcodeRunning())) return true;
      await sleep(100);
    }
    return !(await isXcodeRunning());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CleanManager
// ---------------------------------------------------------------------------

export class CleanManager {
  private packageManagerOverride?: "npm" | "yarn" | "pnpm";

  constructor(private projectRoot: string, packageManager?: "npm" | "yarn" | "pnpm") {
    this.packageManagerOverride = packageManager;
  }

  // -------------------------------------------------------------------------
  // Step definitions
  // -------------------------------------------------------------------------

  private buildAllSteps(): CleanStep[] {
    const root = this.projectRoot;
    const iosDir = join(root, "ios");
    const androidDir = join(root, "android");

    // ------------------------------------------------------------------
    // CLEAN-mode steps (also included in ultra-clean)
    // ------------------------------------------------------------------

    const killWatchman: CleanStep = {
      name: "kill-watchman",
      description: "Kill watchman watches",
      platform: "all",
      mode: ["clean", "ultra-clean"],
      action: async () =>
        run("watchman watch-del-all", { ignoreFailure: true }),
    };

    const removeNodeModules: CleanStep = {
      name: "remove-node-modules",
      description: "Remove node_modules directory",
      platform: "all",
      mode: ["clean", "ultra-clean"],
      action: async () => removeDir(join(root, "node_modules")),
    };

    const clearMetroCache: CleanStep = {
      name: "clear-metro-cache",
      description: "Remove this project's Metro file-map cache",
      platform: "all",
      mode: ["clean", "ultra-clean"],
      // Scoped to THIS project on purpose. The previous version deleted
      // every `metro-*` and `haste-map-*` entry in the shared TMPDIR, so a
      // clean on one project wiped the Metro caches of every other project
      // and every other rn-dev session on the machine. Against the
      // 4-concurrent-session target that is a cross-session footgun.
      //
      // What is actually safe to delete, per Metro 0.84:
      //
      // - `metro-file-map-<md5(projectRoot)>-<configHash>` — the filename
      //   encodes a hash of the project root, so this project's entries are
      //   precisely identifiable. We remove exactly those.
      // - `metro-cache/` — a single FileStore root SHARED by every project
      //   (`metro-config` defaults it to `path.join(os.tmpdir(),
      //   "metro-cache")`). Nothing inside is attributable to a project, so
      //   we no longer touch it. We do not need to: Metro's own
      //   `--reset-cache` calls `store.clear()` on it at startup
      //   (`metro/src/Server.js`), and every mode that runs this step
      //   guarantees a subsequent cold start — `clean`/`ultra-clean` both
      //   satisfy `shouldResetMetroCache`, and `clean/run` restarts Metro
      //   with `resetCache: true` explicitly.
      // - `haste-map-*` — pre-Metro-0.72 naming, no longer produced, and
      //   not attributable to a project either. Dropped.
      action: async () => {
        const tmp = tmpdir();
        // Mirror metro-file-map's own key derivation: md5 of the
        // POSIX-normalised rootDir, where rootDir is `config.projectRoot`.
        // See metro-file-map/src/lib/rootRelativeCacheKeys.js.
        const normalizedRoot =
          sep === "/" ? root : root.replace(/\\/g, "/");
        const rootDirHash = createHash("md5")
          .update(normalizedRoot)
          .digest("hex");
        const prefix = `metro-file-map-${rootDirHash}-`;

        const results: string[] = [];
        let overallSuccess = true;
        try {
          for (const entry of readdirSync(tmp)) {
            if (!entry.startsWith(prefix)) continue;
            const r = removeDir(join(tmp, entry));
            if (!r.success) overallSuccess = false;
            results.push(r.output);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, output: msg };
        }

        return {
          success: overallSuccess,
          output:
            results.length > 0
              ? results.join("\n")
              : `No file-map cache for this project (${prefix}*). The shared transform cache is left alone; Metro clears it on the next --reset-cache start.`,
        };
      },
    };

    const installDependencies: CleanStep = {
      name: "install-dependencies",
      description: "Install npm/yarn/pnpm dependencies",
      platform: "all",
      mode: ["clean", "ultra-clean"],
      action: async () => {
        const pm = this.packageManagerOverride ?? detectPackageManager(root);
        const cmd =
          pm === "yarn"
            ? "yarn install"
            : pm === "pnpm"
            ? "pnpm install"
            : "npm install";
        return run(cmd, { cwd: root, timeout: 300000 });
      },
    };

    // Detect if project uses Bundler and rbenv
    const useBundle = existsSync(join(root, "Gemfile"));
    const hasRbenv = existsSync(join(homedir(), ".rbenv", "bin", "rbenv"));
    const rbenvInit = hasRbenv ? 'eval "$(rbenv init -)" && ' : '';
    const podCmd = useBundle ? `${rbenvInit}bundle exec pod` : `${rbenvInit}pod`;

    const podInstall: CleanStep = {
      name: "pod-install",
      description: "Run pod install",
      platform: "ios",
      mode: ["clean", "ultra-clean"],
      action: async () => run(`LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 RUBYOPT="-EUTF-8" ${podCmd} install --repo-update`, { cwd: iosDir, timeout: 600000 }),
    };

    // ------------------------------------------------------------------
    // ULTRA-CLEAN additional steps
    // ------------------------------------------------------------------

    const podDeintegrate: CleanStep = {
      name: "pod-deintegrate",
      description: "Deintegrate CocoaPods",
      platform: "ios",
      mode: ["ultra-clean"],
      action: async () =>
        run(`LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 RUBYOPT="-EUTF-8" ${podCmd} deintegrate`, { cwd: iosDir, ignoreFailure: true }),
    };

    const removePods: CleanStep = {
      name: "remove-pods",
      description: "Remove Pods directory",
      platform: "ios",
      mode: ["ultra-clean"],
      action: async () => removeDir(join(iosDir, "Pods")),
    };

    const removeDerivedData: CleanStep = {
      name: "remove-derived-data",
      description: "Remove DerivedData (ios/build and project-specific Xcode entries)",
      platform: "ios",
      mode: ["ultra-clean"],
      action: async () => {
        const r1 = removeDir(join(iosDir, "build"));
        const globalDerivedData = resolve(
          homedir(),
          "Library",
          "Developer",
          "Xcode",
          "DerivedData"
        );
        const outputs: string[] = [r1.output];
        let overallSuccess = r1.success;

        if (existsSync(globalDerivedData)) {
          // Only remove entries that match the project name
          // Get the project name from the Xcode workspace/project in ios/
          let projectName = root.split("/").filter(Boolean).pop() ?? "";
          try {
            const iosEntries = readdirSync(join(root, "ios"));
            for (const e of iosEntries) {
              if (e.endsWith(".xcworkspace")) {
                projectName = e.replace(".xcworkspace", "");
                break;
              }
              if (e.endsWith(".xcodeproj")) {
                projectName = e.replace(".xcodeproj", "");
              }
            }
          } catch {}

          try {
            const entries = readdirSync(globalDerivedData);
            for (const entry of entries) {
              if (entry.startsWith(projectName)) {
                const r = removeDir(join(globalDerivedData, entry));
                if (!r.success) overallSuccess = false;
                outputs.push(r.output);
              }
            }
            if (outputs.length === 1) {
              outputs.push(`No DerivedData entries matching "${projectName}" found`);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            overallSuccess = false;
            outputs.push(msg);
          }
        } else {
          outputs.push(`${globalDerivedData} not found, skipping`);
        }

        return { success: overallSuccess, output: outputs.join("\n") };
      },
    };

    const gradleStop: CleanStep = {
      name: "gradle-stop",
      description: "Stop Gradle daemon",
      platform: "android",
      mode: ["ultra-clean"],
      action: async () =>
        run("./gradlew --stop", { cwd: androidDir, ignoreFailure: true }),
    };

    const cleanGradleCaches: CleanStep = {
      name: "clean-gradle-caches",
      description: "Clean Gradle caches",
      platform: "android",
      mode: ["ultra-clean"],
      action: async () => {
        const paths = [
          join(androidDir, ".gradle"),
          join(androidDir, "build"),
          join(androidDir, "app", "build"),
        ];
        let overallSuccess = true;
        const outputs: string[] = [];
        for (const p of paths) {
          const r = removeDir(p);
          if (!r.success) overallSuccess = false;
          outputs.push(r.output);
        }
        return { success: overallSuccess, output: outputs.join("\n") };
      },
    };

    const uninstallAndroidApp: CleanStep = {
      name: "uninstall-android-app",
      description: "Uninstall Android app via adb",
      platform: "android",
      mode: ["ultra-clean"],
      action: async () => {
        const bundleId = readBundleId(root, "android");
        if (!bundleId) {
          return { success: true, output: "Bundle ID not found, skipping uninstall" };
        }
        return run(`adb uninstall ${bundleId}`, { ignoreFailure: true });
      },
    };

    const uninstallIosApp: CleanStep = {
      name: "uninstall-ios-app",
      description: "Uninstall iOS app from booted simulator",
      platform: "ios",
      mode: ["ultra-clean"],
      action: async () => {
        const bundleId = readBundleId(root, "ios");
        if (!bundleId) {
          return { success: true, output: "Bundle ID not found, skipping uninstall" };
        }
        return run(`xcrun simctl uninstall booted ${bundleId}`, {
          ignoreFailure: true,
        });
      },
    };

    return [
      // 1. Kill watchers first
      killWatchman,
      // 2. Ultra-clean: uninstall apps from devices BEFORE cleaning
      uninstallIosApp,
      uninstallAndroidApp,
      // 3. Ultra-clean: deintegrate pods BEFORE removing them
      podDeintegrate,
      removePods,
      // 4. Ultra-clean: remove DerivedData and Gradle caches
      removeDerivedData,
      gradleStop,
      cleanGradleCaches,
      // 5. Clean + Ultra: remove node_modules and metro cache
      removeNodeModules,
      clearMetroCache,
      // 6. Clean + Ultra: reinstall everything
      installDependencies,
      // 7. Clean + Ultra: pod install (after node_modules are back)
      podInstall,
    ];
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getStepsForMode(mode: RunMode, platform: Platform): CleanStep[] {
    if (mode === "dirty") {
      return [];
    }

    const allSteps = this.buildAllSteps();

    return allSteps.filter((step) => {
      // Must be included in this mode
      if (!step.mode.includes(mode)) {
        return false;
      }
      // Must apply to the given platform
      if (step.platform === "all") {
        return true;
      }
      if (platform === "both") {
        return true; // include ios and android steps
      }
      return step.platform === platform;
    });
  }

  async execute(
    mode: RunMode,
    platform: Platform,
    onProgress?: (step: string, status: string) => void
  ): Promise<CleanResult[]> {
    const steps = this.getStepsForMode(mode, platform);
    const results: CleanResult[] = [];

    for (const step of steps) {
      onProgress?.(step.description, "running");

      let result: CleanResult;
      try {
        const outcome = await step.action();
        result = {
          step: step.name,
          success: outcome.success,
          output: outcome.output,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = {
          step: step.name,
          success: false,
          output: msg,
        };
      }

      results.push(result);
    }

    return results;
  }
}
