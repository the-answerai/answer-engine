# Answer Engine

Answer Engine is an open-source, local-first memory engine for AI agents. It
stores conversations and documents in PostgreSQL + pgvector, exposes a small
authenticated REST API, and connects to agent clients through MCP.

The OSS repository contains the single-user memory core only. Account
management, organization features, commercial metering, and managed deployment operations
live in a separate private enterprise layer that composes this package through
the exported `createApp()` extension API.

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

The release installer will be published as `@answer-engine/create` after the
local release candidate is verified:

```bash
npx @answer-engine/create@1.1.0
```

For an agent-led installation, use [INSTALL_AGENT.md](./INSTALL_AGENT.md). The
installer is idempotent and keeps its editable configuration under `AE_HOME`
(default `~/.answer-engine`).

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
| `GET /api/v1/content` | Browse stored content |
| `GET /api/v1/content/:id/lineage` | Inspect origin and artifact history |
| `POST /api/v1/agent/query` | Full-text, semantic, or hybrid search |
| `POST /api/v1/agent/retrieve` | Retrieve known IDs or a conversation |
| `POST /api/v1/agent/summarize` | Summarize selected local evidence |
| `POST /api/v1/agent/ask` | Generate a grounded answer with citations |

See [openapi/answer-engine.yaml](./openapi/answer-engine.yaml) for the exact
contract.

## Packages

| Package | Purpose |
|---|---|
| `@answer-engine/server` | Core API and `createApp()` composition surface |
| `@answer-engine/cli` | Configuration, import, sync, and verification commands |
| `@answer-engine/mcp-server` | MCP tools backed by the local API |
| `@answer-engine/create` | Local installer and client wiring |
| `@answer-engine/web-ui` | Local Blueprint memory interface |

## Development

```bash
pnpm verify
```

The fresh database schema lives in
[`database/migrations/001_local_core.sql`](./database/migrations/001_local_core.sql).
Set `EMBEDDING_DIMENSION` before the first migration. Changing it later requires
a fresh vector schema and re-embedding stored content.

## License

The core server is licensed under Apache-2.0. Package-specific manifests and
license files identify any package-level license differences.
