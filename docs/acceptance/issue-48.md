# Issue #48 acceptance record

## Outcome

Answer Engine now includes a private Electron launcher that reaches the local
web UI or an actionable repair state from a packaged application. The launcher
is a control plane only: closing its only window hides the window and retains
the tray process, while quitting the launcher never invokes a runtime stop.

Every lifecycle request carries one validated stable or staging channel and
delegates to the installer's existing ownership, isolation, release-manifest,
checksum, immutable-image, update, and rollback guards. The desktop app has no
uninstall or purge control.

## Acceptance criteria

- [x] A packaged macOS application launches into a healthy or actionable UI.
- [x] Closing the only window leaves the launcher and independent runtime alive.
- [x] Tray/menu text derives from actual selected-channel status; staging is
  explicitly prefixed and status refreshes every 15 seconds.
- [x] Staging is visually unmistakable at 1440×900 and 375×812.
- [x] Update and rollback delegate to verified installer controls without a
  data-deletion path; unverified release/image regressions remain covered by
  installer tests.
- [x] Context isolation, sandboxing, disabled Node integration, strict CSP,
  sender validation, local-only navigation, and narrow IPC regressions pass.
- [x] `pnpm verify` passes.

## Verification evidence

Executed in the isolated issue #48 worktree on 2026-08-15:

- `pnpm audit --prod --audit-level high` reported no known vulnerabilities.
- `pnpm verify` passed the public-boundary check, server/desktop lint and type
  checks, 116 server tests (plus one environment-gated integration skip), 184
  CLI tests, 63 MCP tests, 119 installer tests, 40 web tests, and 12 desktop
  tests. Every server, CLI, MCP, installer, web, and desktop build passed.
- Desktop tests cover strict Electron web preferences, trusted renderer origin,
  traversal refusal, localhost-only web launch, runtime independence from
  window lifetime, selected-channel lifecycle delegation, guarded restart,
  fixture isolation, actual-health tray labels, staging tray identity, CSP,
  reduced motion, package targets, app icon, and bounded release cleanup.
- The repository-pinned Electron/browser workflow exercised only the in-memory
  fixture. Stable and staging start/stop state remained independent, dangerous
  actions required inline confirmation, and packaged-fixture URL/log/login-item
  operations caused no external side effects.
- At 1440×900 and 375×812 there was zero horizontal overflow and zero axe
  violations. Axe left contrast incomplete because it could not sample the
  custom protocol; manual WCAG calculations found a lowest text contrast of
  4.88:1. Keyboard navigation produced a solid 3px focus ring with 3px offset,
  and reduced-motion emulation reduced duration to 1 microsecond.
- [Desktop screenshot](./evidence/issue-48-desktop.png) and
  [375px screenshot](./evidence/issue-48-mobile.png) capture the staging UI.
- A full unsigned local macOS build produced a runnable `.app`, DMG, ZIP, and
  blockmaps. Five generated-file SHA-256 entries verified successfully. A
  subsequent unpacked build embedded the generated 205 KB `icon.icns`. Local
  builds were not distributed; signing/notarization inputs are release secrets.
- The final packaged ASAR contains the guarded lifecycle/runtime-channel code,
  release manifest, and checked Docker Compose template required by update and
  rollback; the packaged app also completed a fixture-mode smoke test.
- The Windows NSIS x64 target, macOS hardened-runtime targets, no-publish policy,
  data-preserving uninstall option, signing plan, and checksum workflow are
  documented. Clean Windows hardware execution remains correctly assigned to
  issue #49 rather than inferred from macOS.

## Disk and data safety

Browser and lifecycle verification never contacted the stable API or runtime.
Stable sync remained disabled and `~/.answer-engine/raw-archive` remained `0 B`.
The largest transient package directory was 527 MB; it was checksum-verified
and removed with the exact-path guarded cleanup script. Final disk availability
remained 1.1 TiB, with only 272 KB of screenshot evidence retained.
