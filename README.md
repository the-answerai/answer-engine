# Answer Engine

Answer Engine is an open-source, local-first memory engine for AI agents. It
stores conversations and documents in PostgreSQL + pgvector, exposes a small
authenticated REST API, and connects to agent clients through MCP.

The OSS repository contains the complete single-user product, including every
non-paid application UI and API. Only roles, RBAC, teams, billing, and
permissions live in the private enterprise layer, which composes this package
through the exported `createApp()` extension API.

The machine-checked inventory lives in
[`product-boundary.json`](./product-boundary.json). See
[`docs/enterprise-composition.md`](./docs/enterprise-composition.md) for the
typed server/web entry points and the required exact-commit pin and update
workflow. Enterprise consumers compose additions through those contracts and
never copy or replace core pages.

## What is included

- Local ingestion for Claude Code, Codex, Cowork, and document directories
- Full-text, semantic, and hybrid recall
- Grounded answers with citations
- Source metadata, raw archive references, and artifact supersession lineage
- A stdio/HTTP MCP server, CLI, installer, REST API, and local web interface
- Loopback-only Docker Compose defaults
- Optional LM Studio, OpenAI-compatible, Anthropic, or injected model providers

## Requirements

- Node.js 22.16 or newer
- pnpm 10 through Corepack
- Docker Engine or Docker Desktop with Compose v2
- LM Studio with a chat and embedding model, or another configured provider

## Run from this checkout

```bash
corepack enable
corepack prepare pnpm@10 --activate
pnpm install --frozen-lockfile
cp .env.compose.example .env.compose
```

Set the exact chat model, embedding model, and embedding width in
`.env.compose`, then build and start the local stack:

```bash
docker build --tag answer-engine-oss:local .
ANSWER_ENGINE_IMAGE=answer-engine-oss:local docker compose up -d
curl --retry 20 --retry-delay 2 --retry-all-errors --fail http://127.0.0.1:5050/health
docker compose logs --no-log-prefix init
```

The initializer displays one `ae_live_...` API key on its first run for CLI,
MCP, and direct API clients. Store it locally; only its hash is retained in
PostgreSQL. The bundled loopback web interface authenticates automatically and
never exposes this key to browser JavaScript or storage.

The Docker image serves the web interface at <http://127.0.0.1:5050>. To run
the interface through Vite while changing its source, start it in a second
terminal:

```bash
pnpm --filter @answer-engine/web-ui dev
```

Open <http://127.0.0.1:3200> for the Vite version. Its proxy uses the same
automatic local browser session, so no key entry is required. The API and
database ports are bound to loopback by default.

To stop the stack without deleting memory:

```bash
docker compose down
```

## Install from npm

### One-prompt guided install

<!-- INSTALL_PROMPT:START -->
```text
Install Answer Engine stable 1.1.0 on this computer. Follow only the immutable
v1.1.0 instructions at:
https://raw.githubusercontent.com/the-answerai/answer-engine/v1.1.0/INSTALL_AGENT.md

First explain that preflight is read-only and ask permission to run it. Then run:
npx @answer-engine/create@1.1.0 preflight --json --channel stable

Translate every pass, warning, or unsupported result into plain language. Never
install Docker, WSL2, LM Studio, drivers, or another privileged prerequisite
without asking me. Recommend full-local only for supported hardware,
reduced-local for constrained Apple Silicon, or cloud-backed only after explicit
opt-in. Ask me in one short interview for the install folder, model route, every
agent client surface I use, and whether Cowork sessions are local or remote.
Never ask me to paste a secret into chat.

Before executing the installer, verify the bundled release manifest, immutable
version/tag, and SHA-256 checksums. Show the exact runtime, plugin, skill, MCP,
CLI, ledger, and backup paths plus every unsupported client limitation, then ask
for one confirmation. Cancel without changing files if I decline. Use the stable
channel, preserve existing data and unrelated client configuration, and retry
safely if setup is partial. Do not ask me to create or copy a local Answer Engine
API key; the installer must capture and store it automatically.

Finish only when health, the local UI, the direct memory round trip, and a real
Answer Engine recall in every selected supported client pass. Explain that
ChatGPT web/Work and remote Cowork cannot connect directly to localhost; do not
claim or create a remote relay. Report no-op, repair, removal, and rollback paths
clearly. History import, folder ingestion, organization mutation, and the
cross-chat tutorial remain separate consented handoffs.
```
<!-- INSTALL_PROMPT:END -->

The release installer will be published as `@answer-engine/create` after the
local release candidate is verified:

