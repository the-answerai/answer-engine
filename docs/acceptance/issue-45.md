# Issue #45 acceptance record

## Outcome

Local-folder ingestion now requires one explicit root and a metadata-first
inventory approval. Direct `local_dir` sync fails closed. Discovery reports
supported candidates, hidden/hard/custom exclusions, unsupported and binary
files, size limits, access failures, missing paths, and no-follow symlinks.
Approved candidates are restatted through no-follow file descriptors, archived
atomically, verified by SHA-256, and imported with stable source/path lineage.

Tenant-scoped folder sources and runs support approval, progress, cancellation,
retry/resume, refresh diffs, complete inventory reconciliation, and audited
keep/delete removal. The `/import` Local folder mode exposes the exact policy,
warnings, progress, refresh instructions, and explicit retention choice.

## Acceptance criteria

- [x] No full file bytes, archives, or content imports occur before a run has a
  durable folder-level approval and matching channel-local manifest.
- [x] Every preview row receives an applied or explained outcome; refresh
  persists added, changed, unchanged, missing, and excluded categories.
- [x] Unsupported, oversized, hidden, binary, access-denied, symlink, missing,
  and aggregate-limit cases are reported without unsafe traversal.
- [x] Archive tests sample stored bytes and compare their recorded SHA-256.
- [x] Source removal requires `keep` or `delete`, reconciles mapped content and
  archive handling, and records preparation, completion, counts, and failures.
- [x] Desktop and 375px interaction, keyboard focus, reduced motion, and
  accessibility verification passed.
- [x] `pnpm verify` passes.

## Verification evidence

Executed in the isolated issue #45 staging worktree on 2026-08-15:

- Focused server route/state tests — 6 passed.
- CLI suite — 165 passed, including deterministic inventory classification,
  aggregate limits, manifest traversal rejection, apply-time change detection,
  refresh diffs, archive SHA-256 sampling, and replacement (rather than
  broadening) of default include globs.
- Web UI suite — 38 passed, including consent gating, preview cancellation,
  disclosure focus styling, and explicit delete retention confirmation.
- `pnpm verify` — passed:
  - public-boundary check, lint, and root type-check passed;
  - server: 94 passed and the existing environment-gated database integration
    test skipped;
  - CLI: 165 passed; MCP server: 62 passed; installer: 119 passed; web UI: 38 passed;
  - server, CLI, MCP server, installer, and web UI builds passed.
- Built CLI help was compared for `ae`, `ae folders`, `ae folders add`, and
  `ae folders remove`; README and CLI documentation match the actual commands.
- `pnpm browser:ui` exercised the real production React build against an
  API-shaped folder fixture at 1440x900 and 375x812. Approval was disabled
  before consent, enabled after consent, and transitioned to approved live
  progress. Screenshots were captured at
  `/private/tmp/issue-45-folder-desktop-final.png`,
  `/private/tmp/issue-45-folder-desktop-consented-final.png`,
  `/private/tmp/issue-45-folder-mobile-preview-final.png`, and
  `/private/tmp/issue-45-folder-mobile-consented-final.png`. The mobile
  artifacts show the Local folder preview before and after consent; the policy
  and summary stack without horizontal overflow (375px viewport and 375px
  document width).
- Keyboard navigation focused the native inventory `<summary>` with the shared
  3px focus indicator. Reduced-motion emulation reported 1ms transition and
  animation durations. Axe reported 0 violations at both viewports; its one
  mobile incomplete result is the pre-existing transparent menu-glyph contrast
  check.

Migration execution was repeated after recovering Docker Desktop from host disk
exhaustion. Against a newly created, isolated PostgreSQL volume on
`127.0.0.1:16677`, migrations 001 through 004 applied successfully. The first
attempt raced the database's one-time bootstrap; the successful retry began
only after Compose reported PostgreSQL healthy. Stable remained healthy on
`127.0.0.1:5050`, and the repository migration ordering/rollback checks also
passed in `pnpm verify`.

## Review

All new persistence queries are parameterized and tenant-scoped. Runtime input
uses strict Zod contracts. Folder and archive paths are channel/root-contained,
symlinks are not followed, file metadata is checked before and after snapshot
reads, and removal cannot delete content outside the source mapping.
