#!/usr/bin/env bun
/**
 * Build script for rn-dev-cli using Bun's native bundler.
 *
 * Usage:
 *   bun run build.ts          — bundle to dist/index.js
 *   bun run build.ts compile  — standalone binary at dist/rn-dev
 *   bun run build.ts gui      — packaged-app inputs: renderer to
 *                               dist-renderer/, Electron main bundled to
 *                               dist-electron/main.cjs + preloads copied
 *                               beside it (electron-builder consumes both)
 */

const isCompile = process.argv.includes("compile");
const isGui = process.argv.includes("gui");

if (isGui) {
  // 1. Renderer — vite is configured with base './' + outDir
  //    ../dist-renderer, matching the `packagedRendererIndex` hop in
  //    electron/paths.ts.
  const vite = Bun.spawn(["npx", "vite", "build"], {
    cwd: "renderer",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await vite.exited) !== 0) {
    console.error("Renderer build failed");
    process.exit(1);
  }

  // 2. Electron main — one CJS bundle (main.ts is written CJS-style:
  //    __dirname, require('http')). Only `electron` stays external;
  //    everything from src/ is inlined so the packaged app carries no
  //    node_modules. `.cjs` because the root package.json is
  //    "type": "module".
  //
  //    External-via-plugin, not `external: ["electron"]`: bun 1.3.13
  //    misresolves that external against the repo's `electron/` source
  //    directory when cwd is the repo root and dies with
  //    `EISDIR reading file: "electron"`.
  const main = await Bun.build({
    entrypoints: ["electron/main.ts"],
    outdir: "dist-electron",
    target: "node",
    format: "cjs",
    naming: "[dir]/[name].cjs",
    plugins: [
      {
        name: "external-electron",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, (args) => ({
            path: args.path,
            external: true,
          }));
        },
      },
    ],
    minify: false,
    sourcemap: "external",
  });
  if (!main.success) {
    console.error("Electron main build failed:");
    for (const log of main.logs) console.error(log);
    process.exit(1);
  }
  for (const output of main.outputs) {
    console.log(`✓ Built ${output.path} (${(output.size / 1024).toFixed(1)} KB)`);
  }

  // 3. Preloads — plain files loaded by absolute path at runtime; they
  //    must sit next to main.cjs (see electron/paths.ts electronAssetsDir).
  for (const file of ["preload.cjs", "preload-module.js"]) {
    await Bun.write(`dist-electron/${file}`, Bun.file(`electron/${file}`));
    console.log(`✓ Copied electron/${file} → dist-electron/${file}`);
  }
} else if (isCompile) {
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
