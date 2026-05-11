#!/usr/bin/env node
/**
 * `npm run test:tui` entrypoint. Resolves `bun` even when the shell
 * PATH lacks nodenv shims / `~/.bun/bin` / homebrew, mirroring
 * `vitest.global-setup.ts`. Then builds the workspace package
 * artifacts (so `@rn-dev/config` / `@rn-dev/module-sdk` resolve under
 * bun test) and runs the TUI suite.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function compareVer(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function resolveBunBinary() {
  const home = homedir();
  const versionRoots = [
    { root: join(home, ".nodenv", "versions"), subpath: ["bin"] },
    { root: join(home, ".nvm", "versions", "node"), subpath: ["bin"] },
    { root: join(home, ".fnm", "node-versions"), subpath: ["installation", "bin"] },
  ];
  let best = null;
  for (const { root, subpath } of versionRoots) {
    if (!existsSync(root)) continue;
    let entries;
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
      if (!best || compareVer(ver, best.ver) > 0) {
        best = { path: candidate, ver };
      }
    }
  }
  if (best) return best.path;
  for (const dir of [join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    const candidate = join(dir, "bun");
    if (existsSync(candidate)) return candidate;
  }
  return "bun";
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bun = resolveBunBinary();

function run(args) {
  const result = spawnSync(bun, args, { stdio: "inherit", cwd: repoRoot });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["run", "packages/module-sdk/build.ts"]);
run(["run", "packages/config/build.ts"]);

const passthrough = process.argv.slice(2);
const target = passthrough.length > 0 ? passthrough : ["tests/tui/"];
run(["test", ...target]);
