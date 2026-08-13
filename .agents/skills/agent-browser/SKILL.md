---
name: agent-browser
description: Verify Answer Engine UI changes in a real browser at desktop and 375px mobile widths using the repository's sandbox-safe browser profile.
allowed-tools: Bash(pnpm exec agent-browser:*)
---

# Answer Engine browser verification

Use this skill for every Answer Engine UI feature or bug fix. The required
interactive verification CLI is the repository-pinned
`pnpm exec agent-browser`. Do not use `playwright-cli` as a substitute.
Playwright may still run through the repository's automated E2E test scripts.

The project-root `agent-browser.json` supplies the shared session name and a
repository-local profile. Run commands from the current issue worktree so the
profile stays within the Codex workspace-write sandbox. Never override the
profile with a home-directory path.

## Required workflow

1. Start the relevant development services and wait for an observable ready
   condition. Do not use fixed sleeps.
2. Open the affected local URL with `pnpm exec agent-browser open`.
3. Capture `pnpm exec agent-browser snapshot -i`, exercise the changed
   interaction using element refs, and capture a fresh snapshot after every
   navigation or DOM change.
4. Verify desktop layout and save a screenshot.
5. Run `pnpm exec agent-browser set viewport 375 812`, repeat the interaction,
   and save a mobile screenshot.
6. Check keyboard focus and reduced-motion behavior.
7. Run `pnpm exec agent-browser close` when verification is complete.

## Local URLs

- Web UI: `http://127.0.0.1:3200`
- API: `http://127.0.0.1:5050`

## Command pattern

```bash
pnpm exec agent-browser open http://127.0.0.1:3200/path
pnpm exec agent-browser wait --load networkidle
pnpm exec agent-browser snapshot -i
pnpm exec agent-browser set viewport 1440 900
pnpm exec agent-browser screenshot verification-desktop.png
pnpm exec agent-browser set viewport 375 812
pnpm exec agent-browser snapshot -i
pnpm exec agent-browser screenshot verification-mobile.png
pnpm exec agent-browser close
```

Refs such as `@e1` become stale after navigation or dynamic page updates.
Always take a new interactive snapshot before the next action.

If Auth0 or another login screen appears, stop: the OSS application must work
without login or a manually supplied API key. Treat that redirect as a product
failure rather than entering credentials.
