# Issue #43 acceptance record

## Outcome

The stable installer now detects and selects distinct agent client surfaces,
prints exact target paths and unsupported limitations before consent, installs a
checksum-covered dual-host Answer Engine plugin or client-appropriate MCP/CLI
configuration, and blocks completion until supported selected clients pass an
automated or guided real-recall challenge.

The maintained matrix supports the local ChatGPT Desktop Codex host while
rejecting direct localhost claims for hosted ChatGPT Chat/Work/web and Cowork.
No remote relay, npm publication, enterprise
capability, or database migration is included.

## Acceptance criteria

- [x] The welcome flow accepts all maintained client IDs through `--clients`
  and interactive multi-selection; `--agents` remains a compatibility alias.
- [x] Codex receives the Personal plugin and Claude Code receives the shared
  skills through a real local Claude marketplace plugin. Their stdio MCP
  launchers use the installer-owned runtime rather than npm. ChatGPT Desktop
  Codex receives its shared plugin source with bundled MCP; Claude Desktop and
  Cursor-style adapters receive local JSON MCP. Unsupported hosted surfaces and
  Cowork receive explanations and no writes.
- [x] Codex and Claude Code verification launches their real non-interactive
  clients and requires raw Answer Engine `recall` tool-event evidence containing
  the unique marker and expected content ID. Unit tests reject plausible text
  that lacks a tool event. GUI clients require restart and explicit confirmation.
- [x] ChatGPT Desktop Codex is modeled separately from hosted ChatGPT web/Work;
  Cowork limitations are explicit and never receive false localhost wiring.
- [x] Changes are consented, private, idempotent, backed up, Zod-validated,
  redacted in the ledger, reversible through `remove-integrations`, and limited
  to Answer Engine-owned entries. Integration-ledger hashing invalidates stale
  installer completion state.
- [x] Focused install/use/organize skills, shared safety/capability/tool
  references, activation cases, and representative workflow eval fixtures are
  packaged and checksum-covered. Fresh agents executed positive and near-miss
  activation cases plus every workflow prompt, and an independent grader passed
  all 14 packaged-skill assertions.
- [x] `pnpm verify` passes.

## Verification evidence

Executed in the isolated issue #43 worktree on 2026-08-14:

- `pnpm verify` — passed:
  - public-boundary check, lint, and root type-check passed;
  - server: 82 passed, 1 environment-gated database integration skipped;
  - CLI: 149 passed;
  - MCP server: 62 passed;
  - installer: 114 passed;
  - web UI: 35 passed;
  - server, CLI, MCP server, installer, and web UI builds passed.
- Codex plugin validator — passed.
- Claude plugin strict validator — passed.
- Skill quick validator — passed for all three packaged skills; this validates
  package structure, not activation or representative workflow behavior.
- Independent skill evaluation — passed:
  - activation selection: 6 of 6 positive and near-miss decisions;
  - packaged skills: 14 of 14 assertions;
  - no-skill baseline: 11 of 14 assertions;
  - raw runs and independent grades are preserved under
    `docs/acceptance/evidence/issue-43-skill-eval-*` and CI verifies their source
    hashes, assertion coverage, and passing grades.
- Canonical install prompt equality across `README.md`, `INSTALL_AGENT.md`, and
  `packages/create/README.md` — passed by the repository test.
- `git diff --check` — passed.

The worker did not mutate global client configuration or the stable personal
memory channel for a manual smoke test. No isolated staging API was running on
port 5150. The shipped installer performs the live Codex/Claude invocation at
install time and refuses to write completion state when that invocation lacks a
real tool event or fails.

No web UI source changed, so desktop/mobile browser verification is not
applicable to this CLI welcome flow.

## Review

Requirements, runtime code quality, test robustness, and security review status:
pass. Independent activation and workflow evaluation is current and passing.
Credential values appear only in the owner-readable CLI handoff, never in MCP
metadata, the ledger, or command arguments. External commands use `execFile` argument arrays,
existing JSON/TOML entries are preserved, symbolic-link targets are rejected,
and global writes are refused for staging.
