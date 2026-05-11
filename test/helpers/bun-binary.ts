import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve `bun`'s absolute path so test/script harnesses don't depend
 * on the shell PATH having `~/.nodenv/shims` / `~/.bun/bin` /
 * `/opt/homebrew/bin`. Mirrors the production daemon-spawn path in
 * src/daemon/spawn.ts (kept separate from this module so prod code
 * doesn't import test/).
 *
 * The shim path is INTENTIONALLY skipped in favour of the version-
 * specific binary: nodenv shims re-resolve `.node-version` against
 * the current cwd, and a daemon spawned with cwd = a project whose
 * `.node-version` points at a Node version without bun installed
 * fails with `nodenv: bun: command not found`. The version-specific
 * path bypasses that entirely.
 */
export function resolveBunBinary(): string {
  const home = homedir();
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
      const isBetter =
        !best ||
        (() => {
          const len = Math.max(ver.length, best!.ver.length);
          for (let i = 0; i < len; i++) {
            const a = ver[i] ?? 0;
            const b = best!.ver[i] ?? 0;
            if (a !== b) return a > b;
          }
          return false;
        })();
      if (isBetter) best = { path: candidate, ver };
    }
  }
  if (best) return best.path;
  for (const dir of [
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    const candidate = join(dir, "bun");
    if (existsSync(candidate)) return candidate;
  }
  return "bun";
}
