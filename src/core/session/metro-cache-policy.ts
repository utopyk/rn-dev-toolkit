// When a session's Metro must start cold. Deliberately a leaf module:
// `boot.ts` transitively imports the OpenTUI React renderer, so anything
// living there is unreachable from a plain unit test.

import type { RunMode } from "../types.js";

/**
 * Whether this session's Metro must start with `--reset-cache`.
 *
 * Two independent reasons, either of which forces a cold start:
 *
 * 1. **The profile targets a specific app environment.** `enumerateEnvs`
 *    lands the wizard's pick in `profile.env.APP_ENV`, and the project's
 *    `build/pre` hook rewrites `.env` (or whatever it uses) from that key.
 *    Those values are inlined at babel transform time by
 *    react-native-dotenv and friends, but `.env` is NOT part of Metro's
 *    transform cache key. A warm cache therefore keeps serving the
 *    PREVIOUS env's inlined values, with no error anywhere — which is
 *    exactly how a production build shipped a staging JS bundle on
 *    2026-09-14. `quick`/`dirty` trade the reset away for startup speed;
 *    that trade is not on offer once an env switch is in play, because
 *    the failure is silent and lands in the artifact.
 * 2. **The mode already implies a cold tree.** `clean`/`ultra-clean` have
 *    just deleted node_modules and the Metro caches.
 *
 * Mode can only ever ADD a reset, never remove one.
 */
export function shouldResetMetroCache(profile: {
  mode: RunMode;
  env: Record<string, string>;
}): boolean {
  if (profile.env.APP_ENV) return true;
  return profile.mode !== "dirty" && profile.mode !== "quick";
}
