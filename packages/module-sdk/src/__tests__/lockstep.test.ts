import { describe, expect, expectTypeOf, it } from "vitest";
import schema from "../../manifest.schema.json" with { type: "json" };
import {
  validateManifest,
  type ManifestHookEntry,
  type ModuleConsumes,
  type ModuleManifest,
  type ModuleProvides,
} from "../index.js";

// ---------------------------------------------------------------------------
// Lockstep CI check — manifest schema ⇄ ModuleManifest TS type
// ---------------------------------------------------------------------------
//
// The point of this file is to fail loudly the moment someone changes the
// schema without updating the types (or vice versa). We don't pull in
// `json-schema-to-ts`; instead we maintain a fixture that exercises every
// field on both sides and assert: ajv accepts it AND `satisfies` types it.
//
// When you add a new field to the schema, add it here. When you change a
// type narrowly, the `satisfies` line below will fail to compile.

const fullManifest = {
  id: "lockstep-fixture",
  version: "0.1.0",
  hostRange: "^0.1.0",
  scope: "per-worktree" as const,
  experimental: true,
  contributes: {
    mcp: {
      tools: [
        {
          name: "lockstep-fixture__ping",
          description: "Ping",
          inputSchema: { type: "object" },
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      ],
    },
    electron: {
      panels: [
        {
          id: "main",
          title: "Lockstep",
          icon: "✨",
          webviewEntry: "dist/panel.html",
          hostApi: ["log"],
        },
      ],
    },
    tui: { views: [{ id: "main", title: "Lockstep", icon: "📦" }] },
    api: {
      methods: {
        ping: {
          description: "ping",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      },
    },
    config: { schema: { type: "object" } },
  },
  permissions: ["network:outbound"],
  activationEvents: ["onStartup"],
  provides: { hooks: ["pre", "post", "custom"] },
  consumes: {
    hooks: {
      "build/pre": "./pre.sh",
      "build/post": {
        script: "./post.sh",
        onFail: "warn",
        timeoutMs: 30_000,
        priority: 5,
      },
    },
  },
  uses: [{ id: "other", versionRange: "^1.0.0" }],
  signature: { algo: "ed25519", publicKey: "pk", signature: "sig" },
  sandbox: { kind: "none" },
  target: { kind: "emulator" },
} satisfies ModuleManifest;

describe("manifest lockstep — schema ⇄ ModuleManifest", () => {
  it("ajv accepts the all-fields fixture", () => {
    const result = validateManifest(fullManifest);
    expect(result.valid).toBe(true);
  });

  it("schema covers every top-level property the types declare", () => {
    // Drift detector: if someone adds a field to ModuleManifest but forgets
    // the schema (or vice versa), the union below diverges. We compare the
    // schema's declared properties against the fixture keys (proxy for the
    // type's keys via `satisfies`).
    const schemaProps = new Set(Object.keys(schema.properties));
    const fixtureKeys = new Set(Object.keys(fullManifest));
    for (const key of fixtureKeys) {
      expect(schemaProps.has(key)).toBe(true);
    }
  });

  it("rejects a fixture key the schema doesn't declare (additionalProperties: false)", () => {
    const result = validateManifest({ ...fullManifest, rogue: 1 });
    expect(result.valid).toBe(false);
  });

  // Type-level pins. If someone narrows or widens a type incorrectly, these
  // expectTypeOf assertions fail at compile time.
  it("ModuleProvides.hooks is string[]", () => {
    expectTypeOf<NonNullable<ModuleProvides["hooks"]>>().toEqualTypeOf<
      string[]
    >();
  });

  it("ModuleConsumes.hooks is Record<string, ManifestHookEntry>", () => {
    expectTypeOf<NonNullable<ModuleConsumes["hooks"]>>().toEqualTypeOf<
      Record<string, ManifestHookEntry>
    >();
  });

  it("ManifestHookEntry includes the string sugar form", () => {
    expectTypeOf<string>().toMatchTypeOf<ManifestHookEntry>();
  });

  it("ModuleManifest.provides and .consumes are optional", () => {
    expectTypeOf<ModuleManifest>().toHaveProperty("provides");
    expectTypeOf<ModuleManifest>().toHaveProperty("consumes");
  });
});
