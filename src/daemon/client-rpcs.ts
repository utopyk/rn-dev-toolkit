// Client-facing RPC handlers. Every message here requires a running
// session — the daemon holds exactly one supervisor per worktree, and
// the session's wired services back every call. RPCs that arrive while
// the session is stopped or starting respond with E_SESSION_NOT_RUNNING
// so clients can show a coherent "daemon up, session down" state rather
// than silently hanging.
//
// One daemon = one worktree, so no worktreeKey is accepted from the
// client — the supervisor supplies its own. Accepting a client-provided
// worktreeKey would let a compromised client address another worktree's
// services if we ever relax the 1:1 rule.

import path from "node:path";
import { realpathSync } from "node:fs";
import type { IpcMessage, IpcMessageEvent } from "../core/ipc.js";
import type { DaemonSupervisor } from "./supervisor.js";
import type { SessionServices } from "../core/session/boot.js";
import type { BuildOptions } from "../core/builder.js";
import { checkAbsolutePath, checkEnv, validateProfile } from "./profile-guard.js";
import { ProfileStore } from "../core/profile.js";

const CLIENT_RPC_ACTIONS = new Set<string>([
  "metro/reload",
  "metro/devMenu",
  "metro/getInstance",
  "devtools/listNetwork",
  "devtools/status",
  "devtools/clear",
  "devtools/selectTarget",
  "devtools/restart",
  "builder/build",
  "watcher/start",
  "watcher/stop",
  "watcher/isRunning",
  "session/profile-update",
]);

export function isClientRpcAction(action: string): boolean {
  return CLIENT_RPC_ACTIONS.has(action);
}

