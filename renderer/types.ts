/** Theme color tokens */
export interface ThemeColors {
  // Legacy (keep to avoid cascading breaks; map to new tokens where sensible)
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
  // Neumorphic tokens
  bgSoft: string;
  surface: string;
  surfaceHi: string;
  ink: string;
  inkSoft: string;
  muted2: string;
  glow: string;
  glowWarm: string;
  ready: string;
  booting: string;
  shadowLight: string;
  shadowDark: string;
  shadowDarkSoft: string;
  glowMedium: string;           /* multi-part shadow string, applied verbatim */
  accentBorder: string;         /* 'transparent' in light */
  bodyBg: string;               /* full radial-gradient string incl. fallback */
}

export interface Theme {
  name: string;
  colors: ThemeColors;
}

/** IPC bridge exposed on window.rndev */
export interface RnDevBridge {
  on: (channel: string, callback: (...args: any[]) => void) => void;
  off: (channel: string, callback: (...args: any[]) => void) => void;
  invoke: (channel: string, ...args: any[]) => Promise<any>;
}

declare global {
  interface Window {
    rndev?: RnDevBridge;
  }
}

export type ViewTab = 'dev-space' | 'devtools' | 'lint-test' | 'metro-logs' | 'settings';

export interface ProfileInfo {
  name: string;
  branch: string;
  platform: string;
  dirty: boolean;
  port: number;
  buildType: string;
}

/** Multi-instance types */
export interface InstanceInfo {
  id: string;
  worktreeName: string;
  branch: string;
  port: number;
  deviceName: string;
  deviceIcon: string;
  platform: string;
  metroStatus: string;
}

export interface InstanceLogs {
  serviceLines: string[];
  metroLines: string[];
  sections: LogSection[];
}

/** A collapsible section in the tool output log */
export interface LogSection {
  id: string;
  title: string;
  icon: string;
  lines: string[];
  status: 'running' | 'ok' | 'warning' | 'error';
  collapsed: boolean;
}

/** IPC event for starting a log section */
export interface SectionStartEvent {
  instanceId: string;
  id: string;
  title: string;
  icon: string;
}

/** IPC event for ending a log section */
export interface SectionEndEvent {
  instanceId: string;
  id: string;
  status: 'ok' | 'warning' | 'error';
}

/** A parsed build error for the ErrorSummary */
export interface BuildError {
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
  count?: number;
}
