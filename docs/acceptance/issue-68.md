# Issue #68 acceptance record

## Outcome

The desktop launcher now distinguishes simulated fixture state from a real
runtime, returns explicit opened/not-opened results for external actions, and
opens the packaged web application at the validated API origin. A valid
pre-channel stable home is detected and can be adopted from the launcher after
confirmation without starting services or changing memory data.

Legacy adoption is a shared installer API. It runs before Docker, model, and
reserved-port readiness checks; accepts only stable homes with regular
non-symlink required files, the expected project/channel, valid Compose and
configuration mappings, and isolated channel resources; and writes only
`AE_CHANNEL=stable` plus the private ownership marker. Existing lifecycle
ownership refusal remains unchanged.

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
- [x] Adoption runs before unrelated reserved-port/model/Docker readiness and
  fixture database/archive bytes remain unchanged.
- [x] Regression coverage preserves lifecycle refusal when the ownership marker
  is missing.
- [x] `pnpm verify` passes.
- [ ] Live Electron screenshots at 1440×900 and 375×812 remain to be captured
  from a host-capable browser-preparation environment. The managed worker built
  the fixture successfully, but macOS terminated Electron with `SIGABRT` before
  CDP port 9228 opened. After the prelaunched Chrome session was closed, the
  repository wrapper correctly refused a sandboxed replacement because process
  inspection/GUI launch is denied. No unsafe browser bypass was used.

## Verification evidence

Executed in the isolated issue #68 worktree on 2026-08-16:

- `CI=true pnpm install --frozen-lockfile` passed with the lockfile unchanged.
- `pnpm verify` passed the public-boundary check; server and desktop lint/type
  checks; 116 server tests with one expected integration skip; 184 CLI tests;
  63 MCP tests; 126 installer tests; 40 web tests; and 16 desktop tests. All
  server, CLI, MCP, installer, web, and desktop builds passed.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities.
- Installer regressions cover valid metadata-only adoption, read-only
  inspection, unchanged database/archive fixtures, unrelated occupied-port and
  unavailable-model tolerance, stable-only enforcement, wrong project/channel,
  symlinked home/config refusal, and missing ownership refusal before Docker.
- Desktop regressions cover fixture status/tray truthfulness, explicit disabled
  side-effect results, production and explicit Vite URL selection, adoption
  delegation without startup, restrictive renderer policy, and Demo mode copy.

## Data safety

All adoption tests used temporary synthetic homes. Browser attempts used only
the in-memory fixture controller and a temporary static renderer server. No
stable runtime lifecycle command ran, and no user database, blob, volume,
archive, credentials, or release state was read or changed.
