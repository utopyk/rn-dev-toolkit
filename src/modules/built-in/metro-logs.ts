import React from "react";
import type { RnDevModule } from "../../core/types.js";
import { useAppContext } from "../../app/AppContext.js";
import { LogViewer } from "../../ui/components/LogViewer.js";
import { useTheme } from "../../ui/theme-provider.js";

export { metroLogsManifest } from "./manifests.js";

function MetroLogsView(): React.JSX.Element {
  const { metroLines } = useAppContext();
  const theme = useTheme();

  return React.createElement(
    "box",
    { flexDirection: "column", flexGrow: 1, backgroundColor: theme.bg },
    // Instructions
    React.createElement(
      "box",
      { paddingLeft: 1, paddingRight: 1 },
      React.createElement(
        "text",
        { color: theme.muted },
        "[C] Clear Logs  [r] Reload  [d] Dev Menu"
      )
    ),
    // Full-screen metro log viewer
    React.createElement(
      "box",
      { flexGrow: 1 },
      React.createElement(LogViewer, { lines: metroLines, follow: true, title: "Metro Logs", focused: true })
    )
  );
}

export const metroLogsModule: RnDevModule = {
  id: "metro-logs",
  name: "Metro Logs",
  icon: "\ud83d\udce1",
  order: 20,
  component: MetroLogsView,
  shortcuts: [
    { key: "f", label: "Filter Logs", action: async () => {}, showInPanel: true },
    { key: "C", label: "Clear Logs", action: async () => {}, showInPanel: true },
  ],
};

