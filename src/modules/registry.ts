import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import semver from "semver";
import {
  enforceToolPrefix,
  ModuleError,
  ModuleErrorCode,
  validateManifest,
  type ManifestError,
  type ModuleManifest,
} from "@rn-dev/module-sdk";
import type { RnDevModule } from "../core/types.js";
import { isDisabled as isModuleDisabled } from "./disabled-flag.js";

// ---------------------------------------------------------------------------
// Manifest-based module types (Phase 1)
// ---------------------------------------------------------------------------

export type ModuleActivationState = "inert" | "active" | "crashed" | "failed";

export interface RegisteredModule {
  manifest: ModuleManifest;
  /** Absolute path of the module's package root (contains rn-dev-module.json). */
  modulePath: string;
  /**
   * Scope unit this registration is bound to.
   *   - `"global"` for `scope: "global"` modules.
   *   - Worktree key (or arbitrary string) for per-worktree / workspace modules.
   */
  scopeUnit: string;
  state: ModuleActivationState;
  isBuiltIn: boolean;
}

/** A manifest that failed to load — captured so callers can surface diagnostics. */
export interface RejectedManifest {
  manifestPath: string;
  code: ModuleErrorCode | "E_INVALID_JSON" | "E_READ_FAILED";
  message: string;
  schemaErrors?: ManifestError[];
}

export interface LoadManifestsOptions {
  /** Host version to check against each manifest's `hostRange`. */
  hostVersion: string;
  /** Scope unit for `per-worktree` / `workspace` modules. Defaults to `"global"`. */
  scopeUnit?: string;
  /** Override the default `~/.rn-dev/modules/` directory (used by tests). */
  modulesDir?: string;
}

export interface LoadManifestsResult {
  modules: RegisteredModule[];
  rejected: RejectedManifest[];
}

// ---------------------------------------------------------------------------
// ModuleRegistry
// ---------------------------------------------------------------------------

export class ModuleRegistry {
  private modules: Map<string, RnDevModule> = new Map();
  private manifestModules: Map<string, RegisteredModule> = new Map();

  // -------------------------------------------------------------------------
  // Ink (legacy) modules — unchanged API
  // -------------------------------------------------------------------------

  register(module: RnDevModule): void {
    if (this.modules.has(module.id)) {
      throw new Error(`Module "${module.id}" is already registered.`);
    }
    this.modules.set(module.id, module);
  }

  unregister(id: string): boolean {
    return this.modules.delete(id);
  }

  get(id: string): RnDevModule | undefined {
    return this.modules.get(id);
  }

  getAll(): RnDevModule[] {
    return [...this.modules.values()].sort((a, b) => a.order - b.order);
  }

