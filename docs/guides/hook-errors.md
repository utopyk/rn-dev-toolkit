<!--
DO NOT EDIT — auto-generated from packages/module-sdk/src/errors.ts.
Run `bun run scripts/gen-hook-errors-doc.ts` to regenerate.
-->

# Hook error reference

This page lists every error code the rn-dev hook system can raise. Codes are
stable identifiers; renaming any of them is a major-version bump.

For the discriminated detail shape (typed via `HookErrorDetails` in
`@rn-dev/module-sdk`), narrow on `details.code` then on the per-code
fields named below (`cause`, `outcome`, etc.).

## Index

- [`E_HOOK_TARGET_UNKNOWN`](#e-hook-target-unknown)
- [`E_HOOK_NAME_UNDECLARED`](#e-hook-name-undeclared)
- [`E_HOOK_PATH_OUTSIDE_PROJECT`](#e-hook-path-outside-project)
- [`E_HOOK_OVERRIDE_NOT_PERMITTED`](#e-hook-override-not-permitted)
- [`E_HOOK_CONFIG_INVALID`](#e-hook-config-invalid)
- [`E_HOOK_FAILED`](#e-hook-failed)
- [`E_HOOK_RUN_REAL_DENIED`](#e-hook-run-real-denied)
- [`E_HOST_RANGE_REQUIRED`](#e-host-range-required)
- [`E_HOOK_INTERPRETER_MISSING`](#e-hook-interpreter-missing)

## Codes

### `E_HOOK_TARGET_UNKNOWN`

`consumes.hooks` references a `<id>/<name>` whose `<id>` is not a known module. Caught at config/manifest load — never surfaces at fire time.

### `E_HOOK_NAME_UNDECLARED`

`consumes.hooks` references a `<id>/<name>` whose target module exists but does not declare `<name>` in `provides.hooks`. Includes a did-you-mean suggestion in `details.suggestion`.

### `E_HOOK_PATH_OUTSIDE_PROJECT`

Script path resolves outside the config-file's containing directory after `realpathSync`. Fires when a symlink-then-prefix-check would otherwise be bypassed.

### `E_HOOK_OVERRIDE_NOT_PERMITTED`

A 3p module's `consumes.hooks` registers against another module's `custom` override slot but the project did not opt in via `allowModuleOverrides: ['<id>']`.

### `E_HOOK_CONFIG_INVALID`

Project's `rn-dev.config.ts` failed to load or shape-validate. The `cause` discriminator (see `HookConfigInvalidCause`) names the specific subkind — clients render specific guidance per cause.

### `E_HOOK_FAILED`

A hook fire failed at dispatch time. The `outcome` discriminator (see `HookFailedOutcome`) names the specific subkind. Recovery is the calling site's choice (some are retried, some abort the RPC).

### `E_HOOK_RUN_REAL_DENIED`

`hooks/run` MCP tool received `mode: "real"` while the daemon is running with `RN_DEV_DAEMON_MODE=prod`. Synthetic mode is also rejected outright in production.

### `E_HOST_RANGE_REQUIRED`

Manifest declares `provides.hooks` or `consumes.hooks` but its `hostRange` allows daemon versions that pre-date hook support. Older daemons would silently ignore the declarations.

### `E_HOOK_INTERPRETER_MISSING`

Hook script's shebang interpreter (or implicit `node`/`bun` runtime) cannot be resolved on the host. Surfaced at fire time, not registration, because PATH membership is dynamic.


## Discriminators

### `HookConfigInvalidCause`

Discriminator for `E_HOOK_CONFIG_INVALID`.

- `parse-failed`
- `threw`
- `shape-invalid`
- `config-load-timeout`
- `version-mismatch`
- `path-outside-project`

### `HookFailedOutcome`

Discriminator for `E_HOOK_FAILED`.

- `multiple-override`
- `multiple-results`
- `crashed-before-payload`
- `cycle-detected`
- `path-mutated`
- `queue-full`
- `timeout`
- `script-unreadable`