```bash
npx @answer-engine/create@1.1.0
```

For an agent-led installation, use [INSTALL_AGENT.md](./INSTALL_AGENT.md). The
installer is idempotent and keeps its editable configuration under `AE_HOME`
(default `~/.answer-engine`). It records completion only after managed client
integration and real recall verification pass, allowing interrupted healthy installs to
resume instead of being reported as complete.

Installer and CLI operations accept explicit `stable` and `staging` channels.
See [client integrations](docs/client-integrations.md) for the maintained
capability matrix, managed paths, verification rules, and reversible removal.
Their homes, credentials, ports, Compose projects, volumes, logs, archives, and
sync services are isolated; staging history sync is disabled by default. See
[Local runtime channels](./docs/local-runtime-channels.md) for lifecycle
commands and the non-destructive existing-install migration.

Background history sync stores immutable, content-addressed source evidence
under `AE_HOME/raw-archive`. It reuses identical bundles and fails closed before
crossing its default 256 MiB per-bundle limit, 10 GiB total limit, or 10 GiB
free-space reserve. The byte ceilings can be overridden with
`AE_RAW_ARCHIVE_MAX_BUNDLE_BYTES`, `AE_RAW_ARCHIVE_MAX_TOTAL_BYTES`, and
`AE_RAW_ARCHIVE_MIN_FREE_BYTES`. Cowork only archives supported text artifacts
explicitly listed in session metadata; it does not recursively copy a workspace.
Use `ae sync archive plan` for a tenant-aware, non-destructive retention preview.
Pruning requires a stopped sync service and the exact confirmation token emitted
by an unchanged plan.

The **Organize** workspace and `ae organize` commands produce an evidence-backed
preview before changing tags, assignments, or libraries. The default analyzer
is deterministic and local. Model-assisted proposals are explicit opt-ins and
send at most 50 IDs, titles, 500-character summaries, source/type fields, and
existing tag names—never full content or raw archives. Every suggestion needs
an accept or reject decision; apply refuses a stale snapshot and records an
audit trail. Undo removes only organization state introduced by that plan and
never deletes imported content. An undone plan can be reviewed and applied
again without duplicating tags, libraries, or memberships.

## API

CLI, MCP, and direct requests to `/api/v1/*` require the local key in either
header:

```text
X-API-Key: ae_live_...
Authorization: Bearer ae_live_...
```

Core routes:

| Route | Purpose |
|---|---|
| `GET /health` | Local health check |
| `POST /api/v1/content/import` | Import or update content idempotently |
| `GET/POST /api/v1/first-imports` | Register and inspect consent-first agent-history imports |
| `POST /api/v1/first-imports/:id/approve` | Approve any subset of discovered sources before content is read |
| `GET/POST /api/v1/folder-sources` | Preview and inspect explicitly selected local folders |
| `POST /api/v1/folder-sources/runs/:id/approve` | Approve one exact bounded folder inventory before full-file reads |
| `GET/POST /api/v1/organization-plans` | List or create non-mutating evidence-backed organization proposals |
| `POST /api/v1/organization-plans/:id/apply` | Apply a complete set of individual accept/reject decisions |
| `POST /api/v1/organization-plans/:id/undo` | Restore organization state introduced by one applied plan |
| `GET /api/v1/content` | Browse, filter, sort, and cursor-paginate stored content |
| `GET /api/v1/content/:id/lineage` | Inspect origin and artifact history |
| `POST /api/v1/agent/query` | Full-text, semantic, or hybrid search |
| `POST /api/v1/agent/retrieve` | Retrieve known IDs or a conversation |
| `POST /api/v1/agent/summarize` | Summarize selected local evidence |
| `POST /api/v1/agent/ask` | Generate a grounded answer with citations |
| `GET/POST /api/v1/tags` | Manage the local tag taxonomy |
| `GET/POST /api/v1/libraries` | Manage saved libraries and effective membership |
| `GET /api/v1/libraries/:id/members` | Page `(filter OR include) AND NOT exclude` members |
| `GET/POST /api/v1/libraries/:id/recipes` | Manage versioned recipes and durable runs |
| `GET /api/v1/content/:id/artifacts` | Inspect recipe artifacts, versions, and lineage |
| `GET/POST /api/v1/libraries/:id/reports` | Manage grounded library reports |
| `GET/POST /api/v1/libraries/:id/dashboards` | Manage library dashboards |
| `GET/POST /api/v1/batch-jobs` | Manage provider-neutral local batch work |
| `GET/POST /api/v1/access-tokens` | Manage tenant- or library-scoped `ae_live_` tokens |
| `GET /api/v1/audit` | Page local tenant or library audit history |
| `GET/PATCH /api/v1/settings` | Manage safe local workspace preferences without exposing provider credentials |
| `GET/POST /api/v1/content/:id/blobs` | List or store local content blobs |

