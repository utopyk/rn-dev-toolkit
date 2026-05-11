// Phase H2j — `rn-dev/hooks-diagnose` MCP tool. Reads the audit log
// directly (the daemon doesn't expose a registered-hooks listing
// surface yet — that lands at H6) and surfaces hook failures so an
// agent can answer "did my build/pre fire? did it succeed?" without
// `tail -f ~/.rn-dev/audit.log`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHooksTools,
  readHookAuditTail,
  validateHookConfig,
} from "../tools-hooks.js";

let tmpRoot = "";
let auditLogPath = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "h2j-hooks-diagnose-"));
  auditLogPath = join(tmpRoot, "audit.log");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeAudit(lines: Array<Record<string, unknown>>): void {
  writeFileSync(
    auditLogPath,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("readHookAuditTail (H2j)", () => {
  it("returns empty when the audit log does not exist (no hooks ever fired)", () => {
    expect(
      readHookAuditTail({ limit: 20, auditLogPath: "/nonexistent/audit.log" }),
    ).toEqual([]);
  });

  it("filters down to kind:'hook' entries (skips install / host-call / panel-bridge)", () => {
    writeAudit([
      { kind: "install", moduleId: "x", outcome: "ok" },
      { kind: "hook", phase: "build/pre", source: "project", outcome: "exit-nonzero", exitCode: 7 },
      { kind: "host-call", method: "foo", outcome: "ok" },
      { kind: "hook", phase: "build/post", source: "project", outcome: "timeout" },
    ]);
    const out = readHookAuditTail({ limit: 20, auditLogPath });
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.phase)).toEqual(["build/pre", "build/post"]);
  });

  it("narrows further when target is supplied", () => {
    writeAudit([
      { kind: "hook", phase: "build/pre", source: "project", outcome: "exit-nonzero" },
      { kind: "hook", phase: "build/post", source: "project", outcome: "timeout" },
      { kind: "hook", phase: "session/init", source: "project", outcome: "exit-nonzero" },
    ]);
    const out = readHookAuditTail({
      limit: 20,
      target: "build/pre",
      auditLogPath,
    });
    expect(out).toHaveLength(1);
    expect(out[0].phase).toBe("build/pre");
  });

  it("returns the most recent N entries in chronological order", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      kind: "hook",
      phase: "build/pre",
      source: "project",
      outcome: "exit-nonzero",
      seq: i,
    }));
    writeAudit(entries);
    const out = readHookAuditTail({ limit: 5, auditLogPath });
    expect(out).toHaveLength(5);
    // Most recent 5 in oldest-first order: seq 45..49.
    expect(out.map((e) => e.seq)).toEqual([45, 46, 47, 48, 49]);
  });

  it("skips malformed JSON lines without erroring", () => {
    writeFileSync(
      auditLogPath,
      [
        JSON.stringify({ kind: "hook", phase: "build/pre", source: "project" }),
        "not-json{",
        JSON.stringify({ kind: "hook", phase: "build/post", source: "project" }),
      ].join("\n"),
    );
    const out = readHookAuditTail({ limit: 20, auditLogPath });
    expect(out).toHaveLength(2);
  });
});

