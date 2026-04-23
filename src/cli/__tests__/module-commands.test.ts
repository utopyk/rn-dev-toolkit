// Smoke tests for the `rn-dev module {…}` CLI surface. We exercise
// argument parsing + wiring (registerModuleCommands attaches six
// sub-commands to the program and commander resolves them). End-to-end
// tests that spawn a daemon + the CLI process are covered by the manual
// Phase 7 smoke flow documented in the handoff.

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerModuleCommands } from "../module-commands.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerModuleCommands(program);
  return program;
}

describe("registerModuleCommands", () => {
  it("registers every Phase 7 + Phase 8 sub-command", () => {
    const program = buildProgram();
    const moduleCmd = program.commands.find((c) => c.name() === "module");
    expect(moduleCmd).toBeDefined();
    const names = moduleCmd!.commands.map((c) => c.name()).sort();
    expect(names).toEqual([
      "disable",
      "enable",
      "install",
      "list",
      "rescan",
      "restart",
      "uninstall",
    ]);
  });

  it("install sub-command declares every Phase 7 flag", () => {
    const program = buildProgram();
    const install = program.commands
      .find((c) => c.name() === "module")!
      .commands.find((c) => c.name() === "install")!;
    const flags = install.options.map((o) => o.flags).sort();
    expect(flags).toContain("--permissions <list>");
    expect(flags).toContain("--registry-url <url>");
    expect(flags).toContain("--accept-registry-sha <sha>");
    // `-y, --yes` — short form must come first so commander binds the
    // short alias; the earlier `--yes, -y` shape silently swallowed -y.
    expect(flags).toContain("-y, --yes");
  });

  it("install --yes parses onto opts.yes (catches the -y, --yes ordering trap)", () => {
    const program = buildProgram();
    const install = program.commands
      .find((c) => c.name() === "module")!
      .commands.find((c) => c.name() === "install")!;
    // Prevent the action handler from running (it would hit the live
    // installer); we only care about commander's opts parsing.
    install.action(() => {});
    program.parse(["node", "rn-dev", "module", "install", "foo", "-y"], {
      from: "node",
    });
    expect(install.opts()["yes"]).toBe(true);
  });

  it("uninstall sub-command declares --keep-data", () => {
    const program = buildProgram();
    const uninstall = program.commands
      .find((c) => c.name() === "module")!
      .commands.find((c) => c.name() === "uninstall")!;
    const flags = uninstall.options.map((o) => o.flags);
    expect(flags).toContain("--keep-data");
  });

  it("list/enable/disable/restart commands take no flags (they dispatch over IPC)", () => {
    const program = buildProgram();
    const moduleCmd = program.commands.find((c) => c.name() === "module")!;
    for (const name of ["list", "enable", "disable", "restart"]) {
      const cmd = moduleCmd.commands.find((c) => c.name() === name)!;
      // Commander accepts 0 declared options for list; the others take a
      // required <moduleId> positional with no flags.
      expect(cmd.options).toEqual([]);
    }
  });
});
