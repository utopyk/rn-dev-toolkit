// Curated marketplace registry schema + fetcher.
//
// The registry is a single JSON document at a host-baked URL (default:
// `https://raw.githubusercontent.com/<owner>/rn-dev-modules-registry/main/modules.json`,
// overridable via the `RN_DEV_MODULES_REGISTRY_URL` env var). Each entry
// declares a 3p module that users can install via the Marketplace panel or
// the `modules/install` MCP action.
//
// Security model (Phase 6):
//   * The host bakes in a SHA-256 of the expected document per release.
//     Fetches with a mismatched SHA are rejected with `E_REGISTRY_SHA_MISMATCH`
//     unless the caller explicitly overrides via `acceptSha`.
//   * Nothing in this file TRUSTS what the server sent — the SHA is checked
//     before JSON.parse, and the parsed document is validated shape-by-shape.
//   * Cache lives at `~/.rn-dev/modules-registry-cache.json` with a 1h TTL.
//     Cached content is itself SHA-checked on read so tampering with the
//     cache file doesn't bypass the pin.
//
// The tarball SHA-256 per module entry is verified by `ModuleInstaller`, not
// here — this module only covers the index document.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/rn-dev/rn-dev-modules-registry/main/modules.json";

/**
 * Host-baked SHA-256 of the expected `modules.json` content. Empty string means
 * "dev mode — no pin baked" (accepted with a warning). Production host releases
 * replace this constant as part of the release flow.
 */
export const EXPECTED_MODULES_JSON_SHA256: string = "";

export const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1000;

export interface RegistryEntry {
  /** Module id — must match the installed manifest's `id`. */
  id: string;
  /** npm package spec, e.g. `@rn-dev-modules/device-control`. */
  npmPackage: string;
  /** Exact version to install — arborist resolves this; no range semantics. */
  version: string;
  /**
   * Hex-encoded SHA-256 of the tarball (`npm pack` output). `ModuleInstaller`
   * verifies the downloaded file against this before extracting.
   */
  tarballSha256: string;
  description: string;
  author: string;
  /**
   * Advisory permissions copied from the module's manifest. Shown in the
   * consent dialog BEFORE install so the user sees what they're signing off
   * on. Not enforced at runtime in v1 — the host trusts the subprocess
   * isolation + curated registry + consent UI.
   */
  permissions: string[];
  homepage?: string;
}

export interface ModulesRegistry {
  /** Schema version — increment on breaking changes. */
  version: 1;
  modules: RegistryEntry[];
}

export interface FetchOptions {
  /**
   * Override the registry URL (env var wins over this if both are set).
   * Tests pass a `file://` URL or a local path.
   */
  url?: string;
  /**
   * If true, bypass any cached response and always fetch fresh. Does NOT
   * bypass the SHA pin check.
   */
  skipCache?: boolean;
  /**
   * Expected SHA — overrides the compile-time `EXPECTED_MODULES_JSON_SHA256`.
   * Used by `--accept-registry-sha <sha>` flag and by tests.
   */
  expectedSha?: string;
  /**
   * Path override for the cache file. Tests use a tmpdir so CI runs don't
   * touch the user's `~/.rn-dev/`.
   */
  cachePath?: string;
}

export type FetchResult =
  | { kind: "ok"; registry: ModulesRegistry; sha256: string; fromCache: boolean }
  | {
      kind: "error";
      code:
        | "E_REGISTRY_FETCH_FAILED"
        | "E_REGISTRY_SHA_MISMATCH"
        | "E_REGISTRY_INVALID_JSON"
        | "E_REGISTRY_INVALID_SCHEMA";
      message: string;
    };

// Module-level flag — we want the "pin is empty" warning to fire once per
// process, not once per RegistryFetcher instance.
let warnedAboutEmptyPin = false;

export class RegistryFetcher {
  private readonly defaultCachePath = join(
    homedir(),
    ".rn-dev",
    "modules-registry-cache.json",
  );

  async fetch(opts: FetchOptions = {}): Promise<FetchResult> {
    const url = resolveRegistryUrl(opts.url);
    const expectedSha = opts.expectedSha ?? EXPECTED_MODULES_JSON_SHA256;
    const cachePath = opts.cachePath ?? this.defaultCachePath;

    if (!schemeAllowed(url)) {
      return {
        kind: "error",
        code: "E_REGISTRY_FETCH_FAILED",
        message: `registry URL scheme is not allowed: ${url} — production builds require https:, dev builds additionally allow file: and http://localhost.`,
      };
    }

    if (!expectedSha && !warnedAboutEmptyPin) {
      warnedAboutEmptyPin = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[rn-dev] EXPECTED_MODULES_JSON_SHA256 is empty — running in dev mode, modules.json is NOT pinned. Production host releases MUST bake a SHA-256.",
      );
    }

