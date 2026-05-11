export const SDK_VERSION = "0.1.0";

export {
  defineModule,
  validateManifest,
  enforceToolPrefix,
  HOOK_FIELDS_HOST_MINIMUM,
  type ManifestError,
  type ValidationResult,
} from "./define-module.js";
export {
  HookError,
  HookErrorCode,
  ModuleError,
  ModuleErrorCode,
  type HookConfigInvalidCause,
  type HookErrorDetails,
  type HookFailedOutcome,
} from "./errors.js";
export type {
  ApiMethodContribution,
  ElectronPanelContribution,
  ManifestHookEntry,
  McpToolContribution,
  ModuleConsumes,
  ModuleContributions,
  ModuleManifest,
  ModuleProvides,
  ModuleSandbox,
  ModuleScope,
  ModuleSignature,
  ModuleTarget,
  TuiViewContribution,
  UsesEntry,
} from "./types.js";
export type { AppInfo, HostApi, Logger } from "./host-rpc.js";
export { runModule } from "./module-runtime.js";
export type {
  ModuleAppInfo,
  ModuleToolContext,
  RunModuleHandle,
  RunModuleOptions,
  ToolHandler,
} from "./module-runtime.js";
export {
  boundedInt,
  num,
  requireNum,
  requireStr,
  ringCursor,
  str,
  strArr,
  type Args,
} from "./args.js";
export {
  MockHookRuntime,
  runHookInProcess,
  type MockHookFire,
  type RunHookInProcessInput,
  type RunHookInProcessOutcome,
  type RunHookInProcessResult,
} from "./test-helpers.js";
export type {
  HookFireFailure,
  HookFireFailureReason,
  HookFireOutcome,
  HookHostCapability,
} from "./hook-host-capability.js";
