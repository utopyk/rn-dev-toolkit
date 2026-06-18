import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Regression guard for the GUI "panel stuck on Loading…" bug (task #26).
//
// The panel-bridge preload (`electron/preload-module.js`) publishes the host
// API via `contextBridge.exposeInMainWorld('rnDev', api)`, which installs
// `rnDev` as a NON-CONFIGURABLE property on the panel's global object. A
// module panel's classic `<script>` that does a TOP-LEVEL
// `const rnDev = window.rnDev` then trips V8's "restricted global property"
// rule (HasRestrictedGlobalProperty) and throws
// `SyntaxError: Identifier 'rnDev' has already been declared` at PARSE time —
// aborting the entire script before any handler runs, so the panel never
// replaces its initial "Loading…" content. The MCP path never loads a
// preload, which is why it stayed green while every GUI panel silently hung.
//
// Fix: each panel wraps its body in an IIFE so `const rnDev` is a function-
// scoped local that shadows the global property instead of a top-level
// lexical binding. This test asserts that invariant directly: no panel may
// declare `rnDev` at source-file (Program) scope. (The behavioral repro needs
// a real Chromium realm — node:vm and happy-dom don't enforce the restricted-
// global rule — so it's covered by manual GUI verification; this static check
// is the fast, deterministic guard against the IIFE being removed.)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const PANELS = ["redux", "devtools-network", "metro-logs", "device-control"];

/** Names lexically bound at the top (Program) scope of a script. */
function topLevelBindings(src: string): Set<string> {
  const sf = ts.createSourceFile("panel.js", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    } else if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

describe("module panels must not declare `rnDev` at top-level scope", () => {
  for (const id of PANELS) {
    it(`${id}/panel.js keeps rnDev out of the global lexical scope`, () => {
      const js = readFileSync(path.join(REPO, "modules", id, "panel", "panel.js"), "utf8");
      expect(
        topLevelBindings(js).has("rnDev"),
        `panel "${id}" declares \`rnDev\` at top-level — it will collide with the non-configurable window.rnDev installed by the preload and throw at parse time. Wrap the panel body in an IIFE.`,
      ).toBe(false);
    });
  }

  it("control: the detector flags an unwrapped top-level `const rnDev`", () => {
    expect(topLevelBindings("const rnDev = window.rnDev; void rnDev;").has("rnDev")).toBe(true);
  });
});
