// Default implementation of the `build/discover-bundles` hook.
//
// Parses the project's native build files to enumerate buildable
// "bundles" — iOS schemes or Android buildType×flavor permutations —
// so the setup wizard can offer a picker instead of asking the user
// to type the scheme name. See
// `docs/plans/2026-05-05-build-bundle-hook-design.md` for the contract
// this implements.
//
// Pure-data module: no electron, no daemon, no IPC. Callable from the
// wizard (Electron main) and from vitest, with no setup.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface DiscoverBundlesInput {
  projectRoot: string;
  platform: "ios" | "android";
}

export interface BundleConfiguration {
  /** Stored to `profile.configuration`. */
  name: string;
  /** Human-readable label; defaults to `name`. */
  label?: string;
  /** Pre-selected when the user picks the bundle in the wizard. */
  isDefault?: boolean;
}

export interface BundleDescriptor {
  /** Stored to `profile.scheme`. */
  scheme: string;
  /** Human-readable label; defaults to `scheme`. */
  label?: string;
  /** Available configurations the wizard offers as a sub-dropdown. */
  configurations?: BundleConfiguration[];
  variant?: "debug" | "release" | "any";
  /**
   * Advisory: signing style this bundle expects. `manual` means the
   * project HAS Manual signing intentionally; the codesign prompt
   * should not offer to flip it.
   */
  signingStyle?: "manual" | "automatic" | "either";
  description?: string;
}

export interface DiscoverBundlesOutput {
  bundles: BundleDescriptor[];
}

/**
 * Default discover-bundles handler. Returns `{ bundles: [] }` when the
 * project has no recognizable native layout, so the caller can fall
 * back to the existing untyped `profile.scheme` flow.
 */
export async function discoverBundles(
  input: DiscoverBundlesInput,
): Promise<DiscoverBundlesOutput> {
  if (input.platform === "ios") {
    return { bundles: discoverIosBundles(input.projectRoot) };
  }
  if (input.platform === "android") {
    return { bundles: discoverAndroidBundles(input.projectRoot) };
  }
  return { bundles: [] };
}

// ---------------------------------------------------------------------------
// iOS — parse xcshareddata/xcschemes/*.xcscheme + project.pbxproj
// ---------------------------------------------------------------------------

function discoverIosBundles(projectRoot: string): BundleDescriptor[] {
  const iosDir = join(projectRoot, "ios");
  if (!existsSync(iosDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(iosDir);
  } catch {
    return [];
  }

  const xcodeproj = entries.find((e) => e.endsWith(".xcodeproj"));
  if (!xcodeproj) return [];

  const pbxprojPath = join(iosDir, xcodeproj, "project.pbxproj");
  const pbxproj = safeRead(pbxprojPath);
  const projectConfigurations = parseProjectConfigurations(pbxproj);
  const signingStyle = detectIosSigningStyle(pbxproj);

  const schemesDir = join(iosDir, xcodeproj, "xcshareddata", "xcschemes");
  if (!existsSync(schemesDir)) return [];

  let schemeFiles: string[];
  try {
    schemeFiles = readdirSync(schemesDir).filter((f) => f.endsWith(".xcscheme"));
  } catch {
    return [];
  }

  return schemeFiles
    .map((file) => parseScheme(join(schemesDir, file), file, projectConfigurations, signingStyle))
    .filter((b): b is BundleDescriptor => b !== null);
}

function parseScheme(
  schemePath: string,
  fileName: string,
  projectConfigurations: string[],
  signingStyle: BundleDescriptor["signingStyle"],
): BundleDescriptor | null {
  const xml = safeRead(schemePath);
  if (!xml) return null;

  const scheme = fileName.replace(/\.xcscheme$/, "");
  const launchConfig = matchOne(xml, /<LaunchAction\b[^>]*\bbuildConfiguration\s*=\s*"([^"]+)"/);
  const archiveConfig = matchOne(xml, /<ArchiveAction\b[^>]*\bbuildConfiguration\s*=\s*"([^"]+)"/);

  const configurations: BundleConfiguration[] = projectConfigurations.length > 0
    ? projectConfigurations.map((name) => ({
        name,
        isDefault: name === launchConfig,
      }))
    : launchConfig
      ? [{ name: launchConfig, isDefault: true }]
      : [];

  const variant = guessVariant(launchConfig, archiveConfig);

  return {
    scheme,
    configurations: configurations.length > 0 ? configurations : undefined,
    variant,
    signingStyle,
  };
}

