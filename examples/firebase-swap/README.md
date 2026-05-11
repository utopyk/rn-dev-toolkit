# firebase-swap — minimal `rn-dev` hook example

Canonical example of the acme-style "swap a config file before each
build" pattern, expressed through Phase H2's `build/pre` and
`build/post` hook slots.

## What it does

`build/pre` swaps `firebase.config.json` from a `firebase.dev.json` /
`firebase.prod.json` source depending on the current build variant.
`build/post` restores `firebase.config.json` to a known-clean state so
the next dev session doesn't pick up a stale prod swap.

This example is intentionally minimal — it writes a sentinel file
(`.firebase-swap.sentinel`) instead of actually moving config files.
A real project's swap script would replace the sentinel writes with
the actual `cp` / `rename` calls.

## Files

```
examples/firebase-swap/
├── README.md           — this file
├── rn-dev.config.mjs   — registers build/pre + build/post against the
│                         build built-in module's hook slots
└── scripts/
    ├── swap-pre.mjs    — Node-only, Windows-portable; runs under build/pre
    └── swap-post.mjs   — Node-only, Windows-portable; runs under build/post
```

## To use in your own project

1. Copy `rn-dev.config.mjs` to your project root.
2. Copy the `scripts/` directory somewhere under your project root
   (the path-resolver rejects scripts outside the project root —
   that's the H1d TOCTOU defense).
3. Replace the sentinel-write logic in each script with your actual
   `firebase.config.json` swap.
4. Boot the daemon (e.g. `bun run dev` or `npm run dev:gui`); the
   build module is registered automatically.
5. Trigger a build; observe `~/.rn-dev/audit.log` if anything fails
   (audit policy: success path writes nothing, failure path writes a
   `kind: "hook"` entry).
