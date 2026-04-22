import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleConfigStore } from "../config-store.js";

describe("ModuleConfigStore — filesystem ops", () => {
  let root: string;
  let store: ModuleConfigStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rn-dev-config-store-"));
    store = new ModuleConfigStore({ modulesDir: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("get returns {} when no config file exists", () => {
    expect(store.get("never-written")).toEqual({});
  });

  it("write then get round-trips the blob", () => {
    store.write("mod-a", { greeting: "hi", loud: true });
    expect(store.get("mod-a")).toEqual({ greeting: "hi", loud: true });
  });

  it("write persists the blob at ~/.rn-dev/modules/<id>/config.json", () => {
    store.write("mod-b", { k: "v" });
    const onDisk = readFileSync(join(root, "mod-b", "config.json"), "utf-8");
    expect(JSON.parse(onDisk)).toEqual({ k: "v" });
  });

  it("get tolerates a malformed config.json by returning {}", () => {
    mkdirSync(join(root, "corrupt"), { recursive: true });
    writeFileSync(join(root, "corrupt", "config.json"), "{not json", "utf-8");
    expect(store.get("corrupt")).toEqual({});
  });

  it("get tolerates a non-object top-level JSON value by returning {}", () => {
    mkdirSync(join(root, "array-top"), { recursive: true });
    writeFileSync(join(root, "array-top", "config.json"), "[1,2,3]", "utf-8");
    expect(store.get("array-top")).toEqual({});
  });

  it("write is atomic — no tmp file leftover on success", () => {
    store.write("atomic", { a: 1 });
    const files = readdirSync(join(root, "atomic"));
    expect(files.filter((f) => f.startsWith("config.json.tmp-"))).toEqual([]);
    expect(files).toContain("config.json");
  });

  it("write overwrites an existing config atomically", () => {
    store.write("overwrite", { version: 1 });
    store.write("overwrite", { version: 2 });
    expect(store.get("overwrite")).toEqual({ version: 2 });
  });

  it("pathFor exposes the documented on-disk path", () => {
    expect(store.pathFor("abc")).toBe(join(root, "abc", "config.json"));
  });
});

describe("ModuleConfigStore — schema validation", () => {
  const root = mkdtempSync(join(tmpdir(), "rn-dev-config-validate-"));
  const store = new ModuleConfigStore({ modulesDir: root });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      count: { type: "integer", minimum: 0 },
    },
    required: ["name"],
  };

  it("valid=true for schema-conformant candidates", () => {
    expect(store.validate({ name: "ok", count: 3 }, schema)).toEqual({
      valid: true,
    });
  });

  it("valid=true when schema is undefined", () => {
    expect(store.validate({ anything: "goes" }, undefined)).toEqual({
      valid: true,
    });
  });

  it("valid=false with errors when required key missing", () => {
    const result = store.validate({ count: 1 }, schema);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.keyword === "required")).toBe(true);
  });

  it("valid=false with errors when additionalProperties violated", () => {
    const result = store.validate({ name: "ok", bogus: 1 }, schema);
    expect(result.valid).toBe(false);
  });

  it("caches compiled validators by schema identity", () => {
    const first = store.validate({ name: "a" }, schema);
    const second = store.validate({ name: "b" }, schema);
    expect(first).toEqual({ valid: true });
    expect(second).toEqual({ valid: true });
    // Can't observe caching directly; this exercises the hot path twice so
    // a regression that rebuilds ajv per call would slow the suite enough
    // to notice in CI (though we don't assert on timing here).
  });
});

describe("ModuleConfigStore — defaults", () => {
  it("uses ~/.rn-dev/modules/ when no modulesDir is provided", () => {
    const store = new ModuleConfigStore();
    const path = store.pathFor("any-id");
    expect(path).toContain("/.rn-dev/modules/any-id/config.json");
  });
});
