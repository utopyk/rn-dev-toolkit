#!/usr/bin/env node
// Fixture hook — fires under `session/pre`, the slot that runs BEFORE
// Metro starts. Touches a sentinel at <projectRoot>/.hook-fired-session-pre
// so the integration test can prove the runner reached this script, and
// records the timestamp so the test can pin it against the Metro
// "starting" event.
//
// This is the shape a real project uses to switch app environments: the
// env swap has to land while the tree is still quiet, because `.env`
// values are inlined at babel transform time and `.env` is not part of
// Metro's transform cache key. Doing it from `build/pre` is too late by
// construction — Metro has already transformed and cached the old values.
//
// Reads RN_DEV_PROJECT_ROOT injected by the hook subprocess runner
// (see src/core/hooks/runner-subprocess.ts:composeEnv). Node-only,
// no shell — Windows-portable per the H2 plan.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.RN_DEV_PROJECT_ROOT;
if (!root) {
  console.error("[hook-session-pre] missing RN_DEV_PROJECT_ROOT env");
  process.exit(2);
}

writeFileSync(
  join(root, ".hook-fired-session-pre"),
  JSON.stringify({
    ts: Date.now(),
    target: process.env.RN_DEV_HOOK_TARGET,
    pid: process.pid,
  }),
);
process.exit(0);
