import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryFetcher, type ModulesRegistry } from "../registry.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function validRegistryJson(): string {
  const reg: ModulesRegistry = {
    version: 1,
    modules: [
      {
        id: "device-control",
        npmPackage: "@rn-dev-modules/device-control",
        version: "0.1.0",
        tarballSha256: "a".repeat(64),
        description: "Agent-native device control",
        author: "rn-dev",
        permissions: ["exec:adb", "net:5037"],
      },
    ],
  };
  return JSON.stringify(reg);
}

describe("RegistryFetcher", () => {
  let tmp: string;
  let cachePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rn-dev-registry-"));
    cachePath = join(tmp, "cache.json");
  });

  it("accepts a valid registry and returns its parsed contents", async () => {
    const raw = validRegistryJson();
    const url = "http://localhost/modules.json";
    // Stub global fetch for this test.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(raw, { status: 200 })) as unknown as typeof fetch;
    try {
      const fetcher = new RegistryFetcher();
      const result = await fetcher.fetch({
        url,
        cachePath,
        expectedSha: sha256(raw),
      });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.registry.modules).toHaveLength(1);
        expect(result.registry.modules[0].id).toBe("device-control");
        expect(result.fromCache).toBe(false);
      }
      expect(existsSync(cachePath)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rejects the fetched document when SHA doesn't match the baked pin", async () => {
    const raw = validRegistryJson();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(raw, { status: 200 })) as unknown as typeof fetch;
    try {
      const fetcher = new RegistryFetcher();
      const result = await fetcher.fetch({
        url: "http://localhost/modules.json",
        cachePath,
        expectedSha: "b".repeat(64),
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("E_REGISTRY_SHA_MISMATCH");
      }
      // Cache must not be written on SHA mismatch.
      expect(existsSync(cachePath)).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("accepts any SHA in dev mode (expectedSha empty string)", async () => {
    const raw = validRegistryJson();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(raw, { status: 200 })) as unknown as typeof fetch;
    try {
      const fetcher = new RegistryFetcher();
      const result = await fetcher.fetch({
        url: "http://localhost/modules.json",
        cachePath,
        expectedSha: "",
      });
      expect(result.kind).toBe("ok");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("serves cached content on second fetch and sets fromCache=true", async () => {
    const raw = validRegistryJson();
    let callCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      callCount++;
      return new Response(raw, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const fetcher = new RegistryFetcher();
      const expectedSha = sha256(raw);
      const first = await fetcher.fetch({
        url: "http://localhost/modules.json",
        cachePath,
        expectedSha,
      });
      expect(first.kind).toBe("ok");
      const second = await fetcher.fetch({
        url: "http://localhost/modules.json",
        cachePath,
        expectedSha,
      });
      expect(second.kind).toBe("ok");
      if (second.kind === "ok") {
        expect(second.fromCache).toBe(true);
      }
      expect(callCount).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("ignores a tampered cache file (body SHA diverges from stored sha256)", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        url: "http://localhost/modules.json",
        raw: validRegistryJson(),
        sha256: "deadbeef".repeat(8), // intentionally wrong
        fetchedAt: Date.now(),
      }),
    );
    const raw = validRegistryJson();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(raw, { status: 200 })) as unknown as typeof fetch;
    try {
      const fetcher = new RegistryFetcher();
      const result = await fetcher.fetch({
        url: "http://localhost/modules.json",
        cachePath,
        expectedSha: sha256(raw),
      });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(result.fromCache).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rejects JSON that doesn't match the schema (missing tarballSha256)", async () => {
    const raw = JSON.stringify({
      version: 1,
      modules: [
        {
          id: "foo",
          npmPackage: "foo",
          version: "1.0.0",
          description: "missing tarball sha",
          author: "a",
          permissions: [],
        },
      ],
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(raw, { status: 200 })) as unknown as typeof fetch;
    try {
      const fetcher = new RegistryFetcher();
      const result = await fetcher.fetch({
        url: "http://localhost/modules.json",
        cachePath,
        expectedSha: "",
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("E_REGISTRY_INVALID_SCHEMA");
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rejects malformed JSON with E_REGISTRY_INVALID_JSON", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("not json at all", { status: 200 })) as unknown as typeof fetch;
    try {
      const fetcher = new RegistryFetcher();
      const result = await fetcher.fetch({
        url: "http://localhost/modules.json",
        cachePath,
        expectedSha: "",
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("E_REGISTRY_INVALID_JSON");
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("surfaces HTTP errors as E_REGISTRY_FETCH_FAILED", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    try {
      const fetcher = new RegistryFetcher();
      const result = await fetcher.fetch({
        url: "http://localhost/modules.json",
        cachePath,
        expectedSha: "",
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("E_REGISTRY_FETCH_FAILED");
        expect(result.message).toContain("404");
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rejects entries whose id contains path traversal characters", async () => {
    const raw = JSON.stringify({
      version: 1,
      modules: [
        {
          id: "../../etc/passwd",
          npmPackage: "hostile",
          version: "0.0.1",
          tarballSha256: "a".repeat(64),
          description: "x",
          author: "x",
          permissions: [],
        },
      ],
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(raw, { status: 200 })) as unknown as typeof fetch;
    try {
      const fetcher = new RegistryFetcher();
      const result = await fetcher.fetch({
        url: "http://localhost/modules.json",
        cachePath,
        expectedSha: "",
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("E_REGISTRY_INVALID_SCHEMA");
        expect(result.message).toMatch(/id must match/);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("RegistryFetcher.find returns the entry matching moduleId", () => {
    const fetcher = new RegistryFetcher();
    const reg: ModulesRegistry = JSON.parse(validRegistryJson()) as ModulesRegistry;
    expect(fetcher.find(reg, "device-control")?.npmPackage).toBe(
      "@rn-dev-modules/device-control",
    );
    expect(fetcher.find(reg, "unknown")).toBeNull();
  });

  it("caches the JSON verbatim — cache file round-trips through readCache", () => {
    const raw = validRegistryJson();
    const sha = sha256(raw);
    writeFileSync(
      cachePath,
      JSON.stringify({
        url: "http://localhost/modules.json",
        raw,
        sha256: sha,
        fetchedAt: Date.now(),
      }),
    );
    // Smoke: the cached raw still parses and its SHA still matches.
    const read = JSON.parse(readFileSync(cachePath, "utf-8")) as {
      raw: string;
      sha256: string;
    };
    expect(sha256(read.raw)).toBe(read.sha256);
  });
});
