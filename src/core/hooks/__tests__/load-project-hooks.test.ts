import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectHooks } from "../load-project-hooks.js";
import { HookManager } from "../manager.js";
import { getDefaultAuditLog } from "../../audit-log.js";
import type { RnDevConfig } from "@rn-dev/config";

let tmpRoot = "";

function makeManager(): HookManager {
  const m = new HookManager({
    auditLog: getDefaultAuditLog(),
    daemonPid: process.pid,
  });
  // The session/init slot needs a provider to avoid every registration
  // landing as orphaned. Tests in this file register against
  // session/init, so declare it up front.
  m.declareProvider("session", ["init", "profile-changed"]);
  return m;
}

beforeEach(() => {
  // realpath here so subsequent comparisons line up on macOS where
  // /var/folders/* is a symlink to /private/var/folders/*.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "load-project-hooks-")));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadProjectHooks — discovery", () => {
  it("returns the zero result when no rn-dev.config.* exists", async () => {
    const manager = makeManager();
    const result = await loadProjectHooks({
      hookManager: manager,
      projectRoot: tmpRoot,
      emit: () => {},
    });
    expect(result).toEqual({ configFile: null, registered: 0, skipped: 0 });
  });

  it("finds rn-dev.config.mjs", async () => {
    writeFileSync(
      join(tmpRoot, "rn-dev.config.mjs"),
      "export default {};",
      "utf-8",
    );
    const result = await loadProjectHooks({
      hookManager: makeManager(),
      projectRoot: tmpRoot,
      emit: () => {},
      // Stub loadConfig — we don't want to actually dynamic-import.
      loadConfigFn: async () => ({ hooks: undefined }) as RnDevConfig,
    });
    expect(result.configFile).toBe(join(tmpRoot, "rn-dev.config.mjs"));
    expect(result.registered).toBe(0);
  });

  it("prefers rn-dev.config.mjs over the other extensions", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    writeFileSync(join(tmpRoot, "rn-dev.config.ts"), "", "utf-8");
    writeFileSync(join(tmpRoot, "rn-dev.config.js"), "", "utf-8");
    const result = await loadProjectHooks({
      hookManager: makeManager(),
      projectRoot: tmpRoot,
      emit: () => {},
      loadConfigFn: async () => ({}) as RnDevConfig,
    });
    expect(result.configFile).toBe(join(tmpRoot, "rn-dev.config.mjs"));
  });
});

describe("loadProjectHooks — registration", () => {
  it("registers a script entry against an existing slot", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    mkdirSync(join(tmpRoot, "hooks"));
    writeFileSync(join(tmpRoot, "hooks", "init.sh"), "#!/bin/bash\n", "utf-8");

    const manager = makeManager();
    const lines: string[] = [];
    const result = await loadProjectHooks({
      hookManager: manager,
      projectRoot: tmpRoot,
      emit: (line) => lines.push(line),
      loadConfigFn: async () =>
        ({
          hooks: { "session/init": "./hooks/init.sh" },
        }) as RnDevConfig,
    });
    expect(result.registered).toBe(1);
    expect(result.skipped).toBe(0);

    const dump = manager.dumpRegistry();
    expect(dump.registrations["session/init"]?.length).toBe(1);
    const reg = dump.registrations["session/init"]![0]!;
    expect(reg.source.kind).toBe("project");
    expect(reg.resolved.kind).toBe("script");
    expect(reg.orphaned).toBe(false);
    expect(lines.some((l) => l.includes("Registered 1 project hook"))).toBe(true);
  });

  it("registers a script entry with full HookEntryScript options", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    mkdirSync(join(tmpRoot, "hooks"));
    writeFileSync(join(tmpRoot, "hooks", "init.sh"), "#!/bin/bash\n", "utf-8");

    const manager = makeManager();
    await loadProjectHooks({
      hookManager: manager,
      projectRoot: tmpRoot,
      emit: () => {},
      loadConfigFn: async () =>
        ({
          hooks: {
            "session/init": {
              script: "./hooks/init.sh",
              onFail: "warn",
              timeoutMs: 5_000,
              priority: 10,
            },
          },
        }) as RnDevConfig,
    });
    const reg = manager.dumpRegistry().registrations["session/init"]![0]!;
    expect(reg.onFail).toBe("warn");
    expect(reg.timeoutMs).toBe(5_000);
    expect(reg.priority).toBe(10);
  });

  it("registers a fn entry inline (project-only)", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    const fn = vi.fn(async () => undefined);
    const manager = makeManager();
    await loadProjectHooks({
      hookManager: manager,
      projectRoot: tmpRoot,
      emit: () => {},
      loadConfigFn: async () =>
        ({ hooks: { "session/init": { fn } } }) as RnDevConfig,
    });
    const reg = manager.dumpRegistry().registrations["session/init"]![0]!;
    expect(reg.resolved.kind).toBe("fn");
    if (reg.resolved.kind === "fn") {
      expect(reg.resolved.symbol).toBe("project:session/init");
    }
  });
});

