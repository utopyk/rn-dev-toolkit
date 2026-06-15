import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RECENTS,
  defaultProjectsPath,
  getLastProject,
  listRecentProjects,
  readProjects,
  recordOpenedProject,
  writeProjects,
} from "../recent-projects.js";

// All cases route through an isolated tmp store via RN_DEV_PROJECTS_PATH so
// the shared ~/.rn-dev/electron-projects.json never gets clobbered.
let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rn-dev-projects-"));
  storePath = join(dir, "electron-projects.json");
  process.env.RN_DEV_PROJECTS_PATH = storePath;
});

afterEach(() => {
  delete process.env.RN_DEV_PROJECTS_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("recent-projects — path resolution", () => {
  it("honors the RN_DEV_PROJECTS_PATH override", () => {
    expect(defaultProjectsPath()).toBe(storePath);
  });

  it("falls back to ~/.rn-dev when the override is unset", () => {
    delete process.env.RN_DEV_PROJECTS_PATH;
    expect(defaultProjectsPath()).toMatch(/\.rn-dev[/\\]projects\.json$/);
  });
});

describe("recent-projects — read", () => {
  it("returns an empty store when the file is missing", () => {
    expect(readProjects()).toEqual({ lastProject: null, recents: [] });
  });

  it("returns an empty store when the file is malformed (never throws)", () => {
    writeFileSync(storePath, "{ not valid json");
    expect(readProjects()).toEqual({ lastProject: null, recents: [] });
  });

  it("drops malformed recent rows but keeps the valid ones", () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        lastProject: "/a",
        recents: [
          { path: "/a", name: "a", lastOpenedAt: "2026-06-15T00:00:00.000Z" },
          { name: "no-path" },
          { path: 42 },
          "garbage",
        ],
      }),
    );
    const store = readProjects();
    expect(store.lastProject).toBe("/a");
    expect(store.recents).toHaveLength(1);
    expect(store.recents[0].path).toBe("/a");
  });

  it("backfills name/lastOpenedAt when missing or invalid", () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        lastProject: null,
        recents: [{ path: "/Users/x/my-app", lastOpenedAt: "not-a-date" }],
      }),
    );
    const [row] = readProjects().recents;
    expect(row.name).toBe("my-app");
    expect(Number.isNaN(Date.parse(row.lastOpenedAt))).toBe(false);
  });
});

describe("recent-projects — write + record", () => {
  it("round-trips a written store", () => {
    const store = {
      lastProject: "/p",
      recents: [{ path: "/p", name: "p", lastOpenedAt: "2026-06-15T00:00:00.000Z" }],
    };
    writeProjects(store);
    expect(existsSync(storePath)).toBe(true);
    expect(readProjects()).toEqual(store);
  });

  it("recordOpenedProject sets lastProject and fronts the recents list", () => {
    recordOpenedProject("/Users/x/alpha");
    recordOpenedProject("/Users/x/beta");
    expect(getLastProject()).toBe("/Users/x/beta");
    const recents = listRecentProjects();
    expect(recents.map((r) => r.path)).toEqual(["/Users/x/beta", "/Users/x/alpha"]);
    expect(recents[0].name).toBe("beta");
  });

  it("dedupes by path and moves a re-opened project back to the front", () => {
    recordOpenedProject("/a");
    recordOpenedProject("/b");
    recordOpenedProject("/a");
    const recents = listRecentProjects();
    expect(recents.map((r) => r.path)).toEqual(["/a", "/b"]);
    expect(getLastProject()).toBe("/a");
  });

  it("caps the recents list at MAX_RECENTS", () => {
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      recordOpenedProject(`/p/${i}`);
    }
    const recents = listRecentProjects();
    expect(recents).toHaveLength(MAX_RECENTS);
    // Most-recent-first: the last one recorded is at the front.
    expect(recents[0].path).toBe(`/p/${MAX_RECENTS + 4}`);
  });
});
