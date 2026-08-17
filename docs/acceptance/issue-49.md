# Issue #49 clean-machine acceptance record

## Outcome: blocked on genuine platform environments

Final environment-independent verification passes, but the required clean
Apple Silicon and Windows 11/WSL2 GPU runs have not occurred. This record does
not infer success from fixtures, unit tests, the active personal Mac, or an
unsupported hosted runner. Issue #49 and epic #40 must remain open.

## Environment inventory

Re-audited on 2026-08-16 in `America/Los_Angeles`:

| Candidate | Observed state | Acceptance decision |
|---|---|---|
| Local Mac | Apple M5 Max, arm64, 128 GB RAM; active personal machine | Hardware qualifies, but the host is not clean and owns the stable instance. Refused as a clean baseline. |
| Local virtual machines | No Parallels, UTM, VMware, VirtualBox, Multipass, Lima, or Colima installation found | No already-provisioned clean macOS or Windows guest exists. |
| Repository runners | The self-hosted runners API returned `total_count: 0`; the organization hosted-runner API reported that hosted runners are not supported for this organization | No qualifying clean hardware is attached or provisionable through the current repository configuration. |
| GitHub-hosted ARM macOS | Standard runner: 7 GB; larger M2 runner: 14 GB; nested virtualization unsupported | Below the agreed 16 GB baseline and unable to exercise the Docker-backed runtime. |
| Windows 11/WSL2 GPU | No provisioned machine or runner | The required supported 8 GB+ GPU path cannot be executed. |
| Canonical release | #71 removed the npm dependency and added deterministic GitHub Release assets, checksums, provenance, bootstrap scripts, and digest-only runtime validation; no production tag, GitHub Release, or runtime image has been published | The release path is implemented and verified, but a clean machine still has no production artifact to fetch until an explicit human release action. |

GitHub documents the current hosted-runner sizes and the lack of nested
virtualization for ARM macOS in its
[hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and [larger runners reference](https://docs.github.com/en/actions/reference/runners/larger-runners).
Creating a paid larger/GPU runner requires organization-owner provisioning; it
was not silently authorized or substituted for the requested baseline.

## Completed evidence

- A fresh checkout of the integrated epic session reused the local pnpm store
  with zero network downloads. `pnpm verify` passed the public-boundary check,
  all lint/type checks, 124 server tests plus one environment-gated database
  skip, 185 CLI tests, 63 MCP tests, 146 installer tests, 40 web tests, 18
  desktop tests, and every build: 576 passing tests total. The session PR's
  independent `verify` and `container` checks also pass at `15c7a1c`.
- The exact fresh command
  `node ../alpha-loop/dist/cli.js run --verify-only 40` completed with
  `PARTIAL`. It recognizes 10/11 sub-issues merged and reports 65/72 evaluated
  criteria met, seven partial, zero missing, and zero unclear. Every #68 and
  #71 criterion is met. The remaining evidence is the two clean-install gates,
  live Codex/Claude integration and supported-client recall, plus screenshot
  artifacts for #44, #46, and #47.
- Issues #41–#48, #68, and #71 are closed and their epic checkboxes are checked. Their
  session changes are integrated through PRs #56, #57, #58, #59/#60, #63,
  #64, #65, #66, #70, and #72. Each issue has at least one learning file; #43–#48
  and #68 also have dedicated acceptance records.
- PR #64's missing session-child cross-reference was repaired after the verifier
  failed to associate already-merged #46. The issue timeline now contains a
  merged PR #64 cross-reference; future child handoff checks must verify both
  the PR base and the issue timeline association.
- The desktop/macOS package, Electron security, responsive UI, migration,
  installer, integration, import, ingestion, organization, and tutorial fixture
  evidence remains recorded in the preceding issue acceptance files. #68 adds
  host-launched native Electron fixture and real-controller verification: the
  stable runtime was healthy at port 5050, the web application returned HTTP
  200, staging remained independently not installed at port 5150, desktop and
  375px checks passed, and no lifecycle mutation ran.
- #71 provides registry-independent Bash and PowerShell bootstrap assets,
  deterministic checksums and provenance, explicit dependency policy and
  consent, strict runtime digest persistence, and a manually gated release
  workflow. Its local verification, production audit, independent reviews, and
  PR #55 GitHub checks pass; no release, npm package, or production tag was
  published.
- No role, RBAC, team, billing, or enterprise permission-management code was
  found by the public-boundary check. No npm package was published.

## Required evidence before unblocking

1. Provide a genuinely clean Apple Silicon Mac with at least 16 GB RAM and a
   clean Windows 11/WSL2 machine with a supported GPU containing at least 8 GB
   VRAM, or attach equivalent dedicated runners.
2. Explicitly authorize and execute the manually gated release workflow after
   candidate acceptance so the canonical prompt can fetch a production tag,
   installer/CLI assets, checksums, provenance, and a digest-pinned runtime
   image. npm publication is neither required nor allowed.
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

## Evidence worksheet to complete

Every cell must link to evidence from the named clean machine. A component test,
fixture, active personal host, or result copied from the other platform does not
complete a cell.

| Gate | Clean Apple Silicon 16 GB+ | Clean Windows 11/WSL2 GPU 8 GB+ |
|---|---|---|
| Sanitized hardware, OS, Node, Docker, Compose, and model-runtime inventory | Blocked | Blocked |
| Versioned prompt, package/release checksum, runtime digest, and rollback-input verification | Blocked | Blocked |
| Prompt-driven preflight, interview, confirmed install, health, and no-login local UI | Blocked | Blocked |
| Consented first history import with reconciled inventory and sampled lineage | Blocked | Blocked |
| Folder preview/apply/remove and archive-integrity sample | Blocked | Blocked |
| Organization preview/apply/undo/reapply with unchanged imported content | Blocked | Blocked |
| Real Codex and Claude Code MCP/CLI recall events; applicable desktop-client guided recall | Blocked | Blocked |
| Fresh-chat grounded remember/recall tutorial without copied answer context | Blocked | Blocked |
| Native desktop/tray behavior, background recovery after reboot, desktop screenshot, and 375px screenshot | Blocked | Blocked |
| Repair, update, rollback, cancellation, uninstall/reinstall, and preserved stable data | Blocked | Blocked |
| Concurrent stable/staging mutation with unchanged stable database, archive, credential, volume, and service fingerprints | Blocked | Blocked |
| Clean-checkout `pnpm verify`, installer/package verification, and final epic verify-only audit | Blocked | Blocked |

Each machine's evidence bundle must record the source commit and immutable
artifact identifiers; timestamps and command exit status; sanitized commands
and outputs; before/after fingerprints; client/tool event identifiers; and
screenshot paths. Never retain secrets, raw imported content, database dumps,
machine serial numbers, hardware UUIDs, or credential bytes. Fingerprint those
inputs as a stream when required and retain only the digest.

## Disk and data safety

No VM or OS image was downloaded. No stable API, database, service, credential,
or memory file was mutated. The 738 MB native-verification worktree and the
862 MB fresh-audit worktree were removed after use, this documentation-only
worktree has no dependency tree, the raw archive remains `0 B`, and the host
retains approximately 1.1 TiB free.