    // Try cache first unless explicitly skipped.
    if (!opts.skipCache) {
      const cached = readCache(cachePath);
      if (cached && cached.url === url && Date.now() - cached.fetchedAt < REGISTRY_CACHE_TTL_MS) {
        const shaCheck = verifyShaIfPinned(cached.raw, expectedSha);
        if (shaCheck.kind === "ok") {
          const parsed = parseAndValidate(cached.raw);
          if (parsed.kind === "ok") {
            return {
              kind: "ok",
              registry: parsed.registry,
              sha256: cached.sha256,
              fromCache: true,
            };
          }
          return parsed;
        }
        // Pinned SHA diverged from cached content — fall through to refetch.
      }
    }

    // Fetch fresh.
    let raw: string;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        return {
          kind: "error",
          code: "E_REGISTRY_FETCH_FAILED",
          message: `registry fetch ${url} returned ${res.status} ${res.statusText}`,
        };
      }
      raw = await res.text();
    } catch (err) {
      return {
        kind: "error",
        code: "E_REGISTRY_FETCH_FAILED",
        message: err instanceof Error ? err.message : `failed to fetch ${url}`,
      };
    }

    const shaCheck = verifyShaIfPinned(raw, expectedSha);
    if (shaCheck.kind === "error") return shaCheck;

    const parsed = parseAndValidate(raw);
    if (parsed.kind === "error") return parsed;

    writeCache(cachePath, {
      url,
      raw,
      sha256: shaCheck.sha256,
      fetchedAt: Date.now(),
    });

    return {
      kind: "ok",
      registry: parsed.registry,
      sha256: shaCheck.sha256,
      fromCache: false,
    };
  }

  /** Look up a single entry by module id in a fetched registry. */
  find(registry: ModulesRegistry, moduleId: string): RegistryEntry | null {
    return registry.modules.find((m) => m.id === moduleId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface CachedRegistry {
  url: string;
  raw: string;
  sha256: string;
  fetchedAt: number;
}

/**
 * Whitelist of URL schemes the registry fetcher will accept. Security P1-2
 * (Phase 6 review): unrestricted scheme acceptance let a malicious env-var
 * point at `file:///etc/passwd` or internal HTTP services. In production
 * builds only https is allowed; dev builds add `file:` + http://localhost
 * so tests and local-fixture flows keep working.
 */
const ALLOWED_SCHEMES_PRODUCTION: ReadonlyArray<string> = ["https:"];
const ALLOWED_SCHEMES_DEV: ReadonlyArray<string> = ["https:", "http:", "file:"];

function schemeAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const schemes =
    process.env["NODE_ENV"] === "production"
      ? ALLOWED_SCHEMES_PRODUCTION
      : ALLOWED_SCHEMES_DEV;
  if (!schemes.includes(parsed.protocol)) return false;
  // Even in dev, plain http is only permitted for loopback targets.
  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }
  return true;
}

export function resolveRegistryUrl(override?: string): string {
  if (override) return override;
  const envUrl = process.env["RN_DEV_MODULES_REGISTRY_URL"];
  if (envUrl) return envUrl;
  return DEFAULT_REGISTRY_URL;
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function verifyShaIfPinned(
  raw: string,
  expectedSha: string,
):
  | { kind: "ok"; sha256: string }
  | {
      kind: "error";
      code: "E_REGISTRY_SHA_MISMATCH";
      message: string;
    } {
  const actual = sha256Hex(raw);
  if (!expectedSha) {
    // Dev mode — no pin baked. Accepted silently here; callers that want to
    // warn can compare `fromCache` + the returned sha256.
    return { kind: "ok", sha256: actual };
  }
  if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
    return {
      kind: "error",
      code: "E_REGISTRY_SHA_MISMATCH",
      message: `modules.json SHA-256 mismatch — expected ${expectedSha}, got ${actual}. Possible registry compromise; refusing to install. Override via --accept-registry-sha if you've audited the document.`,
    };
  }
  return { kind: "ok", sha256: actual };
}

function parseAndValidate(
  raw: string,
):
  | { kind: "ok"; registry: ModulesRegistry }
  | {
      kind: "error";
      code: "E_REGISTRY_INVALID_JSON" | "E_REGISTRY_INVALID_SCHEMA";
      message: string;
    } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "error",
      code: "E_REGISTRY_INVALID_JSON",
      message: err instanceof Error ? err.message : "invalid JSON",
    };
  }

  if (!json || typeof json !== "object") {
    return {
      kind: "error",
      code: "E_REGISTRY_INVALID_SCHEMA",
      message: "modules.json must be a JSON object",
    };
  }
  const obj = json as Record<string, unknown>;
  if (obj["version"] !== 1) {
    return {
      kind: "error",
      code: "E_REGISTRY_INVALID_SCHEMA",
      message: `unsupported registry schema version: ${String(obj["version"])}`,
    };
  }
  if (!Array.isArray(obj["modules"])) {
    return {
      kind: "error",
      code: "E_REGISTRY_INVALID_SCHEMA",
      message: "modules.json: `modules` must be an array",
    };
  }

  const entries: RegistryEntry[] = [];
  for (let i = 0; i < obj["modules"].length; i++) {
    const entry = obj["modules"][i];
    const v = validateEntry(entry, i);
    if (v.kind === "error") return v;
    entries.push(v.entry);
  }

  return { kind: "ok", registry: { version: 1, modules: entries } };
}

