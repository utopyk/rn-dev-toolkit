import React, { useCallback, useMemo } from 'react';
import { useTheme } from '../theme/ThemeProvider';
import type { Theme } from '../types';
import { ModuleConfigForm } from '../components/ModuleConfigForm';
import './Settings.css';

// Phase 5c — Settings panel is now driven by the `settings` module's
// `contributes.config.schema`. Theme picker stays as a visual grid on top
// (it's a degree of polish that a generic form can't match), but the
// boolean + free-form fields come from the schema so the Settings panel
// and the MCP `modules/config/*` surface share a single source of truth.

const themes: Theme[] = [
  {
    name: 'Midnight',
    colors: {
      bg: '#1a1b26', fg: '#c0caf5', border: '#565f89', accent: '#7aa2f7',
      success: '#9ece6a', warning: '#e0af68', error: '#f7768e',
      muted: '#565f89', highlight: '#bb9af7', selection: '#283457',
    },
  },
  {
    name: 'Ember',
    colors: {
      bg: '#1c1210', fg: '#e8d5c4', border: '#6b4c3b', accent: '#e8976c',
      success: '#a3be8c', warning: '#ebcb8b', error: '#bf616a',
      muted: '#6b4c3b', highlight: '#d08770', selection: '#3b2520',
    },
  },
  {
    name: 'Arctic',
    colors: {
      bg: '#1b2330', fg: '#d8dee9', border: '#4c566a', accent: '#88c0d0',
      success: '#a3be8c', warning: '#ebcb8b', error: '#bf616a',
      muted: '#4c566a', highlight: '#b48ead', selection: '#2e3440',
    },
  },
  {
    name: 'Neon Drive',
    colors: {
      bg: '#0d0d1a', fg: '#e0e0ff', border: '#3d3d5c', accent: '#00ffcc',
      success: '#39ff14', warning: '#ffcc00', error: '#ff0055',
      muted: '#3d3d5c', highlight: '#ff00ff', selection: '#1a1a33',
    },
  },
];

// Mirror of the `settingsManifest.contributes.config.schema` declared in
// `src/modules/built-in/manifests.ts`. Duplicated rather than imported so
// the renderer doesn't transitively pull server-side module code. Any
// schema change needs to land in both places — covered by a renderer
// unit test so drift surfaces loudly.
//
// The `theme` field is modeled as an enum over the theme names so the
// generic form renders it as a select. The visual theme picker above
// handles the actual application; the form is an "agent-native parity"
// surface so MCP / future agents can set the theme by name.
const SETTINGS_CONFIG_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    theme: {
      type: 'string' as const,
      description:
        'Active UI theme name. Changing via this field switches the theme.',
      enum: themes.map((t) => t.name),
    },
    showExperimentalModules: {
      type: 'boolean' as const,
      description:
        'Surface modules that declare `experimental: true` in their manifest.',
    },
  },
};

export function Settings() {
  const { theme: currentTheme, setTheme } = useTheme();

  const handleSaved = useCallback(
    (config: Record<string, unknown>) => {
      const themeName = config.theme;
      if (typeof themeName === 'string') {
        const match = themes.find((t) => t.name === themeName);
        if (match) setTheme(match);
      }
    },
    [setTheme],
  );

  const schema = useMemo(() => SETTINGS_CONFIG_SCHEMA, []);

  return (
    <div className="settings-view">
      <h2 className="settings-title">Settings</h2>

      <div className="settings-section">
        <h3 className="settings-section-title">Theme</h3>
        <div className="theme-grid">
          {themes.map((t) => (
            <button
              key={t.name}
              className={`theme-card${currentTheme.name === t.name ? ' active' : ''}`}
              onClick={() => setTheme(t)}
            >
              <div className="theme-preview" style={{ background: t.colors.bg }}>
                <div className="theme-swatch" style={{ background: t.colors.accent }} />
                <div className="theme-swatch" style={{ background: t.colors.success }} />
                <div className="theme-swatch" style={{ background: t.colors.error }} />
                <div className="theme-swatch" style={{ background: t.colors.highlight }} />
              </div>
              <div className="theme-name">{t.name}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Preferences</h3>
        <p className="settings-section-description">
          Persisted to <code>~/.rn-dev/modules/settings/config.json</code>.
          MCP clients can read/write these via <code>modules/config/get</code>{' '}
          / <code>modules/config/set</code>.
        </p>
        <ModuleConfigForm
          moduleId="settings"
          schema={schema}
          onSaved={handleSaved}
        />
      </div>
    </div>
  );
}

export { SETTINGS_CONFIG_SCHEMA };
