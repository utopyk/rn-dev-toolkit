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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(softDark);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyThemeToRoot(t.colors);
    document.documentElement.setAttribute(
      'data-theme',
      t.name.toLowerCase().replace(/\s+/g, '-'),
    );
  }, []);

  useEffect(() => {
    // Mount-only: initial theme application. Subsequent changes go through setTheme (eager).
    applyThemeToRoot(theme.colors);
    document.documentElement.setAttribute(
      'data-theme',
      theme.name.toLowerCase().replace(/\s+/g, '-'),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
