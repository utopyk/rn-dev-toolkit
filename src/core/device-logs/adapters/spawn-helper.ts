/**
 * Shared spawn + line-buffer helper for device-log adapters.
 *
 * Same chunk-to-line pattern MetroManager uses (see src/core/metro.ts:460
 * — `buffer += chunk; lines = buffer.split('\n'); buffer = lines.pop()`).
 * Each non-empty line goes through the supplied `parseLine`; non-null
 * results push to the store.
 */

import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import type { DeviceLogsStore, AppendArgs } from "../buffer.js";
import type { SpawnHandle } from "../tap-manager.js";

export interface LineTapOptions {
  cmd: string;
  args: readonly string[];
  store: DeviceLogsStore;
  /** Parser: line → store args, or null when the line should be dropped
   *  (header, blank, unrecognized continuation, etc.). */
  parseLine: (line: string) => Omit<AppendArgs, "at"> | null;
  /** Optional env / cwd / shell — passed straight to `spawn()`. */
  spawnOptions?: SpawnOptions;
  /** Called when the subprocess exits naturally (kill() bypasses this). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** stderr collector — used for surfacing tap-startup errors like
   *  "idevicesyslog: command not found" or "adb: device not found".
   *  Receives every stderr line (still trimmed for the chunk pattern). */
  onStderr?: (line: string) => void;
}

export function createLineTap(opts: LineTapOptions): SpawnHandle {
  const proc: ChildProcessWithoutNullStreams = spawn(
    opts.cmd,
    [...opts.args],
    {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts.spawnOptions,
    },
  ) as ChildProcessWithoutNullStreams;

  let stdoutBuf = "";
  let stderrBuf = "";

  proc.stdout.on("data", (chunk: Buffer | string) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const parsed = opts.parseLine(line);
      if (parsed) opts.store.append(parsed);
    }
  });

  if (opts.onStderr) {
    proc.stderr.on("data", (chunk: Buffer | string) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line) opts.onStderr!(line);
      }
    });
  }

  let killed = false;
  proc.once("exit", (code, signal) => {
    if (killed) return;
    opts.onExit?.(code, signal);
  });
  proc.once("error", () => {
    // Spawn-time errors (cmd not found) — surface via onExit so the
    // tap descriptor flips to "error" if we ever add status-after-start
    // tracking. For Phase 2 we already caught the startup error path
    // before this point via the availability check; this handler is
    // defense-in-depth.
    if (killed) return;
    opts.onExit?.(null, null);
  });

  return {
    kill: () => {
      killed = true;
      // SIGTERM first; the child should exit cleanly. If it doesn't
      // (rare), the OS reaps it eventually — we don't follow up with
      // SIGKILL because the host's shutdown is what would orphan us.
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    },
  };
}
