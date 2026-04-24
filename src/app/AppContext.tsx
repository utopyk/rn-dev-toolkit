import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { Profile } from "../core/types.js";
import type { MetroClient } from "./client/metro-adapter.js";
import type { WatcherClient } from "./client/watcher-adapter.js";
import type { BuilderClient } from "./client/builder-adapter.js";
import type { DevToolsClient } from "./client/devtools-adapter.js";
import type {
  CaptureMeta,
  NetworkEntry,
  TargetDescriptor,
} from "../core/devtools/types.js";
import { execShellAsync } from "../core/exec-async.js";
import { serviceBus } from "./service-bus.js";

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface ModalConfig {
  title: string;
  message: string;
  icon?: string;
  actions: Array<{ label: string; key: string; accent?: boolean; danger?: boolean }>;
  onAction: (key: string) => void;
}

export interface AppContextValue {
  profile: Profile;
  metroLines: string[];
  toolOutputLines: string[];
  shortcuts: Array<{ key: string; label: string; action: () => void }>;
  runShortcut: (key: string) => void;
  wizardContent?: React.ReactNode;
  buildPhase: string | null;
  modal: ModalConfig | null;
  showModal: (config: ModalConfig) => void;
  dismissModal: () => void;
  // DevTools — Phase 3 Track A. All fields are null / empty until the
  // manager publishes on the service bus (which happens after Metro is up).
  /** Current captured entries for the active worktree, newest last. */
  networkEntries: readonly NetworkEntry[];
  /** Capture envelope metadata (proxy status, epoch, etc). */
  devtoolsMeta: CaptureMeta | null;
  /** Available CDP targets from Metro `/json`. Often length 1 on Hermes. */
  devtoolsTargets: TargetDescriptor[];
  /** Currently selected target id, or null when no target is attached. */
  devtoolsSelectedTargetId: string | null;
  /** Clear the capture ring. No-op when no manager is attached. */
  devtoolsClear: () => void;
  /** Switch the active CDP target. Bumps the buffer epoch. */
  devtoolsSelectTarget: (targetId: string) => Promise<void>;
}

const AppContextInstance = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContextInstance);
  if (!ctx) throw new Error("useAppContext must be used within AppProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface AppProviderProps {
  profile: Profile;
  metro?: MetroClient;
  watcher?: WatcherClient | null;
  worktreeKey?: string;
  startupLog?: string[];
  builder?: BuilderClient;
  wizardContent?: React.ReactNode;
  children: React.ReactNode;
}