export async function handleClientRpc(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
): Promise<void> {
  const { message, reply } = event;
  const services = supervisor.getServices();
  if (!services) {
    reply({
      type: "response",
      action: message.action,
      id: message.id,
      payload: {
        code: "E_SESSION_NOT_RUNNING",
        message:
          "no session is currently running — call session/start before issuing client RPCs",
      },
    });
    return;
  }

  try {
    const payload = await dispatch(message, services, supervisor);
    reply({
      type: "response",
      action: message.action,
      id: message.id,
      payload,
    });
  } catch (err) {
    reply({
      type: "response",
      action: message.action,
      id: message.id,
      payload: {
        code: "E_RPC_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function dispatch(
  message: IpcMessage,
  services: SessionServices,
  supervisor: DaemonSupervisor,
): Promise<unknown> {
  switch (message.action) {
    case "metro/reload": {
      const ok = services.metro.reload(services.worktreeKey);
      return { ok };
    }
    case "metro/devMenu": {
      const ok = services.metro.devMenu(services.worktreeKey);
      return { ok };
    }
    case "metro/getInstance": {
      return { instance: services.metro.getInstance(services.worktreeKey) };
    }
    case "devtools/listNetwork": {
      const filter = readObjectField(message.payload, "filter");
      const list = services.devtools.listNetwork(
        services.worktreeKey,
        filter as Parameters<typeof services.devtools.listNetwork>[1],
      );
      return list;
    }
    case "devtools/status": {
      return services.devtools.status(services.worktreeKey);
    }
    case "devtools/clear": {
      services.devtools.clear(services.worktreeKey);
      return { ok: true };
    }
    case "devtools/selectTarget": {
      const targetId = readStringField(message.payload, "targetId");
      if (!targetId) {
        return {
          code: "E_RPC_INVALID_PAYLOAD",
          message: "devtools/selectTarget: targetId is required",
        };
      }
      await services.devtools.selectTarget(services.worktreeKey, targetId);
      return { ok: true };
    }
    case "devtools/restart": {
      // Composition lives in DevToolsManager.restart() — the manager
      // owns the per-worktree state machine, so exposing the boundary
      // as a single atomic verb here keeps concurrent observers from
      // seeing the stop/start gap. Architecture P1-2 on PR #26.
      return services.devtools.restart(services.worktreeKey);
    }
    case "builder/build": {
      return await handleBuilderBuild(message, services, supervisor);
    }
    case "watcher/start": {
      if (!services.watcher) {
        return { ok: false, reason: "E_NO_WATCHER_CONFIGURED" };
      }
      services.watcher.start();
      return { ok: true };
    }
    case "watcher/stop": {
      if (!services.watcher) {
        return { ok: false, reason: "E_NO_WATCHER_CONFIGURED" };
      }
      services.watcher.stop();
      return { ok: true };
    }
    case "watcher/isRunning": {
      return { running: services.watcher?.isRunning() ?? false };
    }
    case "session/profile-update": {
      return await handleProfileUpdate(message, services, supervisor);
    }
    default:
      throw new Error(`client-rpcs.dispatch: unknown action ${message.action}`);
  }
}

/**
 * Phase H2g — `builder/build` handler. Fires `build/pre` BEFORE the
 * Builder spawns its subprocess (a hard failure aborts the RPC with
 * E_HOOK_FAILED so the caller knows the build never started), then
 * arranges to fire `build/post` once the Builder emits `done`. The
 * post-fire is detached (no `await`) — clients have already received
 * `{ ok: true }` and observe the build via `builder/done` events.
 */
export async function handleBuilderBuild(
  message: IpcMessage,
  services: SessionServices,
  supervisor: DaemonSupervisor,
): Promise<unknown> {
  const parsed = parseBuildOptions(message.payload, supervisor.getWorktree());
  if (!parsed.ok) {
    return { code: parsed.code, message: parsed.message };
  }

  // build/pre: any consumer's onFail:'hard' propagates as a thrown
  // HookError → the surrounding dispatch surfaces { ok: false,
  // code: E_HOOK_FAILED, phase: 'build/pre' } to the caller.
  try {
    await services.hookManager.fire(
      "build/pre",
      { profile: services.validatedProfile, opts: parsed.opts },
      services.validatedProfile,
    );
  } catch (err) {
    return {
      ok: false,
      code: "E_HOOK_FAILED",
      phase: "build/pre",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Arrange the post-fire BEFORE kicking off the Builder so we can't
  // miss a fast 'done' (e.g. concurrency-guard rejection emits 'done'
  // synchronously). once() so a long-lived Builder instance doesn't
  // leak listeners across builds.
  services.builder.once("done", () => {
    void services.hookManager
      .fire(
        "build/post",
        { profile: services.validatedProfile },
        services.validatedProfile,
      )
      .catch(() => {
        // build/post failures (incl. onFail:'hard') are intentionally
        // swallowed: the build is already done, the RPC has long since
        // returned, and the failure surfaces via the audit log + the
        // hooks/fired session event the dispatcher emits regardless.
      });
  });

  services.builder.build(parsed.opts);
  return { ok: true };
}

/**
 * `session/profile-update` — re-validate the supplied profile, fire
 * `session/profile-changed` so consumers (`consumes.hooks` against
 * the `session` built-in) react, and persist the new profile to
 * `<worktree>/.rn-dev/profiles/<name>.json` so the next session
 * boot picks it up.
 *
 * Mid-session reconfiguration of services (Metro port changes,
 * env-mutation, etc.) is intentionally NOT done here — the hook is
 * the extension point modules use to react. A profile change that
 * needs a restart is the caller's responsibility (issue
 * `session/stop` + re-attach with the new profile).
 */
async function handleProfileUpdate(
  message: IpcMessage,
  services: SessionServices,
  supervisor: DaemonSupervisor,
): Promise<unknown> {
  const profileInput = readObjectField(message.payload, "profile");
  if (profileInput === undefined) {
    return {
      ok: false,
      code: "E_RPC_INVALID_PAYLOAD",
      message: "session/profile-update: payload.profile is required",
    };
  }
  const result = validateProfile(profileInput);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  const validated = result.profile;

  // Fire the hook BEFORE persistence so a hard-failing consumer
  // can abort the change. `fire` throws on `onFail: "hard"`; let it
  // propagate so the dispatch's catch returns E_RPC_FAILED with the
  // hook's message attached.
  await services.hookManager.fire(
    "session/profile-changed",
    { profile: validated },
    validated,
  );

  const profilesDir = path.join(supervisor.getWorktree(), ".rn-dev", "profiles");
  new ProfileStore(profilesDir).save(validated);

  // Phase H2g — refresh SessionServices.validatedProfile so subsequent
  // builder/build hook fires see the latest config. Refresh AFTER the
  // session/profile-changed fire + persistence so a hard-failing
  // consumer leaves both the in-memory and on-disk state untouched.
  services.validatedProfile = validated;

  return { ok: true };
}

function readStringField(
  payload: unknown,
  key: string,
): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function readObjectField(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as Record<string, unknown>)[key];
}

type ParseResult<T> =
  | { ok: true; opts: T }
  | { ok: false; code: string; message: string };

/**
 * Validate a `builder/build` payload. The field-level checks mirror
 * `validateProfile` in profile-guard.ts — same denylist on env keys,
 * same absolute-path discipline on projectRoot, same NUL/newline
 * rejections — because this RPC ends up spawning a subprocess and is
 * exactly the same threat surface as session/start.
 *
 * projectRoot is additionally constrained to be inside the
 * supervisor's worktree, so a caller that can reach the socket
 * can't kick a build in a sibling repo whose
 * `node_modules/.bin/react-native` the daemon has never vetted
 * (Security P1-1 on PR #17).
 */
function parseBuildOptions(
  payload: unknown,
  worktree: string,
): ParseResult<BuildOptions> {
  if (!payload || typeof payload !== "object") {
    return fail("E_RPC_INVALID_PAYLOAD", "builder/build: payload must be an object");
  }
  const p = payload as Record<string, unknown>;

  const projectRootCheck = checkAbsolutePath(p.projectRoot, "builder/build.projectRoot");
  if (!projectRootCheck.ok) {
    return fail(projectRootCheck.code, projectRootCheck.message);
  }
  const projectRoot = p.projectRoot as string;

  // Bound to the daemon's worktree. `path.relative` returns a string
  // starting with ".." when the second arg is above the first; an
  // exact match returns "". Absolute paths return themselves.
  //
  // realpath both sides BEFORE the relative check: macOS's
  // `/private/var` ↔ `/var` symlink (and analogous setups on Linux)
  // mean a caller computing projectRoot via process.cwd()/realpath can
  // legitimately pass a symlink-resolved path while the daemon was
  // spawned with the original. Without resolution the relative check
  // returns `../../../private/var/…` and rejects the same physical
  // directory the daemon is anchored to. realpathSync.native throws
  // ENOENT for missing paths — fall back to the original input so the
  // existing absolute-path check below still catches that case.
  const resolveSafe = (input: string): string => {
    try {
      return realpathSync.native(input);
    } catch {
      return input;
    }
  };
  const resolvedWorktree = resolveSafe(worktree);
  const resolvedProjectRoot = resolveSafe(projectRoot);
  const rel = path.relative(resolvedWorktree, resolvedProjectRoot);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return fail(
      "E_BUILD_PROJECTROOT_OUTSIDE_WORKTREE",
      `builder/build.projectRoot ${projectRoot} must be inside the daemon's worktree ${worktree}`,
    );
  }

  if (p.platform !== "ios" && p.platform !== "android") {
    return fail(
      "E_RPC_INVALID_PAYLOAD",
      "builder/build.platform must be 'ios' or 'android'",
    );
  }
  const platform = p.platform;

  if (
    typeof p.port !== "number" ||
    !Number.isFinite(p.port) ||
    !Number.isInteger(p.port) ||
    p.port < 1 ||
    p.port > 65535
  ) {
    return fail(
      "E_RPC_INVALID_PAYLOAD",
      "builder/build.port must be an integer in [1, 65535]",
    );
  }
  const port = p.port;

  if (p.variant !== "debug" && p.variant !== "release") {
    return fail(
      "E_RPC_INVALID_PAYLOAD",
      "builder/build.variant must be 'debug' or 'release'",
    );
  }
  const variant = p.variant;

  let deviceId: string | undefined;
  if (p.deviceId !== undefined) {
    if (typeof p.deviceId !== "string") {
      return fail(
        "E_RPC_INVALID_PAYLOAD",
        "builder/build.deviceId must be a string",
      );
    }
    deviceId = p.deviceId;
  }

  const envCheck = checkEnv(p.env, "builder/build.env");
  if (!envCheck.ok) return fail(envCheck.code, envCheck.message);
  const env =
    p.env && typeof p.env === "object"
      ? (p.env as Record<string, string>)
      : undefined;

  // Optional iOS scheme/configuration. Mirror profile-guard's rule:
  // present-but-empty is rejected so an empty payload field doesn't
  // silently fall back to RN CLI's default-scheme heuristic.
  let scheme: string | undefined;
  if (p.scheme !== undefined) {
    if (typeof p.scheme !== "string" || p.scheme.length === 0) {
      return fail(
        "E_RPC_INVALID_PAYLOAD",
        "builder/build.scheme must be a non-empty string when present",
      );
    }
    scheme = p.scheme;
  }
  let configuration: string | undefined;
  if (p.configuration !== undefined) {
    if (typeof p.configuration !== "string" || p.configuration.length === 0) {
      return fail(
        "E_RPC_INVALID_PAYLOAD",
        "builder/build.configuration must be a non-empty string when present",
      );
    }
    configuration = p.configuration;
  }

  return {
    ok: true,
    opts: { projectRoot, platform, port, variant, deviceId, env, scheme, configuration },
  };
}

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}