/**
 * Defense-in-depth: reject registry entries whose `id` isn't a safe npm-style
 * identifier. The id is used as a directory name under `~/.rn-dev/modules/`,
 * so a compromised registry entry with `"../../etc/passwd"` could otherwise
 * escape. SHA-pinning is the primary defense; this is the belt. Exported so
 * other code paths that build install paths from moduleIds (uninstall) can
 * re-check before `join()`.
 */
export const SAFE_MODULE_ID = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export function isSafeModuleId(id: string): boolean {
  return typeof id === "string" && SAFE_MODULE_ID.test(id);
}

function validateEntry(
  raw: unknown,
  index: number,
):
  | { kind: "ok"; entry: RegistryEntry }
  | {
      kind: "error";
      code: "E_REGISTRY_INVALID_SCHEMA";
      message: string;
    } {
  if (!raw || typeof raw !== "object") {
    return {
      kind: "error",
      code: "E_REGISTRY_INVALID_SCHEMA",
      message: `modules[${index}] must be an object`,
    };
  }
  const obj = raw as Record<string, unknown>;
  const required: ReadonlyArray<keyof RegistryEntry> = [
    "id",
    "npmPackage",
    "version",
    "tarballSha256",
    "description",
    "author",
    "permissions",
  ];
  for (const key of required) {
    if (!(key in obj)) {
      return {
        kind: "error",
        code: "E_REGISTRY_INVALID_SCHEMA",
        message: `modules[${index}].${String(key)} is required`,
      };
    }
  }
  const strings: ReadonlyArray<keyof RegistryEntry> = [
    "id",
    "npmPackage",
    "version",
    "tarballSha256",
    "description",
    "author",
  ];
  for (const key of strings) {
    if (typeof obj[key as string] !== "string") {
      return {
        kind: "error",
        code: "E_REGISTRY_INVALID_SCHEMA",
        message: `modules[${index}].${String(key)} must be a string`,
      };
    }
  }
  if (!Array.isArray(obj["permissions"])) {
    return {
      kind: "error",
      code: "E_REGISTRY_INVALID_SCHEMA",
      message: `modules[${index}].permissions must be an array`,
    };
  }
  for (const p of obj["permissions"]) {
    if (typeof p !== "string") {
      return {
        kind: "error",
        code: "E_REGISTRY_INVALID_SCHEMA",
        message: `modules[${index}].permissions must be string[]`,
      };
    }
  }
  const sha = obj["tarballSha256"] as string;
  if (!/^[a-f0-9]{64}$/i.test(sha)) {
    return {
      kind: "error",
      code: "E_REGISTRY_INVALID_SCHEMA",
      message: `modules[${index}].tarballSha256 must be 64 hex chars`,
    };
  }
  const id = obj["id"] as string;
  if (!isSafeModuleId(id)) {
    return {
      kind: "error",
      code: "E_REGISTRY_INVALID_SCHEMA",
      message: `modules[${index}].id must match ${SAFE_MODULE_ID.source} (got "${id}")`,
    };
  }
  return {
    kind: "ok",
    entry: {
      id,
      npmPackage: obj["npmPackage"] as string,
      version: obj["version"] as string,
      tarballSha256: sha.toLowerCase(),
      description: obj["description"] as string,
      author: obj["author"] as string,
      permissions: obj["permissions"] as string[],
      homepage: typeof obj["homepage"] === "string" ? (obj["homepage"] as string) : undefined,
    },
  };
}

function readCache(path: string): CachedRegistry | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj["url"] !== "string" ||
      typeof obj["raw"] !== "string" ||
      typeof obj["sha256"] !== "string" ||
      typeof obj["fetchedAt"] !== "number"
    ) {
      return null;
    }
    // Verify cache integrity — a tampered cache file shouldn't bypass the pin.
    if (sha256Hex(obj["raw"]) !== obj["sha256"]) return null;
    return obj as unknown as CachedRegistry;
  } catch {
    return null;
  }
}

function writeCache(path: string, cached: CachedRegistry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cached));
  } catch {
    // Cache write failures are non-fatal — the next request will just refetch.
  }
}
