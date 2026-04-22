import React, { useState, useCallback } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { Profile } from "../../core/types.js";
import { ShortcutBar } from "../components/ShortcutBar.js";
import { StatusBar } from "../components/StatusBar.js";
import { Modal } from "../components/Modal.js";
import { ProfileBanner } from "../components/ProfileBanner.js";
import { useTheme } from "../theme-provider.js";
import { useAppContext } from "../../app/AppContext.js";

export interface MainLayoutModule {
  id: string;
  icon: string;
  name: string;
  /** Optional — modules without a TUI surface render a disabled tab. */
  component?: React.FC;
}

export interface MainLayoutProps {
  profile: Profile;
  modules: MainLayoutModule[];
  shortcuts: Array<{ key: string; label: string }>;
  metroStatus: "starting" | "running" | "error" | "stopped";
  metroPort?: number;
  watcherEnabled: boolean;
}


export function MainLayout({
  profile,
  modules,
  shortcuts,
  metroStatus,
  metroPort,
  watcherEnabled,
}: MainLayoutProps): React.JSX.Element {
  const theme = useTheme();
  const { width, height } = useTerminalDimensions();

  const [activeModuleId, setActiveModuleId] = useState<string>(
    modules[0]?.id ?? ""
  );
  const [bannerCollapsed, setBannerCollapsed] = useState(false);

  const cycleModule = useCallback(() => {
    const currentIndex = modules.findIndex((m) => m.id === activeModuleId);
    const nextIndex = (currentIndex + 1) % modules.length;
    const next = modules[nextIndex];
    if (next) {
      setActiveModuleId(next.id);
    }
  }, [modules, activeModuleId]);

  useKeyboard(
    useCallback(
      (event: { name: string }) => {
        if (event.name === "tab") {
          cycleModule();
        } else if (event.name === "p") {
          setBannerCollapsed((prev) => !prev);
        }
      },
      [cycleModule]
    )
  );

  const { modal } = useAppContext();

  const activeModule = modules.find((m) => m.id === activeModuleId);
  const ActiveComponent = activeModule?.component ?? null;

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.bg}>
      {/* -- Tab bar -- */}
      <box flexDirection="row" gap={1} height={3} paddingLeft={1} backgroundColor={theme.bg}>
        {modules.map((mod) => {
          const isActive = mod.id === activeModuleId;
          return (
            <box
              key={mod.id}
              borderStyle="single"
              borderColor={isActive ? theme.accent : theme.border}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={isActive ? theme.selection : theme.bg}
              onMouseDown={() => setActiveModuleId(mod.id)}
            >
              <text
                color={isActive ? theme.accent : theme.fg}
                bold={isActive}
              >
                {mod.icon} {mod.name}
              </text>
            </box>
          );
        })}
      </box>

      {/* -- Profile banner -- */}
      <ProfileBanner
        profile={profile}
        collapsible={true}
        collapsed={bannerCollapsed}
        onToggle={() => setBannerCollapsed((p) => !p)}
      />

      {/* -- Active module content (or modal overlay) -- */}
      <box flexGrow={1} flexDirection="column" backgroundColor={theme.bg}>
        {modal ? (
          <Modal
            title={modal.title}
            message={modal.message}
            icon={modal.icon}
            actions={modal.actions}
            onAction={modal.onAction}
          />
        ) : (
          ActiveComponent != null && <ActiveComponent />
        )}
      </box>

      {/* -- Shortcut bar -- */}
      <ShortcutBar shortcuts={shortcuts} />

      {/* -- Status bar -- */}
      <StatusBar
        metroStatus={metroStatus}
        metroPort={metroPort}
        watcherEnabled={watcherEnabled}
        activeModule={activeModule?.name ?? ""}
      />
    </box>
  );
}
