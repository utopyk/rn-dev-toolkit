/**
 * Vitest global setup — runs once before the test suite starts.
 *
 * Builds workspace packages whose `package.json#main` points at a `dist/`
 * artifact, so vite's import-analysis can resolve them by package name when
 * the CLI / daemon code dynamically imports them. Each build is idempotent
 * and finishes in <200ms, so we always run them instead of checking mtimes.
 *
 * Phase 3d added `@rn-dev/module-sdk`. Phase H0 added `@rn-dev/config`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate `bun` even when vitest is run from a shell whose PATH lacks
 * `~/.nodenv/shims` / `~/.bun/bin` / homebrew. Mirrors the same logic
 * the daemon-spawn path uses (src/daemon/spawn.ts) so vitest stops
 * exploding with `[vitest.global-setup] build of … exited with code
 * null` when bun isn't on the shell PATH.
 *
 * Prefer the version-specific binary (`~/.nodenv/versions/<v>/bin/bun`)
 * over the shim, because the shim re-resolves `.node-version` at
 * runtime and our cwd's `.node-version` may point at a Node version
 * without bun installed.
 */
function resolveBunBinary(): string {
  const home = homedir();
  // 1. Highest version under nodenv/nvm/fnm.
  const versionRoots: Array<{ root: string; subpath: string[] }> = [
    { root: join(home, ".nodenv", "versions"), subpath: ["bin"] },
    { root: join(home, ".nvm", "versions", "node"), subpath: ["bin"] },
    { root: join(home, ".fnm", "node-versions"), subpath: ["installation", "bin"] },
  ];
  let best: { path: string; ver: number[] } | null = null;
  for (const { root, subpath } of versionRoots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(root, entry, ...subpath, "bun");
      if (!existsSync(candidate)) continue;
      const ver = entry.replace(/^v/, "").split(".").map((s) => Number(s));
      if (ver.some((v) => Number.isNaN(v))) continue;
      if (!best || compareVer(ver, best.ver) > 0) best = { path: candidate, ver };
    }
  }
  if (best) return best.path;
  // 2. Static well-known dirs.
  const staticDirs = [
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of staticDirs) {
    const candidate = join(dir, "bun");
    if (existsSync(candidate)) return candidate;
  }
  // 3. Final fallback — let spawnSync's PATH search try.
  return "bun";
}

function compareVer(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export default async function globalSetup(): Promise<void> {
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const buildScripts = [
    join(repoRoot, "packages/module-sdk/build.ts"),
    join(repoRoot, "packages/config/build.ts"),
  ];
  const bun = resolveBunBinary();
  for (const script of buildScripts) {
    const result = spawnSync(bun, ["run", script], {
      stdio: "inherit",
      cwd: repoRoot,
    });
    if (result.status !== 0) {
      throw new Error(
        `[vitest.global-setup] build of ${script} exited with code ${result.status}`,
      );
    }
  }
}
