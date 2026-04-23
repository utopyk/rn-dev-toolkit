# Phase 12 Handoff — SDK Arg-Narrowers Extraction (Rule-of-Three)

**Shipped**: 2026-04-23 via
[PR #11](https://github.com/utopyk/rn-dev-cli/pull/11). Squash-merged to
`main`.

## Context

Phase 11 closed on 2026-04-23 with three modules on disk that each
carried a verbatim copy of `str` / `num` / `strArr` / `cursor` /
`requireStr` / `requireNum`. The Simplicity reviewer in Phase 11 flagged
this as Rule-of-Three met; Phase 11 handoff queued the extraction as
Phase 12's first task regardless of which of the three candidate phases
(A/B/C) got picked.

Phase 12 was picked as Option C (npm publishing the three modules to the
`@rn-dev-modules/` scope under `rn-tools.com`). That half is blocked
until Martin finishes npm scope registration + DNS setup, so this
sub-phase shipped the in-repo refactor first — it compounds with C (a
smaller per-module `index.ts` means the npm diff is cleaner).

## What shipped

### New SDK surface

`packages/module-sdk/src/args.ts` — seven named exports:

| Name          | Signature                                                   | Notes |
|---------------|-------------------------------------------------------------|-------|
| `Args`        | `Record<string, unknown>`                                   | Canonical name for unvalidated wire args. |
| `str`         | `(Args, key) => string \| undefined`                        | Non-empty string. |
| `num`         | `(Args, key) => number \| undefined`                        | Any finite number — including negatives + non-integers. JSDoc now explicit about this. |
| `strArr`      | `(Args, key) => string[] \| undefined`                      | Filters to non-empty strings; `undefined` when filtered-empty (not `[]`). |
| `requireStr`  | `(Args, key, tool) => string`                               | Throws `"${tool}: ${key} is required"` on missing. |
| `requireNum`  | `(Args, key, tool) => number`                               | Same contract, for numbers. |
| `ringCursor`  | `(Args, key?) => { readonly bufferEpoch, sequence } \| undefined` | Default key `"since"`. Strips extra fields deliberately. |

24 unit tests at `packages/module-sdk/src/__tests__/args.test.ts`.

### Modules migrated

- `modules/metro-logs/src/index.ts` — uses `str`, `num`, `ringCursor`.
  Kept `stream` narrower local (`"stdout" | "stderr"` union).
- `modules/devtools-network/src/index.ts` — uses `str`, `num`, `strArr`,
  `ringCursor`, `requireStr`. Kept `statusRange` narrower local (HTTP
  status tuple).
- `modules/device-control/src/index.ts` — uses `str`, `num`, `requireStr`,
  `requireNum`. No module-specific narrowers.

Net LoC: `-65` across the three modules (`-108 / +43`).

## Reviewer round

Four parallel reviewers: Kieran TS + Architecture + Security + Simplicity.
**All approved. No P0 or P1 findings.** Applied P2/P3s in-branch:

- Kieran P2-1 + Simplicity P1.2 — `ringCursor` return fields marked
  `readonly`; JSDoc documents the field-stripping contract.
- Kieran P2-2 — metro-logs + devtools-network now narrow `limit` via
  `num(args, "limit")` instead of raw `args["limit"]`.
- Security P3 — `num` JSDoc notes non-integer + negative acceptance and
  points callers at `extractFilter` for tighter gating.
- Architecture P3 — file-header wording clarifies the `./args.ts` path
  is a source location, not a public subpath import specifier.
- Simplicity P3.1 — device-control's 7-line "Arg narrowing" comment
  block trimmed to one line (no module-specific narrowers means the
  header was explaining an absence).

## Intentionally deferred

| Finding | Source | Rationale |
|---|---|---|
| `extractFilter` double-validation collapse — `tools.ts` re-narrows what `index.ts::toXArgs` already narrowed (`isCursor`, `Array.isArray(methods).filter`, etc.) | Kieran P1-1 + Simplicity P1.1 | Both reviewers explicitly out-of-scope. Right cleanup is a new SDK `boundedInt(args, key, {min, max})` helper + deleting `extractFilter`. Estimated net `-50` LoC across metro-logs + devtools-network. Phase 12.1 candidate. |
| `loadManifest` + `invokedAsEntry` SDK extraction | Architecture P2-A/B | Verbatim triplicate across all three modules — strong Rule-of-Three case. But only 1/3 reviewers flagged (Kieran + Simplicity silent). Better as its own sibling PR with its own narrative (`bootstrapModule` surface) than compounded with arg-narrowers. Phase 12.2 candidate. |
| Prototype-chain walk in `args[key]` / `c.bufferEpoch` across all narrowers | Security P2 | Pre-existing (identical to pre-PR local helpers). Not wire-reachable — `JSON.parse` rejects `__proto__`. Latent amplifier only if subprocess-local code already pollutes `Object.prototype`. Security already spawned a follow-up task chip ("Harden SDK arg-narrowers against Object.prototype pollution") — fix is `Object.prototype.hasOwnProperty.call` gating across all six narrowers + the pre-existing `isCursor` helpers in each module's `tools.ts`. |
| Rename `Args` → `ToolArgs` | Architecture P2-C | Architecture worried about name collision for 3p authors. Kieran + Simplicity both argued keep (canonical name + symmetric with `ToolHandler`'s default generic). Consensus against the rename. |
| `requireStr` / `requireNum` throw `ModuleError(INVALID_ARGS, ...)` instead of plain `Error` | Kieran P2-3 | `ModuleErrorCode` at `packages/module-sdk/src/errors.ts` has no `INVALID_ARGS` / `E_INVALID_ARGS` entry. Adding a new code is a semantic decision worth its own PR. Kieran explicitly demoted this to P3 if no code exists. |
| JSDoc nit — `strArr` could be `strings` / `stringArr` | Kieran P3-3 | Bikeshed. Not worth churning three modules for. |

## Baselines (Phase 12 SDK arg-narrowers commit)

- **vitest**: 873/0 (+24 from new args tests; was 849 baseline)
- **tsc root**: 150 (unchanged — pre-existing wizard errors)
- **tsc electron**: 0
- **tsc per-module**: 0/0/0 (all three)
- **`bun run build`**: green
- **`bun run typecheck`**: green

## Commits on the branch

- `dea844c feat(module-sdk): add arg-narrower primitives (str/num/strArr/ringCursor/requireStr/requireNum)`
- `b43fda1 refactor(modules): migrate metro-logs/devtools-network/device-control to SDK arg narrowers`
- `0153f52 fix(module-sdk): address reviewer feedback on arg-narrower extraction`

Squash-merged as a single commit on `main`.

## What's next — Phase 12 Option C (npm publishing) picks back up when

1. `@rn-dev-modules` scope registered on npmjs.org by Martin (user
   account or org — decide the account ownership).
2. `rn-tools.com` DNS pointed at a static host (Cloudflare Pages,
   Netlify, GitHub Pages all fine) with a `modules.json` fixture moved
   into place under a stable URL (e.g. `https://rn-tools.com/modules/modules.json`).
3. Version decision: publish at `0.1.0` (current fixtures) or cut a
   `0.0.1` / pre-release tag first. Publishing to real npm is
   permanent — the version number locks forever.

Once those are unblocked, the publishing flow (per
[Phase 12 next-session prompt](2026-04-23-next-session-prompt-phase-12.md)
Option C) is:

1. `bun publish` for `device-control`, `devtools-network`, `metro-logs`
   under the `@rn-dev-modules/` scope.
2. Upload the real `modules.json` to `rn-tools.com` with published
   tarball SHAs.
3. Bake production `EXPECTED_MODULES_JSON_SHA256` into
   `src/modules/marketplace/registry.ts`.
4. Migrate the fixture registry URL in `docs/fixtures/modules.json` to
   the prod URL; move the old fixture to `docs/examples/` for offline
   demos.
5. Add a GitHub Action that re-SHA's the published `modules.json` on
   every release tag and fails the build if it drifts from the baked
   constant.
6. Document the release flow in `docs/releases.md`.
