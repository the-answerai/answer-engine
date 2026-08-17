# Issue #44 acceptance record

## Outcome

The first agent-history import now discovers Claude Code, Codex, and Cowork
without reading transcript bodies, presents a selectable consent preview, and
uses a tenant-scoped session lifecycle to approve, run, cancel, retry, resume,
and reconcile every discovered item. Complete bundle metadata and byte totals
are previewed, and the bundle fingerprint is verified again before any approved
transcript body is read. Deterministic raw archives are reused only after hash
verification, and imported chat outcomes require both a non-empty summary and a
matching raw-manifest path.
Resumed runs additionally require the owner-only channel-local discovery
manifest to match the complete server inventory, preventing a fabricated API
session from turning the CLI into an arbitrary local-file reader.

The manual text and JSON import paths remain available. Folder scanning,
automatic organization, Graphify, and npm publication remain out of scope.

## Acceptance criteria

- [x] No progress event or transcript import can occur before explicit source
  approval; discovery uses adapter path/stat metadata only and execution rejects
  a bundle that changed after approval.
- [x] Any available subset can be approved, while unavailable sources are
  shown with a safe explanation and cannot be selected.
- [x] Session items, sync cursors, deterministic archives, atomic staging
  replacement, cancellation checks, and `--resume` provide interruption-safe
  retry without duplicate rows or partial archive reuse.
- [x] Completion reconciles imported, duplicate, failed, and skipped outcomes
  to the discovered inventory. Imported outcomes verify tenant-scoped chat
  content, non-empty summaries, and matching raw manifests.
- [x] Errors are limited to source labels, safe codes, and recovery actions;
  inaccessible discovery and changed snapshots do not expose transcript
  content, raw filesystem errors, or credentials.
- [x] Desktop and 375px interaction, responsive width, keyboard focus,
  reduced-motion, and browser-error checks passed through `pnpm browser:ui`.
- [x] `pnpm verify` passes.

## Verification evidence

Executed in the isolated issue #44 staging worktree on 2026-08-14:

- `pnpm install --frozen-lockfile` through `pnpm browser:prepare` — passed.
- Clean database migration — passed from an empty isolated PostgreSQL volume:
  migrations `001`, `002`, and `003` applied in order.
- `RUN_DATABASE_INTEGRATION=true pnpm vitest run
  tests/server/application-database.integration.test.ts` — 1 passed. The test
  covers pre-approval rejection, manifest-integrity rejection, valid progress,
  and final reconciliation.
- `pnpm verify` — passed:
  - public-boundary check, lint, and root type-check passed;
  - server: 87 passed, 1 environment-gated integration skipped;
  - CLI: 156 passed;
  - MCP server: 62 passed;
  - installer: 119 passed;
  - web UI: 36 passed;
  - server, CLI, MCP server, installer, and web UI builds passed.
- `pnpm browser:ui` against the isolated staging API — interaction checks
  passed at 1440x900 and 375x812. The run selected a single source, required
  consent before enabling approval, observed a successful approval request,
  preserved the selected source after reload, reported no page errors, and
  confirmed reduced-motion emulation. At 375px, document and viewport widths
  both measured 375px after correcting the import-switch overflow.
- Follow-up `pnpm browser:ui` verification used a server-side synthetic Codex
  discovery containing one 120-byte fixture. The approval button remained
  disabled before consent, enabled after consent, and transitioned to the
  approved waiting state. Keyboard navigation produced a visible 3px focus
  ring. At 375x812, viewport, document, and body widths all measured 375px;
  the menu opened, trapped focus, closed on Escape, and returned focus to its
  trigger. Reduced-motion emulation reduced the sidebar transition to 1ms, and
  the page reported no browser errors.
- Browser accessibility scan after approval — 0 violations and one incomplete
  automated contrast result for the menu glyph because its button background
  is transparent. Manual computed-style checks measured the glyph against its
  header at 18.11:1 and the active menu link at 8.84:1, both above WCAG AA.

The repository-scoped browser daemon's screenshot command stalled on repeated
attempts and produced no PNG before the bounded retries were stopped. The
failure reproduced after terminating the validated project daemon and its
Chrome child, rerunning `pnpm browser:ui prepare`, and reopening the isolated
page. The recorder started, but its stop RPC stalled identically and produced no
WebM. Screenshot or recording RPCs also blocked later semantic commands until
the daemon was reset. No raw browser CLI, Playwright CLI, or stable-channel
browser was used as a substitute; the semantic snapshots and measured browser
checks above are the retained evidence from the approved browser workflow.

The follow-up initially invoked CLI discovery with only `CODEX_HOME` redirected
to the synthetic fixture. Claude Code and Cowork still inventoried their real
default paths, reading path/stat metadata only. That session was canceled before
approval, so no transcript body was read, archived, or imported. The successful
interaction pass then used only the server-side synthetic discovery described
above.

The disposable issue-scoped PostgreSQL and Redis volumes were removed once to
prove a clean migration, recreated for verification, and their containers were
stopped afterward. No stable-channel services, data, or credentials were
changed.

## Review

Requirements, code quality, test robustness, and security review status: pass.
All persistence queries are parameterized and tenant-scoped, Zod validates
runtime contracts, archive paths and hashes are verified, lifecycle transitions
fail closed, and safe errors contain no transcript bodies or secrets.
