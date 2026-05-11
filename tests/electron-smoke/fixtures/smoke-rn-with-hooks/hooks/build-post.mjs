#!/usr/bin/env node
// Phase H2h fixture hook — fires under build/post. Same Node-only
// shape as build-pre.mjs.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.RN_DEV_PROJECT_ROOT;
if (!root) {
  console.error("[h2-hook-post] missing RN_DEV_PROJECT_ROOT env");
  process.exit(2);
}

writeFileSync(
  join(root, ".h2-hook-fired-post"),
  JSON.stringify({
    ts: Date.now(),
    target: process.env.RN_DEV_HOOK_TARGET,
    pid: process.pid,
  }),
);
process.exit(0);
