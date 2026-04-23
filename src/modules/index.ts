export {
  ModuleRegistry,
  SENSITIVE_PERMISSION_PREFIXES,
  isSensitivePermission,
  S6_WARNING_PATTERN,
  S6_WARNING_EXAMPLE,
} from "./registry.js";
export { devSpaceModule } from "./built-in/dev-space.js";
export { settingsModule } from "./built-in/settings.js";
export { lintTestModule } from "./built-in/lint-test.js";
export {
  devSpaceManifest,
  lintTestManifest,
  settingsManifest,
} from "./built-in/manifests.js";
export {
  createMarketplaceCapability,
  marketplaceManifest,
  MARKETPLACE_CAPABILITY_ID,
  registerMarketplaceBuiltIn,
  type MarketplaceCapability,
  type MarketplaceModuleEntry,
} from "./built-in/marketplace.js";
