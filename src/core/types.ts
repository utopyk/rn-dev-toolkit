export interface Profile {
  name: string;
  isDefault: boolean;
  worktree: string | null;
  branch: string;
  platform: "ios" | "android" | "both";
  mode: RunMode;
  metroPort: number;
  devices: DeviceSelection;
  buildVariant: "debug" | "release";
  preflight: PreflightConfig;
  onSave: OnSaveAction[];
  env: Record<string, string>;
  packageManager?: "npm" | "yarn" | "pnpm"; // override auto-detection
  projectRoot: string;
}

export interface PreflightConfig {
  checks: string[];
  frequency: "once" | "always";
}

export interface DeviceSelection {
  ios?: string | null;
  android?: string | null;
}

export interface OnSaveAction {
  name: string;
  enabled: boolean;
  haltOnFailure: boolean;
  command?: string;
  glob?: string;
  showOutput: "tool-panel" | "notification" | "silent";
}

export interface MetroInstance {
  worktree: string;
  port: number;
  pid: number;
  status: "starting" | "running" | "error" | "stopped";
  startedAt: Date;
  projectRoot: string;
}

export interface BuildError {
  source: "xcodebuild" | "gradle";
  summary: string;
  file?: string;
  line?: number;
  reason?: string;
  rawOutput: string;
  suggestion?: string;
}

export interface Artifact {
  worktree: string;
  worktreeHash: string;
  metroPort: number | null;
  checksums: {
    packageJson?: string;
    lockfile?: string;
    podfileLock?: string;
  };
  preflightPassed?: boolean;
  lastBuildPort?: number;
}

export interface Theme {
  name: string;
  colors: ThemeColors;
}

export interface ThemeColors {
  bg: string;
  fg: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  muted: string;
  highlight: string;
  selection: string;
}

export type Platform = "ios" | "android" | "both";
/**
 * Run modes (fastest → slowest):
 * - `quick`       — skip clean AND build; just start Metro. Use when the
 *                   app binary is already installed on the device/sim and
 *                   only the JS bundle needs to be served. Great for
 *                   smoke-testing rn-dev-cli itself.
 * - `dirty`       — skip clean; still builds the native app.
 * - `clean`       — run clean then build.
 * - `ultra-clean` — nuclear clean (delete node_modules, Pods, DerivedData,
 *                   gradle caches) then build.
 */
export type RunMode = "quick" | "dirty" | "clean" | "ultra-clean";

export interface PreflightCheck {
  id: string;
  name: string;
  severity: "error" | "warning";
  platform: "ios" | "android" | "all";
  check: () => Promise<PreflightResult>;
  fix?: () => Promise<boolean>;
}

export interface PreflightResult {
  passed: boolean;
  message: string;
  details?: string;
}

export interface RnDevModule {
  id: string;
  name: string;
  icon: string;
  order: number;
  /**
   * Ink TUI component. Optional — a module with only MCP tools or Electron
   * panels (i.e. no terminal surface) is valid. The TUI renders a disabled
   * tab for modules missing this.
   */
  component?: React.FC;
  shortcuts?: Shortcut[];
}

export interface Shortcut {
  key: string;
  label: string;
  action: () => Promise<void>;
  showInPanel: boolean;
}
