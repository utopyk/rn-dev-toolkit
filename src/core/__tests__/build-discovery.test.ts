import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverBundles } from "../build-discovery.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-dev-cli-build-discovery-"));
}

describe("discoverBundles — iOS", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty when ios/ does not exist", async () => {
    const result = await discoverBundles({ projectRoot: dir, platform: "ios" });
    expect(result.bundles).toEqual([]);
  });

  it("returns empty when ios/ has no .xcodeproj", async () => {
    mkdirSync(join(dir, "ios"));
    const result = await discoverBundles({ projectRoot: dir, platform: "ios" });
    expect(result.bundles).toEqual([]);
  });

  it("returns one bundle per shared scheme, with project configurations + manual signing", async () => {
    const xcodeproj = join(dir, "ios", "Acme.xcodeproj");
    const schemes = join(xcodeproj, "xcshareddata", "xcschemes");
    mkdirSync(schemes, { recursive: true });

    writeFileSync(
      join(xcodeproj, "project.pbxproj"),
      [
        "/* Some preamble */",
        "13B07F941A680F5B00A75B9A /* Debug */ = {",
        "  isa = XCBuildConfiguration;",
        "  name = Debug;",
        "};",
        "13B07F951A680F5B00A75B9A /* Release */ = {",
        "  isa = XCBuildConfiguration;",
        "  name = Release;",
        "};",
        "13B07F961A680F5B00A75B9A /* Beta */ = {",
        "  isa = XCBuildConfiguration;",
        "  name = Beta;",
        "};",
        "buildSettings = {",
        "  CODE_SIGN_STYLE = Manual;",
        "};",
      ].join("\n"),
    );

    writeFileSync(
      join(schemes, "Acme.xcscheme"),
      `<?xml version="1.0"?><Scheme>
        <LaunchAction buildConfiguration="Debug"/>
        <ArchiveAction buildConfiguration="Release"/>
      </Scheme>`,
    );
    writeFileSync(
      join(schemes, "Acme-beta.xcscheme"),
      `<?xml version="1.0"?><Scheme>
        <LaunchAction buildConfiguration="Beta"/>
        <ArchiveAction buildConfiguration="Beta"/>
      </Scheme>`,
    );

    const result = await discoverBundles({ projectRoot: dir, platform: "ios" });

    expect(result.bundles).toHaveLength(2);

    const acme = result.bundles.find((b) => b.scheme === "Acme")!;
    expect(acme.signingStyle).toBe("manual");
    expect(acme.variant).toBe("debug");
    expect(acme.configurations).toEqual([
      { name: "Debug", isDefault: true },
      { name: "Release", isDefault: false },
      { name: "Beta", isDefault: false },
    ]);

    const beta = result.bundles.find((b) => b.scheme === "Acme-beta")!;
    expect(beta.configurations?.find((c) => c.isDefault)?.name).toBe("Beta");
  });

  it("falls back to the scheme's launch config when project.pbxproj is unreadable", async () => {
    const xcodeproj = join(dir, "ios", "Tiny.xcodeproj");
    const schemes = join(xcodeproj, "xcshareddata", "xcschemes");
    mkdirSync(schemes, { recursive: true });
    writeFileSync(
      join(schemes, "Tiny.xcscheme"),
      `<?xml version="1.0"?><Scheme><LaunchAction buildConfiguration="Debug"/></Scheme>`,
    );

    const result = await discoverBundles({ projectRoot: dir, platform: "ios" });
    expect(result.bundles).toEqual([
      {
        scheme: "Tiny",
        configurations: [{ name: "Debug", isDefault: true }],
        variant: "debug",
        signingStyle: undefined,
      },
    ]);
  });

  it("flags signingStyle: 'either' when both Manual and Automatic appear", async () => {
    const xcodeproj = join(dir, "ios", "Mixed.xcodeproj");
    const schemes = join(xcodeproj, "xcshareddata", "xcschemes");
    mkdirSync(schemes, { recursive: true });
    writeFileSync(
      join(xcodeproj, "project.pbxproj"),
      "CODE_SIGN_STYLE = Manual;\nCODE_SIGN_STYLE = Automatic;\n",
    );
    writeFileSync(
      join(schemes, "Mixed.xcscheme"),
      `<?xml version="1.0"?><Scheme><LaunchAction buildConfiguration="Debug"/></Scheme>`,
    );
    const result = await discoverBundles({ projectRoot: dir, platform: "ios" });
    expect(result.bundles[0].signingStyle).toBe("either");
  });
});

describe("discoverBundles — Android", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns implicit debug + release for a project with no flavors", async () => {
    const appDir = join(dir, "android", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "build.gradle"),
      `android {
        buildTypes {
          release {
            signingConfig signingConfigs.release
          }
        }
      }`,
    );

    const result = await discoverBundles({ projectRoot: dir, platform: "android" });
    expect(result.bundles.map((b) => b.scheme).sort()).toEqual(["debug", "release"]);
  });

  it("returns one bundle per productFlavor with each buildType as a config", async () => {
    const appDir = join(dir, "android", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "build.gradle.kts"),
      `android {
        buildTypes {
          debug {}
          release {}
        }
        productFlavors {
          create("free") {}
          create("paid") {}
        }
      }`,
    );

    const result = await discoverBundles({ projectRoot: dir, platform: "android" });
    const free = result.bundles.find((b) => b.scheme === "free");
    const paid = result.bundles.find((b) => b.scheme === "paid");
    expect(free?.configurations?.map((c) => c.name).sort()).toEqual(["freeDebug", "freeRelease"]);
    expect(paid?.configurations?.find((c) => c.isDefault)?.name).toBe("paidDebug");
  });

  it("returns empty when neither build.gradle nor build.gradle.kts exists", async () => {
    const result = await discoverBundles({ projectRoot: dir, platform: "android" });
    expect(result.bundles).toEqual([]);
  });
});
