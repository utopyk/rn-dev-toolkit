import path from "path";
import fs, { existsSync, rmSync } from "fs";
import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import { parseXcodebuildErrors, parseGradleErrors, parseXcresultErrors } from "./build-parser.js";

function resolveRnBin(projectRoot: string): [string, ...string[]] {
  const localBin = path.join(projectRoot, "node_modules", ".bin", "react-native");
  if (fs.existsSync(localBin)) {
    return [localBin];
  }
  return ["npx", "react-native"];
}
import type { BuildError } from "./types.js";

// Strip ANSI escape codes
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildOptions {
  projectRoot: string;
  platform: "ios" | "android";
  deviceId?: string;
  port: number;
  variant: "debug" | "release";
  env?: Record<string, string>;
  /**
   * iOS scheme to build. Optional — if not provided, react-native CLI
   * defaults to `<workspace-name>` (e.g. `Acme` for Acme.xcworkspace).
   * Passed through as `--scheme <name>` when set, mirroring
   * `npx react-native run-ios --scheme X`.
   *
   * The user-reported case: acme has both `Acme` and `Acme-beta`
   * schemes, with code-signing wired only for `Acme`. Without an
   * explicit scheme the CLI default works, but the moment the workspace
   * filename ever differs from the right scheme name the build fails
   * silently with a different scheme. Making this explicit closes that
   * ambiguity.
   */
  scheme?: string;
  /**
   * iOS configuration to build (Debug/Release/etc.). Optional; defaults
   * via the variant field (`release` → "Release", `debug` → unset so
   * RN CLI picks Debug). When set explicitly, passed as
   * `--configuration <name>` and overrides the variant default. Useful
   * for projects with custom configurations like "DebugQA" or
   * "ReleaseStaging".
   */
  configuration?: string;
}

export interface BuildResult {
  success: boolean;
  errors: BuildError[];
  rawOutput: string;
}

/**
 * Discriminator on every Builder event payload distinguishing the
 * Builder's own emits ("builtin") from events synthesized by an
 * override hook script ("override"). Override semantics arrive in
 * Phase H4 — H2 only ever emits "builtin", but the field lands on
 * the public payloads now so consumers (TUI / Electron renderer / MCP
 * subscribers) don't have to be updated again when override events
 * start flowing through `BuildHostCapability` in H4.
 *
 * Per architecture-strategist showstopper #5: "build failed" vs
 * "override hook crashed" must be distinguishable by every consumer
 * downstream of the Builder.
 */
export type BuilderEventSource = "builtin" | "override";

export interface BuilderLineEvent {
  source: BuilderEventSource;
  text: string;
  stream: "stdout" | "stderr";
  replace?: boolean;
}

export interface BuilderProgressEvent {
  source: BuilderEventSource;
  phase: string;
}

export interface BuilderDoneEvent {
  source: BuilderEventSource;
  success: boolean;
  errors: BuildError[];
  platform?: "ios" | "android";
}

/**
 * Manages app builds. Spawns `react-native run-ios` or `run-android`
 * as a child process and streams output line-by-line via events.
 *
 * Emits:
 *   'line'     — `BuilderLineEvent`     (source always "builtin")
 *   'progress' — `BuilderProgressEvent` (source always "builtin")
 *   'done'     — `BuilderDoneEvent`     (source always "builtin")
 *
 * `source` reads "builtin" because this class IS the built-in builder.
 * Override-hook events (source: "override") are synthesized by
 * `BuildHostCapability` in Phase H4; consumers can already discriminate.
 */
export class Builder extends EventEmitter {
  private process: ChildProcess | null = null;
  private rawOutput = "";
  private xcresultPath: string | null = null;
  private detectedXcresultPath: string | null = null;

  // Stamp `source: "builtin"` on every emit from this class so wrappers
  // (e.g. `BuildHostCapability` in H4) and downstream consumers can
  // distinguish builtin events from override-synthesized ones without
  // re-checking the call site.
  private emitBuiltin(event: "line", payload: Omit<BuilderLineEvent, "source">): void;
  private emitBuiltin(event: "progress", payload: Omit<BuilderProgressEvent, "source">): void;
  private emitBuiltin(event: "done", payload: Omit<BuilderDoneEvent, "source">): void;
  private emitBuiltin(
    event: "line" | "progress" | "done",
    payload: Record<string, unknown>,
  ): void {
    this.emit(event, { source: "builtin" as const, ...payload });
  }

