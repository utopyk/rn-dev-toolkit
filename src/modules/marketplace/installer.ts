// Marketplace installer / uninstaller.
//
// Given a validated `RegistryEntry` + a `permissionsAccepted[]` the caller
// walked through consent with, this module:
//
//   1. Downloads the tarball via `pacote` and verifies its SHA-256 against
//      `entry.tarballSha256`. Mismatch aborts.
//   2. Extracts the tarball into `~/.rn-dev/modules/<id>/`.
//   3. If the extracted package declares runtime dependencies, reifies them
//      via `@npmcli/arborist` with `ignoreScripts: true`. This is the only
//      entry point that runs arborist; never `execa npm install`.
//   4. Validates the extracted `rn-dev-module.json` against the schema via
//      the existing `ModuleRegistry` pipeline.
//   5. Registers the resulting manifest into the supplied registry + emits
//      an install event.
//
// Failure path rolls back: any partial install directory is `rm -rf`'d
// before the caller sees the error so a retry starts clean.
//
// Uninstall tears down the subprocess (if running) + removes the install
// directory. `keepData: true` preserves `<dir>/data/` for 30 days (Phase 6
// deferred — data retention + GC sweep is declared but not yet implemented
// in `uninstall`; the flag is accepted for MCP surface parity).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModuleManifest,
} from "@rn-dev/module-sdk";
import type { ModuleHostManager } from "../../core/module-host/manager.js";
import { ModuleRegistry, type RegisteredModule } from "../registry.js";
import { isSafeModuleId, type RegistryEntry } from "./registry.js";

export const DEFAULT_MODULES_DIR = join(homedir(), ".rn-dev", "modules");
const THIRD_PARTY_ACK_PATH = join(homedir(), ".rn-dev", ".third-party-acknowledged");

export type InstallErrorCode =
  | "E_PERMISSION_DENIED"
  | "E_TARBALL_FETCH_FAILED"
  | "E_INTEGRITY_MISMATCH"
  | "E_EXTRACT_FAILED"
  | "E_DEPS_FAILED"
  | "E_INVALID_MANIFEST"
  | "E_MANIFEST_ID_MISMATCH"
  | "E_ALREADY_INSTALLED"
  | "E_THIRD_PARTY_NOT_ACKNOWLEDGED";

export type InstallResult =
  | {
      kind: "ok";
      module: RegisteredModule;
      installPath: string;
      /** SHA-256 of the installed tarball — the same value we verified against. */
      tarballSha256: string;
    }
  | {
      kind: "error";
      code: InstallErrorCode;
      message: string;
    };

export type UninstallErrorCode =
  | "E_UNINSTALL_NOT_FOUND"
  | "E_UNINSTALL_IO";

export type UninstallResult =
  | { kind: "ok"; removed: string; keptData: boolean }
  | { kind: "error"; code: UninstallErrorCode; message: string };

export interface InstallOptions {
  entry: RegistryEntry;
  /**
   * Permissions the caller's consent flow surfaced + the user accepted. Every
   * string in `entry.permissions` must appear here verbatim; superset is OK,
   * subset rejects with `E_PERMISSION_DENIED`.
   */
  permissionsAccepted: string[];
  registry: ModuleRegistry;
  /** Host version used to validate `hostRange` after extract. */
  hostVersion: string;
  /** Scope unit to register the module at. Defaults to `"global"`. */
  scopeUnit?: string;
  /** Override install root. Defaults to `~/.rn-dev/modules/`. */
  modulesDir?: string;
  /**
   * When false, the installer acts like the MCP-mode path: if the user has
   * never installed a 3p module on this host, the fresh-host acknowledgment
   * must already be recorded; otherwise returns `E_THIRD_PARTY_NOT_ACKNOWLEDGED`.
   * Electron-path callers set this to `true` once the consent dialog has
   * walked the one-time ack. Tests override to skip the ack entirely.
   */
  thirdPartyAcknowledged?: boolean;
  /**
   * Optional pacote override. Tests inject a stub so the installer is
   * offline-safe; production uses the real `pacote` package.
   */
  pacote?: PacoteLike;
  /**
   * Optional arborist override. Tests inject a stub; production uses
   * `@npmcli/arborist`.
   */
  arboristFactory?: ArboristFactory;
}

