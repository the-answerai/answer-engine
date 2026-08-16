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
- [x] A host-launched native Electron window reported the existing stable
  runtime healthy at port 5050, opened that web application successfully, and
  showed staging as an independent not-installed runtime at port 5150.
  Evidence: [real stable runtime](evidence/issue-68-real-runtime.png).

## Verification evidence

Executed in the isolated issue #68 worktree on 2026-08-16:

- `CI=true pnpm install --frozen-lockfile` passed with the lockfile unchanged.
- `pnpm verify` passed the public-boundary check; server and desktop lint/type
  checks; 117 server tests with one expected integration skip; 185 CLI tests;
  63 MCP tests; 129 installer tests; 40 web tests; and 18 desktop tests. All
  server, CLI, MCP, installer, web, and desktop builds passed.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities.
- The unsigned macOS directory package completed with sandbox-writable Electron
  caches, and `app.asar` contains the exported installer adoption module and its
  runtime dependencies.
- The host-launched Electron fixture exposed CDP on port 9228, and the prepared
  repository-pinned `pnpm browser:ui` session exercised the native window and
  real preload IPC contract. At
  1440×900, Start retained `None running`, Open web app returned its explicit
  not-opened message, and stable retained `http://127.0.0.1:5050`. Stop moved
  focus to Confirm and Cancel returned focus to Stop. At 375×812, staging used
  `http://127.0.0.1:5150`, Open logs returned its explicit not-opened message,
  and `body.scrollWidth` was 360px within the 375px viewport. Emulated
  `prefers-reduced-motion: reduce` matched and reduced transition/animation
  durations to `0.001ms`. The browser console and page-error logs were empty;
  axe reported zero WCAG A/AA violations, with gradient-dependent contrast
  checks left incomplete.
- A second host-launched native Electron window used the real desktop
  controller in read-only use. It reported stable `Healthy and ready`, release
  `answer-engine-oss:local`, services `api, postgres, redis`, and local URL
  `http://localhost:5050`. Open web app returned `Opened the stable web app`,
  while an independent request returned HTTP 200 and `/health` returned
  `channel: stable`. Switching to staging reported `Not installed` at
  `http://127.0.0.1:5150`; returning to stable remained healthy.
- The managed worker could not launch Electron because of its macOS sandbox,
  so native verification was completed from the host after Alpha Loop's
  independent review passed. Every browser interaction still used the
  repository wrapper; no raw browser CLI, Playwright substitute, or unsafe
  launch bypass was used.
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

All adoption tests used temporary synthetic homes. Fixture-mode browser
verification used the native Electron window and in-memory controller. Real
mode was limited to status reads, channel selection, and Open web app; no
lifecycle action ran. The stable database, blobs, volumes, archive,
credentials, and release state were not changed. After verification, stable
remained healthy, `~/.answer-engine/raw-archive` remained 0 B, and the host had
approximately 1.1 TiB free.
