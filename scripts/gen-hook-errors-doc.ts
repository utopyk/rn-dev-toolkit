#!/usr/bin/env bun
/**
 * Generates `docs/guides/hook-errors.md` from the declarative entries in
 * `packages/module-sdk/src/errors.ts`. Phase H7 will wire this into CI; H0
 * ships the generator + a checked-in artifact so the doc page exists from
 * day one and the source-of-truth invariant holds even before CI.
 *
 * Run:
 *   bun run scripts/gen-hook-errors-doc.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const errorsTsPath = join(repoRoot, "packages/module-sdk/src/errors.ts");
const outPath = join(repoRoot, "docs/guides/hook-errors.md");

interface HookErrorDoc {
  code: string;
  doc: string;
}

interface DiscriminatorDoc {
  name: string;
  variants: string[];
  comment: string;
}

const source = readFileSync(errorsTsPath, "utf8");

const hookErrors = parseHookErrorBlock(source);
const discriminators = parseDiscriminators(source);

writeFileSync(outPath, render(hookErrors, discriminators));
console.log(`✓ Wrote ${outPath} (${hookErrors.length} codes, ${discriminators.length} discriminators)`);

// ---------------------------------------------------------------------------
// Parsers — ad-hoc but pinned to errors.ts conventions.
// Keep the format conservative; H7's auto-gen can swap to a TS API parse.
// ---------------------------------------------------------------------------

function parseHookErrorBlock(src: string): HookErrorDoc[] {
  const start = src.indexOf("export const HookErrorCode = {");
  const end = src.indexOf("} as const;", start);
  if (start === -1 || end === -1) {
    throw new Error("Could not locate HookErrorCode block in errors.ts");
  }
  const block = src.slice(start, end);
  // Match: optional /** ... */ comment, then `<NAME>: "<NAME>",`
  const re =
    /\/\*\*([\s\S]*?)\*\/\s*([A-Z_]+):\s*"([A-Z_]+)"/g;
  const out: HookErrorDoc[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    const code = match[2];
    const codeRhs = match[3];
    if (code !== codeRhs) {
      throw new Error(
        `HookErrorCode entry mismatch: ${code} vs ${codeRhs}`,
      );
    }
    out.push({ code, doc: cleanDocstring(match[1]) });
  }
  return out;
}

function parseDiscriminators(src: string): DiscriminatorDoc[] {
  const re =
    /\/\*\* (Discriminator for `[^`]+`\.) \*\/\s*export type (\w+) =\s*([\s\S]*?);/g;
  const out: DiscriminatorDoc[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const variants = match[3]
      .split("\n")
      .map((line) => line.replace(/^\s*\|\s*"([^"]+)";?$/, "$1"))
      .filter((line) => /^[a-z]/.test(line));
    out.push({ name: match[2], comment: match[1], variants });
  }
  return out;
}

function cleanDocstring(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .filter((line) => line.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function render(
  errors: HookErrorDoc[],
  discriminators: DiscriminatorDoc[],
): string {
  const tocLines = errors.map((e) => `- [\`${e.code}\`](#${e.code.toLowerCase().replace(/_/g, "-")})`);
  const sections = errors
    .map(
      (e) =>
        `### \`${e.code}\`\n\n${e.doc}\n`,
    )
    .join("\n");
  const discSections = discriminators
    .map(
      (d) =>
        `### \`${d.name}\`\n\n${d.comment}\n\n${d.variants
          .map((v) => `- \`${v}\``)
          .join("\n")}\n`,
    )
    .join("\n");

  return `<!--
DO NOT EDIT — auto-generated from packages/module-sdk/src/errors.ts.
Run \`bun run scripts/gen-hook-errors-doc.ts\` to regenerate.
-->

# Hook error reference

This page lists every error code the rn-dev hook system can raise. Codes are
stable identifiers; renaming any of them is a major-version bump.

For the discriminated detail shape (typed via \`HookErrorDetails\` in
\`@rn-dev/module-sdk\`), narrow on \`details.code\` then on the per-code
fields named below (\`cause\`, \`outcome\`, etc.).

## Index

${tocLines.join("\n")}

## Codes

${sections}

## Discriminators

${discSections}
`;
}