  build(options: BuildOptions): void {
    // Concurrency guard: Phase 13.3 Security P1-2 — before this, every
    // call to build() overwrote `this.process` with a fresh subprocess
    // and orphaned the previous one. A client looping `builder/build`
    // over the daemon socket could fork-bomb xcodebuild/gradle
    // children and OOM the host. Refuse to start a second build while
    // one is live; emit a `done` with a meaningful error so listeners
    // aren't left hanging.
    if (this.process && this.process.exitCode === null) {
      this.emitBuiltin("done", {
        success: false,
        platform: options.platform,
        errors: [
          {
            source: options.platform === "ios" ? "xcodebuild" : "gradle",
            summary:
              "build already in progress — refusing to start a second build on the same Builder",
            rawOutput: "",
          },
        ],
      });
      return;
    }

    const { projectRoot, platform, deviceId, port, variant, env, scheme, configuration } = options;

    const args = [`run-${platform}`, "--port", String(port), "--verbose"];

    this.detectedXcresultPath = null;

    if (platform === "ios") {
      if (deviceId) {
        args.push("--udid", deviceId);
      }
      // Scheme + configuration (iOS only). Profile-driven so projects
      // with multiple schemes (acme has Acme + Acme-beta) can
      // pin the right one without relying on RN CLI's default heuristic.
      //
      // `react-native run-ios` calls the configuration flag `--mode`
      // (not `--configuration`); pre-existing code passed
      // `--configuration Release` for release builds, which the CLI
      // rejected with `error: unknown option '--configuration'`. The
      // `BuildOptions` field stays semantically-named `configuration`
      // because that's the Xcode term users recognise; we map to
      // `--mode` at the CLI boundary.
      if (scheme) {
        args.push("--scheme", scheme);
      }
      if (configuration) {
        args.push("--mode", configuration);
      } else if (variant === "release") {
        args.push("--mode", "Release");
      }
    } else {
      if (deviceId) {
        args.push("--deviceId", deviceId);
      }
      if (variant === "release") {
        args.push("--variant", "release");
      }
    }

    const [cmd, ...cmdPrefix] = resolveRnBin(projectRoot);

    this.emitBuiltin("progress", { phase: "Building" });
    this.emitBuiltin("line", { text: `Building for ${platform}...`, stream: "stdout" });
    this.emitBuiltin("line", { text: `  ${cmd} ${[...cmdPrefix, ...args].join(" ")}`, stream: "stdout" });

    this.rawOutput = "";

    // Always write build output to a file for debugging
    const buildLogPath = `/tmp/rn-dev-logs/build-${platform}.log`;
    try { require("fs").mkdirSync("/tmp/rn-dev-logs", { recursive: true }); } catch {}
    try { require("fs").writeFileSync(buildLogPath, `Build started: ${new Date().toISOString()}\n${cmd} ${[...cmdPrefix, ...args].join(" ")}\n\n`); } catch {}

    let proc: ChildProcess;
    try {
      proc = spawn(cmd, [...cmdPrefix, ...args], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
    } catch (err: any) {
      this.emitBuiltin("done", {
        success: false,
        platform,
        errors: [{
          source: platform === "ios" ? "xcodebuild" : "gradle",
          summary: `Failed to spawn build process: ${err.message}`,
          rawOutput: err.message,
        }],
      });
      return;
    }

    this.process = proc;

    // Node stream reader — non-blocking, event-driven
    const attachStream = (stream: NodeJS.ReadableStream | null, streamName: "stdout" | "stderr") => {
      if (!stream) return;
      let buffer = "";
      stream.on("data", (chunk: Buffer | string) => {
        const text = stripAnsi(chunk.toString());
        this.rawOutput += text;
        try { require("fs").appendFileSync(buildLogPath, text); } catch {}

        // Detect xcresult bundle path
        const xcresultMatch = text.match(/(?:Writing|Wrote)\s+(?:error\s+)?result\s+bundle\s+to\s+(.+?\.xcresult)/i);
        if (xcresultMatch) {
          this.detectedXcresultPath = xcresultMatch[1].trim();
        }

        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const isMilestone =
            trimmed.startsWith("BUILD SUCCESSFUL") ||
            trimmed.startsWith("Build Succeeded") ||
            trimmed.includes("BUILD FAILED") ||
            trimmed.startsWith("error ") ||
            trimmed.startsWith("info Found") ||
            trimmed.startsWith("info Building") ||
            trimmed.startsWith("info Installing") ||
            trimmed.startsWith("info Launching") ||
            trimmed.startsWith("success ") ||
            trimmed.startsWith("warn ") ||
            trimmed.includes("FAILURE:") ||
            /^\s*error:/.test(trimmed) ||
            /^\/.+:\d+:\d+: (error|fatal error):/.test(trimmed) ||
            // xcbeautify emoji-prefixed errors and warnings
            trimmed.startsWith("❌") ||
            trimmed.startsWith("⚠️") ||
            trimmed.includes("ld: symbol(s) not found") ||
            trimmed.includes("ld: Could not find") ||
            trimmed.includes("linker command failed") ||
            trimmed.includes("clang: error") ||
            trimmed.includes("not found for architecture") ||
            trimmed.includes("framework not found");

          if (trimmed.includes("Compiling") || trimmed.includes("CompileC")) {
            this.emitBuiltin("progress", { phase: "Compiling" });
          } else if (trimmed.includes("Linking") || trimmed.includes("Ld ")) {
            this.emitBuiltin("progress", { phase: "Linking" });
          } else if (trimmed.startsWith("info Installing")) {
            this.emitBuiltin("progress", { phase: "Installing" });
          } else if (trimmed.startsWith("info Launching")) {
            this.emitBuiltin("progress", { phase: "Launching" });
          }

          if (isMilestone) {
            this.emitBuiltin("line", { text: trimmed, stream: streamName, replace: false });
          } else {
            this.emitBuiltin("line", { text: `  ${trimmed.slice(0, 100)}`, stream: streamName, replace: true });
          }
        }
      });
    };

    attachStream(proc.stdout, "stdout");
    attachStream(proc.stderr, "stderr");

    proc.on("exit", (code) => {
      const success = code === 0;
      let errors: BuildError[] = [];

      if (!success) {
        // Strategy 1: Parse xcresult bundle (iOS only, most reliable)
        // Use detected auto-generated path from stderr
        const xcresult = this.detectedXcresultPath;
        if (platform === "ios" && xcresult && existsSync(xcresult)) {
          try {
            errors = parseXcresultErrors(xcresult);
            if (errors.length > 0) {
              this.emitBuiltin("line", { text: `  📋 Extracted ${errors.length} error(s) from xcresult bundle`, stream: "stdout" });
            }
          } catch {
            // Fall through to regex parsing
          }
        }

        // Strategy 2: Parse raw output with regex
        if (errors.length === 0) {
          if (platform === "ios") {
            errors = parseXcodebuildErrors(this.rawOutput);
          } else {
            errors = parseGradleErrors(this.rawOutput);
          }
        }

        // Strategy 3: Extract context from raw output
        // When we only have the generic wrapper error, show the last
        // meaningful lines before "Failed to build" for context
        if (errors.length === 0 || errors.every(e => e.summary.includes("exited with error code"))) {
          const rawLines = this.rawOutput.split("\n").map(l => l.trim()).filter(Boolean);
          const contextLines: string[] = [];
          for (let i = rawLines.length - 1; i >= 0 && contextLines.length < 15; i--) {
            const l = rawLines[i];
            // Skip the generic wrapper and empty/decorative lines
            if (l.includes("exited with error code") || l.includes("To debug build logs") || l.length < 3) continue;
            // Capture anything that looks useful
            if (l.includes("error") || l.includes("Error") || l.includes("FAIL") ||
                l.includes("fatal") || l.includes("warning:") || l.includes("note:") ||
                l.includes("Reason:") || l.includes("required") || l.includes("missing") ||
                l.includes("not found") || l.includes("denied") || l.includes("could not") ||
                l.includes("unable to") || l.includes("BUILD FAILED")) {
              contextLines.unshift(l);
            }
          }

          if (contextLines.length > 0 && errors.every(e => e.summary.includes("exited with error code"))) {
            // Replace the generic error with actual context
            errors = contextLines.map(line => ({
              source: (platform === "ios" ? "xcodebuild" : "gradle") as "xcodebuild" | "gradle",
              summary: line.slice(0, 200),
              rawOutput: line,
            }));
          }

          // If still nothing, add the generic fallback
          if (errors.length === 0) {
            errors.push({
              source: platform === "ios" ? "xcodebuild" : "gradle",
              summary: `Build failed with exit code ${code}. Check Xcode for details.`,
              rawOutput: this.rawOutput.slice(-2000),
            });
          }
        }
      }

      this.emitBuiltin("done", { success, errors, platform });
      this.process = null;
    });
  }

  cancel(): void {
    if (this.process) {
      const pid = this.process.pid;
      try {
        if (pid != null) process.kill(-pid, "SIGKILL");
      } catch {
        try {
          this.process.kill("SIGKILL");
        } catch {}
      }
      this.process = null;
    }
  }

  get isBuilding(): boolean {
    return this.process !== null;
  }
}
