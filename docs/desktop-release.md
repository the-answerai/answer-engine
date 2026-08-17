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
- The manifest records the exact source commit, release asset identities, and
  `ghcr.io/the-answerai/answer-engine@sha256:...` runtime. Mutable tags are not
  install, update, or rollback inputs. See [Immutable installer releases](./installer-release.md).
- Uninstall and purge are deliberately absent from the desktop controls.
- The packaged web application is served by the installed API origin (`5050`
  for stable and `5150` for staging). The launcher preserves that validated
  origin when opening the app. Ports `3200` and `3300` are used only when
  `AE_DESKTOP_WEB_DEV=1` explicitly selects a standalone Vite development UI.
- A pre-channel stable home is shown as adoptable only after the installer's
  file, project, channel, known Compose topology, configuration, and isolation
  validation passes. Extra services, host mounts, privileged options, and
  unexpected images, commands, ports, mounts, or volumes are rejected. The
  confirmed Adopt action writes ownership metadata only; it does not start the
  runtime or migrate user data. Invalid legacy homes remain unmanaged and show
  the validation error.

## Fixture mode

`pnpm --filter @answer-engine/desktop fixture` is a simulated UI preview. The
window and tray label it as Demo mode, status reports no installed or healthy
runtime, and lifecycle controls change no external state. Open-web and
open-logs requests return an explicit not-opened result; they never claim that
a disabled fixture side effect succeeded. Use normal launcher mode for real
runtime verification.

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
