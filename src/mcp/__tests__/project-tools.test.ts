// MCP project-selection parity (mirrors the Electron picker):
//   - rn-dev/list-projects  → current project + the shared recents store
//   - rn-dev/open-project   → delegates to ctx.openProject (server-wired),
//                             with E_NOT_WIRED / E_NOT_A_PROJECT / E_INVALID_PATH
//                             surfaced as structuredContent errors.
//
// The real re-scope (teardown + reconnect) lives in server.ts and is
// covered by the e2e/probe harness; here we pin the tool's contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpContext, OpenProjectResult } from "../tools.js";
import { createToolDefinitions } from "../tools.js";
import { recordOpenedProject } from "../../core/recent-projects.js";

let dir: string;

function makeCtx(
  overrides: Partial<McpContext> & { projectRoot: string },
): McpContext {
  return {
    profileStore: {} as McpContext["profileStore"],
    artifactStore: {} as McpContext["artifactStore"],
    metro: null,
    preflightEngine: {} as McpContext["preflightEngine"],
    sessions: new Map(),
    defaultSessionId: null,
    ...overrides,
  };
}

function tool(ctx: McpContext, name: string) {
  const t = createToolDefinitions(ctx).find((d) => d.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rn-dev-mcp-projects-"));
  process.env.RN_DEV_PROJECTS_PATH = join(dir, "projects.json");
});

afterEach(() => {
  delete process.env.RN_DEV_PROJECTS_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("rn-dev/list-projects", () => {
  it("returns the current project and the shared recents store", async () => {
    recordOpenedProject("/Users/x/alpha");
    recordOpenedProject("/Users/x/beta");
    const ctx = makeCtx({ projectRoot: "/Users/x/current" });
    const out = (await tool(ctx, "rn-dev/list-projects").handler({})) as {
      current: { path: string; name: string };
      recents: Array<{ path: string; name: string; exists: boolean }>;
    };
    expect(out.current).toEqual({ path: "/Users/x/current", name: "current" });
    expect(out.recents.map((r) => r.path)).toEqual([
      "/Users/x/beta",
      "/Users/x/alpha",
    ]);
    // Neither tmp path exists on disk → annotated false, not omitted.
    expect(out.recents.every((r) => r.exists === false)).toBe(true);
  });

  it("returns an empty recents list when nothing has been opened", async () => {
    const ctx = makeCtx({ projectRoot: "/Users/x/current" });
    const out = (await tool(ctx, "rn-dev/list-projects").handler({})) as {
      recents: unknown[];
    };
    expect(out.recents).toEqual([]);
  });
});

describe("rn-dev/open-project", () => {
  it("delegates to ctx.openProject and wraps the success result", async () => {
    const openProject = vi.fn(
      async (): Promise<OpenProjectResult> => ({
        ok: true,
        projectRoot: "/Users/x/other",
        name: "other",
        profileName: "default",
        bootedSessionId: "sid-9",
      }),
    );
    const ctx = makeCtx({ projectRoot: "/Users/x/current", openProject });
    const out = (await tool(ctx, "rn-dev/open-project").handler({
      path: "/Users/x/other",
    })) as { structuredContent: Record<string, unknown>; isError?: boolean };
    expect(openProject).toHaveBeenCalledWith("/Users/x/other");
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({
      kind: "ok",
      projectRoot: "/Users/x/other",
      name: "other",
      profileName: "default",
      bootedSessionId: "sid-9",
    });
  });

  it("surfaces a bad path as E_NOT_A_PROJECT", async () => {
    const openProject = vi.fn(
      async (): Promise<OpenProjectResult> => ({
        ok: false,
        error: "That path is not a React Native project.",
      }),
    );
    const ctx = makeCtx({ projectRoot: "/Users/x/current", openProject });
    const out = (await tool(ctx, "rn-dev/open-project").handler({
      path: "/not/a/project",
    })) as { structuredContent: { code: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("E_NOT_A_PROJECT");
  });

  it("returns E_NOT_WIRED when the server did not wire openProject", async () => {
    const ctx = makeCtx({ projectRoot: "/Users/x/current" });
    const out = (await tool(ctx, "rn-dev/open-project").handler({
      path: "/Users/x/other",
    })) as { structuredContent: { code: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("E_NOT_WIRED");
  });

  it("rejects a missing/empty path with E_INVALID_PATH before delegating", async () => {
    const openProject = vi.fn();
    const ctx = makeCtx({ projectRoot: "/Users/x/current", openProject });
    const out = (await tool(ctx, "rn-dev/open-project").handler({})) as {
      structuredContent: { code: string };
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("E_INVALID_PATH");
    expect(openProject).not.toHaveBeenCalled();
  });
});
