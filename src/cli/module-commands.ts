// `rn-dev module {install, uninstall, list, enable, disable, restart}` CLI.
// Split from commands.ts so the sub-commands + their helpers stay in one
// file. Commands that operate on live state (list/enable/disable/restart)
// talk to a running daemon over the unix-socket `IpcClient`. Install and
// uninstall prefer the daemon too — so the running session's
// ModuleRegistry stays in sync + the `install` / `uninstall` event bus
// fires — and fall back to the standalone installer only when no daemon
// is reachable.

import { Command } from "commander";
import path from "node:path";
import { homedir } from "node:os";
import { detectProjectRoot } from "../core/project.js";
import { IpcClient, type IpcMessage } from "../core/ipc.js";
import { ModuleRegistry } from "../modules/registry.js";
import {
  installModule,
  uninstallModule,
} from "../modules/marketplace/installer.js";
import { RegistryFetcher } from "../modules/marketplace/registry.js";

export function registerModuleCommands(program: Command): void {
  const module = program
    .command("module")
    .description("Manage rn-dev modules (install, uninstall, list, enable/disable, restart)");

  module
    .command("list")
    .description("List registered modules (requires a running rn-dev daemon)")
    .action(async () => {
      const client = await getDaemonClientOrExit();
      const reply = await send(client, {
        type: "command",
        action: "modules/list",
        payload: {},
        id: newId(),
      });
      const rows = (reply.payload as { modules?: Array<Record<string, unknown>> })?.modules;
      if (!rows || rows.length === 0) {
        console.log("No modules registered.");
        return;
      }
      console.log("\nModules:\n");
      for (const row of rows) {
        const id = String(row["id"] ?? "?");
        const version = String(row["version"] ?? "?");
        const kind = String(row["kind"] ?? "?");
        const state = String(row["state"] ?? "?");
        const builtIn = row["isBuiltIn"] ? " [built-in]" : "";
        console.log(`  ${id}${builtIn}  v${version}  ${kind}  ${state}`);
      }
      console.log();
    });

  module
    .command("install <moduleId>")
    .description("Install a module from the curated registry")
    .option(
      "--permissions <list>",
      "Comma-separated permissions to accept (default: accept every declared permission)",
    )
    .option(
      "--registry-url <url>",
      "Override the registry URL (file://... or https://...)",
    )
    .option("--accept-registry-sha <sha>", "Accept a specific modules.json SHA-256")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (moduleId: string, opts: InstallCliOptions) => {
      // Security: surface the SHA-pin override explicitly so --yes
      // --accept-registry-sha=<attacker-sha> isn't silent-bypass.
      if (opts.acceptRegistrySha) {
        process.stderr.write(
          `[rn-dev] WARNING: --accept-registry-sha overrides the baked modules.json SHA pin. ` +
            `Only proceed if you trust the registry URL (${opts.registryUrl ?? "<default>"}).\n`,
        );
      }

      const fetcher = new RegistryFetcher();
      const fetchOpts = {
        ...(opts.registryUrl !== undefined ? { url: opts.registryUrl } : {}),
        ...(opts.acceptRegistrySha !== undefined
          ? { expectedSha: opts.acceptRegistrySha }
          : {}),
      };
      const fetched = await fetcher.fetch(fetchOpts);
      if (fetched.kind === "error") {
        console.error(`registry fetch failed: ${fetched.code} — ${fetched.message}`);
        process.exit(1);
      }
      const entry = fetched.registry.modules.find((m) => m.id === moduleId);
      if (!entry) {
        console.error(`module "${moduleId}" is not in the curated registry`);
        process.exit(1);
      }

      const permissionsAccepted = opts.permissions
        ? opts.permissions.split(",").map((p) => p.trim()).filter(Boolean)
        : entry.permissions;
      const missing = entry.permissions.filter(
        (p) => !permissionsAccepted.includes(p),
      );
      if (missing.length > 0) {
        console.error(
          `missing permission acceptances: ${missing.join(", ")}. ` +
            `Pass --permissions=${entry.permissions.join(",")} or omit --permissions to accept all.`,
        );
        process.exit(1);
      }

      if (!opts.yes) {
        console.log("\nInstalling:");
        console.log(`  ${entry.id} v${entry.version} — ${entry.description}`);
        console.log(`  author:      ${entry.author}`);
        console.log(`  permissions: ${entry.permissions.join(", ") || "(none)"}`);
        console.log(`  sha256:      ${entry.tarballSha256}`);
        console.log("\nRe-run with --yes to confirm.");
        process.exit(1);
      }

      // Prefer the daemon — that way the running ModuleRegistry sees
      // the new module immediately + the `install` event fans out to
      // MCP subscribers + the panel bridge. Standalone install is a
      // fallback for when no session is up.
      const daemon = await tryDaemonClient();
      if (daemon) {
        const reply = await send(daemon, {
          type: "command",
          action: "modules/install",
          payload: {
            moduleId: entry.id,
            permissionsAccepted,
            thirdPartyAcknowledged: true,
          },
          id: newId(),
        });
        const payload = reply.payload as InstallReplyShape;
        if (payload?.kind === "ok") {
          console.log(
            `installed ${payload.moduleId} v${payload.version} at ${payload.installPath}`,
          );
          return;
        }
        console.error(
          `install failed${payload?.code ? ` (${payload.code})` : ""}: ${payload?.message ?? "unknown"}`,
        );
        process.exit(1);
      }

      // Standalone path — no daemon is running, so we install directly.
      // The module becomes available at the next `rn-dev start`. With a
      // live daemon, the modules/install IPC above triggers the daemon's
      // rescan + emits tools/listChanged without restarting.
      const registry = new ModuleRegistry();
      const result = await installModule({
        entry,
        permissionsAccepted,
        registry,
        hostVersion: "0.1.0",
        thirdPartyAcknowledged: true,
      });
      if (result.kind === "error") {
        console.error(`install failed (${result.code}): ${result.message}`);
        process.exit(1);
      }
      console.log(
        `installed ${result.module.manifest.id} v${result.module.manifest.version} at ${result.installPath}`,
      );
      console.log(
        "note: no daemon was running — the module will load on the next `rn-dev start`.",
      );
    });

  module
    .command("uninstall <moduleId>")
    .description("Uninstall a module and remove its files")
    .option("--keep-data", "Preserve ~/.rn-dev/modules/<id>/data/ (retention GC: Phase 8)")
    .action(async (moduleId: string, opts: { keepData?: boolean }) => {
      const daemon = await tryDaemonClient();
      if (daemon) {
        const reply = await send(daemon, {
          type: "command",
          action: "modules/uninstall",
          payload: { moduleId, keepData: !!opts.keepData },
          id: newId(),
        });
        const payload = reply.payload as UninstallReplyShape;
        if (payload?.kind === "ok") {
          console.log(`uninstalled ${moduleId} (removed ${payload.removed ?? ""})`);
          return;
        }
        console.error(
          `uninstall failed${payload?.code ? ` (${payload.code})` : ""}: ${payload?.message ?? "unknown"}`,
        );
        process.exit(1);
      }

      const registry = new ModuleRegistry();
      const result = await uninstallModule({
        moduleId,
        registry,
        ...(opts.keepData !== undefined ? { keepData: opts.keepData } : {}),
      });
      if (result.kind === "error") {
        console.error(`uninstall failed (${result.code}): ${result.message}`);
        process.exit(1);
      }
      console.log(`uninstalled ${moduleId} (removed ${result.removed})`);
    });

  module
    .command("enable <moduleId>")
    .description("Enable a previously disabled module")
    .action(async (moduleId: string) => {
      const client = await getDaemonClientOrExit();
      const reply = await send(client, {
        type: "command",
        action: "modules/enable",
        payload: { moduleId },
        id: newId(),
      });
      const payload = reply.payload as { status?: string; error?: string };
      if (payload?.error) {
        console.error(payload.error);
        process.exit(1);
      }
      console.log(`enabled ${moduleId}`);
    });

  module
    .command("disable <moduleId>")
    .description("Disable a module — shuts down its subprocess + skips on reload")
    .action(async (moduleId: string) => {
      const client = await getDaemonClientOrExit();
      const reply = await send(client, {
        type: "command",
        action: "modules/disable",
        payload: { moduleId },
        id: newId(),
      });
      const payload = reply.payload as { status?: string; error?: string };
      if (payload?.error) {
        console.error(payload.error);
        process.exit(1);
      }
      console.log(`disabled ${moduleId}`);
    });

  module
    .command("rescan")
    .description(
      "Rescan ~/.rn-dev/modules/ against the running daemon's registry (diff + sync)",
    )
    .action(async () => {
      const client = await getDaemonClientOrExit();
      const reply = await send(client, {
        type: "command",
        action: "modules/rescan",
        payload: {},
        id: newId(),
      });
      const payload = reply.payload as {
        kind?: string;
        added?: string[];
        removed?: string[];
        updated?: string[];
        rejected?: string[];
      };
      if (payload?.kind !== "ok") {
        console.error("rescan failed");
        process.exit(1);
      }
      const { added = [], removed = [], updated = [], rejected = [] } = payload;
      console.log(
        `rescan: +${added.length} added · -${removed.length} removed · ~${updated.length} updated · ${rejected.length} rejected`,
      );
      if (added.length > 0) console.log(`  added:   ${added.join(", ")}`);
      if (removed.length > 0) console.log(`  removed: ${removed.join(", ")}`);
      if (updated.length > 0) console.log(`  updated: ${updated.join(", ")}`);
      for (const r of rejected) console.log(`  ${r}`);
    });

  module
    .command("restart <moduleId>")
    .description("Restart a module's subprocess")
    .action(async (moduleId: string) => {
      const client = await getDaemonClientOrExit();
      const reply = await send(client, {
        type: "command",
        action: "modules/restart",
        payload: { moduleId },
        id: newId(),
      });
      const payload = reply.payload as { status?: string; pid?: number; error?: string };
      if (payload?.error) {
        console.error(payload.error);
        process.exit(1);
      }
      console.log(`restarted ${moduleId}${payload?.pid ? ` (pid ${payload.pid})` : ""}`);
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InstallCliOptions {
  permissions?: string;
  registryUrl?: string;
  acceptRegistrySha?: string;
  yes?: boolean;
}

interface InstallReplyShape {
  kind?: string;
  code?: string;
  message?: string;
  moduleId?: string;
  version?: string;
  installPath?: string;
}

interface UninstallReplyShape {
  kind?: string;
  code?: string;
  message?: string;
  removed?: string;
}

function newId(): string {
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function send(client: IpcClient, msg: IpcMessage): Promise<IpcMessage> {
  const reply = await client.send(msg);
  if (!reply) throw new Error("daemon returned no reply");
  return reply;
}

/**
 * Resolve the daemon socket. In order of precedence:
 *   1. `RN_DEV_DAEMON_SOCK` env var — escape hatch for CI / tests.
 *   2. `<projectRoot>/.rn-dev/sock` if the current directory is inside
 *      an rn-dev project — matches the `reload` / `dev-menu` commands.
 *   3. `~/.rn-dev/sock` — user-global fallback. Not currently wired on
 *      the server side; reserved for a Phase 8 global daemon.
 */
function candidateSockets(): string[] {
  const out: string[] = [];
  const env = process.env["RN_DEV_DAEMON_SOCK"];
  if (env) out.push(env);
  const projectRoot = detectProjectRoot(process.cwd());
  if (projectRoot) out.push(path.join(projectRoot, ".rn-dev", "sock"));
  out.push(path.join(homedir(), ".rn-dev", "sock"));
  return out;
}

async function tryDaemonClient(): Promise<IpcClient | null> {
  for (const socketPath of candidateSockets()) {
    const client = new IpcClient(socketPath);
    try {
      if (await client.isServerRunning()) return client;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function getDaemonClientOrExit(): Promise<IpcClient> {
  const client = await tryDaemonClient();
  if (client) return client;
  console.error(
    "No running rn-dev daemon. Start one via `rn-dev start` (or set RN_DEV_DAEMON_SOCK to an existing socket).",
  );
  process.exit(1);
}
