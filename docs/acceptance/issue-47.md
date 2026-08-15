# Issue #47 acceptance record

## Outcome

Answer Engine now provides a persisted first-memory tutorial that generates a
harmless, distinctive lighthouse fact and an opaque marker. The remember prompt
contains the generated fact; the fresh-chat prompt contains only the marker and
explicitly instructs the client to call `recall` and then `inspect_memory`.
Typed answer text is never accepted as proof.

Completion requires ordered, tenant-scoped audit evidence for the exact content
ID: a matching import from the selected client and transport, a later exact
marker query from the selected recall client that returned that ID, and a still
later lineage read for the same ID and client. Managed MCP entries stamp a
validated client identity, CLI requests identify as CLI, and same-origin browser
requests cannot masquerade as a tool client.

## Acceptance criteria

- [x] Completion is based on audited tool calls and source evidence, never an
  answer typed by a model or user.
- [x] The fresh-chat prompt contains the opaque marker but not the fact, answer,
  or answer-bearing context.
- [x] Same-client and client-identifiable cross-client paths are supported.
- [x] Unsupported remote, WSL/desktop-host, and ambiguous shared-plugin
  combinations are rejected before challenge creation with specific guidance.
- [x] Runtime, wiring, access, indexing, and retrieval failures remain distinct
  diagnostic states and never count as completion.
- [x] Persistence and audit queries are parameterized, tenant-scoped, and hidden
  from library-scoped principals.
- [x] Desktop and 375px interaction, responsive width, keyboard focus, reduced
  motion, and accessibility verification passed.
- [x] Migration 006 passed clean apply, rollback, and reapply.
- [x] `pnpm verify` passes.

## Verification evidence

Executed in the isolated issue #47 worktree on 2026-08-15:

- Focused server/repository coverage passed for harmless challenge generation,
  answer-free prompts, client capability parity, unsupported preflight, strict
  request validation, tenant/library isolation, request transport and client
  identification, exact import/query/lineage ordering, wrong-client refusal,
  and diagnostic recovery.
- CLI tests passed, including `tutorial clients`, `start`, `list`, `show`, and
  `check`, encoded IDs, diagnostic reporting, and CLI client headers.
- MCP tests passed, including validated `ANSWER_ENGINE_CLIENT_ID` parsing and
  the audited MCP client header.
- Installer tests passed, including distinct managed client identity injection
  into Codex and Claude Code MCP launchers without exposing the API key.
- Web UI tests passed, including cross-client selection, previewed harmless
  instructions, remembered state, and completion only after the verified state.
- `pnpm verify` passed: public-boundary check, lint, all type checks, all package
  tests, and server/CLI/MCP/installer/web builds.
- Migration 006 passed a clean up → down → up cycle against an isolated
  `pgvector/pgvector:pg16` container with a 512 MB memory-backed data directory.
  The table and migration receipt were checked, and the container was removed.
- `pnpm browser:ui` exercised the production React build against an in-memory,
  API-shaped fixture that served only on `127.0.0.1:3200`. At 1440x900 and
  375x812, Codex → Claude Code selection completed planned → remembered →
  verified, while the fresh prompt remained answer-free. The WSL view removed
  Windows-host desktop clients before start. Both widths had zero horizontal
  overflow and zero axe violations; mobile retained only axe's pre-existing
  incomplete contrast result for the non-text menu glyph. Keyboard Tab produced
  the shared solid 3px focus indicator, reduced-motion emulation reduced
  transition and animation duration to 1ms, and the browser reported no errors.
  Captured requests were all confined to port 3200.

The repository-pinned browser screenshot RPC stalled and wrote no PNG,
reproducing the known issue #44 defect. The call was bounded, only the exact
validated project daemon and its Chrome process tree were replaced, and the
required semantic, viewport, focus, motion, request, and axe evidence was then
completed through `pnpm browser:ui`. The browser closed normally afterward. No
raw browser CLI, Playwright CLI, regular browser profile, stable API, or stable
memory was used as a substitute.

## Safety review

Runtime input and client identities are strictly validated with Zod. Same-origin
browser requests override spoofable tool headers, tool/client combinations must
be compatible, and audit details cannot override the trusted request identity.
The proof checks the generated exact fact, source identifier, content ID,
transport, client, event order, and lineage evidence. All persistence queries
are parameterized and tenant-scoped; library-scoped tokens fail closed.

Browser verification used only an in-memory fixture. Migration verification used
RAM-backed PostgreSQL with no Docker volume. Stable sync remained disabled, the
stable raw archive remained 0 B, and the disk retained 1.1 TiB free.
