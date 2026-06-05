import path from "path";
import fs, { existsSync, rmSync } from "fs";
import { EventEmitter } from "events";
import { randomUUID } from "node:crypto";
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

/**
 * Build the `react-native run-<platform>` argv from a BuildOptions.
 * Pure (no spawn, no I/O) so the CLI-boundary mapping — the part that
 * has caused real bugs (`--configuration` vs `--mode`, missing Android
 * variant/appIdSuffix) — is unit-testable in isolation.
 */
export function composeRunArgs(options: BuildOptions): string[] {
  const { platform, deviceId, port, variant, scheme, configuration, appIdSuffix } = options;
  // `--no-packager`: rn-dev's daemon owns Metro (MetroManager starts
  // `react-native start` on this port). Without this flag, run-ios/
  // run-android each try to launch their OWN packager in a new terminal
  // window (`launchPackager.command`), which collides with the daemon's
  // Metro (`EADDRINUSE`) and litters a terminal window per build. Tell
  // the CLI to skip the bundler — the app loads from the daemon's Metro.
  const args = [`run-${platform}`, "--port", String(port), "--verbose", "--no-packager"];

  if (platform === "ios") {
    if (deviceId) {
      args.push("--udid", deviceId);
    }
    // Scheme + configuration (iOS only). Profile-driven so projects
    // with multiple schemes (acme has Acme + Acme-beta) can pin
    // the right one without relying on RN CLI's default heuristic.
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
    // Android build variant ("mode" in RN CLI parlance, e.g.
    // "betaDebug"). Mirrors iOS's configuration→--mode mapping. Projects
    // with product flavors and no plain `debug` variant (acme:
    // beta/production) need this or run-android fails with an
    // ambiguous-variant error. Fall back to the legacy `--variant
    // release` only when no explicit configuration is given.
    if (configuration) {
      args.push("--mode", configuration);
      // Override the gradle task to `assemble<Variant>` (build only).
      // RN CLI's default `install<Variant>` task installs the APK on
      // EVERY connected device, which reinstalls + restarts the apps of
      // OTHER sessions running on this host — a cross-session disruption
      // under multi-device use (building session B drops session A's
      // running app + DevTools target). RN CLI separately does a
      // device-scoped reverse + `adb -s <deviceId> install` + launch
      // (installAndLaunchOnDevice, unconditional), so assembling and
      // letting that step do the install keeps the build scoped to the
      // one targeted device. Only safe when we know the exact variant
      // (configuration set); otherwise leave RN CLI's default.
      const variantName = `${configuration[0]!.toUpperCase()}${configuration.slice(1)}`;
      args.push("--tasks", `assemble${variantName}`);
    } else if (variant === "release") {
      args.push("--variant", "release");
    }
    // applicationIdSuffix-bearing variants (acme beta →
    // com.acme.beta) need the suffix at the CLI boundary so
    // run-android's launch step targets the installed package.
    if (appIdSuffix) {
      args.push("--appIdSuffix", appIdSuffix);
    }
  }

  return args;
}

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
   * Build configuration / variant name. Optional; defaults via the
   * variant field (`release` → "Release", `debug` → unset so RN CLI
   * picks its default).
   *
   * Both platforms map this to RN CLI's `--mode` flag:
   *  - iOS: the Xcode configuration ("Debug"/"Release"/"DebugQA").
   *  - Android: the Gradle build variant ("betaDebug"/"productionRelease").
   *    Required for projects with product flavors and no plain `debug`
   *    variant — acme's flavors are beta/production, so an unqualified
   *    `run-android` fails with an ambiguous-variant error.
   */
  configuration?: string;
  /**
   * Android applicationId suffix (e.g. "beta" → `com.acme.beta`).
   * Passed as `--appIdSuffix <suffix>`. Needed when the selected Gradle
   * variant applies an `applicationIdSuffix`: run-android's launch step
   * `am start`s the installed package, so without the suffix it tries
   * the base applicationId and fails to resolve the activity. iOS
   * ignores this field.
   */
  appIdSuffix?: string;
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
  /**
   * Phase D3 — discriminator for the build that fired this event.
   * Lets clients correlate `done` with the `BuildHandle` returned from
   * `Builder.build()`, closing the cross-talk vector that the old
   * single-shared-`once("done")` post-hook listener in
   * `client-rpcs.ts` suffered from. Always non-empty; uuid v4.
   */
  buildId: string;
}