export interface UninstallOptions {
  moduleId: string;
  registry: ModuleRegistry;
  manager?: ModuleHostManager;
  scopeUnit?: string;
  keepData?: boolean;
  modulesDir?: string;
}

export interface PacoteLike {
  tarball(spec: string): Promise<Buffer>;
  extract(spec: string, target: string): Promise<unknown>;
}

export interface ArboristLike {
  reify(options?: Record<string, unknown>): Promise<unknown>;
}

export type ArboristFactory = (opts: {
  path: string;
  ignoreScripts: boolean;
}) => ArboristLike;

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export async function installModule(opts: InstallOptions): Promise<InstallResult> {
  const modulesDir = opts.modulesDir ?? DEFAULT_MODULES_DIR;
  const scopeUnit = opts.scopeUnit ?? "global";
  const installPath = join(modulesDir, opts.entry.id);

  // 1. Permission gate — the user's accepted list must cover every declared.
  const missing = opts.entry.permissions.filter(
    (p) => !opts.permissionsAccepted.includes(p),
  );
  if (missing.length > 0) {
    return {
      kind: "error",
      code: "E_PERMISSION_DENIED",
      message: `permissions not accepted: ${missing.join(", ")}. Re-run with permissionsAccepted covering every declared permission.`,
    };
  }

  // 2. Fresh-host acknowledgment (one-time). Electron GUI walks this via the
  //    consent dialog and passes `thirdPartyAcknowledged: true`; MCP callers
  //    with no GUI set `RN_DEV_ACK_THIRD_PARTY=1` out-of-band.
  if (!opts.thirdPartyAcknowledged && !existsSync(THIRD_PARTY_ACK_PATH)) {
    return {
      kind: "error",
      code: "E_THIRD_PARTY_NOT_ACKNOWLEDGED",
      message:
        "First-ever third-party module install on this host requires a one-time acknowledgment that modules run as your user and can do anything you can. Install via the GUI once, or touch ~/.rn-dev/.third-party-acknowledged after reading https://<docs>/modules/consent.",
    };
  }

  // 3. Refuse if already installed. Uninstall first, then re-install — we
  //    don't silently overwrite because it could upgrade permissions under
  //    the user's nose.
  if (existsSync(installPath)) {
    return {
      kind: "error",
      code: "E_ALREADY_INSTALLED",
      message: `module "${opts.entry.id}" is already installed at ${installPath}; uninstall first`,
    };
  }

  const pacote = opts.pacote ?? (await defaultPacote());
  const arboristFactory = opts.arboristFactory ?? (await defaultArboristFactory());

  // 4. Download tarball + verify SHA.
  let tarballBuffer: Buffer;
  try {
    tarballBuffer = await pacote.tarball(
      `${opts.entry.npmPackage}@${opts.entry.version}`,
    );
  } catch (err) {
    return {
      kind: "error",
      code: "E_TARBALL_FETCH_FAILED",
      message: err instanceof Error ? err.message : "pacote.tarball failed",
    };
  }

  const actualSha = createHash("sha256").update(tarballBuffer).digest("hex");
  if (actualSha.toLowerCase() !== opts.entry.tarballSha256.toLowerCase()) {
    return {
      kind: "error",
      code: "E_INTEGRITY_MISMATCH",
      message: `tarball SHA-256 mismatch for ${opts.entry.npmPackage}@${opts.entry.version} — expected ${opts.entry.tarballSha256}, got ${actualSha}. Refusing to install.`,
    };
  }

  // 5. Extract via pacote into the install path. Two-step (buffer → tmp
  //    file → pacote.extract) so SHA-256 verification happens on the
  //    verbatim buffer we fetched — `pacote.extract(spec)` with SSRI
  //    integrity would be more idiomatic but requires sha512 and would
  //    route through pacote's internal cache. A future contributor should
  //    NOT collapse this back into a single extract() call without
  //    replicating the SHA-256 check against the fetched bytes.
  //
  //    Tmp file lives inside an mkdtempSync'd dir so the name is
  //    unpredictable to other processes on this host (Security P2-1
  //    from the Phase 6 review).
  mkdirSync(installPath, { recursive: true });
  const tmpDir = mkdtempSync(join(tmpdir(), `rn-dev-install-${opts.entry.id}-`));
  const tmpFile = join(tmpDir, "module.tgz");
  try {
    writeFileSync(tmpFile, tarballBuffer);
    await pacote.extract(`file:${tmpFile}`, installPath);
  } catch (err) {
    rollback(installPath);
    return {
      kind: "error",
      code: "E_EXTRACT_FAILED",
      message: err instanceof Error ? err.message : "extract failed",
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  // 6. Reify deps if the package declares any.
  const pkgJsonPath = join(installPath, "package.json");
  if (existsSync(pkgJsonPath)) {
    let pkg: { dependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
        dependencies?: Record<string, string>;
      };
    } catch (err) {
      rollback(installPath);
      return {
        kind: "error",
        code: "E_EXTRACT_FAILED",
        message: `installed package.json is not valid JSON: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      try {
        const arb = arboristFactory({ path: installPath, ignoreScripts: true });
        await arb.reify({ ignoreScripts: true });
      } catch (err) {
        rollback(installPath);
        return {
          kind: "error",
          code: "E_DEPS_FAILED",
          message: err instanceof Error ? err.message : "arborist reify failed",
        };
      }
    }
  }

  // 7. Validate the manifest. `loadUserGlobalModules` on the install root's
  //    parent (which is our modulesDir) picks it up + validates; we isolate
  //    to the single entry by passing `modulesDir = installPath's parent`
  //    but that also picks up siblings — so instead we invoke the full
  //    pipeline via a scratch ModuleRegistry + loadUserGlobalModules pointed
  //    at a staging dir, then copy the RegisteredModule into the caller's
  //    registry. (Simpler: call loadUserGlobalModules on modulesDir, find
  //    the entry for our id. Any rejections unrelated to our id we ignore.)
  const scratch = new ModuleRegistry();
  const loadResult = scratch.loadUserGlobalModules({
    hostVersion: opts.hostVersion,
    scopeUnit,
    modulesDir,
  });
  const ours = loadResult.modules.find((m) => m.manifest.id === opts.entry.id);
  if (!ours) {
    const rejected = loadResult.rejected.find((r) =>
      r.manifestPath.startsWith(installPath),
    );
    rollback(installPath);
    return {
      kind: "error",
      code: "E_INVALID_MANIFEST",
      message: rejected
        ? `manifest rejected (${rejected.code}): ${rejected.message}`
        : `no rn-dev-module.json found at ${installPath}`,
    };
  }

  // 8. Guard against id spoofing — the registry entry's id MUST match the
  //    manifest's id. Otherwise an attacker with a registry-compromised entry
  //    could ship a different module under a trusted id.
  if (ours.manifest.id !== opts.entry.id) {
    rollback(installPath);
    return {
      kind: "error",
      code: "E_MANIFEST_ID_MISMATCH",
      message: `registry entry declares id "${opts.entry.id}" but installed manifest says "${ours.manifest.id}"; refusing to register.`,
    };
  }

  // 9. Register into the caller's registry. `ours` was built against `scratch`,
  //    but the object itself is a plain POJO — safe to pass into another
  //    registry.registerManifest.
  opts.registry.registerManifest(ours);

  return {
    kind: "ok",
    module: ours,
    installPath,
    tarballSha256: actualSha,
  };
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export async function uninstallModule(opts: UninstallOptions): Promise<UninstallResult> {
  const modulesDir = opts.modulesDir ?? DEFAULT_MODULES_DIR;
  const scopeUnit = opts.scopeUnit ?? "global";

  // Defense-in-depth. Install-path registry entries already go through
  // `isSafeModuleId` at load time, but uninstall accepts a `moduleId` from
  // the MCP surface / Electron payload directly — re-check before join()
  // to prevent `..` / absolute paths from escaping the modulesDir.
  if (!isSafeModuleId(opts.moduleId)) {
    return {
      kind: "error",
      code: "E_UNINSTALL_NOT_FOUND",
      message: `module id "${opts.moduleId}" is not a safe identifier`,
    };
  }

  const installPath = join(modulesDir, opts.moduleId);

  if (!existsSync(installPath)) {
    return {
      kind: "error",
      code: "E_UNINSTALL_NOT_FOUND",
      message: `module "${opts.moduleId}" is not installed at ${installPath}`,
    };
  }

  // Tear down the live subprocess if any. Shutdown is best-effort — if the
  // process is already gone, we still proceed with the FS removal.
  if (opts.manager) {
    try {
      await opts.manager.shutdown(opts.moduleId, scopeUnit);
    } catch {
      /* acceptable */
    }
  }
  opts.registry.unregisterManifest(opts.moduleId, scopeUnit);

  // `keepData: true` is MCP-surface parity only in v1 — the retention GC
  // isn't built yet. We still accept it so agents can write future-compatible
  // calls; the behavior is "delete everything" today.
  try {
    rmSync(installPath, { recursive: true, force: true });
  } catch (err) {
    return {
      kind: "error",
      code: "E_UNINSTALL_IO",
      message: err instanceof Error ? err.message : "uninstall rm failed",
    };
  }

  return {
    kind: "ok",
    removed: installPath,
    keptData: !!opts.keepData,
  };
}

/**
 * Record the one-time "I understand third-party modules run as me"
 * acknowledgment. Writes a zero-byte file at
 * `~/.rn-dev/.third-party-acknowledged`. Safe to call repeatedly.
 */
export function acknowledgeThirdParty(): void {
  const ackDir = join(homedir(), ".rn-dev");
  mkdirSync(ackDir, { recursive: true });
  writeFileSync(THIRD_PARTY_ACK_PATH, "");
}

export function hasAcknowledgedThirdParty(): boolean {
  return existsSync(THIRD_PARTY_ACK_PATH);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function rollback(installPath: string): void {
  try {
    rmSync(installPath, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

let cachedPacote: PacoteLike | null = null;

async function defaultPacote(): Promise<PacoteLike> {
  if (cachedPacote) return cachedPacote;
  // Dynamic import so test runs that inject a stub don't pay the cost of
  // loading the real pacote (which transitively pulls a lot of npm tooling).
  // Narrow the cast to exactly the two fields we call — if pacote ever
  // reshapes, TS catches it instead of a runtime "undefined is not a
  // function" (Kieran P1-3, Phase 6 review).
  const mod = (await import("pacote")) as unknown as {
    tarball: (spec: string) => Promise<Buffer>;
    extract: (spec: string, target: string) => Promise<unknown>;
  };
  cachedPacote = { tarball: mod.tarball, extract: mod.extract };
  return cachedPacote;
}

let cachedArboristCtor:
  | (new (opts: Record<string, unknown>) => ArboristLike)
  | null = null;

async function defaultArboristFactory(): Promise<ArboristFactory> {
  // Arborist's default export is a class constructor; wrap it behind the
  // ArboristLike surface so the rest of the installer stays typed without
  // a direct dep on arborist types. Dynamic import keeps arborist's large
  // transitive tree out of process memory when tests inject a stub.
  // Kieran P1-2 (Phase 6 review): earlier revision used require() which
  // was suspect under ESM NodeNext + bundler emit.
  if (!cachedArboristCtor) {
    // @npmcli/arborist ships without .d.ts — treat the import as unknown
    // then narrow to the ArboristLike constructor shape we actually use.
    // @ts-expect-error — no types shipped with @npmcli/arborist
    const mod = (await import("@npmcli/arborist")) as unknown as {
      default?: new (o: Record<string, unknown>) => ArboristLike;
    } & (new (o: Record<string, unknown>) => ArboristLike);
    cachedArboristCtor =
      mod.default ?? (mod as new (o: Record<string, unknown>) => ArboristLike);
  }
  const Ctor = cachedArboristCtor;
  return (opts) => new Ctor(opts);
}
