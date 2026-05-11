// Phase H2b — every event the Builder itself emits must carry
// `source: "builtin"`. Override-source events come from
// BuildHostCapability in H4 and are tested separately.
//
// Strategy:
//   - Drive the synchronous concurrency-guard `done` to assert the
//     full payload stamping at runtime.
//   - Statically assert that every `this.emit(...)` in builder.ts goes
//     through the `emitBuiltin` helper, since that helper is the only
//     way to inject `source` into the emit. (Spying on `spawn` to drive
//     the line/progress paths trips ESM "module namespace is not
//     configurable" — the static check is the safer pin for those.)
//
// Together these prove the contract: by inspection no raw `emit("line"
// |"progress"|"done")` exists in the source file, and at runtime the
// one path we CAN drive without spawning a subprocess emits the field.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { Builder } from "../builder.js";
import type {
  BuilderDoneEvent,
  BuilderLineEvent,
  BuilderProgressEvent,
} from "../builder.js";

describe("Builder source discriminator (H2b)", () => {
  let builder: Builder;
  let lines: BuilderLineEvent[];
  let progresses: BuilderProgressEvent[];
  let dones: BuilderDoneEvent[];

  beforeEach(() => {
    builder = new Builder();
    lines = [];
    progresses = [];
    dones = [];
    builder.on("line", (e: BuilderLineEvent) => lines.push(e));
    builder.on("progress", (e: BuilderProgressEvent) => progresses.push(e));
    builder.on("done", (e: BuilderDoneEvent) => dones.push(e));
  });

  it("stamps source: 'builtin' on the concurrency-guard 'done' event", () => {
    // Force the guard branch: pretend a build is already in flight.
    (
      builder as unknown as { process: { exitCode: number | null } }
    ).process = { exitCode: null };

    builder.build({
      projectRoot: "/tmp/never-exists",
      platform: "ios",
      port: 8081,
      variant: "debug",
    });

    expect(dones).toHaveLength(1);
    expect(dones[0].source).toBe("builtin");
    expect(dones[0].success).toBe(false);
    expect(dones[0].errors[0].summary).toContain("build already in progress");
  });

  it("uses emitBuiltin (not raw this.emit) for every line/progress/done emit", () => {
    // Architectural pin: all source-stamped emit sites must route through
    // `emitBuiltin`. If a future change reintroduces a raw
    // `this.emit("line"|"progress"|"done", ...)`, this test fails and
    // forces an update — H4's "override" events are the only legitimate
    // path that bypasses `emitBuiltin`, and they live in a different file.
    const here = dirname(fileURLToPath(import.meta.url));
    const builderPath = resolve(here, "..", "builder.ts");
    const source = readFileSync(builderPath, "utf-8");

    // Strip block + line comments so doc examples ("Emits: 'line' — ...")
    // don't trigger the assertion.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    const rawEmits = stripped.match(/this\.emit\(\s*"(line|progress|done)"/g) ?? [];
    expect(rawEmits).toEqual([]);

    // And: emitBuiltin is invoked for each of the three variants somewhere
    // in the file — guards against accidentally deleting all of them.
    expect(stripped).toMatch(/emitBuiltin\(\s*"line"/);
    expect(stripped).toMatch(/emitBuiltin\(\s*"progress"/);
    expect(stripped).toMatch(/emitBuiltin\(\s*"done"/);
  });
});
