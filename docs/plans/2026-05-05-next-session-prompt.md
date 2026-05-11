---
title: Next-session prompt — verify real app launch + DevTools frame read; then plan H3
type: handoff
status: active
date: 2026-05-05
predecessor: docs/plans/2026-05-04-next-session-real-e2e-before-h3.md
---

# Next-session prompt — verify real app launch + DevTools frame read; then plan H3

H1 + H2 + middle phase + watchdog + scheme/configuration + branch
consolidation are landed. The repo is now **one branch (`main`),
one worktree (the repo root)** — sibling fix branches and throwaway
claude/* worktrees were deleted. 81 commits ahead of `origin/main`.
Local-only.

The earlier session claimed an "end-to-end run with the app launched
on iPhone" — that's overstated. What's actually verified by me:

- The build TRIGGER fires (`Building for ios` lands in Tool Output).
- The daemon stays alive through long sessions (watchdog-driven).
- Bug A/B/D/E/F regression specs pass.

What's NOT verified yet (the work this next session needs to close):

1. **The app actually installs + launches on the user's iPhone.**
2. **The DevTools panel reads real CDP frames from Hermes.** In
   every probe run, `devtools.status()` reported `proxyStatus:
   "no-target"` because no Hermes target was discovered. The
   product can't deliver value until DevTools shows real
   Network/Console/React content.

Copy-paste the section below into a fresh Claude Code session.

---

## Self-contained prompt for next session

You are continuing the rn-dev-cli hook system + electron flip work.

**Branch + worktree rule (HARD):** one branch (`main`), one worktree
(the repo root `/Users/martincouso/Downloads/rn-dev-cli`). Do NOT
create new branches. Do NOT use `git worktree add`. Do NOT use the
agent harness `isolation: "worktree"` option. See
`memory/single_branch_single_worktree.md` and the top of
`CLAUDE.md` for the full rationale.

`main` is **81 commits ahead of `origin/main`**, local-only. Do NOT
push from this account (per `memory/workflow_local_only_personal_account.md`).

The user is `dev@example.com`. iPhone 15 (UDID
`00008130-001A653A3E11001C`) is connected and on the same network.
Acme profile lives at
`/Users/martincouso/Documents/GitHub/acme-mobile-app/.rn-dev/profiles/profile-1777926131792.json`
(dirty mode, port 8081, branch `feat/camera-mode-memory`). The
user's existing acme dev CLI flow works against this device; ours
should match it.

### Where to start

1. **Read these in order:**
   - `memory/real_acme_verification_complete.md` — full status of
     the 81 commits, what's verified, what's NOT verified, and
     specifically the "Open verification work" section at the
     bottom (this is the next-session work).
   - `memory/single_branch_single_worktree.md` — hard rule.
   - `memory/workflow_local_only_personal_account.md` — local-only
     account; do NOT push, do NOT run `acme-reviewer:*` skills.
   - `memory/feedback_review_weighting.md` — how the user weights
     review findings.
   - `docs/plans/2026-05-05-build-bundle-hook-design.md` — the
     `build/discover-bundles` hook contract that the next phase
     implements.
   - The 81 commits: `git log --oneline origin/main..HEAD`.

### Step 1 — Verify the app actually launches on the iPhone

The probe-real-build.spec.ts assertions pass on probe-side
detection, NOT on visual confirmation that the app is on the phone.

**Do this manually first:**

```bash
# Clean slate
pkill -9 -f "src/index.tsx daemon /Users/martincouso/Documents/GitHub/acme" 2>&1; sleep 1
rm -f /Users/martincouso/Documents/GitHub/acme-mobile-app/.rn-dev/sock \
      /Users/martincouso/Documents/GitHub/acme-mobile-app/.rn-dev/pid

# Verify iPhone connected
xcrun xctrace list devices 2>&1 | grep -i "iPhone 15"
# Should NOT be under "Devices Offline".

# Boot dev:gui pointed at acme
RN_DEV_PROJECT_ROOT=/Users/martincouso/Documents/GitHub/acme-mobile-app \
  npm run dev:gui
```

In the Electron window:
- Pick the user's profile (the dirty one).
- **DO NOT click "Switch to Automatic" on the codesign modal.** That
  rewrites pbxproj and disturbs intentional Manual signing — that's
  what produced xcodebuild error 70 in the earlier probe. Click the
  Skip option (now labelled the recommended default).
- Wait ~5-15 minutes for the build (clean modes run pnpm install +
  pod install + xcodebuild on a cold cache).
- **Visually confirm Acme.app is on the iPhone home screen / launches.**
- Confirm the JS bundle is requested from Metro on the configured port
  (`info Metro → GET /index.bundle...`).

If install/launch fails:
- Read `~/.rn-dev/logs/daemon-acme-mobile-app-*.log` for the
  daemon-side trace.
- Read `/tmp/rn-dev-logs/build-ios.log` for the build subprocess
  output.
- Compare the build command logged in the Tool Output panel to what
  the user's existing acme CLI runs. Differences are the bug.

### Step 2 — Verify DevTools reads frames from Hermes

Once Step 1 confirms the app is running with Metro serving JS:

- In the Electron window, click the **DevTools** tab.
- Pre-fix observation: `proxyStatus: "no-target"` for the entire
  poll window. Now that Hermes is alive, the proxy should transition
  to `proxyStatus: "connected"` within a few seconds.
- The DevTools webview should render Fusebox with real Network +
  Console + React-tree content.
- Trigger network activity in the app; confirm requests appear in
  the DevTools Network tab.

This is the assertion a probe should add (the gap tracked in
`real_acme_verification_complete.md`'s "Open verification work"
#2). After confirming manually, codify it:

```ts
// Pseudo-code for the new probe assertion:
await waitFor(() => {
  const status = await session.devtools.status();
  expect(status.meta.proxyStatus).toBe("connected");
});
// Then: assert at least one network request was captured.
```

### Step 3 — Verify 2nd-tab clean-mode reaches `running`

The watchdog fix proved the user-reported `did not reach "running"
within 30000ms` error is gone. But the 90s probe never confirmed
the 2nd session actually transitioned to `running` — only that the
old error string didn't surface.

Drive the new-instance dialog with a clean profile, wait long
enough for `pnpm install` + `pod install` to finish (5-10 min on a
cold cache), and confirm:
- `session/status: running` event is observed.
- The 2nd tab shows Metro running on its profile's port.
- A second build trigger fires for that tab.

### Step 4 — Implement `build/discover-bundles` hook

`docs/plans/2026-05-05-build-bundle-hook-design.md` is the ready-to-
implement contract. Order of work:

1. **Hook contract type** under `src/core/hooks/contracts/`. Mirror
   the existing `build/pre` contract. Input + output types match the
   plan doc verbatim.
2. **Default implementation** for `ios`: parse
   `<projectRoot>/ios/*.xcodeproj/xcshareddata/xcschemes/*.xcscheme`,
   return one `BundleDescriptor` per shared scheme with its
   `<BuildConfiguration>` entries as `configurations`. For
   `android`: parse `<projectRoot>/android/app/build.gradle{,.kts}`
   `buildTypes` + `productFlavors` permutations.
3. **Wizard step** under `renderer/views/Wizard.tsx`: call the
   hook, render dropdowns for scheme + configuration, persist to
   `profile.scheme` + `profile.configuration`.
4. **`signingStyle` gate** in
   `electron/ipc/services.ts::settleCodeSigning`: if the discovered
   bundle's `signingStyle === "manual"`, skip the prompt entirely
   (the project HAS Manual signing intentionally).
5. **Probe** drives the wizard end-to-end against acme. Verify
   the picker shows both `Acme` and `Acme-beta`, that selecting
   `Acme` does NOT surface the codesign rewrite prompt, and that
   the build uses the picked scheme.

### Step 5 — Plan H3

Only after Steps 1-4 are green. Use the same a–k sub-phase pattern
H1+H2 used. H3 is `docs/plans/2026-04-30-feat-hook-system-plan.md`
§H3 — Clean / Metro / DevTools / Preflight built-in module wraps.

### What NOT to do this session

- Do NOT push. Do NOT open PRs.
- Do NOT run `acme-reviewer:*` skills.
- Do NOT auto-flip code signing or modify `project.pbxproj`. The
  prompt is now Skip-by-default; keep that contract.
- Do NOT re-introduce `--configuration` for run-ios — it crashes
  with `unknown option`. The CLI flag is `--mode`.
- Do NOT use `bun` from `~/.nodenv/shims/`; the daemon spawn needs
  the versioned binary.
- **Do NOT create new branches or worktrees.** Hard rule. See
  `memory/single_branch_single_worktree.md`.

### Watch out for (lessons to carry forward)

- **Probe-side green ≠ product working.** A previous session claimed
  end-to-end success because the probe regex matched the build
  trigger. The actual app launch on iPhone + DevTools frame reading
  were never verified. **Visual confirmation on the device + a
  user-facing surface** is the ground truth. Don't claim more than
  was actually observed.
- **`react-native run-ios` calls it `--mode`, not `--configuration`.**
  The CLI rejects `--configuration` with `unknown option` before
  xcodebuild ever runs. The BuildOptions field is semantically named
  `configuration` (Xcode's term); the mapping happens at the CLI
  boundary in `src/core/builder.ts`.
- **`bun` is a versioned binary, not a shim.** `~/.nodenv/shims/bun`
  re-resolves `.node-version` against the spawned cwd. Use
  `~/.nodenv/versions/<v>/bin/bun` (or whatever the resolver picks).
- **Codesign prompt default is now Skip.** Don't reverse this
  without a hook-driven `signingStyle` per bundle (Step 4 above).
- **Profile timeout strategy is progress-based, not wall-clock.**
  Slow machines + heavy builds NEVER hit a wall-clock kill. Only
  true daemon silence does. Don't reintroduce a mode-based timeout.
- **The DevTools `proxyStatus: "no-target"` state is the default
  when no app is connected.** Pre-fix the daemon would crash when
  Fusebox connected to it; that's fixed (Bug A). The remaining work
  is verifying the proxy actually transitions to `connected` once
  Hermes is alive.

Today is 2026-05-05.

---

## Notes for the resumer

- **Branch state:** `main` is 81 commits ahead of `origin/main`.
  Single branch, single worktree. Do not change this.
- **Sibling branches + claude/* worktrees:** all deleted.
- **The user's iPhone is connected** and on the same network. The
  profile points at it.
- **Test-fixture daemons leak protection** is in place across all
  three Playwright suites — pgrep should always return 0 between
  runs.
- **Open verification gaps** are tracked at the bottom of
  `memory/real_acme_verification_complete.md`. Steps 1-3 above
  close those gaps.
