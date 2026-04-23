# rn-dev Marketplace fixtures

Local stand-ins for the curated `modules.json` registry while the
`rn-dev-modules-registry` repository is still empty.

## Files

- `modules.json` — one-entry registry pointing at `device-control`.
- `device-control-0.1.0.tgz` — packed `@rn-dev-modules/device-control` tarball.

## Smoke-testing the install flow

```sh
# 1. Rebuild the SDK + device-control, re-pack the tarball.
bun run packages/module-sdk/build.ts
bun run modules/device-control/build.ts
cd modules/device-control && bun pm pack
mv rn-dev-modules-device-control-0.1.0.tgz \
  ../../docs/fixtures/device-control-0.1.0.tgz
cd -

# 2. Recompute the tarball SHA and update modules.json.
SHA=$(shasum -a 256 docs/fixtures/device-control-0.1.0.tgz | awk '{print $1}')
# Paste $SHA into docs/fixtures/modules.json#modules[0].tarballSha256

# 3. Start the GUI with the registry pointed at the local fixture.
RN_DEV_MODULES_REGISTRY_URL="file://$PWD/docs/fixtures/modules.json" \
  bun run dev:gui
```

Then open Marketplace → Available to install → Install → walk the
consent dialog. The subprocess should spawn + show up in the
registered list + `device-control__*` MCP tools should be callable.

## Why the tarball SHA moves per build

Bun's bundler embeds absolute source-file paths in the sourcemap.
Different checkout locations produce different sourcemaps → different
tarball bytes → different SHA. Re-packing on a fresh clone requires
updating `modules.json` to match. Production (published) tarballs are
SHA-pinned once per release and don't drift.
