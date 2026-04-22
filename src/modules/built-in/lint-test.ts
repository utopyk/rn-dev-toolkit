import React from "react";
import type { RnDevModule } from "../../core/types.js";
import { useAppContext } from "../../app/AppContext.js";
import { LogViewer } from "../../ui/components/LogViewer.js";
import { useTheme } from "../../ui/theme-provider.js";

export { lintTestManifest } from "./manifests.js";

function LintTestView(): React.JSX.Element {
  const { toolOutputLines } = useAppContext();
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
        "[l] Lint  [t] Type Check  [T] Tests"
      )
    ),
    // Output panel
    React.createElement(
      "box",
      { flexGrow: 1 },
      React.createElement(LogViewer, { lines: toolOutputLines, follow: true, title: "Output", focused: true })
    )
  );
}

export const lintTestModule: RnDevModule = {
  id: "lint-test",
  name: "Lint & Test",
  icon: "\ud83e\uddea",
  order: 10,
  component: LintTestView,
  shortcuts: [],
};

