#!/usr/bin/env node
// Phase H2h fixture hook — fires under build/pre. Touches a sentinel
// file at <projectRoot>/.h2-hook-fired-pre so the integration test
// can prove the runner reached + executed this script.
//
// Reads RN_DEV_PROJECT_ROOT injected by the hook subprocess runner
// (see src/core/hooks/runner-subprocess.ts:composeEnv). Node-only,
// no shell — Windows-portable per the H2 plan.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.RN_DEV_PROJECT_ROOT;
if (!root) {
  console.error("[h2-hook-pre] missing RN_DEV_PROJECT_ROOT env");
  process.exit(2);
}

writeFileSync(
  join(root, ".h2-hook-fired-pre"),
  JSON.stringify({
    ts: Date.now(),
    target: process.env.RN_DEV_HOOK_TARGET,
    pid: process.pid,
  }),
);
process.exit(0);
