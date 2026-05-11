export const CONFIG_VERSION = "0.1.0";

export {
  defineConfig,
  loadConfig,
  validateConfig,
  type ConfigValidationError,
  type DefineConfigInput,
  type LoadConfigOptions,
  type ValidateConfigResult,
} from "./define-config.js";

export type {
  HookContracts,
  HookEntry,
  HookEntryCommon,
  HookEntryFn,
  HookEntryScript,
  HookEntryString,
  HookPhase,
  HookRecord,
  HookRegistrations,
  HookSlotsOf,
  OnFailMode,
  OverrideSlotOf,
  RnDevConfig,
} from "./types.js";