function parseProjectConfigurations(pbxproj: string): string[] {
  if (!pbxproj) return [];
  // Each XCBuildConfiguration block opens with:
  //   <UUID> /* Name */ = {
  //       isa = XCBuildConfiguration;
  // The `/* Name */` comment is what Xcode displays. The `name = X;`
  // field is at the bottom of the block — past nested braces from
  // `buildSettings = { ... }` — so anchoring on the comment label is
  // more reliable than looking forward through the body.
  const names = new Set<string>();
  for (const m of pbxproj.matchAll(
    /\/\*\s*([A-Za-z][A-Za-z0-9_ -]*?)\s*\*\/\s*=\s*\{\s*isa\s*=\s*XCBuildConfiguration\b/g,
  )) {
    names.add(m[1]);
  }
  return [...names];
}

function detectIosSigningStyle(pbxproj: string): BundleDescriptor["signingStyle"] {
  if (!pbxproj) return undefined;
  const manual = (pbxproj.match(/CODE_SIGN_STYLE\s*=\s*Manual/g) ?? []).length;
  const automatic = (pbxproj.match(/CODE_SIGN_STYLE\s*=\s*Automatic/g) ?? []).length;
  if (manual > 0 && automatic === 0) return "manual";
  if (automatic > 0 && manual === 0) return "automatic";
  if (manual === 0 && automatic === 0) return undefined;
  return "either";
}

function guessVariant(
  launchConfig: string | null,
  archiveConfig: string | null,
): BundleDescriptor["variant"] {
  const lower = (launchConfig ?? "").toLowerCase();
  if (lower.includes("debug")) return "debug";
  if (lower.includes("release")) return "release";
  if (archiveConfig && /release/i.test(archiveConfig)) return "any";
  return undefined;
}

// ---------------------------------------------------------------------------
// Android — parse app/build.gradle{,.kts} buildTypes × flavors
// ---------------------------------------------------------------------------

function discoverAndroidBundles(projectRoot: string): BundleDescriptor[] {
  const appDir = join(projectRoot, "android", "app");
  const gradleKts = join(appDir, "build.gradle.kts");
  const gradle = join(appDir, "build.gradle");
  const path = existsSync(gradleKts) ? gradleKts : existsSync(gradle) ? gradle : null;
  if (!path) return [];

  const text = safeRead(path);
  if (!text) return [];

  const buildTypes = parseGradleNames(text, "buildTypes");
  // Always include the implicit `debug` + `release` types Android adds
  // for free even when the buildTypes block is empty.
  const types = uniq([...buildTypes, "debug", "release"]);

  const flavors = parseGradleNames(text, "productFlavors");

  if (flavors.length === 0) {
    // Single-flavor projects: one bundle per buildType.
    return types.map((t) => ({
      scheme: t,
      label: capitalize(t),
      variant: t === "release" ? "release" : "debug",
    }));
  }

  // Multi-flavor: scheme is `<flavor><Type>` (Gradle's variant name
  // convention), with each flavor offering each buildType as a config.
  return flavors.map((flavor) => ({
    scheme: flavor,
    label: capitalize(flavor),
    configurations: types.map((t) => ({
      name: `${flavor}${capitalize(t)}`,
      label: `${capitalize(flavor)} · ${capitalize(t)}`,
      isDefault: t === "debug",
    })),
    variant: "any",
  }));
}

function parseGradleNames(text: string, blockName: string): string[] {
  const block = matchBlock(text, blockName);
  if (!block) return [];
  // Match Gradle DSL declarations: `debug { ... }`, `release {}`,
  // `create("flavorName") { ... }`, `flavorName {}`. Names that are
  // already-known Gradle keywords are skipped.
  const names = new Set<string>();
  for (const m of block.matchAll(/(?:create\s*\(\s*"([^"]+)"\s*\)|^\s*([a-z][A-Za-z0-9_]*))\s*\{/gm)) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    if (GRADLE_RESERVED.has(name)) continue;
    names.add(name);
  }
  return [...names];
}

const GRADLE_RESERVED = new Set([
  "buildTypes",
  "productFlavors",
  "signingConfigs",
  "android",
  "dependencies",
  "if",
  "matchingFallbacks",
  "proguardFiles",
  "manifestPlaceholders",
]);

function matchBlock(text: string, blockName: string): string | null {
  const start = text.indexOf(`${blockName} {`);
  const altStart = text.indexOf(`${blockName}{`);
  const open = start !== -1 ? start : altStart;
  if (open === -1) return null;
  let depth = 0;
  let i = text.indexOf("{", open);
  if (i === -1) return null;
  const blockStart = i + 1;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(blockStart, i);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function matchOne(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m?.[1] ?? null;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
