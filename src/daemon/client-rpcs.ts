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
import type { IpcMessage, IpcMessageEvent } from "../core/ipc.js";
import type { DaemonSupervisor } from "./supervisor.js";
import type { SessionServices } from "../core/session/boot.js";
import type { BuildOptions } from "../core/builder.js";
import { checkAbsolutePath, checkEnv } from "./profile-guard.js";

const CLIENT_RPC_ACTIONS = new Set<string>([
  "metro/reload",
  "metro/devMenu",
  "metro/getInstance",
  "devtools/listNetwork",
  "devtools/status",
  "devtools/clear",
  "devtools/selectTarget",
  "builder/build",
  "watcher/start",
  "watcher/stop",
  "watcher/isRunning",
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
    case "builder/build": {
      const parsed = parseBuildOptions(message.payload, supervisor.getWorktree());
      if (!parsed.ok) {
        return { code: parsed.code, message: parsed.message };
      }
      services.builder.build(parsed.opts);
      return { ok: true };
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
    default:
      throw new Error(`client-rpcs.dispatch: unknown action ${message.action}`);
  }
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
  const rel = path.relative(worktree, projectRoot);
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

  return {
    ok: true,
    opts: { projectRoot, platform, port, variant, deviceId, env },
  };
}

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}
