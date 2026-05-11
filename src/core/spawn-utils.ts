// Shared spawn primitives. Both ModuleHostManager and HookSubprocessRunner
// need the same `setpriv --pdeathsig SIGKILL` wrapping, the same SpawnHandle
// shape (process-group kill on POSIX, plain kill on Windows), and the same
// guard against partial ChildProcess plumbing. Lives at this layer because
// those concerns are orthogonal to the module-host vs hook taxonomy.

import { execSync, type ChildProcess } from "node:child_process";

export interface SpawnHandle {
  pid: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export interface SpawnInput {
  command: string;
  args: string[];
}

/**
 * Wrap `input` with `setpriv --pdeathsig SIGKILL --` on Linux when the
 * `setpriv` binary is in PATH, so the kernel kills the child the instant
 * its parent dies. macOS/Windows have no equivalent — caller falls back
 * to the orphan-sweep at next daemon boot.
 */
export function buildSpawnCommand(input: SpawnInput): SpawnInput {
  if (process.platform === "linux" && hasSetpriv()) {
    return {
      command: "setpriv",
      args: ["--pdeathsig", "SIGKILL", "--", input.command, ...input.args],
    };
  }
  return input;
}

let setprivCached: boolean | null = null;
let probeSetpriv: () => boolean = defaultProbeSetpriv;

function defaultProbeSetpriv(): boolean {
  try {
    execSync("which setpriv", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function hasSetpriv(): boolean {
  if (setprivCached !== null) return setprivCached;
  setprivCached = probeSetpriv();
  return setprivCached;
}

/** Test seam — swap in a stub probe and clear the cache. */
export function __setSetprivProbeForTests(impl: () => boolean): void {
  probeSetpriv = impl;
  setprivCached = null;
}

/** Test seam — clear the cache without swapping the probe. */
export function __resetSetprivCacheForTests(): void {
  setprivCached = null;
  probeSetpriv = defaultProbeSetpriv;
}

/**
 * Adapt a Node `ChildProcess` into a `SpawnHandle`. Throws if any of the
 * required pipes (`stdin`/`stdout`/`stderr`) or `pid` is missing — that
 * would indicate the spawn already failed before we got here.
 *
 * On POSIX the returned `kill` targets the negative pid (process group)
 * so detached grandchildren are reaped with the parent. On Windows it
 * targets the child directly — process-group semantics differ and v1
 * does not rely on them there.
 */
export function wrapChild(child: ChildProcess): SpawnHandle {
  if (!child.pid || !child.stdin || !child.stdout || !child.stderr) {
    throw new Error(
      `[spawn-utils] spawn returned an incomplete ChildProcess (pid=${child.pid}).`,
    );
  }
  const pid = child.pid;
  return {
    pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill(signal?: NodeJS.Signals): boolean {
      try {
        if (process.platform === "win32") {
          return child.kill(signal);
        }
        process.kill(-pid, signal ?? "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
    onExit(listener) {
      child.on("exit", listener);
    },
  };
}
