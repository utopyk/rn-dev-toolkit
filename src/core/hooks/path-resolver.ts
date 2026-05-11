// Resolve a hook script path against the config-file's containing
// directory and capture a `(realPath, dev, ino)` fingerprint at boot
// time. The dispatcher re-resolves at fire time and compares fingerprints
// to detect symlink swaps between registration and dispatch (TOCTOU).
//
// Rules (security-sentinel finding 1):
//   - `~` prefix is rejected outright. Hook scripts live inside the
//     project tree; absolute paths above `configDir` would let a
//     malicious `rn-dev.config.ts` reach `~/.ssh/foo` etc.
//   - Symbolic resolution uses `realpathSync` so a `node_modules/.bin`
//     symlink-chain into a system path is rejected at registration.
//   - The resolved real path must start with `realpath(configDir) + sep`,
//     or equal `realpath(configDir)` (a script literally at the project
//     root is unusual but legal).

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { HookError, HookErrorCode } from "@rn-dev/module-sdk";

/**
 * Captured at registration time so the dispatcher can spot a symlink
 * swap before re-spawning the hook. Comparing `(dev, ino)` of the
 * already-resolved real path is cheaper than re-running `realpathSync`
 * twice.
 */
export interface PathFingerprint {
  /** The script's absolute, symlink-resolved path. */
  realPath: string;
  /** `lstat.dev` of `realPath` — partition-id, stable for the file's lifetime. */
  dev: number;
  /** `lstat.ino` of `realPath` — inode within the partition. */
  ino: number;
}

export interface ResolvedHookScript {
  /** What the config or manifest declared (e.g. `./bin/pre.sh`). */
  declaredPath: string;
  /** Joined against `configDir`, before symlink resolution. */
  absolutePath: string;
  fingerprint: PathFingerprint;
}

/**
 * Resolve `scriptPath` against `configDir`, walking symlinks. Throws
 * `E_HOOK_PATH_OUTSIDE_PROJECT` (a `HookError`) when:
 *   - `scriptPath` starts with `~` (no shell expansion of home dirs);
 *   - the resolved real path escapes `realpath(configDir)`;
 *   - `lstatSync` cannot read the resolved file.
 *
 * Callers MUST cache the returned fingerprint. The dispatcher compares
 * against it at fire time; a mismatch surfaces as
 * `E_HOOK_FAILED { outcome: "path-mutated" }`.
 */
export function resolveHookScript(
  scriptPath: string,
  configDir: string,
): ResolvedHookScript {
  if (scriptPath.startsWith("~")) {
    throw outside(scriptPath, scriptPath, configDir);
  }
  const absolutePath = isAbsolute(scriptPath)
    ? scriptPath
    : resolve(configDir, scriptPath);

  let realPath: string;
  let realConfigDir: string;
  try {
    realPath = realpathSync(absolutePath);
    realConfigDir = realpathSync(configDir);
  } catch (err) {
    throw new HookError(
      `Failed to resolve hook script ${absolutePath}: ${(err as Error).message ?? String(err)}`,
      {
        code: HookErrorCode.E_HOOK_PATH_OUTSIDE_PROJECT,
        script: scriptPath,
        resolved: absolutePath,
        projectRoot: configDir,
      },
    );
  }

  const rootWithSep = realConfigDir.endsWith(sep)
    ? realConfigDir
    : realConfigDir + sep;
  if (realPath !== realConfigDir && !realPath.startsWith(rootWithSep)) {
    throw outside(scriptPath, realPath, realConfigDir);
  }

  const stat = lstatSync(realPath);
  return {
    declaredPath: scriptPath,
    absolutePath,
    fingerprint: {
      realPath,
      dev: Number(stat.dev),
      ino: Number(stat.ino),
    },
  };
}

/**
 * Re-resolve `script` and check the captured fingerprint. Returns
 * `{ ok: true }` on match, `{ ok: false; reason }` on a mismatch
 * (path-mutated). Cheaper than re-throwing — the dispatcher calls this
 * on the hot path and the result drives an audit decision.
 */
export function checkFingerprint(
  resolved: ResolvedHookScript,
): { ok: true } | { ok: false; reason: string } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    const currentReal = realpathSync(resolved.absolutePath);
    if (currentReal !== resolved.fingerprint.realPath) {
      return {
        ok: false,
        reason: `realpath drift: was ${resolved.fingerprint.realPath}, now ${currentReal}`,
      };
    }
    stat = lstatSync(currentReal);
  } catch (err) {
    return {
      ok: false,
      reason: `re-stat failed: ${(err as Error).message ?? String(err)}`,
    };
  }
  if (
    Number(stat.dev) !== resolved.fingerprint.dev ||
    Number(stat.ino) !== resolved.fingerprint.ino
  ) {
    return {
      ok: false,
      reason: `inode drift: dev/ino changed since registration`,
    };
  }
  return { ok: true };
}

function outside(script: string, resolved: string, projectRoot: string): HookError {
  return new HookError(
    `Hook script ${script} resolves to ${resolved}, outside project root ${projectRoot}.`,
    {
      code: HookErrorCode.E_HOOK_PATH_OUTSIDE_PROJECT,
      script,
      resolved,
      projectRoot,
    },
  );
}