  getShortcuts(): Array<{
    key: string;
    label: string;
    moduleId: string;
    action: () => Promise<void>;
  }> {
    const result: Array<{
      key: string;
      label: string;
      moduleId: string;
      action: () => Promise<void>;
    }> = [];

    for (const module of this.modules.values()) {
      if (!module.shortcuts) continue;
      for (const shortcut of module.shortcuts) {
        result.push({
          key: shortcut.key,
          label: shortcut.label,
          moduleId: module.id,
          action: shortcut.action,
        });
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Manifest-based (Phase 1+) modules
  // -------------------------------------------------------------------------

  /** Compose the scope-aware key used in the manifest map. */
  static manifestKey(id: string, scopeUnit: string): string {
    return `${id}:${scopeUnit}`;
  }

  registerManifest(registered: RegisteredModule): void {
    const key = ModuleRegistry.manifestKey(
      registered.manifest.id,
      registered.scopeUnit,
    );
    if (this.manifestModules.has(key)) {
      throw new Error(
        `Manifest module "${registered.manifest.id}" is already registered for scope "${registered.scopeUnit}".`,
      );
    }
    this.manifestModules.set(key, registered);
  }

  unregisterManifest(id: string, scopeUnit: string): boolean {
    return this.manifestModules.delete(
      ModuleRegistry.manifestKey(id, scopeUnit),
    );
  }

  getManifest(id: string, scopeUnit: string): RegisteredModule | undefined {
    return this.manifestModules.get(
      ModuleRegistry.manifestKey(id, scopeUnit),
    );
  }

  getAllManifests(): RegisteredModule[] {
    return [...this.manifestModules.values()];
  }

  /**
   * Scan a modules directory (defaults to `~/.rn-dev/modules/`) and register
   * every valid manifest as a `RegisteredModule` in `inert` state.
   *
   * Manifests that fail schema validation, `hostRange`, or the 3p tool-prefix
   * policy are returned in `rejected[]` and skipped — never thrown.
   */
  loadUserGlobalModules(options: LoadManifestsOptions): LoadManifestsResult {
    const modulesDir =
      options.modulesDir ?? join(homedir(), ".rn-dev", "modules");
    const scopeUnit = options.scopeUnit ?? "global";
    const result: LoadManifestsResult = { modules: [], rejected: [] };

    if (!existsSync(modulesDir)) return result;

    let entries: string[];
    try {
      entries = readdirSync(modulesDir);
    } catch {
      return result;
    }

    for (const entry of entries) {
      const moduleRoot = join(modulesDir, entry);
      try {
        if (!statSync(moduleRoot).isDirectory()) continue;
      } catch {
        continue;
      }

      const manifestPath = join(moduleRoot, "rn-dev-module.json");
      if (!existsSync(manifestPath)) continue;

      // Phase 3c: skip modules that have been explicitly disabled via
      // `modules/disable`. Keeps the manifest on disk; just doesn't register
      // it at runtime. `modules/enable` re-enables by removing the flag.
      if (isModuleDisabled(entry, modulesDir)) {
        continue;
      }

      const loaded = this.loadManifestFile(manifestPath, {
        hostVersion: options.hostVersion,
        scopeUnit,
        isBuiltIn: false,
      });

      if (loaded.kind === "ok") {
        try {
          this.registerManifest(loaded.module);
          result.modules.push(loaded.module);
        } catch (err) {
          result.rejected.push({
            manifestPath,
            code: ModuleErrorCode.E_INVALID_MANIFEST,
            message:
              err instanceof Error ? err.message : "duplicate registration",
          });
        }
      } else {
        result.rejected.push(loaded.rejection);
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Legacy loadPlugins — per-project Ink-style override.
  // -------------------------------------------------------------------------

  async loadPlugins(projectRoot: string): Promise<void> {
    const pkgPath = join(projectRoot, "package.json");

    if (!existsSync(pkgPath)) {
      return;
    }

    let pkg: Record<string, unknown>;
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Malformed package.json — skip silently
      return;
    }

    const rnDev = pkg["rn-dev"] as Record<string, unknown> | undefined;
    if (!rnDev || !Array.isArray(rnDev.plugins)) {
      return;
    }

    for (const entry of rnDev.plugins as unknown[]) {
      if (typeof entry !== "string" || entry.trim() === "") {
        console.warn(`[ModuleRegistry] Skipping invalid plugin entry: ${String(entry)}`);
        continue;
      }

      try {
        const modulePath = entry.startsWith("./")
          ? join(projectRoot, entry)
          : entry;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const imported = (await import(modulePath)) as Record<string, any>;

        // Support default export or named "default" export
        const candidate =
          imported.default ?? Object.values(imported).find(Boolean);

        if (!isRnDevModule(candidate)) {
          console.warn(
            `[ModuleRegistry] Plugin "${entry}" does not export a valid RnDevModule — skipping.`
          );
          continue;
        }

        this.register(candidate as RnDevModule);
      } catch (err) {
        console.warn(
          `[ModuleRegistry] Failed to load plugin "${entry}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: single-manifest load + validation pipeline
  // -------------------------------------------------------------------------

  private loadManifestFile(
    manifestPath: string,
    opts: { hostVersion: string; scopeUnit: string; isBuiltIn: boolean },
  ):
    | { kind: "ok"; module: RegisteredModule }
    | { kind: "err"; rejection: RejectedManifest } {
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf-8");
    } catch (err) {
      return {
        kind: "err",
        rejection: {
          manifestPath,
          code: "E_READ_FAILED",
          message:
            err instanceof Error ? err.message : "failed to read manifest",
        },
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      return {
        kind: "err",
        rejection: {
          manifestPath,
          code: "E_INVALID_JSON",
          message:
            err instanceof Error
              ? err.message
              : "manifest is not valid JSON",
        },
      };
    }

    const validation = validateManifest(json);
    if (!validation.valid) {
      return {
        kind: "err",
        rejection: {
          manifestPath,
          code: ModuleErrorCode.E_INVALID_MANIFEST,
          message: `Manifest failed schema validation (${validation.errors.length} error${validation.errors.length === 1 ? "" : "s"}).`,
          schemaErrors: validation.errors,
        },
      };
    }

    const manifest = validation.manifest;

    if (!semver.satisfies(opts.hostVersion, manifest.hostRange, { includePrerelease: true })) {
      return {
        kind: "err",
        rejection: {
          manifestPath,
          code: ModuleErrorCode.E_HOST_RANGE_MISMATCH,
          message: `Module "${manifest.id}" declares hostRange "${manifest.hostRange}", which does not include host version ${opts.hostVersion}.`,
        },
      };
    }

    try {
      enforceToolPrefix(manifest, { isBuiltIn: opts.isBuiltIn });
    } catch (err) {
      if (err instanceof ModuleError) {
        return {
          kind: "err",
          rejection: {
            manifestPath,
            code: err.code,
            message: err.message,
          },
        };
      }
      throw err;
    }

    const scopeUnit =
      manifest.scope === "global" ? "global" : opts.scopeUnit;

    return {
      kind: "ok",
      module: {
        manifest,
        modulePath: manifestDir(manifestPath),
        scopeUnit,
        state: "inert",
        isBuiltIn: opts.isBuiltIn,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function manifestDir(manifestPath: string): string {
  const idx = manifestPath.lastIndexOf("/rn-dev-module.json");
  return idx === -1
    ? manifestPath
    : manifestPath.slice(0, idx);
}

/**
 * Runtime shape check for Ink-style `RnDevModule` exports loaded via
 * `loadPlugins`. Loosened in Phase 1: `component` is optional so MCP-only /
 * Electron-only modules pass through. Manifest-based modules should be loaded
 * via `loadUserGlobalModules` instead.
 */
function isRnDevModule(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["icon"] === "string" &&
    typeof v["order"] === "number" &&
    (v["component"] === undefined || typeof v["component"] === "function")
  );
}
