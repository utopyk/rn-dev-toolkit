// Daemon protocol version. Bumped on:
//   1. Wire-shape changes (events/subscribe payload, client RPCs, event
//      envelopes) — old client/daemon pairings will mis-parse.
//   2. Daemon-side behavior changes that callers can observe (profile
//      validation, error codes, RPC semantics) — old daemons reject
//      input that new clients consider valid, or vice versa.
//
// `connectToDaemon`'s version handshake treats any mismatch as "stale
// daemon, restart it" — bumping here is how a fix lands in users'
// already-running daemons without requiring manual `kill ~/.rn-dev/pid`.
//
// Kept in sync with `src/cli/commands.ts::program.version(...)` (the
// CLI literal still lives there pending a separate cleanup).
//
// Bump history:
//   0.1.0 — Phase 13.1 onward (lifecycle + multiplexed channel).
//   0.1.1 — profile-guard accepts `null` for `devices.{ios,android}`
//           ([profile-guard.ts:184]). Old daemons rejected null with
//           E_PROFILE_DEVICE_ID even though Profile.devices typed it.
//   0.1.2 — `devtools/restart` client RPC added ([client-rpcs.ts]).
//           Old daemons reject the action with E_RPC_FAILED, and the
//           Electron "Reconnect" button surfaces the failure as
//           "Cannot restart DevTools proxy for Metro on port N" — Bug
//           5 fix only lands once the running daemon picks this up.
export const DAEMON_VERSION = "0.1.2";

// Range of host versions this daemon will accept clients from. Returned
// in `daemon/ping` responses but not currently enforced — kept for
// forward compatibility with a future host/daemon split.
export const HOST_RANGE = ">=0.1.0";
