#!/usr/bin/env bun
/**
 * Build script for rn-dev-cli using Bun's native bundler.
 *
 * Usage:
 *   bun run build.ts          — bundle to dist/index.js
 *   bun run build.ts compile  — standalone binary at dist/rn-dev
 */

const isCompile = process.argv.includes("compile");

if (isCompile) {
  // Standalone binary — no runtime dependency needed
  const proc = Bun.spawn(
    ["bun", "build", "--compile", "--target=bun", "src/index.tsx", "--outfile", "dist/rn-dev"],
    { stdout: "inherit", stderr: "inherit" }
  );
  await proc.exited;
  console.log("✓ Built standalone binary: dist/rn-dev");
} else {
  // Bundled JS — requires bun to run
  const result = await Bun.build({
    entrypoints: ["src/index.tsx"],
    outdir: "dist",
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "external",
  });

  if (result.success) {
    for (const output of result.outputs) {
      const sizeKB = (output.size / 1024).toFixed(1);
      console.log(`✓ Built ${output.path} (${sizeKB} KB)`);
    }
    // Prepend a `bun` shebang to `dist/index.js` so the `bin` entry in
    // package.json is directly executable (required for `claude mcp add
    // rn-dev -- /path/to/dist/index.js mcp` to work without an explicit
    // interpreter). Bun's bundler has no build-API option for this —
    // the `--compile` path injects one automatically, but the ESM
    // bundle path doesn't.
    const entry = "dist/index.js";
    const existing = await Bun.file(entry).text();
    if (!existing.startsWith("#!")) {
      await Bun.write(entry, `#!/usr/bin/env bun\n${existing}`);
      console.log(`✓ Prepended bun shebang to ${entry}`);
    }
  } else {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}
