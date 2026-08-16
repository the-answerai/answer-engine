# Issue #68 acceptance record

## Outcome

The desktop launcher now distinguishes simulated fixture state from a real
runtime, returns explicit opened/not-opened results for external actions, and
opens the packaged web application at the validated API origin. A valid
pre-channel stable home is detected and can be adopted from the launcher after
confirmation without starting services or changing memory data.

Legacy adoption is a shared installer API. It runs before Docker, model, and
reserved-port readiness checks; accepts only stable homes with regular
non-symlink required files, the expected project/channel, the known Answer
Engine Compose service/image/command/loopback-port/volume topology, valid
configuration mappings, and isolated channel resources; and writes only
`AE_CHANNEL=stable` plus the private ownership marker. Extra services, host
mounts, and privileged options fail closed. Existing lifecycle ownership
refusal remains unchanged.

## Acceptance criteria

- [x] Fixture status is labeled Demo mode in the renderer and tray and reports
  no installed, healthy, or running runtime.
- [x] Disabled fixture URL/log actions return `opened: false` with truthful
  user-facing messages.
- [x] Installed production URLs preserve the API-served `5050`/`5150` origin;
  `3200`/`3300` rewriting requires explicit standalone web-development mode.
- [x] The launcher exposes confirmed stable-only adoption and refreshes status
  without starting containers or migrating data.
- [x] Wrong-project, channel-conflicting, symlinked, malformed, and non-stable
  adoption attempts fail closed before ownership is written.
- [x] Arbitrary Compose projects cannot gain lifecycle ownership; unexpected
  services, commands, images, ports, mounts, volumes, or privileged options are
  rejected before channel metadata is written.
- [x] Adoption runs before unrelated reserved-port/model/Docker readiness and
  fixture database/archive bytes remain unchanged.
- [x] Regression coverage preserves lifecycle refusal when the ownership marker
  is missing.
- [x] `pnpm verify` passes.
- [x] The built production Electron renderer completed live interaction checks
  through the repository-pinned `pnpm browser:ui` session at 1440×900 and
  375×812. Fixture lifecycle and external-action controls remained truthful,
  stable/staging origins remained isolated, confirmation focus returned to its
  trigger, the mobile layout had no horizontal overflow, and reduced-motion
  styles were active. Evidence: [desktop](evidence/issue-68-desktop.png) and
  [375px mobile](evidence/issue-68-mobile.png).

## Verification evidence

Executed in the isolated issue #68 worktree on 2026-08-16:

- `CI=true pnpm install --frozen-lockfile` passed with the lockfile unchanged.
- `pnpm verify` passed the public-boundary check; server and desktop lint/type
  checks; 117 server tests with one expected integration skip; 185 CLI tests;
  63 MCP tests; 128 installer tests; 40 web tests; and 18 desktop tests. All
  server, CLI, MCP, installer, web, and desktop builds passed.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities.
- The unsigned macOS directory package completed with sandbox-writable Electron
  caches, and `app.asar` contains the exported installer adoption module and its
  runtime dependencies.
- The prepared `pnpm browser:ui` Chrome session exercised the built production
  desktop renderer with a preload-compatible in-memory fixture contract. At
  1440×900, Start retained `None running`, Open web app returned its explicit
  not-opened message, and stable retained `http://127.0.0.1:5050`. Stop moved
  focus to Confirm and Cancel returned focus to Stop. At 375×812, staging used
  `http://127.0.0.1:5150`, Open logs returned its explicit not-opened message,
  and `body.scrollWidth` equaled the 375px viewport. Emulated
  `prefers-reduced-motion: reduce` matched and reduced transition/animation
  durations to `0.001ms`.
- Direct fixture launch remains unavailable inside the managed macOS worker:
  both the workspace Electron binary and a valid ad-hoc-signed temporary app
  bundle were denied before CDP port 9228 became available. The live pass
  therefore covers the production renderer and fixture preload contract; the
  native macOS window shell and tray still require a host-capable release
  environment. No raw browser CLI, Playwright substitute, or unsafe launch
  bypass was used.
- Installer regressions cover valid metadata-only adoption, read-only
  inspection, unchanged database/archive fixtures, unrelated occupied-port and
  unavailable-model tolerance, stable-only enforcement, wrong project/channel,
  complete and partial symlinked home/config refusal, and missing ownership
  refusal before Docker.
- Desktop regressions cover fixture status/tray truthfulness, explicit disabled
  side-effect results, production and explicit Vite URL selection, adoption
  delegation without startup, adoption completion when Docker cannot refresh
  status, log access during status failure, restrictive renderer policy, and
  Demo mode copy.

## Data safety

All adoption tests used temporary synthetic homes. Browser verification used
only the built production renderer, an in-memory preload-compatible fixture,
and a temporary static server. Electron launch attempts used fixture mode and a
temporary packaged copy. No stable runtime lifecycle command ran, and no user
database, blob, volume, archive, credentials, or release state was read or
changed.
