/**
 * Idle auto-release for the MCP server's daemon sessions.
 *
 * Why this exists (2026-07-28 diagnosis, memory
 * `idle-mcp-resurrection-pins-ports`): every Claude Code window in an
 * RN project spawns an rn-dev MCP server that attaches a counting
 * session at boot. The daemon has no idle reaper, and the MCP's
 * auto-reconnect makes the attachment immortal — a window parked for
 * six days kept a worktree's daemon + Metro-on-8081 alive, blocking
 * every physical-iOS session on the machine (physical-iOS builds bake
 * port 8081). Killing the daemon didn't help: the idle MCP cold-spawned
 * it back within seconds.
 *
 * The fix: the MCP server releases its sessions after a period with no
 * tool calls (default 60 min) and transparently re-attaches on the next
 * tool call. Releasing drops the daemon-side refcount, so if the parked
 * window was the last client, the session tears down and its Metro port
 * frees. An active window is unaffected: any tool call resets the
 * clock, and the first call after a release boots-or-joins right back.
 */

/** Default: release sessions after 60 minutes without a tool call. */
export const DEFAULT_IDLE_RELEASE_MS = 60 * 60 * 1000;

/** How often the server checks for idleness. */
export const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Resolve the idle-release window from the environment.
 * `RN_DEV_MCP_IDLE_RELEASE_MS` accepts a positive integer (ms) or
 * `0`/`off` to disable idle release entirely. Anything unparseable
 * falls back to the default.
 */
export function resolveIdleReleaseMs(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.RN_DEV_MCP_IDLE_RELEASE_MS;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_RELEASE_MS;
  if (raw.toLowerCase() === "off") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IDLE_RELEASE_MS;
  if (parsed === 0) return null;
  return parsed;
}

/**
 * Tracks tool-call activity against an idle threshold. Pure and
 * clock-injectable so the release policy is unit-testable without a
 * live MCP server.
 */
export class IdleTracker {
  private lastActivityAt: number;

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.lastActivityAt = this.now();
  }

  /** Record activity (a tool call). Resets the idle clock. */
  touch(): void {
    this.lastActivityAt = this.now();
  }

  /** True when the idle window has fully elapsed since the last touch. */
  isIdle(): boolean {
    return this.now() - this.lastActivityAt >= this.idleMs;
  }

  /** Milliseconds since the last recorded activity. */
  idleFor(): number {
    return this.now() - this.lastActivityAt;
  }
}
