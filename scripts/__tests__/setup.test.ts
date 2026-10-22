import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideLinkAction,
  discoverModules,
  discoverPackages,
  parseSetupArgs,
} from "../setup.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

function writePackage(
  root: string,
  dirName: string,
  pkg: Record<string, unknown>,
  withBuild = true,
): void {
  const dir = join(root, "packages", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  if (withBuild) writeFileSync(join(dir, "build.ts"), "");
}

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

describe("discoverPackages", () => {
  it("builds module-sdk before config, which depends on it", () => {
    const names = discoverPackages(repoRoot).map((p) => p.name);
    expect(names).toContain("@rn-dev/module-sdk");
    expect(names).toContain("@rn-dev/config");
    expect(names.indexOf("@rn-dev/module-sdk")).toBeLessThan(
      names.indexOf("@rn-dev/config"),
    );
  });

  it("orders workspace dependencies first, whatever the directory order", () => {
    const tmp = mkdtempSync(join(tmpdir(), "setup-test-"));
    writePackage(tmp, "aaa", {
      name: "@x/aaa",
      dependencies: { "@x/zzz": "workspace:*" },
    });
    writePackage(tmp, "mmm", {
      name: "@x/mmm",
      devDependencies: { "@x/aaa": "workspace:*", left: "^1.0.0" },
    });
    writePackage(tmp, "bbb", {
      name: "@x/bbb",
      peerDependencies: { "@x/mmm": "*" },
    });
    writePackage(tmp, "zzz", { name: "@x/zzz" });
    expect(discoverPackages(tmp).map((p) => p.name)).toEqual([
      "@x/zzz",
      "@x/aaa",
      "@x/mmm",
      "@x/bbb",
    ]);
  });

  it("skips packages without a build.ts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "setup-test-"));
    writePackage(tmp, "built", { name: "@x/built" });
    writePackage(tmp, "types-only", { name: "@x/types-only" }, false);
    expect(discoverPackages(tmp).map((p) => p.name)).toEqual(["@x/built"]);
  });

  it("throws on a workspace dependency cycle", () => {
    const tmp = mkdtempSync(join(tmpdir(), "setup-test-"));
    writePackage(tmp, "a", { name: "@x/a", dependencies: { "@x/b": "*" } });
    writePackage(tmp, "b", { name: "@x/b", dependencies: { "@x/a": "*" } });
    expect(() => discoverPackages(tmp)).toThrow("dependency cycle");
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
