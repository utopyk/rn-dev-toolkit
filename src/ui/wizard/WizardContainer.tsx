import React, { useState } from "react";
import { useTheme } from "../theme-provider.js";
import type { Profile, OnSaveAction, Platform, DeviceSelection, PreflightConfig, RunMode } from "../../core/types.js";
import { WorktreeStep } from "./WorktreeStep.js";
import { BranchStep } from "./BranchStep.js";
import { PlatformStep } from "./PlatformStep.js";
import { ModeStep } from "./ModeStep.js";
import { DeviceStep } from "./DeviceStep.js";
import { PreflightStep } from "./PreflightStep.js";
import { OnSaveStep } from "./OnSaveStep.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WizardState {
  currentStep: number;
  worktree: string | null;
  branch: string;
  platform: Platform;
  mode: RunMode;
  devices: DeviceSelection;
  buildVariant: "debug" | "release";
  preflight: PreflightConfig;
  onSave: OnSaveAction[];
}

export interface WizardContainerProps {
  projectRoot: string;
  existingProfile?: Profile;
  onComplete: (profile: Partial<Profile>) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Step metadata
// ---------------------------------------------------------------------------

const STEP_NAMES = [
  "Worktree",
  "Branch",
  "Platform",
  "Mode",
  "Device",
  "Preflight",
  "On-Save",
] as const;

const TOTAL_STEPS = STEP_NAMES.length;

// ---------------------------------------------------------------------------
// WizardContainer
// ---------------------------------------------------------------------------

export function WizardContainer({
  projectRoot,
  existingProfile,
  onComplete,
  onCancel,
}: WizardContainerProps): React.JSX.Element {
  const theme = useTheme();

  const [state, setState] = useState<WizardState>({
    currentStep: 0,
    worktree: existingProfile?.worktree ?? null,
    branch: existingProfile?.branch ?? "",
    platform: existingProfile?.platform ?? "ios",
    mode: existingProfile?.mode ?? "dirty",
    devices: existingProfile?.devices ?? {},
    buildVariant: existingProfile?.buildVariant ?? "debug",
    preflight: existingProfile?.preflight ?? { checks: [], frequency: "once" },
    onSave: existingProfile?.onSave ?? [],
  });

  // ---------------------------------------------------------------------------
  // Navigation helpers
  // ---------------------------------------------------------------------------

  function goBack(): void {
    setState((prev) => ({
      ...prev,
      currentStep: Math.max(0, prev.currentStep - 1),
    }));
  }

  function handleWorktreeNext(worktree: string | null): void {
    setState((prev) => ({
      ...prev,
      worktree,
      currentStep: prev.currentStep + 1,
    }));
  }

  function handleBranchNext(branch: string): void {
    setState((prev) => ({
      ...prev,
      branch,
      currentStep: prev.currentStep + 1,
    }));
  }

  function handlePlatformNext(platform: Platform): void {
    setState((prev) => ({
      ...prev,
      platform,
      currentStep: prev.currentStep + 1,
    }));
  }

  function handleModeNext(mode: RunMode): void {
    setState((prev) => ({
      ...prev,
      mode,
      currentStep: prev.currentStep + 1,
    }));
  }

  function handleDeviceNext(devices: DeviceSelection): void {
    setState((prev) => ({
      ...prev,
      devices,
      currentStep: prev.currentStep + 1,
    }));
  }

  function handlePreflightNext(preflight: PreflightConfig): void {
    setState((prev) => ({
      ...prev,
      preflight,
      currentStep: prev.currentStep + 1,
    }));
  }

  function handleOnSaveNext(onSave: OnSaveAction[]): void {
    const finalProfile: Partial<Profile> = {
      worktree: state.worktree,
      branch: state.branch,
      platform: state.platform,
      mode: state.mode,
      devices: state.devices,
      buildVariant: state.buildVariant,
      preflight: state.preflight,
      onSave,
      projectRoot,
    };
    onComplete(finalProfile);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const stepName = STEP_NAMES[state.currentStep] ?? "Unknown";

  return (
    <box flexDirection="column">
      {/* Step indicator */}
      <box marginBottom={1}>
        <text color={theme.muted}>
          Step {state.currentStep + 1}/{TOTAL_STEPS} {"\u00b7"}{" "}
        </text>
        <text color={theme.accent} bold>
          {stepName}
        </text>
      </box>

      {/* Current step */}
      {state.currentStep === 0 && (
        <WorktreeStep
          projectRoot={projectRoot}
          onNext={handleWorktreeNext}
          onBack={onCancel}
        />
      )}

      {state.currentStep === 1 && (
        <BranchStep
          projectRoot={projectRoot}
          worktree={state.worktree}
          onNext={handleBranchNext}
          onBack={goBack}
        />
      )}

      {state.currentStep === 2 && (
        <PlatformStep
          initialValue={state.platform}
          onNext={handlePlatformNext}
          onBack={goBack}
        />
      )}

      {state.currentStep === 3 && (
        <ModeStep
          initialValue={state.mode}
          onNext={handleModeNext}
          onBack={goBack}
        />
      )}

      {state.currentStep === 4 && (
        <DeviceStep
          platform={state.platform}
          onNext={handleDeviceNext}
          onBack={goBack}
        />
      )}

      {state.currentStep === 5 && (
        <PreflightStep
          projectRoot={projectRoot}
          platform={state.platform}
          initialPreflight={state.preflight}
          onNext={handlePreflightNext}
          onBack={goBack}
        />
      )}

      {state.currentStep === 6 && (
        <OnSaveStep
          projectRoot={projectRoot}
          initialOnSave={state.onSave}
          onNext={handleOnSaveNext}
          onBack={goBack}
        />
      )}
    </box>
  );
}
