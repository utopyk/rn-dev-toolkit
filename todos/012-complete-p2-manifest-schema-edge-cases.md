---
status: pending
priority: p2
issue_id: 012
tags: [plan-review, hook-system, schema, validation]
dependencies: []
---

# Manifest Schema Edge Cases for `provides.hooks`

## Problem Statement

Plan's manifest validation rules for `provides.hooks` are stated as "alphanum-dash, ≥1 char." Several edge cases unaddressed.

## Findings

1. **Empty `provides.hooks: []` array** — should be valid (module declares no hooks); plan should say so explicitly.
2. **Duplicate names within `provides.hooks: ["pre", "pre"]`** — schema allows by default; needs `uniqueItems: true`.
3. **Tool-name vs hook-name collision** — module declares `provides.hooks: ["foo"]` AND MCP tool `<id>__foo`. Names live in different namespaces (`<id>/<name>` vs `<id>__<name>`) so non-issue, but document explicitly.
4. **Reserved names** — `custom`, `pre`, `post`, `init`, `shutdown`. Should `provides.hooks` allow shadowing of names from another module? They're scoped by `<id>/`, so yes, but document.
5. **Maximum length** — no max declared. Recommend 64 chars.
6. **Leading/trailing dash** — `-pre` or `pre-` — should be invalid.

## Proposed Solutions

**Option A: Add explicit schema rules to H0 deliverables.** Effort: Small.

## Recommended Action

Option A.

## Acceptance Criteria

- [ ] H0 deliverable lists explicit schema rules: empty array allowed, `uniqueItems: true`, `maxLength: 64`, no leading/trailing dash, regex `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`.
- [ ] Reserved-name policy documented (no enforcement; cross-module collisions are scoped by `<id>/`).
- [ ] Tool-name vs hook-name namespace separation documented.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 6).

## Resources

- [packages/module-sdk/manifest.schema.json](../packages/module-sdk/manifest.schema.json)
