// Safe child-process wrapper shared by the android and ios adapters.
// Every adapter call funnels through here so:
//   - Argv arrays only — never a shell-interpolated string; `shell: false`
//     on every spawn.
//   - Binary-not-found is a distinct error kind from "binary ran but
//     exited non-zero"; the adapters translate both into tool-error
//     responses the MCP layer can surface.
//   - Stdout/stderr are captured to memory with a hard cap (default 32MB)
//     — adb screencap PNGs are ~2-4MB so the cap is generous; it's only
//     there to stop a runaway log tail from OOMing the subprocess.
//
// Never pulls a userland string into an argv slot that could be misread
// as a flag — callers are responsible for quoting device ids correctly
// (adb/simctl both accept arbitrary udids; regex-validate at the caller
// layer if tighter policies are needed).

import { spawn } from "node:child_process";

export interface ExecResult {
  kind: "ok";
  stdout: Buffer;
  stderr: string;
}

export type ExecError =
  | { kind: "not-found"; binary: string; message: string }
  | { kind: "non-zero"; binary: string; code: number | null; stderr: string }
  | { kind: "timeout"; binary: string; timeoutMs: number }
  | { kind: "oversize"; binary: string; limitBytes: number };

export type ExecOutcome = ExecResult | ExecError;

export interface ExecOptions {
  /** Hard wall clock. Default 15s. */
  timeoutMs?: number;
  /** Hard cap on captured stdout. Default 32MB. */
  stdoutLimitBytes?: number;
  /** Supply stdin (rarely needed). */
  input?: string | Buffer;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STDOUT_LIMIT = 32 * 1024 * 1024;

export async function execBinary(
  binary: string,
  argv: readonly string[],
  options: ExecOptions = {},
): Promise<ExecOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT;

  return new Promise<ExecOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [...argv], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        kind: "not-found",
        binary,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let oversizeKilled = false;
    let timedOut = false;
    let settled = false;

    const finish = (outcome: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      finish({ kind: "timeout", binary, timeoutMs });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limit) {
        if (!oversizeKilled) {
          oversizeKilled = true;
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
          finish({ kind: "oversize", binary, limitBytes: limit });
        }
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish({
          kind: "not-found",
          binary,
          message: `binary "${binary}" is not installed or not on PATH`,
        });
        return;
      }
      finish({
        kind: "non-zero",
        binary,
        code: null,
        stderr: err.message,
      });
    });

    child.on("close", (code) => {
      if (timedOut || oversizeKilled) return;
      if (code === 0) {
        finish({
          kind: "ok",
          stdout: Buffer.concat(stdoutChunks),
          stderr,
        });
        return;
      }
      finish({
        kind: "non-zero",
        binary,
        code,
        stderr: stderr.length > 0 ? stderr : `exited with code ${code}`,
      });
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

/** Convenience: run and return stdout as a utf-8 string, or throw. */
export async function execBinaryText(
  binary: string,
  argv: readonly string[],
  options: ExecOptions = {},
): Promise<string> {
  const outcome = await execBinary(binary, argv, options);
  if (outcome.kind === "ok") return outcome.stdout.toString("utf-8");
  throw execErrorToError(outcome);
}

export function execErrorToError(err: ExecError): Error {
  switch (err.kind) {
    case "not-found":
      return new Error(`${err.binary}: ${err.message}`);
    case "non-zero":
      return new Error(
        `${err.binary} exited ${err.code ?? "null"}: ${err.stderr.trim() || "(no stderr)"}`,
      );
    case "timeout":
      return new Error(`${err.binary} timed out after ${err.timeoutMs}ms`);
    case "oversize":
      return new Error(
        `${err.binary} stdout exceeded ${err.limitBytes} bytes (limit)`,
      );
  }
}
