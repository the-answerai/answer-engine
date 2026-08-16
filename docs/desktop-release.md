# Desktop launcher releases

The private `@answer-engine/desktop` workspace packages a lightweight macOS and
Windows control app. It does not embed the Answer Engine database or own the
runtime process: closing every window, or quitting the launcher, leaves an
installed runtime and its data unchanged.

## Safety model

- Stable and staging commands always carry an explicit validated channel. The
  launcher reuses the installer lifecycle guards, runtime ownership marker,
  non-overlapping ports and volumes, immutable image validation, and bundled
  release checksums.
- The renderer is local-only. Context isolation, Chromium sandboxing, web
  security, a restrictive content-security policy, sender validation, and a
  narrow preload bridge remain enabled. Navigation and new windows are denied.
- Update accepts only the release embedded in the verified installer manifest;
  rollback accepts only its recorded, verified predecessor. Neither action
  removes the runtime home or persistent volumes.
- Uninstall and purge are deliberately absent from the desktop controls.

## Build and sign

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @answer-engine/create build
pnpm --filter @answer-engine/desktop package:mac
pnpm --filter @answer-engine/desktop package:win
pnpm --filter @answer-engine/desktop checksums
(cd tmp/desktop-release && shasum -a 256 -c SHA256SUMS)
```

Artifacts and `SHA256SUMS` are written to the ignored
`tmp/desktop-release/` directory. Release automation must start from a clean
checkout, verify the lockfile, and retain the generated checksums with the
release. It must never run electron-builder's publish command.

For macOS, supply the Apple Developer ID identity through electron-builder's
standard signing environment and notarize with Apple credentials in the
release job. For Windows, supply the code-signing certificate through the
release job's secret store. Secrets must not be written to repository files or
printed. Unsigned local directory builds are for inspection only and must not
be distributed.

The Windows NSIS target preserves application data on uninstall. A real clean
Windows 11 installation, signed artifact verification, first launch, repair,
update, rollback, tray behavior, and uninstall-with-data-preservation check are
the release gate tracked by the clean-machine acceptance issue.

Delete `tmp/desktop-release/` after local verification to reclaim the packaged
Electron runtime; it contains no user memory.
