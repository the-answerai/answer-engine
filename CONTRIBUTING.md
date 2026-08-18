# Contributing to Answer Engine

Thank you for helping improve Answer Engine. This repository contains the
complete open-source, single-user product. Changes to roles, RBAC, teams,
billing, or permissions belong in the separate enterprise repository; neutral
extension interfaces that let another application add those capabilities
belong here.

## Before opening a change

- Search existing issues and open an issue before starting code changes.
- Discuss security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Keep changes narrowly scoped and preserve `tenant_id` on persistence and
  queries.
- Do not add provider credentials, personal transcripts, raw archives, or
  proprietary code to issues, commits, tests, or logs.

## Development workflow

1. Fork the repository and create a branch from `master`.
2. Install the pinned toolchain with `corepack enable`, then run
   `pnpm install --frozen-lockfile`.
3. Add or update tests with the implementation.
4. Run `pnpm verify`. UI changes also require the repository browser workflow
   at desktop and 375px mobile widths.
5. Open a pull request that links its issue and records exact verification
   results.

Maintainers may ask for a smaller change, additional tests, or a design issue
before review. A submitted pull request is not guaranteed to be accepted.

## Contribution terms

No Contributor License Agreement or Developer Certificate of Origin sign-off
is required at this time. By intentionally submitting a contribution, you
confirm that you have the right to submit it and agree that it is provided
under the existing license of the package or file being changed:

- Apache License 2.0 for the repository and packages that declare
  `Apache-2.0`.
- MIT License for `@answer-engine/cli` and `@answer-engine/mcp-server`.

Apache-licensed contributions are also governed by section 5 of the root
[LICENSE](LICENSE). Contributions explicitly marked "Not a Contribution" are
excluded as described there. Do not submit work that cannot be redistributed
under the applicable license.

Git commits permanently record author names and email addresses. Contributors
who do not want to publish a personal address should configure a GitHub-provided
`noreply` address before committing. Bots and co-authors must use identities
that accurately identify the accountable GitHub account or automation.

## Community expectations

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Community support boundaries are in [SUPPORT.md](SUPPORT.md), and project
decision-making is described in [GOVERNANCE.md](GOVERNANCE.md).
