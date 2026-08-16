# Issue #49 clean-machine acceptance record

## Outcome: blocked on genuine platform environments

Final environment-independent verification passes, but the required clean
Apple Silicon and Windows 11/WSL2 GPU runs have not occurred. This record does
not infer success from fixtures, unit tests, the active personal Mac, or an
unsupported hosted runner. Issue #49 and epic #40 must remain open.

## Environment inventory

Recorded on 2026-08-15 in `America/Los_Angeles`:

| Candidate | Observed state | Acceptance decision |
|---|---|---|
| Local Mac | Apple M5 Max, arm64, 128 GB RAM; active personal machine | Hardware qualifies, but the host is not clean and owns the stable instance. Refused as a clean baseline. |
| Local virtual machines | No Parallels, UTM, VMware, VirtualBox, Multipass, Lima, or Colima installation found | No already-provisioned clean macOS or Windows guest exists. |
| Repository self-hosted runners | GitHub Actions runners API returned `total_count: 0` | No clean hardware is attached to the repository. |
| GitHub-hosted ARM macOS | Standard runner: 7 GB; larger M2 runner: 14 GB; nested virtualization unsupported | Below the agreed 16 GB baseline and unable to exercise the Docker-backed runtime. |
| Windows 11/WSL2 GPU | No provisioned machine or runner | The required supported 8 GB+ GPU path cannot be executed. |
| Canonical release | npm returns `E404` for `@answer-engine/create@1.1.0`; Git has no `v1.1.0` tag | The copy-pasted immutable install prompt cannot execute. Publishing npm is forbidden by the epic instructions. |

GitHub documents the current hosted-runner sizes and the lack of nested
virtualization for ARM macOS in its
[hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and [larger runners reference](https://docs.github.com/en/actions/reference/runners/larger-runners).
Creating a paid larger/GPU runner requires organization-owner provisioning; it
was not silently authorized or substituted for the requested baseline.

## Completed evidence

- A fresh checkout of the merged epic session reused the local pnpm store with
  zero network downloads. `pnpm verify` passed the public-boundary check, all
  lint/type checks, 116 server tests plus one environment-gated database skip,
  184 CLI tests, 63 MCP tests, 119 installer tests, 40 web tests, 12 desktop
  tests, and every build: 534 passing tests total.
- `node ../alpha-loop/dist/cli.js run --verify-only 40` completed with
  `PARTIAL`. It reported 43/48 evaluated criteria met and independently found
  the same operational gaps: real simultaneous Compose channels, immutable
  published installer inputs, clean baseline installs, and live configured
  client recall are not proven.
- Issues #41–#48 are closed and their epic checkboxes are checked. Their session
  changes are merged through PRs #56, #57, #58, #59/#60, #63, #64, #65, and
  #66. Each issue has at least one learning file; #43–#48 also have dedicated
  acceptance records.
- PR #64's missing session-child cross-reference was repaired after the verifier
  failed to associate already-merged #46. The issue timeline now contains a
  merged PR #64 cross-reference; future child handoff checks must verify both
  the PR base and the issue timeline association.
- The desktop/macOS package, Electron security, responsive UI, migration,
  installer, integration, import, ingestion, organization, and tutorial fixture
  evidence remains recorded in the preceding issue acceptance files.
- No role, RBAC, team, billing, or enterprise permission-management code was
  found by the public-boundary check. No npm package was published.

## Required evidence before unblocking

1. Provide a genuinely clean Apple Silicon Mac with at least 16 GB RAM and a
   clean Windows 11/WSL2 machine with a supported GPU containing at least 8 GB
   VRAM, or attach equivalent dedicated runners.
2. Provide an immutable install candidate that the canonical prompt can fetch
   without violating the no-publication constraint, or explicitly authorize the
   release/tag workflow after candidate acceptance.
3. On both machines, execute the full prompt-driven install, first import,
   folder preview, organization preview/apply/undo, client wiring, fresh-chat
   grounded recall, desktop/tray, reboot recovery, repair, upgrade, rollback,
   cancellation, uninstall/reinstall, and checksum matrix.
4. Run concurrent stable/staging services and a destructive staging fixture,
   recording stable database, archive, credential, volume, and service hashes
   before and after.
5. Record real Codex and Claude Code tool events plus supported desktop-client
   guided recall; do not substitute mocked command output.
6. Re-run `pnpm verify` from both clean checkouts and the epic verify-only audit.

## Disk and data safety

No VM or OS image was downloaded. No stable API, database, service, credential,
or memory file was mutated. The final worktree dependency tree is 436 MB, the
raw archive remains `0 B`, and the host retains 1.1 TiB free. The dependency
tree can be deleted when this blocked evidence branch is retired.
