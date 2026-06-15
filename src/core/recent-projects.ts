// ---------------------------------------------------------------------------
// recent-projects — persisted "which project is the GUI bound to" store
// ---------------------------------------------------------------------------
//
// The Electron GUI binds to exactly one React Native project per window
// (the project root is a boot-time constant — see electron/main.ts). Before
// this store, that root was chosen *silently* from `process.cwd()` with a
// hardcoded fallback: a user opening the app had no way to see which project
// was active, and no way to pick a different one without relaunching from a
// different directory.
//
// This store backs the explicit project picker (renderer/views/WelcomeScreen):
//   - `lastProject` is the committed root the next boot opens straight into.
//   - `recents` is the most-recent-first list the picker offers.
//
// Lives at `~/.rn-dev/projects.json` to sit with the rest of the host's
// per-user state (registry.json, audit.log, …) and is shared across
// clients: the Electron picker AND the MCP `rn-dev/open-project` tool read
// and write the same store, so a project an agent opens shows up in the GUI
// picker and vice versa. Read is defensive (a corrupt file never blocks
// boot — we just fall back to the picker); write is atomic (temp-file +
// rename) so a crash mid-write can't leave a half-formed file. Mirrors
// src/daemon/registry.ts.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** One entry in the picker's recent list. */
export interface RecentProject {
  /** Absolute project root (directory containing the RN package.json). */
  path: string;
  /** Display name — `basename(path)`. */
  name: string;
  /** ISO-8601 timestamp of the last time this project was opened. */
  lastOpenedAt: string;
}

/** On-disk store shape. */
export interface ProjectsStore {
  /**
   * The project root the next GUI boot should open into, or null to show
   * the picker. Set whenever the user explicitly opens a project.
   */
  lastProject: string | null;
  /** Most-recent-first, deduped by path, capped at MAX_RECENTS. */
  recents: RecentProject[];
}

/** Upper bound on the recents list — keeps the picker scannable. */
export const MAX_RECENTS = 12;

const EMPTY: ProjectsStore = { lastProject: null, recents: [] };

/**
 * Default store path. Tests override via `RN_DEV_PROJECTS_PATH` so the
 * shared `~/.rn-dev/electron-projects.json` doesn't get clobbered by runs.
 */
export function defaultProjectsPath(): string {
  const override = process.env.RN_DEV_PROJECTS_PATH;
  if (override) return override;
  return join(homedir(), ".rn-dev", "projects.json");
}

/**
 * Read + parse the store. Returns an empty store if the file is missing or
 * malformed — a corrupted file shouldn't permanently block the GUI, it just
 * means the user re-picks their project once.
 */
export function readProjects(
  path: string = defaultProjectsPath(),
): ProjectsStore {
  if (!existsSync(path)) return { ...EMPTY };
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { ...EMPTY };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...EMPTY };
    const obj = parsed as { lastProject?: unknown; recents?: unknown };

    const lastProject =
      typeof obj.lastProject === "string" && obj.lastProject.length > 0
        ? obj.lastProject
        : null;

    const recents: RecentProject[] = [];
    if (Array.isArray(obj.recents)) {
      for (const raw of obj.recents) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        if (typeof r.path !== "string" || r.path.length === 0) continue;
        recents.push({
          path: r.path,
          name:
            typeof r.name === "string" && r.name.length > 0
              ? r.name
              : basename(r.path),
          lastOpenedAt:
            typeof r.lastOpenedAt === "string" &&
            !Number.isNaN(Date.parse(r.lastOpenedAt))
              ? r.lastOpenedAt
              : new Date(0).toISOString(),
        });
      }
    }

    return { lastProject, recents: recents.slice(0, MAX_RECENTS) };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Atomically write the store — temp-file + rename so a crash mid-write
 * can't leave a half-formed file. The temp filename carries a random
 * suffix in addition to the pid to defend against a same-UID adversary
 * pre-symlinking `${path}.tmp.${pid}`.
 */
export function writeProjects(
  store: ProjectsStore,
  path: string = defaultProjectsPath(),
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Record that `projectRoot` was just opened: set it as `lastProject` and
 * push it to the front of `recents` (deduped by path, capped). Returns the
 * updated store (already persisted).
 */
export function recordOpenedProject(
  projectRoot: string,
  path: string = defaultProjectsPath(),
): ProjectsStore {
  const store = readProjects(path);
  const now = new Date().toISOString();
  const entry: RecentProject = {
    path: projectRoot,
    name: basename(projectRoot),
    lastOpenedAt: now,
  };
  const deduped = store.recents.filter((r) => r.path !== projectRoot);
  const next: ProjectsStore = {
    lastProject: projectRoot,
    recents: [entry, ...deduped].slice(0, MAX_RECENTS),
  };
  writeProjects(next, path);
  return next;
}

/** The committed project root for the next boot, or null to show the picker. */
export function getLastProject(
  path: string = defaultProjectsPath(),
): string | null {
  return readProjects(path).lastProject;
}

/** The most-recent-first recents list. */
export function listRecentProjects(
  path: string = defaultProjectsPath(),
): RecentProject[] {
  return readProjects(path).recents;
}
