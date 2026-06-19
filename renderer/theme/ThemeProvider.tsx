import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Theme, ThemeColors } from '../types';
import { softDark } from './themes.js';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: softDark,
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function applyThemeToRoot(colors: ThemeColors) {
  const root = document.documentElement;
  root.style.setProperty('--bg', colors.bg);
  root.style.setProperty('--bg-soft', colors.bgSoft);
  root.style.setProperty('--surface', colors.surface);
  root.style.setProperty('--surface-hi', colors.surfaceHi);
  root.style.setProperty('--ink', colors.ink);
  root.style.setProperty('--ink-soft', colors.inkSoft);
  root.style.setProperty('--fg', colors.ink);                 /* legacy alias */
  root.style.setProperty('--muted', colors.muted);
  root.style.setProperty('--muted-2', colors.muted2);
  root.style.setProperty('--glow', colors.glow);
  root.style.setProperty('--glow-warm', colors.glowWarm);
  root.style.setProperty('--accent', colors.glow);            /* legacy alias */
  root.style.setProperty('--ready', colors.ready);
  root.style.setProperty('--booting', colors.booting);
  root.style.setProperty('--success', colors.ready);          /* legacy alias */
  root.style.setProperty('--warning', colors.booting);        /* legacy alias */
  root.style.setProperty('--error', colors.error);
  root.style.setProperty('--shadow-light', colors.shadowLight);
  root.style.setProperty('--shadow-dark', colors.shadowDark);
  root.style.setProperty('--shadow-dark-soft', colors.shadowDarkSoft);
  root.style.setProperty('--glow-medium', colors.glowMedium);
  root.style.setProperty('--accent-border', colors.accentBorder);
  root.style.setProperty('--body-bg', colors.bodyBg);
  root.style.setProperty('--border', colors.accentBorder === 'transparent' ? 'rgba(26,31,46,0.15)' : colors.accentBorder);
  root.style.setProperty('--selection', colors.surfaceHi);
  root.style.setProperty('--highlight', colors.glow);
  root.style.setProperty('--panel-focus', colors.surfaceHi);
}

/**
 * Push the current theme's tokens to module panels. Panels are isolated
 * WebContentsViews that do NOT inherit the renderer's CSS, so without this
 * they'd be stuck on their hardcoded fallback palette. Best-effort and
 * guarded: `window.rndev` is absent under jsdom tests, so this no-ops there.
 */
function reportThemeToPanels(colors: ThemeColors) {
  const bridge = (window as unknown as {
    rndev?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };
  }).rndev;
  if (!bridge?.invoke) return;
  const vars: Record<string, string> = {
    '--bg': colors.bg,
    '--bg-soft': colors.bgSoft,
    '--surface': colors.surface,
    '--surface-hi': colors.surfaceHi,
    '--ink': colors.ink,
    '--ink-soft': colors.inkSoft,
    '--muted': colors.muted,
    '--muted-2': colors.muted2,
    '--glow': colors.glow,
    '--ready': colors.ready,
    '--booting': colors.booting,
    '--error': colors.error,
  };
  try { void bridge.invoke('modules:report-theme', vars).catch(() => {}); } catch { /* ignore */ }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(softDark);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyThemeToRoot(t.colors);
    document.documentElement.setAttribute(
      'data-theme',
      t.name.toLowerCase().replace(/\s+/g, '-'),
    );
    reportThemeToPanels(t.colors);
  }, []);

  useEffect(() => {
    // Mount-only: initial theme application. Subsequent changes go through setTheme (eager).
    applyThemeToRoot(theme.colors);
    document.documentElement.setAttribute(
      'data-theme',
      theme.name.toLowerCase().replace(/\s+/g, '-'),
    );
    reportThemeToPanels(theme.colors);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
