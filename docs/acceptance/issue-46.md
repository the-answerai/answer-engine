# Issue #46 acceptance record

## Outcome

Answer Engine now proposes explainable tags, assignments, and filtered
libraries from a tenant-scoped metadata sample. The deterministic local mode is
the default. Model use is an explicit opt-in and is capped at 50 records with
only IDs, titles, 500-character summaries, source/type fields, and existing tag
names exposed. Full content and raw archives are never selected for proposal
generation.

Every suggestion includes confidence, rationale, source examples, and explicit
dependencies. Apply requires one accept or reject decision per suggestion,
rechecks the complete source/taxonomy fingerprint, and commits taxonomy,
memberships, plan state, and audit evidence in one transaction. Undo removes
only plan-owned memberships and hides only plan-created taxonomy after a
stale-write guard. The same reviewed plan can be reapplied after undo without
duplicating tags, libraries, or memberships.

## Acceptance criteria

- [x] Proposal generation writes only workflow/audit evidence and does not
  mutate imported content, taxonomy, libraries, or memberships.
- [x] Every suggestion links to one to three supporting source examples and
  requires an individual accept or reject decision.
- [x] Apply is tenant-scoped, parameterized, transactional, dependency-aware,
  and refuses a stale proposal snapshot.
- [x] Undo restores plan-owned taxonomy and membership state without rewriting
  or deleting imported content.
- [x] Apply, undo, reapply, and second undo reuse the same tag/library IDs and
  do not duplicate memberships.
- [x] Desktop and 375px interaction, responsive width, keyboard focus, reduced
  motion, and accessibility verification passed.
- [x] `pnpm verify` passes.

## Verification evidence

Executed in the isolated issue #46 worktree on 2026-08-15:

- Focused organization service/routes — 9 passed, including non-mutating local
  proposals, bounded model exposure, invented-ID rejection, complete decisions,
  dependency validation, stale-plan rejection, tenant isolation, transactional
  apply/undo, same-plan reactivation, and refusal to reactivate another plan's
  inactive taxonomy.
- Focused CLI — 4 passed, including explicit model opt-in, the enforced
  50-record exposure ceiling, complete decision forwarding, and non-destructive
  undo.
- Web UI — 39 passed, including approval gating and preview → apply → undo →
  reapply.
- `pnpm verify` — passed:
  - public-boundary check, lint, and root type-check passed;
  - server: 105 passed and 1 environment-gated integration test skipped;
  - CLI: 180 passed; MCP server: 62 passed; installer: 119 passed; web UI: 39 passed;
  - server, CLI, MCP server, installer, and web UI builds passed.
- Migration 005 passed a clean up → down → up cycle against an isolated
  `pgvector/pgvector:pg16` PostgreSQL container with a 512 MB memory-backed data
  directory. The container was removed immediately afterward.
- Built CLI help was inspected for `ae organize`, `propose`, `apply`, and
  `undo`; command descriptions and the 1–50 sample limit match the docs.
- `pnpm browser:ui` exercised the production React build against an API-shaped
  organization fixture at 1440x900 and 375x812. Both viewports completed apply,
  undo, and reapply; both had zero horizontal overflow. Keyboard Tab produced
  the shared 3px focus indicator, reduced-motion emulation reduced transition
  and animation durations to 1ms, and the page reported no browser errors.
  Axe reported zero violations at both widths after the plan-history timestamp
  contrast was increased; mobile retained only the pre-existing incomplete
  result for the non-text menu glyph.

The repository-pinned browser's screenshot and close RPCs stalled and wrote no
PNG, matching the defect already recorded in the issue #44 acceptance run.
The daemon was reset once through `pnpm browser:prepare`; after the second
bounded screenshot attempt stalled, its exact validated daemon and Chrome PIDs
were stopped. No raw browser CLI, Playwright CLI, regular browser profile, or
stable service was used as a substitute.

## Safety review

All organization persistence queries are parameterized and tenant-scoped.
Library-scoped principals fail closed. Runtime and stored workflow payloads are
strictly validated with Zod. Model output can reference only sampled content
IDs. Apply and undo are transactional, audit-recorded, and stale-write guarded;
the only content-table mutation is insertion/deletion of plan-owned tag
memberships. There is no content rewrite, imported-content deletion, archive
read, archive write, or background automation in this workflow.

Stable sync remained disabled throughout verification. The stable raw archive
remained 0 B and the disk retained 1.1 TiB free.
