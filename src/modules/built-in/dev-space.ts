import React from "react";
import type { RnDevModule } from "../../core/types.js";
import { DevSpaceView } from "../../ui/layout/DevSpaceView.js";
import { useAppContext } from "../../app/AppContext.js";

export { devSpaceManifest } from "./manifests.js";

const DevSpaceViewConnected: React.FC = () => {
  const { metroLines, toolOutputLines, shortcuts, wizardContent, buildPhase } = useAppContext();
  return React.createElement(DevSpaceView, {
    metroLines,
    toolOutputLines,
    shortcuts,
    wizardContent,
    buildPhase,
  });
};

export const devSpaceModule: RnDevModule = {
  id: "dev-space",
  name: "Dev Space",
  icon: "🚀",
  order: 0,
  component: DevSpaceViewConnected,
  shortcuts: [
    { key: "r", label: "Reload", action: async () => {}, showInPanel: true },
    { key: "d", label: "Dev Menu", action: async () => {}, showInPanel: true },
    { key: "l", label: "Lint", action: async () => {}, showInPanel: true },
    { key: "t", label: "Type Check", action: async () => {}, showInPanel: true },
    { key: "c", label: "Clean", action: async () => {}, showInPanel: true },
    { key: "w", label: "Toggle Watcher", action: async () => {}, showInPanel: true },
  ],
};
