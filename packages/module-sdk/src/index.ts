export const SDK_VERSION = "0.1.0";

export {
  defineModule,
  validateManifest,
  enforceToolPrefix,
  type ManifestError,
  type ValidationResult,
} from "./define-module.js";
export { ModuleError, ModuleErrorCode } from "./errors.js";
export type {
  ApiMethodContribution,
  ElectronPanelContribution,
  McpToolContribution,
  ModuleContributions,
  ModuleManifest,
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