describe("loadProjectHooks — error handling", () => {
  it("emits a warning + zero result when loadConfig throws", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    const lines: string[] = [];
    const result = await loadProjectHooks({
      hookManager: makeManager(),
      projectRoot: tmpRoot,
      emit: (line) => lines.push(line),
      loadConfigFn: async () => {
        throw new Error("E_HOOK_CONFIG_INVALID: parse failed");
      },
    });
    expect(result.registered).toBe(0);
    expect(result.skipped).toBe(0);
    expect(lines.some((l) => l.includes("Failed to load"))).toBe(true);
  });

  it("emits a warning per skipped entry and continues with the remainder", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    mkdirSync(join(tmpRoot, "hooks"));
    writeFileSync(join(tmpRoot, "hooks", "good.sh"), "#!/bin/bash\n", "utf-8");

    const manager = makeManager();
    const lines: string[] = [];
    const result = await loadProjectHooks({
      hookManager: manager,
      projectRoot: tmpRoot,
      emit: (line) => lines.push(line),
      loadConfigFn: async () =>
        ({
          hooks: {
            "session/init": "./hooks/good.sh",
            // ~ prefix is unconditionally rejected by resolveHookScript
            // regardless of contents; this entry should be skipped, the
            // first should still register.
            "session/profile-changed": "~/evil.sh",
          },
        }) as RnDevConfig,
    });
    expect(result.registered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(
      lines.some((l) => l.includes("Skipping hook session/profile-changed")),
    ).toBe(true);
  });

  it("rejects an entry with neither fn nor script", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    const lines: string[] = [];
    const result = await loadProjectHooks({
      hookManager: makeManager(),
      projectRoot: tmpRoot,
      emit: (line) => lines.push(line),
      loadConfigFn: async () =>
        ({
          // Cast escape — exercise the runtime guard against a
          // malformed entry that the type system would normally
          // reject. defineConfig at write time should catch this; the
          // boot path is the last line of defense.
          hooks: { "session/init": { onFail: "warn" } as never },
        }) as RnDevConfig,
    });
    expect(result.registered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(
      lines.some((l) => l.includes("declared neither fn nor script")),
    ).toBe(true);
  });
});

describe("loadProjectHooks — override-slot opt-in (Phase H2e)", () => {
  it("rejects a project consumer of <id>/custom without allowModuleOverrides", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    mkdirSync(join(tmpRoot, "hooks"));
    writeFileSync(join(tmpRoot, "hooks", "swap.sh"), "#!/bin/bash\n", "utf-8");

    const manager = makeManager();
    manager.declareProvider("build", ["pre", "post", "custom"]);
    const lines: string[] = [];
    const result = await loadProjectHooks({
      hookManager: manager,
      projectRoot: tmpRoot,
      emit: (line) => lines.push(line),
      loadConfigFn: async () =>
        ({
          hooks: { "build/custom": "./hooks/swap.sh" },
        }) as RnDevConfig,
    });
    expect(result.registered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(
      lines.some(
        (l) =>
          l.includes("Skipping hook build/custom") &&
          l.includes("allowModuleOverrides"),
      ),
    ).toBe(true);
  });

  it("accepts a project consumer of <id>/custom WITH allowModuleOverrides", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    mkdirSync(join(tmpRoot, "hooks"));
    writeFileSync(join(tmpRoot, "hooks", "swap.sh"), "#!/bin/bash\n", "utf-8");

    const manager = makeManager();
    manager.declareProvider("build", ["pre", "post", "custom"]);
    const lines: string[] = [];
    const result = await loadProjectHooks({
      hookManager: manager,
      projectRoot: tmpRoot,
      emit: (line) => lines.push(line),
      loadConfigFn: async () =>
        ({
          allowModuleOverrides: ["build"],
          hooks: { "build/custom": "./hooks/swap.sh" },
        }) as RnDevConfig,
    });
    expect(result.registered).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("non-custom slots are unaffected by the opt-in gate", async () => {
    writeFileSync(join(tmpRoot, "rn-dev.config.mjs"), "", "utf-8");
    mkdirSync(join(tmpRoot, "hooks"));
    writeFileSync(join(tmpRoot, "hooks", "pre.sh"), "#!/bin/bash\n", "utf-8");

    const manager = makeManager();
    manager.declareProvider("build", ["pre", "post", "custom"]);
    const result = await loadProjectHooks({
      hookManager: manager,
      projectRoot: tmpRoot,
      emit: () => {},
      loadConfigFn: async () =>
        ({
          // No allowModuleOverrides; build/pre and build/post are
          // regular slots and should land normally.
          hooks: {
            "build/pre": "./hooks/pre.sh",
            "build/post": "./hooks/pre.sh",
          },
        }) as RnDevConfig,
    });
    expect(result.registered).toBe(2);
    expect(result.skipped).toBe(0);
  });
});
