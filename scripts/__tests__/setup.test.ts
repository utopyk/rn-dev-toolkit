import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideLinkAction,
  discoverModules,
  parseSetupArgs,
} from "../setup.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

describe("parseSetupArgs", () => {
  it("parses repeated --app paths", () => {
    expect(
      parseSetupArgs(["--app", "/a", "--app", "/b"]),
    ).toEqual({ apps: ["/a", "/b"], help: false });
  });

  it("parses --help", () => {
    expect(parseSetupArgs(["--help"]).help).toBe(true);
  });

  it("rejects --app without a value", () => {
    expect(() => parseSetupArgs(["--app"])).toThrow("--app requires a path");
    expect(() => parseSetupArgs(["--app", "--help"])).toThrow(
      "--app requires a path",
    );
  });

  it("rejects unknown flags", () => {
    expect(() => parseSetupArgs(["--nope"])).toThrow("Unknown argument");
  });
});

describe("discoverModules", () => {
  it("finds the shipped module workspaces by manifest id", () => {
    const ids = discoverModules(repoRoot).map((m) => m.id);
    expect(ids).toContain("redux");
    expect(ids).toContain("device-control");
    expect(ids).toContain("devtools-network");
    expect(ids).toContain("metro-logs");
  });

  it("throws on a manifest with no id", () => {
    const tmp = mkdtempSync(join(tmpdir(), "setup-test-"));
    const bad = join(tmp, "modules", "broken");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "rn-dev-module.json"), "{}");
    expect(() => discoverModules(tmp)).toThrow('no "id" field');
  });
});

describe("decideLinkAction", () => {
  it("creates when nothing exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "setup-test-"));
    const target = join(tmp, "target");
    mkdirSync(target);
    expect(decideLinkAction(join(tmp, "missing"), target)).toEqual({
      kind: "create",
    });
  });

  it("skips a symlink already pointing at the target", () => {
    const tmp = mkdtempSync(join(tmpdir(), "setup-test-"));
    const target = join(tmp, "target");
    mkdirSync(target);
    const link = join(tmp, "link");
    symlinkSync(target, link);
    expect(decideLinkAction(link, target).kind).toBe("skip");
  });

  it("replaces a symlink pointing elsewhere", () => {
    const tmp = mkdtempSync(join(tmpdir(), "setup-test-"));
    const target = join(tmp, "target");
    const other = join(tmp, "other");
    mkdirSync(target);
    mkdirSync(other);
    const link = join(tmp, "link");
    symlinkSync(other, link);
    const action = decideLinkAction(link, target);
    expect(action.kind).toBe("replace");
  });

  it("replaces a dangling symlink", () => {
    const tmp = mkdtempSync(join(tmpdir(), "setup-test-"));
    const target = join(tmp, "target");
    mkdirSync(target);
    const link = join(tmp, "link");
    symlinkSync(join(tmp, "gone"), link);
    expect(decideLinkAction(link, target)).toEqual({
      kind: "replace",
      from: "<dangling>",
    });
  });

  it("never touches a real directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "setup-test-"));
    const target = join(tmp, "target");
    const realDir = join(tmp, "real");
    mkdirSync(target);
    mkdirSync(realDir);
    expect(decideLinkAction(realDir, target).kind).toBe("warn-skip");
  });
});
