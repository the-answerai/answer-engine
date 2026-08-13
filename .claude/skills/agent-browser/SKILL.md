---
name: agent-browser
description: Verify Answer Engine UI changes in a real browser at desktop and 375px mobile widths using the repository's sandbox-safe browser profile.
allowed-tools: Bash(pnpm browser:ui:*)
---

# Answer Engine browser verification

Use this skill for every Answer Engine UI feature or bug fix. The required
interactive verification CLI is the repository-pinned `pnpm browser:ui`. Do
not run `pnpm exec agent-browser` directly and do not use `playwright-cli` as a
substitute. Playwright may still run through the repository's automated E2E
test scripts.

The project-root `agent-browser.json` supplies the shared session name.
`scripts/agent-browser.sh` supplies a short, project-scoped socket and profile
under `/tmp/answer-engine-oss-browser`, which Codex linked-worktree sandboxes
can access. Alpha Loop's `setup_command` runs `pnpm browser:prepare` outside the
worker sandbox so Chrome is already running before a worker connects. Never
override these paths with a home-directory location.

## Required workflow

1. Start the relevant development services and wait for an observable ready
   condition. Do not use fixed sleeps.
2. Confirm `pnpm browser:prepare` passed in the Alpha Loop setup output. Stop if
   it failed; a sandboxed worker cannot safely launch a replacement Chrome.
3. Open the affected local URL with `pnpm browser:ui open`.
4. Capture `pnpm browser:ui snapshot -i`, exercise the changed
   interaction using element refs, and capture a fresh snapshot after every
   navigation or DOM change.
5. Verify desktop layout and save a screenshot.
6. Run `pnpm browser:ui set viewport 375 812`, repeat the interaction,
   and save a mobile screenshot.
7. Check keyboard focus and reduced-motion behavior.
8. Run `pnpm browser:ui close` when verification is complete.

## Local URLs

- Web UI: `http://127.0.0.1:3200`
- API: `http://127.0.0.1:5050`

## Command pattern

```bash
pnpm browser:ui open http://127.0.0.1:3200/path
pnpm browser:ui wait --load networkidle
pnpm browser:ui snapshot -i
pnpm browser:ui set viewport 1440 900
pnpm browser:ui screenshot verification-desktop.png
pnpm browser:ui set viewport 375 812
pnpm browser:ui snapshot -i
pnpm browser:ui screenshot verification-mobile.png
pnpm browser:ui close
```

Refs such as `@e1` become stale after navigation or dynamic page updates.
Always take a new interactive snapshot before the next action.

If Auth0 or another login screen appears, stop: the OSS application must work
without login or a manually supplied API key. Treat that redirect as a product
failure rather than entering credentials.
