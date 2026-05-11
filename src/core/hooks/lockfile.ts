// Per-fire lockfile sentinel. Mirrors the lockfile pattern used by
// `src/daemon/orphan-sweep.ts` (modules) but keyed by hook subprocess
// pgid rather than module id — a hook fire is short-lived and there
// can be many in flight, so a flat directory of `<pgid>.lock` is a
// better fit than a per-module directory.
//
// Layout:  ~/.rn-dev/hooks/<pgid>.lock
// Payload: { daemonPid, target, ts }
//
// Why a lockfile rather than scanning /proc/<pid>/environ for the
// `RN_DEV_HOOK_PGID` env var: macOS has no portable way to read another
// process's environment. The lockfile pattern is already proven on this
// codebase by the module orphan-sweep — staying consistent.
//
// Writes are sync to keep the spawn → record window narrow. The
// `release()` path is best-effort; an unlinked-twice lockfile is a
// no-op, and a leftover lockfile after a crash is exactly what
// `sweepOrphanHooks` exists to clean up.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HookLockfileRecord {
  daemonPid: number;
  target: string;
  ts: number;
}

export function hookLockfilesRoot(rootOverride?: string): string {
  if (rootOverride !== undefined) return rootOverride;
  // Tests override via `RN_DEV_HOOKS_ROOT` so the sweep + writer can
  // share a tmpdir without bleeding into the user's real ~/.rn-dev.
  // Same pattern as `RN_DEV_REGISTRY_PATH` in `src/daemon/registry.ts`.
  const env = process.env.RN_DEV_HOOKS_ROOT;
  if (env !== undefined && env.length > 0) return env;
  return join(homedir(), ".rn-dev", "hooks");
}

export function hookLockfilePath(pgid: number, rootOverride?: string): string {
  return join(hookLockfilesRoot(rootOverride), `${pgid}.lock`);
}

export function writeHookLockfile(input: {
  pgid: number;
  daemonPid: number;
  target: string;
  rootOverride?: string;
  now?: () => number;
}): string {
  const path = hookLockfilePath(input.pgid, input.rootOverride);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* ignore — writeFileSync surfaces a useful error if dir is broken */
  }
  const record: HookLockfileRecord = {
    daemonPid: input.daemonPid,
    target: input.target,
    ts: (input.now ?? Date.now)(),
  };
  writeFileSync(path, JSON.stringify(record), { encoding: "utf-8", mode: 0o600 });
  return path;
}

export function unlinkHookLockfile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* may have been swept by a fresh daemon — fine */
  }
}

export function readHookLockfile(path: string): HookLockfileRecord | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.daemonPid !== "number") return null;
  if (typeof v.target !== "string") return null;
  if (typeof v.ts !== "number") return null;
  return { daemonPid: v.daemonPid, target: v.target, ts: v.ts };
}