describe("buildHooksTools (H2j + H2k)", () => {
  it("registers two tools: hooks-diagnose + hooks-config-validate", () => {
    const tools = buildHooksTools();
    expect(tools.map((t) => t.name)).toEqual([
      "rn-dev/hooks-diagnose",
      "rn-dev/hooks-config-validate",
    ]);
  });

  it("describes target + limit on the input schema", () => {
    const tool = buildHooksTools()[0];
    const props = (tool.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(props.target).toBeDefined();
    expect(props.limit).toBeDefined();
  });

  it("hooks-diagnose handler returns advice text when no entries are found", async () => {
    const tool = buildHooksTools().find(
      (t) => t.name === "rn-dev/hooks-diagnose",
    );
    if (!tool) throw new Error("hooks-diagnose tool missing");
    // The handler reads from ~/.rn-dev/audit.log by default; on a fresh
    // CI box this either doesn't exist or has no kind:'hook' entries.
    // Pass an explicit non-existent log path via the underlying reader
    // by mocking RN_DEV_HOOKS_DIAGNOSE_AUDIT_OVERRIDE — wait, no env
    // hook here. Instead, just call with a target the audit log
    // certainly doesn't have (random unique) and check for advice
    // text on the empty branch.
    const out = (await tool.handler({
      target: "nonexistent-module/never-fires-" + Math.random(),
      limit: 5,
    })) as {
      structuredContent: { entries: unknown[]; advice?: string };
    };
    expect(out.structuredContent.entries).toEqual([]);
    expect(out.structuredContent.advice).toMatch(/No audit entries/);
  });
});

describe("validateHookConfig (H2k)", () => {
  let projectRoot = "";

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "h2k-validate-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns valid:true with no errors when no rn-dev.config.* exists", async () => {
    const out = await validateHookConfig({ projectRoot });
    expect(out.configFile).toBeNull();
    expect(out.valid).toBe(true);
    expect(out.errors).toEqual([]);
  });

  it("knownSlots includes the H1 + H2 built-in slots", async () => {
    const out = await validateHookConfig({ projectRoot });
    expect(out.knownSlots).toEqual(
      expect.arrayContaining([
        "build/pre",
        "build/post",
        "build/custom",
        "session/init",
        "session/profile-changed",
      ]),
    );
  });

  it("flags an unknown slot with a did-you-mean suggestion", async () => {
    writeFileSync(
      join(projectRoot, "rn-dev.config.mjs"),
      `export default { hooks: { "build/before": "./x.sh" } };`,
    );
    const out = await validateHookConfig({ projectRoot });
    expect(out.valid).toBe(false);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({
      key: "build/before",
      reason: "unknown-slot",
    });
    // Most-shared-prefix nearest-neighbour: "build/before" → "build/post"
    // (build/post and build/pre both share "build/" but "build/post"
    // shares one more char with "build/before"). The suggest function is
    // documented as best-effort; we only assert that *some* build/* slot
    // is suggested.
    expect(out.errors[0].suggestion).toMatch(/^build\//);
  });

  it("flags an unknown module id (typed-but-not-installed 3p)", async () => {
    writeFileSync(
      join(projectRoot, "rn-dev.config.mjs"),
      `export default { hooks: { "totally-fake-module/whatever": "./x.sh" } };`,
    );
    const out = await validateHookConfig({ projectRoot });
    expect(out.valid).toBe(false);
    expect(out.errors[0]).toMatchObject({
      key: "totally-fake-module/whatever",
      reason: "unknown-module",
    });
  });

  it("malformed keys (no slash) are caught by loadConfig's schema before reaching the runtime check", async () => {
    writeFileSync(
      join(projectRoot, "rn-dev.config.mjs"),
      `export default { hooks: { "no-slash-here": "./x.sh" } };`,
    );
    const out = await validateHookConfig({ projectRoot });
    expect(out.valid).toBe(false);
    // loadConfig's HookPhase pattern rejects this first — that's the
    // CONFIG-LEVEL gate. The defensive malformed-key branch in
    // validateHookConfig is unreachable for keys that load successfully,
    // which is fine: it's belt-and-suspenders for a future loadConfig
    // change that relaxes the pattern.
    expect(out.errors[0].reason).toBe("config-load-failed");
  });

  it("returns valid:true on a config with only known slots", async () => {
    writeFileSync(
      join(projectRoot, "rn-dev.config.mjs"),
      `export default { hooks: { "build/pre": "./x.sh", "session/init": "./y.sh" } };`,
    );
    const out = await validateHookConfig({ projectRoot });
    expect(out.valid).toBe(true);
    expect(out.errors).toEqual([]);
  });

  it("surfaces config-load failures (e.g. import threw) as a config-load-failed error", async () => {
    writeFileSync(
      join(projectRoot, "rn-dev.config.mjs"),
      `throw new Error("intentional config-load failure");`,
    );
    const out = await validateHookConfig({ projectRoot });
    expect(out.valid).toBe(false);
    expect(out.errors[0].reason).toBe("config-load-failed");
  });
});
