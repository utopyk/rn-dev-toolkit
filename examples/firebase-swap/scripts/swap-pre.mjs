#!/usr/bin/env node
// Phase H2i — runs under build/pre. Reads RN_DEV_PROFILE_JSON from the
// env (the hook subprocess runner injects this with the validated
// profile shape) so the swap can branch on `profile.buildVariant` —
// "release" → swap in firebase.prod.json; "debug" → firebase.dev.json.
//
// In this minimal example we don't actually move files; we just touch
// a sentinel that proves the hook ran. Replace the sentinel block
// with your real `cp` / `rename` calls.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.RN_DEV_PROJECT_ROOT;
const profileJson = process.env.RN_DEV_PROFILE_JSON;
if (!root || !profileJson) {
  console.error("[firebase-swap-pre] missing RN_DEV_PROJECT_ROOT or RN_DEV_PROFILE_JSON");
  process.exit(2);
}

const profile = JSON.parse(profileJson);
const variant = profile.buildVariant ?? "debug";

writeFileSync(
  join(root, ".firebase-swap.sentinel"),
  JSON.stringify({
    phase: "pre",
    variant,
    swappedTo: variant === "release" ? "firebase.prod.json" : "firebase.dev.json",
    ts: Date.now(),
  }),
);

// Real implementation:
//   import { copyFileSync } from "node:fs";
//   const src = variant === "release"
//     ? join(root, "firebase.prod.json")
//     : join(root, "firebase.dev.json");
//   copyFileSync(src, join(root, "firebase.config.json"));
process.exit(0);
