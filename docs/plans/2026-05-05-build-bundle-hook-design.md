---
title: Build-bundle hook — mobile app declares available schemes/configurations
type: design
status: draft
date: 2026-05-05
---

# Problem

The user has multiple iOS schemes in `acme-mobile-app`: `Acme` (production, signing wired) and `Acme-beta` (beta, different cert chain). Today the only way to pick a scheme is:

- React Native CLI's default heuristic — picks `<workspace-name>` (`Acme`). Works by accident here; would silently pick the wrong thing on any project where workspace name doesn't match the canonical scheme.
- The new `profile.scheme` + `profile.configuration` fields (this commit) — explicit, but **unmanaged**: the user has to know the names and type them into the profile JSON. The wizard has no way to enumerate available schemes for the user to pick from.

The right design is: the mobile app itself declares its available schemes/configurations through a build hook. Then:

- The setup wizard offers a dropdown populated by the hook's output, instead of asking the user to type the scheme name.
- The daemon/builder uses the picked scheme + configuration verbatim — no heuristics.
- Adding a new scheme to the Xcode project automatically surfaces it in the wizard the next time the project is opened.

This document is the contract for that hook.

# Hook name

`build/discover-bundles` — declared by the mobile app (or a project-local `rn-dev.config.ts`), called by rn-dev's wizard before showing the scheme picker.

# Input

```ts
interface DiscoverBundlesInput {
  /** Absolute path of the project root (typically the git worktree). */
  projectRoot: string;
  /** Platform the user is configuring (a wizard with platform="both" calls
   *  the hook twice — once per platform). */
  platform: "ios" | "android";
}
```

# Output

```ts
interface BundleDescriptor {
  /** Stable identifier — what gets persisted to `profile.scheme`. */
  scheme: string;
  /** Optional human-readable label. Defaults to `scheme` when omitted. */
  label?: string;
  /** Optional configurations available for this scheme. The wizard
   *  shows these as a sub-dropdown next to the scheme picker. */
  configurations?: Array<{
    name: string;        // -> profile.configuration
    label?: string;      // human-readable; defaults to name
    /** Mark which configuration is the canonical default for this
     *  scheme. The wizard pre-selects this when the user picks the
     *  scheme. */
    isDefault?: boolean;
  }>;
  /** Optional advisory: which buildVariant the bundle is meant for.
   *  Lets the wizard hide release-only bundles from a debug-mode
   *  profile and vice versa. */
  variant?: "debug" | "release" | "any";
  /** Optional advisory: which signing style the bundle expects.
   *  rn-dev's settleCodeSigning prompt uses this to skip the
   *  auto-flip-to-Automatic prompt for bundles the project has
   *  intentionally configured Manual for. The user-reported bug was
   *  that this prompt damaged acme's intentional Manual signing. */
  signingStyle?: "manual" | "automatic" | "either";
  /** Free-form description shown in the wizard. */
  description?: string;
}

type DiscoverBundlesOutput = {
  bundles: BundleDescriptor[];
};
```

# Default implementation (when no hook is registered)

For iOS: parse the project's `xcshareddata/xcschemes/*.xcscheme` files + the workspace's referenced project, return one `BundleDescriptor` per shared scheme. Configurations come from each scheme's `<BuildConfiguration>` entries.

For Android: parse `app/build.gradle{,.kts}` `buildTypes` + `flavorDimensions`/`productFlavors`, return one `BundleDescriptor` per `<buildType><flavor>` permutation.

This default is what `acme-mobile-app` would get for free if it didn't register a hook — which means just adding `profile.scheme` to the wizard's dropdown closes 90% of the user-reported bug class without the project needing to do anything.

# Project-side override (acme-specific example)

Projects with non-trivial bundle stories (acme, multi-target apps, white-labelled products) register a hook in `rn-dev.config.ts`:

```ts
import { defineRnDevConfig } from "@rn-dev/config";

export default defineRnDevConfig({
  hooks: {
    "build/discover-bundles": async ({ projectRoot, platform }) => {
      if (platform !== "ios") return { bundles: [] };
      return {
        bundles: [
          {
            scheme: "Acme",
            label: "Acme (production signing)",
            configurations: [
              { name: "Debug", isDefault: true },
              { name: "Release" },
            ],
            signingStyle: "manual",
            description: "Production app — uses CI/Fastlane certs.",
          },
          {
            scheme: "Acme-beta",
            label: "Acme Beta",
            configurations: [
              { name: "Debug", isDefault: true },
              { name: "Release" },
            ],
            signingStyle: "manual",
            description: "Beta channel — different bundle id + entitlements.",
          },
        ],
      };
    },
  },
});
```

# Wizard flow change

Pre-hook: the wizard's iOS step has no scheme picker — the profile is created with `scheme: undefined` and the build relies on the RN CLI default.

Post-hook: the wizard's iOS step:

1. Calls the `build/discover-bundles` hook with `{projectRoot, platform: "ios"}`.
2. Renders a dropdown of `bundles[].label`. The user picks one.
3. If that bundle has multiple `configurations`, renders a sub-dropdown.
4. Persists `scheme` + `configuration` to the profile.
5. Uses `signingStyle` to gate the `settleCodeSigning` prompt — `signingStyle: "manual"` means the project HAS Manual signing intentionally and we should NOT auto-flip to Automatic.

# Builder change

No change beyond what this commit already lands: `BuildOptions.scheme` + `BuildOptions.configuration` flow through to `react-native run-ios --scheme X --configuration Y`. The hook just populates the profile correctly so those fields are always set.

# Why this design

- **The mobile app owns its bundle story.** acme knows which schemes are real-world callable; rn-dev shouldn't have to read pbxproj internals to guess.
- **Defaults work.** A project with no hook gets free auto-discovery from the standard Xcode/Gradle layouts. Most projects never need to author the hook.
- **One consistent permission surface.** The hook contract is the H1/H2 hook system's existing contribution-point pattern — same registration, same lifecycle, same audit.
- **Closes adjacent bugs.** `signingStyle` carrying through means the auto-flip-to-Automatic modal stops damaging projects that have Manual signing on purpose. That's the user-reported bug from the live acme session.

# What this commit does NOT do

- The hook contract is documented. Implementing the hook handler, the wizard's bundle-picker UI, and the auto-discovery default is the next phase.
- The `scheme`/`configuration` fields on `Profile` already work — they're the immediate-fix tactical bridge until the hook lands.
- `settleCodeSigning` still asks. Threading `signingStyle` from the discovered bundle into the prompt's gating logic is part of the hook implementation phase, not this commit.

# Out of scope (future)

- Per-target signing identities (a rare advanced case).
- Watchkit / app-extension target enumeration.
- macOS / tvOS / visionOS schemes (the hook contract supports them via `platform` extension; the default implementation doesn't enumerate them yet).