export function AppProvider({
  profile,
  metro,
  watcher,
  worktreeKey,
  startupLog,
  builder,
  wizardContent,
  children,
}: AppProviderProps): React.JSX.Element {
  const [metroLines, setMetroLines] = useState<string[]>([]);
  const [toolOutputLines, setToolOutputLines] = useState<string[]>(
    startupLog ?? []
  );
  const [buildPhase, setBuildPhase] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalConfig | null>(null);

  // Live service references updated via service bus
  const [liveMetro, setLiveMetro] = useState<MetroClient | undefined>(metro);
  const [liveBuilder, setLiveBuilder] = useState<BuilderClient | undefined>(builder);
  const [liveWatcher, setLiveWatcher] = useState<WatcherClient | null | undefined>(watcher);
  const [liveWorktreeKey, setLiveWorktreeKey] = useState<string | undefined>(worktreeKey);
  const [liveDevTools, setLiveDevTools] = useState<DevToolsClient | undefined>(undefined);

  // DevTools state — driven by the manager's 'delta' and 'status' events.
  const [networkEntries, setNetworkEntries] = useState<readonly NetworkEntry[]>([]);
  const [devtoolsMeta, setDevtoolsMeta] = useState<CaptureMeta | null>(null);
  const [devtoolsTargets, setDevtoolsTargets] = useState<TargetDescriptor[]>([]);
  const [devtoolsSelectedTargetId, setDevtoolsSelectedTargetId] = useState<string | null>(null);

  // Subscribe to service bus — bridges start-flow → React state
  useEffect(() => {
    const onLog = (text: string) => {
      setToolOutputLines((prev) => [...prev, text].slice(-500));
    };
    const onMetro = (m: MetroClient) => setLiveMetro(m);
    const onBuilder = (b: BuilderClient) => setLiveBuilder(b);
    const onWatcher = (w: WatcherClient) => setLiveWatcher(w);
    const onWorktreeKey = (k: string) => setLiveWorktreeKey(k);
    const onDevTools = (m: DevToolsClient) => setLiveDevTools(m);

    serviceBus.on("log", onLog);
    serviceBus.on("metro", onMetro);
    serviceBus.on("builder", onBuilder);
    serviceBus.on("watcher", onWatcher);
    serviceBus.on("worktreeKey", onWorktreeKey);
    serviceBus.on("devtools", onDevTools);

    return () => {
      serviceBus.off("log", onLog);
      serviceBus.off("metro", onMetro);
      serviceBus.off("builder", onBuilder);
      serviceBus.off("watcher", onWatcher);
      serviceBus.off("worktreeKey", onWorktreeKey);
      serviceBus.off("devtools", onDevTools);
    };
  }, []);

  // Subscribe to DevToolsClient delta + status events. The daemon's own
  // query RPCs (listNetwork, status) are the source of truth — we
  // re-snapshot on every delta flush rather than maintaining a parallel
  // entry list. Refresh is async now (round-trips to daemon) so we
  // guard against the effect re-running while an in-flight fetch is
  // still resolving.
  useEffect(() => {
    if (!liveDevTools) return;
    const manager = liveDevTools;
    let cancelled = false;

    const refresh = async (): Promise<void> => {
      try {
        const [list, status] = await Promise.all([
          manager.listNetwork(),
          manager.status(),
        ]);
        if (cancelled) return;
        setNetworkEntries(list.entries);
        setDevtoolsMeta(list.meta);
        setDevtoolsTargets(status.targets);
        setDevtoolsSelectedTargetId(status.meta.selectedTargetId);
      } catch {
        // daemon RPC failures are transient; the next delta/status
        // event schedules a new refresh
      }
    };

    // Seed with whatever is already captured (the module may mount
    // after the daemon has been running for a while).
    void refresh();

    const onDelta = (): void => {
      void refresh();
    };
    const onStatus = (): void => {
      void refresh();
    };

    manager.on("delta", onDelta);
    manager.on("status", onStatus);
    return () => {
      cancelled = true;
      manager.off("delta", onDelta);
      manager.off("status", onStatus);
    };
  }, [liveDevTools]);

  const devtoolsClear = useCallback(() => {
    if (!liveDevTools) return;
    void liveDevTools.clear();
  }, [liveDevTools]);

  const devtoolsSelectTarget = useCallback(
    async (targetId: string) => {
      if (!liveDevTools) return;
      await liveDevTools.selectTarget(targetId);
    },
    [liveDevTools]
  );

  const showModal = useCallback((config: ModalConfig) => {
    setModal(config);
  }, []);

  const dismissModal = useCallback(() => {
    setModal(null);
  }, []);

  // Subscribe to metro output — uses liveMetro from service bus.
  // The client adapter emits { line, stream } directly from the
  // daemon's metro/log event (no worktreeKey envelope; the session is
  // already 1:1 with a worktree).
  useEffect(() => {
    if (!liveMetro) return;

    const handler = ({ line }: { line: string; stream: "stdout" | "stderr" }) => {
      setMetroLines((prev) => [...prev, line].slice(-500));
    };

    liveMetro.on("log", handler);
    return () => {
      liveMetro.off("log", handler);
    };
  }, [liveMetro]);

  // Subscribe to watcher pipeline events — uses liveWatcher
  useEffect(() => {
    const watcher = liveWatcher;
    if (!watcher) return;

    const onActionComplete = ({
      name,
      result,
    }: {
      name: string;
      result: {
        action: string;
        success: boolean;
        output: string;
        durationMs: number;
      };
    }) => {
      const status = result.success ? "\u2713" : "\u2717";
      const header = `${status} ${name} (${result.durationMs}ms)`;
      const outputLines = result.output
        .split("\n")
        .filter((l) => l.length > 0);
      setToolOutputLines((prev) =>
        [...prev, header, ...outputLines, ""].slice(-500)
      );
    };

    watcher.on("action-complete", onActionComplete);
    return () => {
      watcher.off("action-complete", onActionComplete);
    };
  }, [liveWatcher]);

  // Subscribe to builder events for live build output — uses liveBuilder
  useEffect(() => {
    if (!liveBuilder) return;
    const builder = liveBuilder;

    const onLine = ({ text, replace }: { text: string; replace?: boolean }) => {
      if (replace) {
        setToolOutputLines((prev) => {
          const copy = prev.slice(0, -1);
          copy.push(text);
          return copy.slice(-500);
        });
      } else {
        setToolOutputLines((prev) => [...prev, text].slice(-500));
      }
    };
    const onProgress = ({ phase }: { phase: string }) => {
      setBuildPhase(phase);
      setToolOutputLines((prev) => {
        const copy = prev.slice(0, -1);
        copy.push(`  \u23f3 ${phase}...`);
        return copy.slice(-500);
      });
    };
    const onDone = ({ success, errors, platform }: { success: boolean; errors: Array<{ summary: string; reason?: string; suggestion?: string }>; platform?: string }) => {
      setBuildPhase(null);
      if (success) {
        setToolOutputLines((prev) => [...prev, "\u2705 Build complete!", ""].slice(-500));
      } else {
        const lines = ["\u274c Build failed:"];
        for (const err of errors) {
          lines.push(`  ${err.summary}`);
          if (err.reason) lines.push(`    Reason: ${err.reason}`);
          if (err.suggestion) lines.push(`    Fix: ${err.suggestion}`);
        }
        lines.push("");
        const plat = platform ?? "ios";
        const logPath = `/tmp/rn-dev-logs/build-${plat}.log`;
        // OSC 8 hyperlink: \x1b]8;;URL\x07text\x1b]8;;\x07
        const link = `\x1b]8;;file://${logPath}\x07${logPath}\x1b]8;;\x07`;
        lines.push(`  Full build log: ${link}`);
        lines.push("  Press [o] to dump logs, [y] to copy errors to clipboard");
        lines.push("");
        setToolOutputLines((prev) => [...prev, ...lines].slice(-500));
      }
    };

    builder.on("line", onLine);
    builder.on("progress", onProgress);
    builder.on("done", onDone);
    return () => {
      builder.off("line", onLine);
      builder.off("progress", onProgress);
      builder.off("done", onDone);
    };
  }, [liveBuilder]);

  // Shortcut actions
  const appendToolOutput = useCallback((...lines: string[]) => {
    setToolOutputLines((prev) => [...prev, ...lines].slice(-500));
  }, []);

  const runCommand = useCallback(
    (label: string, cmd: string) => {
      appendToolOutput(`\u25b6 ${label}...`);
      execShellAsync(cmd, {
        cwd: profile.projectRoot,
        timeout: 60000,
      })
        .then((output) => {
          const lines = output.split("\n").filter((l: string) => l.length > 0);
          appendToolOutput(...lines, `\u2713 ${label} complete`, "");
        })
        .catch((err: unknown) => {
          const error = err as { stdout?: string; stderr?: string; message?: string };
          const output = (error.stdout ?? error.stderr ?? error.message ?? "Unknown error")
            .split("\n")
            .filter((l: string) => l.length > 0);
          appendToolOutput(...output, `\u2717 ${label} failed`, "");
        });
    },
    [profile.projectRoot, appendToolOutput]
  );

  const runShortcut = useCallback(
    (key: string) => {
      switch (key) {
        case "r":
          appendToolOutput("\u25b6 Reloading app...");
          if (liveMetro) {
            void liveMetro.reload();
            appendToolOutput("\u2713 Reload signal sent", "");
          } else {
            appendToolOutput("\u2717 Metro not running", "");
          }
          break;
        case "d":
          appendToolOutput("\u25b6 Opening dev menu...");
          if (liveMetro) {
            void liveMetro.devMenu();
            appendToolOutput("\u2713 Dev menu signal sent", "");
          } else {
            appendToolOutput("\u2717 Metro not running", "");
          }
          break;
        case "l":
          runCommand("Lint", "npx eslint . --max-warnings=0 2>&1 || true");
          break;
        case "t":
          runCommand("Type Check", "npx tsc --noEmit 2>&1 || true");
          break;
        case "c":
          appendToolOutput("\u25b6 Clean requires interactive mode. Use 'rn-dev clean' from CLI.", "");
          break;
        case "w":
          if (liveWatcher) {
            // The watcher adapter's isRunning round-trips to the
            // daemon, so we fire-and-forget inside an async IIFE to
            // keep the shortcut switch synchronous.
            (async () => {
              const running = await liveWatcher.isRunning();
              if (running) {
                await liveWatcher.stop();
                appendToolOutput("\u2713 Watcher disabled", "");
              } else {
                appendToolOutput("⏳ Starting watcher (scanning project)...", "");
                await liveWatcher.start();
                appendToolOutput("\u2713 Watcher enabled", "");
              }
            })().catch(() => {
              appendToolOutput("\u2717 Watcher toggle failed", "");
            });
          } else {
            appendToolOutput("\u2717 No on-save actions configured", "");
          }
          break;
        case "Y": {
          // Shift+Y: copy focused panel content to clipboard via pbcopy
          // Uses the focusedPanel from DevSpaceView context
          const content = toolOutputLines.join("\n");
          try {
            const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
            proc.stdin.write(content);
            proc.stdin.end();
            appendToolOutput("✔ Tool output copied to clipboard (" + toolOutputLines.length + " lines)");
          } catch {
            appendToolOutput("✖ pbcopy not available");
          }
          break;
        }
        case "y": {
          // y: copy last error block to clipboard (most common use case)
          const lastErrorIdx = toolOutputLines.findLastIndex(
            (l: string) => l.includes("❌") || l.includes("Build failed")
          );
          const linesToCopy = lastErrorIdx >= 0
            ? toolOutputLines.slice(lastErrorIdx)
            : toolOutputLines.slice(-20); // last 20 lines if no error
          const text = linesToCopy.join("\n");
          try {
            const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
            proc.stdin.write(text);
            proc.stdin.end();
            appendToolOutput(lastErrorIdx >= 0
              ? "✔ Error copied to clipboard (" + linesToCopy.length + " lines)"
              : "✔ Last 20 lines copied to clipboard");
          } catch {
            appendToolOutput("✖ pbcopy not available");
          }
          break;
        }
        case "o": {
          // Dump logs to files for easy copying/inspection
          const fs = require("fs");
          const logDir = "/tmp/rn-dev-logs";
          try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
          const toolFile = `${logDir}/tool-output.log`;
          const metroFile = `${logDir}/metro.log`;
          fs.writeFileSync(toolFile, toolOutputLines.join("\n") + "\n");
          fs.writeFileSync(metroFile, metroLines.join("\n") + "\n");
          appendToolOutput(
            `✔ Logs dumped to:`,
            `  ${toolFile}`,
            `  ${metroFile}`,
            `  Open with: cat ${toolFile}`,
            ""
          );
          break;
        }
        case "q":
          // The daemon owns the session lifecycle — quitting the TUI
          // closes the subscription and issues session/stop, but the
          // daemon itself stays up so other clients (Electron, MCP)
          // keep working. Restore terminal first, then exit; the
          // subscription socket is torn down by the kernel on process
          // exit so we don't need to await stop() here.
          process.stdout.write("\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l");
          process.stdout.write("\x1b[?25h");   // show cursor
          process.stdout.write("\x1b[?1049l"); // exit alternate screen
          process.stdout.write("\x1b[0m");     // reset colors
          process.exit(0);
          break;
        default:
          break;
      }
    },
    [liveMetro, liveWatcher, runCommand, appendToolOutput]
  );

  const shortcuts = [
    { key: "r", label: "Reload", action: () => runShortcut("r") },
    { key: "d", label: "Dev Menu", action: () => runShortcut("d") },
    { key: "l", label: "Lint", action: () => runShortcut("l") },
    { key: "t", label: "Type Check", action: () => runShortcut("t") },
    { key: "c", label: "Clean", action: () => runShortcut("c") },
    { key: "w", label: "Toggle Watcher", action: () => runShortcut("w") },
    { key: "y", label: "Copy Error", action: () => runShortcut("y") },
    { key: "o", label: "Dump Logs", action: () => runShortcut("o") },
    { key: "q", label: "Quit", action: () => runShortcut("q") },
  ];

  const value: AppContextValue = {
    profile,
    metroLines,
    toolOutputLines,
    shortcuts,
    runShortcut,
    wizardContent,
    buildPhase,
    modal,
    showModal,
    dismissModal,
    networkEntries,
    devtoolsMeta,
    devtoolsTargets,
    devtoolsSelectedTargetId,
    devtoolsClear,
    devtoolsSelectTarget,
  };

  return React.createElement(
    AppContextInstance.Provider,
    { value },
    children
  );
}
