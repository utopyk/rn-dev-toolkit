import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleRegistry } from "../../registry.js";
import {
  installModule,
  uninstallModule,
  type PacoteLike,
  type ArboristFactory,
  type ArboristLike,
} from "../installer.js";
import type { RegistryEntry } from "../registry.js";

const MANIFEST_CONTENT = {
  id: "test-module",
  version: "0.1.0",
  hostRange: ">=0.0.0",
  scope: "global",
  contributes: {
    mcp: {
      tools: [
        {
          name: "test-module__hello",
          description: "echoes a string",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  },
  activationEvents: ["onStartup"],
};

const PACKAGE_JSON_CONTENT = {
  name: "@rn-dev-modules/test-module",
  version: "0.1.0",
  main: "index.js",
};

function makeFakeTarball(content: string): Buffer {
  // Returns a deterministic byte sequence so the caller can compute its
  // SHA-256 ahead of time. The stub extractor doesn't actually parse it;
  // this is just a "blob with known hash."
  return Buffer.from(content, "utf-8");
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface FakePacoteOptions {
  tarballContent?: string;
  manifest?: Record<string, unknown>;
  packageJson?: Record<string, unknown>;
  extractFails?: boolean;
  tarballFails?: boolean;
}

function fakePacote(opts: FakePacoteOptions = {}): {
  pacote: PacoteLike;
  tarballSha: string;
} {
  const tarballContent = opts.tarballContent ?? "fake-tarball-bytes";
  const buf = makeFakeTarball(tarballContent);
  const pacote: PacoteLike = {
    tarball: async () => {
      if (opts.tarballFails) throw new Error("tarball fetch failed");
      return buf;
    },
    extract: async (_spec: string, target: string) => {
      if (opts.extractFails) throw new Error("extract failed");
      mkdirSync(target, { recursive: true });
      writeFileSync(
        join(target, "rn-dev-module.json"),
        JSON.stringify(opts.manifest ?? MANIFEST_CONTENT),
      );
      writeFileSync(
        join(target, "package.json"),
        JSON.stringify(opts.packageJson ?? PACKAGE_JSON_CONTENT),
      );
      return undefined;
    },
  };
  return { pacote, tarballSha: sha256(buf) };
}

function neverCalledArborist(): ArboristFactory {
  return () => ({
    reify: async () => {
      throw new Error("arborist should not have been called — no deps declared");
    },
  });
}

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "test-module",
    npmPackage: "@rn-dev-modules/test-module",
    version: "0.1.0",
    tarballSha256: "a".repeat(64),
    description: "test fixture",
    author: "tests",
    permissions: ["exec:adb", "net:5037"],
    ...overrides,
  };
}

describe("installModule", () => {
  let modulesDir: string;

  beforeEach(() => {
    modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-install-"));
  });

  it("installs a well-formed module end-to-end and returns the RegisteredModule", async () => {
    const { pacote, tarballSha } = fakePacote();
    const registry = new ModuleRegistry();
    const entry = makeEntry({ tarballSha256: tarballSha });

    const result = await installModule({
      entry,
      permissionsAccepted: ["exec:adb", "net:5037"],
      registry,
      hostVersion: "1.0.0",
      modulesDir,
      pacote,
      arboristFactory: neverCalledArborist(),
      thirdPartyAcknowledged: true,
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.module.manifest.id).toBe("test-module");
      expect(result.module.isBuiltIn).toBe(false);
      expect(result.tarballSha256).toBe(tarballSha);
      expect(existsSync(join(modulesDir, "test-module", "rn-dev-module.json"))).toBe(true);
    }
    expect(registry.getManifest("test-module", "global")).toBeDefined();
  });

  it("rejects install when tarball SHA doesn't match the registry entry", async () => {
    const { pacote } = fakePacote();
    const registry = new ModuleRegistry();
    const entry = makeEntry({ tarballSha256: "b".repeat(64) });

    const result = await installModule({
      entry,
      permissionsAccepted: entry.permissions,
      registry,
      hostVersion: "1.0.0",
      modulesDir,
      pacote,
      arboristFactory: neverCalledArborist(),
      thirdPartyAcknowledged: true,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_INTEGRITY_MISMATCH");
    }
    expect(existsSync(join(modulesDir, "test-module"))).toBe(false);
    expect(registry.getAllManifests()).toHaveLength(0);
  });

  it("rejects install when permissionsAccepted doesn't cover every declared permission", async () => {
    const { pacote, tarballSha } = fakePacote();
    const registry = new ModuleRegistry();

    const result = await installModule({
      entry: makeEntry({ tarballSha256: tarballSha }),
      permissionsAccepted: ["exec:adb"], // missing net:5037
      registry,
      hostVersion: "1.0.0",
      modulesDir,
      pacote,
      arboristFactory: neverCalledArborist(),
      thirdPartyAcknowledged: true,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_PERMISSION_DENIED");
      expect(result.message).toContain("net:5037");
    }
  });

  it("rolls back (removes install dir) when manifest validation fails", async () => {
    const { pacote, tarballSha } = fakePacote({
      manifest: { id: "not-a-manifest" }, // missing required fields
    });
    const registry = new ModuleRegistry();

    const result = await installModule({
      entry: makeEntry({ tarballSha256: tarballSha }),
      permissionsAccepted: ["exec:adb", "net:5037"],
      registry,
      hostVersion: "1.0.0",
      modulesDir,
      pacote,
      arboristFactory: neverCalledArborist(),
      thirdPartyAcknowledged: true,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_INVALID_MANIFEST");
    }
    expect(existsSync(join(modulesDir, "test-module"))).toBe(false);
  });

  it("rejects install when manifest id differs from registry entry id", async () => {
    const { pacote, tarballSha } = fakePacote({
      manifest: { ...MANIFEST_CONTENT, id: "different-id" },
    });
    const registry = new ModuleRegistry();

    const result = await installModule({
      entry: makeEntry({ id: "test-module", tarballSha256: tarballSha }),
      permissionsAccepted: ["exec:adb", "net:5037"],
      registry,
      hostVersion: "1.0.0",
      modulesDir,
      pacote,
      arboristFactory: neverCalledArborist(),
      thirdPartyAcknowledged: true,
    });

    // Manifest-id-mismatch comes after loadUserGlobalModules runs. The
    // installer looks for a manifest whose id matches the registry entry id;
    // with a spoofed manifest it finds no match + returns E_INVALID_MANIFEST
    // rather than reaching the explicit mismatch check. Either code is a
    // safe rejection — we verify the install was rolled back.
    expect(result.kind).toBe("error");
    expect(existsSync(join(modulesDir, "test-module"))).toBe(false);
  });

  it("refuses to overwrite an already-installed module", async () => {
    const { pacote, tarballSha } = fakePacote();
    const registry = new ModuleRegistry();
    const entry = makeEntry({ tarballSha256: tarballSha });
    mkdirSync(join(modulesDir, "test-module"), { recursive: true });

    const result = await installModule({
      entry,
      permissionsAccepted: entry.permissions,
      registry,
      hostVersion: "1.0.0",
      modulesDir,
      pacote,
      arboristFactory: neverCalledArborist(),
      thirdPartyAcknowledged: true,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_ALREADY_INSTALLED");
    }
  });

  it("runs arborist when the package declares runtime dependencies", async () => {
    const { pacote, tarballSha } = fakePacote({
      packageJson: {
        name: "@rn-dev-modules/test-module",
        version: "0.1.0",
        dependencies: { "some-dep": "^1.0.0" },
      },
    });
    const registry = new ModuleRegistry();
    let arboristCalled = false;
    let passedOpts: Record<string, unknown> | null = null;
    const arboristFactory: ArboristFactory = (opts) => {
      passedOpts = opts as Record<string, unknown>;
      const arb: ArboristLike = {
        reify: async (reifyOpts) => {
          arboristCalled = true;
          expect(reifyOpts).toEqual({ ignoreScripts: true });
          return undefined;
        },
      };
      return arb;
    };

    const result = await installModule({
      entry: makeEntry({ tarballSha256: tarballSha }),
      permissionsAccepted: ["exec:adb", "net:5037"],
      registry,
      hostVersion: "1.0.0",
      modulesDir,
      pacote,
      arboristFactory,
      thirdPartyAcknowledged: true,
    });

    expect(result.kind).toBe("ok");
    expect(arboristCalled).toBe(true);
    expect(passedOpts).toMatchObject({ ignoreScripts: true });
    expect((passedOpts as unknown as { path: string }).path).toContain("test-module");
  });

  it("surfaces pacote.tarball failures as E_TARBALL_FETCH_FAILED", async () => {
    const { pacote, tarballSha } = fakePacote({ tarballFails: true });
    const registry = new ModuleRegistry();
    const result = await installModule({
      entry: makeEntry({ tarballSha256: tarballSha }),
      permissionsAccepted: ["exec:adb", "net:5037"],
      registry,
      hostVersion: "1.0.0",
      modulesDir,
      pacote,
      arboristFactory: neverCalledArborist(),
      thirdPartyAcknowledged: true,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_TARBALL_FETCH_FAILED");
    }
    expect(existsSync(join(modulesDir, "test-module"))).toBe(false);
  });

  it("rolls back and surfaces E_EXTRACT_FAILED if pacote.extract throws", async () => {
    const { pacote, tarballSha } = fakePacote({ extractFails: true });
    const registry = new ModuleRegistry();
    const result = await installModule({
      entry: makeEntry({ tarballSha256: tarballSha }),
      permissionsAccepted: ["exec:adb", "net:5037"],
      registry,
      hostVersion: "1.0.0",
      modulesDir,
      pacote,
      arboristFactory: neverCalledArborist(),
      thirdPartyAcknowledged: true,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_EXTRACT_FAILED");
    }
    expect(existsSync(join(modulesDir, "test-module"))).toBe(false);
  });
});

describe("uninstallModule", () => {
  let modulesDir: string;

  beforeEach(() => {
    modulesDir = mkdtempSync(join(tmpdir(), "rn-dev-uninstall-"));
  });

  it("removes the install directory and unregisters the manifest", async () => {
    // Seed an install state.
    const installPath = join(modulesDir, "test-module");
    mkdirSync(installPath);
    writeFileSync(
      join(installPath, "rn-dev-module.json"),
      JSON.stringify(MANIFEST_CONTENT),
    );
    const registry = new ModuleRegistry();
    registry.registerManifest({
      manifest: MANIFEST_CONTENT as any,
      modulePath: installPath,
      scopeUnit: "global",
      state: "inert",
      isBuiltIn: false,
      kind: "subprocess",
    });

    const result = await uninstallModule({
      moduleId: "test-module",
      registry,
      modulesDir,
    });

    expect(result.kind).toBe("ok");
    expect(existsSync(installPath)).toBe(false);
    expect(registry.getManifest("test-module", "global")).toBeUndefined();
  });

  it("returns E_UNINSTALL_NOT_FOUND when the install dir is missing", async () => {
    const result = await uninstallModule({
      moduleId: "ghost",
      registry: new ModuleRegistry(),
      modulesDir,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_UNINSTALL_NOT_FOUND");
    }
  });
});