The all-content system library is provisioned automatically. User-defined
libraries are saved filters with manual include/exclude overrides; excludes win
conflicts. Library-scoped tokens apply that same membership predicate to direct
content reads, search, grounded answers, artifacts, and blobs. Raw token values
are returned once when created and are stored only as SHA-256 hashes. Token
capabilities are independent: `read` permits retrieval, while `write` permits
mutations without implicitly granting read access.

Recipe, report, and batch work is claimed transactionally by the local
PostgreSQL worker. The worker uses the configured language-provider facade and
persists observable progress and per-item results without a hosted queue.
Batch retries skip records that already succeeded. The protected installer
credential cannot be edited or revoked through the token API, preventing local
browser lockout. Workspace defaults drive content page size/library scope,
density, and batch export format in the web application.
`LOCAL_WORKER_POLL_MS` controls its polling interval (default `1000`, minimum
`250`); blob bytes remain under `AE_HOME/blobs`.

See [openapi/answer-engine.yaml](./openapi/answer-engine.yaml) for the exact
contract.

## Packages

| Package | Purpose |
|---|---|
| `@answer-engine/server` | Core API, `createApp()`, and stable `./composition` contracts |
| `@answer-engine/cli` | Configuration, import, sync, and verification commands |
| `@answer-engine/mcp-server` | MCP tools backed by the local API |
| `@answer-engine/create` | Local installer and client wiring |
| `@answer-engine/web-ui` | Standalone local interface plus non-published composition library |

## First agent-history import

After installer wiring succeeds, run `ae sync first-import` in the stable
channel, open `/import`, review the discovered Claude Code, Codex, and Cowork
paths/counts/sizes/exclusions, and approve any subset. The command waits for
approval, preserves unrelated `config.yaml` source settings, verifies each
complete history bundle still matches the approved metadata fingerprint,
imports one source-backed history at a time, and reconciles imported,
duplicate, failed, and skipped outcomes. Resume an interruption with
`ae sync first-import --resume <session-id>`. See
[First agent-history import](./docs/first-agent-history-import.md).

## Local-folder ingestion

Run `ae folders add <exact-folder-path>`, then open `/import` and select
**Local folder**. Review the root, patterns, limits, types, exclusions, symlink
reports, and estimated work before approval. Apply-time restats prevent changed
or new files from being read under stale consent; approved snapshots retain
SHA-256 lineage. Use `ae folders resume --source <id>`, `ae folders refresh
--source <id>`, or `ae folders remove <id> --retention keep|delete`. Direct
`local_dir` sync is fail-closed. See [Permissioned local-folder ingestion](./docs/local-folder-ingestion.md).

## Development

```bash
pnpm verify
```

The final real-history acceptance check is read-only. For an installer-managed
stack with its background service running, record the UTC start of a complete
three-source cycle, then run:

```bash
pnpm acceptance:real-history \
  --installer-home "$AE_HOME" \
  --sync-log "$AE_HOME/logs/sync.out.log" \
  --sync-after 2026-08-13T07:28:00.000Z
```

For a manually managed database, capture one JSON result from
`ae sync once --source <source>` for each source and pass each file with a
repeated `--sync-summary` option instead.

The verifier requires at least the acceptance baseline (848 Claude Code, 4105
Codex, and 112 Cowork files), cursor coverage of the latest append-only scans,
zero sync/import failures, tenant-scoped stored summaries and manifests, and
matching SHA-256 values for a deterministic archive sample.

The complete clean-install, browser, API/MCP, model, background-service, and
enterprise-composition execution record for the final product-parity run is in
[`docs/acceptance/issue-12.md`](./docs/acceptance/issue-12.md).

The immutable fresh database baseline lives in
[`database/migrations/001_local_core.sql`](./database/migrations/001_local_core.sql),
with the neutral application foundation in the paired `002` up/down migrations
and the reusable first-import lifecycle in the paired `003` migrations.
Use `pnpm db:migrate` to apply pending migrations and `pnpm db:rollback` to roll
back the latest migration.
Set `EMBEDDING_DIMENSION` before the first migration. Changing it later requires
a fresh vector schema and re-embedding stored content.

## License

The core server is licensed under Apache-2.0. Package-specific manifests and
license files identify any package-level license differences.
