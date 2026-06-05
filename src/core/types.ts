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
  /**
   * iOS scheme to build (e.g. "Acme" vs "Acme-beta"). Optional —
   * RN CLI defaults to the workspace name when unset, which is right
   * for projects with a single user-facing scheme. Required when the
   * project has multiple schemes with different signing configurations
   * (the acme case: production vs beta have different cert chains).
   * The right long-term home for this is a build hook the mobile app
   * itself contributes — see `docs/plans/2026-05-05-build-bundle-hook-design.md`.
   */
  scheme?: string;
  /**
   * Build configuration name. Optional — defaults via `buildVariant`.
   * Maps to RN CLI's `--mode` on both platforms: the iOS Xcode
   * configuration (e.g. "Debug"/"DebugQA") or the Android Gradle variant
   * (e.g. "betaDebug"). Required for Android projects with product
   * flavors and no plain `debug` variant (the acme case:
   * beta/production).
   */
  configuration?: string;
  /**
   * Android applicationId suffix (e.g. "beta" → `com.acme.beta`),
   * passed as `--appIdSuffix`. Set when the selected Gradle variant
   * applies an `applicationIdSuffix` so run-android launches the
   * installed package rather than the base applicationId. iOS ignores it.
   */
  appIdSuffix?: string;
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
  /**
   * Owning sessionId — Phase D3 made this the identity field. Two
   * sessions for the same worktree on different Metro ports are
   * distinct MetroInstance values keyed by this.
   */
  sessionId: string;
  /**
   * ArtifactStore-hashed worktree key. Phase D3 demoted this from
   * Map-key (identity) to instance metadata — port persistence and
   * MetroLogsStore routing still need it, but two MetroInstance values
   * can legitimately share a worktree.
   */
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