/**
 * Returned by `Builder.build()` — replaces the old void-returning
 * fire-and-forget API. The promise resolves exactly once per build
 * (success OR failure OR concurrency-guard rejection), so consumers
 * can `await` it instead of attaching a `.once("done")` listener that
 * cross-talks across concurrent builds on the same Builder instance.
 */
export interface BuildHandle {
  /** Discriminator threaded through the matching `done` event. */
  buildId: string;
  /** Resolves with the final BuildResult exactly once. */
  promise: Promise<BuildResult>;
  /** Cancel an in-flight build subprocess. No-op if already settled. */
  cancel(): void;
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
  /**
   * Phase D3 — per-build promise plumbing. `activeBuildId` and the
   * matching resolver are set when a build's subprocess spawns and
   * cleared in the `exit` handler. The concurrency-guard path
   * resolves synchronously and never sets these. Single-slot is
   * enough because the guard enforces at-most-one-in-flight; if we
   * ever lift that guard, this becomes a Map.
   */
  private activeBuildId: string | null = null;
  private activeResolver: ((r: BuildResult) => void) | null = null;
  private activePromise: Promise<BuildResult> | null = null;

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

  build(options: BuildOptions): BuildHandle {
    const buildId = randomUUID();
    let resolveResult!: (r: BuildResult) => void;
    const promise = new Promise<BuildResult>((resolve) => {
      resolveResult = resolve;
    });

    // Concurrency guard: Phase 13.3 Security P1-2 — before this, every
    // call to build() overwrote `this.process` with a fresh subprocess
    // and orphaned the previous one. A client looping `builder/build`
    // over the daemon socket could fork-bomb xcodebuild/gradle
    // children and OOM the host. Refuse to start a second build while
    // one is live; emit a `done` with a meaningful error so listeners
    // aren't left hanging.
    if (this.process && this.process.exitCode === null) {
      const errors: BuildError[] = [
        {
          source: options.platform === "ios" ? "xcodebuild" : "gradle",
          summary:
            "build already in progress — refusing to start a second build on the same Builder",
          rawOutput: "",
        },
      ];
      this.emitBuiltin("done", {
        success: false,
        platform: options.platform,
        errors,
        buildId,
      });
      // Resolve the rejected build's promise synchronously — the
      // caller's `await handle.promise` sees the BuildResult exactly
      // once and never cross-talks with the in-flight build whose own
      // promise belongs to a different handle.
      resolveResult({ success: false, errors, rawOutput: "" });
      return { buildId, promise, cancel: () => {} };
    }

    const { projectRoot, platform, env } = options;

    const args = composeRunArgs(options);

    this.detectedXcresultPath = null;

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
      const errors: BuildError[] = [{
        source: platform === "ios" ? "xcodebuild" : "gradle",
        summary: `Failed to spawn build process: ${err.message}`,
        rawOutput: err.message,
      }];
      this.emitBuiltin("done", {
        success: false,
        platform,
        errors,
        buildId,
      });
      resolveResult({ success: false, errors, rawOutput: err.message });
      return { buildId, promise, cancel: () => {} };
    }

    this.process = proc;
    this.activeBuildId = buildId;
    this.activeResolver = resolveResult;
    this.activePromise = promise;

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

      this.emitBuiltin("done", { success, errors, platform, buildId });
      const resolver = this.activeResolver;
      const result: BuildResult = { success, errors, rawOutput: this.rawOutput };
      this.process = null;
      this.activeBuildId = null;
      this.activeResolver = null;
      this.activePromise = null;
      resolver?.(result);
    });

    return {
      buildId,
      promise,
      cancel: () => this.cancel(),
    };
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
      // Don't null `this.process` here — the `exit` handler is what
      // settles activeResolver/activePromise. Nulling it eagerly would
      // race the resolver path and leak a hanging promise.
    }
  }

  /**
   * Phase D3 — per-session lifecycle hook. Cancels any in-flight
   * build's subprocess and awaits the resolver chain so `await
   * builder.dispose()` from `SessionServices.dispose()` doesn't leave
   * an orphan resolver behind. Safe to call when idle (no-op).
   */
  async dispose(): Promise<void> {
    const pending = this.activePromise;
    if (pending && this.process) {
      this.cancel();
      try {
        await pending;
      } catch {
        // Promise from build() never rejects — but `await` semantics
        // forced the catch for the unsynchronised type case.
      }
    }
  }

  get isBuilding(): boolean {
    return this.process !== null;
  }
}
