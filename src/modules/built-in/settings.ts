import React, { useState, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import type { RnDevModule } from "../../core/types.js";
import { useAppContext } from "../../app/AppContext.js";
import { useTheme } from "../../ui/theme-provider.js";
import { listThemes } from "../../ui/theme-provider.js";

export { settingsManifest } from "./manifests.js";

function SettingsView(): React.JSX.Element {
  const { profile } = useAppContext();
  const theme = useTheme();
  const themes = listThemes();
  const [selectedTheme, setSelectedTheme] = useState(0);

  useKeyboard(
    useCallback(
      (event: { name: string }) => {
        if (event.name === "up") {
          setSelectedTheme((prev) => (prev > 0 ? prev - 1 : themes.length - 1));
        } else if (event.name === "down") {
          setSelectedTheme((prev) => (prev < themes.length - 1 ? prev + 1 : 0));
        }
      },
      [themes.length]
    )
  );

  const row = (label: string, value: string, valueColor?: string) =>
    React.createElement(
      "box",
      { key: label },
      React.createElement("text", { color: theme.muted }, `  ${label}: `),
      React.createElement("text", { color: valueColor ?? theme.fg, bold: !!valueColor }, value)
    );

  return React.createElement(
    "box",
    { flexDirection: "column", padding: 1, backgroundColor: theme.bg },

    // Current Profile section
    React.createElement("text", { color: theme.accent, bold: true }, "\u2699 Current Profile"),
    React.createElement("box", { height: 1 }),
    row("Name", profile.name, theme.accent),
    row("Branch", profile.branch, theme.success),
    row("Platform", profile.platform),
    row("Mode", profile.mode, profile.mode === "ultra-clean" ? theme.warning : undefined),
    row("Metro Port", String(profile.metroPort)),
    row("Build Variant", profile.buildVariant),
    row("Worktree", profile.worktree ?? "(default)"),
    row("Preflight", `${profile.preflight.checks.length} checks, ${profile.preflight.frequency}`),
    row("On-Save", profile.onSave.length > 0
      ? profile.onSave.filter((a: { enabled: boolean }) => a.enabled).map((a: { name: string }) => a.name).join(", ")
      : "none"
    ),

    React.createElement("box", { height: 1 }),

    // Themes section
    React.createElement("text", { color: theme.accent, bold: true }, "\ud83c\udfa8 Themes"),
    React.createElement("text", { color: theme.muted }, "  Use \u2191\u2193 to browse, set via: rn-dev start --theme <name>"),
    React.createElement("box", { height: 1 }),
    ...themes.map((name: string, index: number) =>
      React.createElement(
        "box",
        { key: name, paddingLeft: 2 },
        React.createElement(
          "text",
          {
            color: index === selectedTheme ? theme.accent : theme.fg,
            bold: index === selectedTheme,
            backgroundColor: index === selectedTheme ? theme.selection : undefined,
          },
          `${index === selectedTheme ? "\u25b8 " : "  "}${name}`
        )
      )
    ),

    React.createElement("box", { height: 1 }),

    // Modules section
    React.createElement("text", { color: theme.accent, bold: true }, "\ud83d\udce6 Loaded Modules"),
    React.createElement("box", { height: 1 }),
    React.createElement("text", { color: theme.fg }, "  \ud83d\ude80 Dev Space"),
    React.createElement("text", { color: theme.fg }, "  \ud83e\uddea Lint & Test"),
    React.createElement("text", { color: theme.fg }, "  \ud83d\udce1 Metro Logs"),
    React.createElement("text", { color: theme.fg }, "  \u2699 Settings"),
    React.createElement("box", { height: 1 }),
    React.createElement("text", { color: theme.muted }, '  Add plugins via package.json "rn-dev.plugins" field'),

    React.createElement("box", { height: 1 }),

    // Keyboard reference
    React.createElement("text", { color: theme.accent, bold: true }, "\u2328 Keyboard"),
    React.createElement("box", { height: 1 }),
    React.createElement("text", { color: theme.fg }, "  [Tab] Switch module  [p] Toggle profile  [q] Quit"),
    React.createElement("text", { color: theme.fg }, "  [r] Reload  [d] Dev Menu  [l] Lint  [t] Type Check"),
    React.createElement("text", { color: theme.fg }, "  [c] Clean  [w] Toggle Watcher  [C] Clear Logs"),
  );
}

export const settingsModule: RnDevModule = {
  id: "settings",
  name: "Settings",
  icon: "\u2699",
  order: 90,
  component: SettingsView,
  shortcuts: [],
};

