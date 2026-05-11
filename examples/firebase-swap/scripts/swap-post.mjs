#!/usr/bin/env node
// Phase H2i — runs under build/post. Restores firebase.config.json
// to a known-clean state (the dev variant) so the next dev session
// doesn't pick up a stale prod swap.
//
// Minimal example writes a sentinel; real impl does the cp/rename.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.RN_DEV_PROJECT_ROOT;
if (!root) {
  console.error("[firebase-swap-post] missing RN_DEV_PROJECT_ROOT");
  process.exit(2);
}

writeFileSync(
  join(root, ".firebase-swap.sentinel"),
  JSON.stringify({
    phase: "post",
    restoredTo: "firebase.dev.json",
    ts: Date.now(),
  }),
);

// Real implementation:
//   import { copyFileSync } from "node:fs";
//   copyFileSync(
//     join(root, "firebase.dev.json"),
//     join(root, "firebase.config.json"),
//   );
process.exit(0);
