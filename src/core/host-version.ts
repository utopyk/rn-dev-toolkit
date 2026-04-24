// Single source of truth for the host version string, read once from
// `process.cwd()/package.json`. Both the TUI bootstrap and the daemon
// supervisor need this; having two near-identical copies was the kind
// of drift risk the extraction removes.

import { readFileSync } from "node:fs";
import path from "node:path";

export function readHostVersion(): string {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
