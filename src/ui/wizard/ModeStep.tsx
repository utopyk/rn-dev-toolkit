import React, { useState, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunMode = "quick" | "dirty" | "clean" | "ultra-clean";

export interface ModeStepProps {
  initialValue?: RunMode;
  onNext: (mode: RunMode) => void;
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// ModeStep
// ---------------------------------------------------------------------------

const MODE_ITEMS: Array<{ label: string; value: RunMode }> = [
  {
    label: "\u26a1 Quick \u2014 Metro only; skip build (app already installed)",
    value: "quick",
  },
  {
    label: "\ud83d\udfe2 Dirty \u2014 Skip clean; still builds",
    value: "dirty",
  },
  {
    label: "\ud83d\udfe1 Clean \u2014 Reinstall modules + pods, then build",
    value: "clean",
  },
  {
    label: "\ud83d\udd34 Ultra Clean \u2014 Full nuclear clean + reinstall",
    value: "ultra-clean",
  },
];

export function ModeStep({
  initialValue = "dirty",
  onNext,
  onBack,
}: ModeStepProps): React.JSX.Element {
  const theme = useTheme();

  const initialIndex = MODE_ITEMS.findIndex(
    (item) => item.value === initialValue
  );

  const [selectedIndex, setSelectedIndex] = useState(
    initialIndex >= 0 ? initialIndex : 0
  );

  useKeyboard(
    useCallback(
      (event: { name: string }) => {
        if (event.name === "escape") {
          onBack();
        } else if (event.name === "up") {
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : MODE_ITEMS.length - 1
          );
        } else if (event.name === "down") {
          setSelectedIndex((prev) =>
            prev < MODE_ITEMS.length - 1 ? prev + 1 : 0
          );
        } else if (event.name === "return") {
          const item = MODE_ITEMS[selectedIndex];
          if (item) {
            onNext(item.value);
          }
        }
      },
      [onBack, onNext, selectedIndex]
    )
  );

  return (
    <box flexDirection="column">
      <text color={theme.fg} bold>
        Select run mode:
      </text>
      <box marginTop={1} flexDirection="column">
        {MODE_ITEMS.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <box key={item.value} paddingLeft={1} paddingRight={1}>
              <text
                color={isSelected ? theme.accent : theme.fg}
                bold={isSelected}
                inverse={isSelected}
              >
                {isSelected ? "\u276f " : "  "}{item.label}
              </text>
            </box>
          );
        })}
      </box>
      <box marginTop={1}>
        <text color={theme.muted}>Press Esc to go back</text>
      </box>
    </box>
  );
}
