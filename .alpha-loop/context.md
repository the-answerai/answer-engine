# Answer Engine OSS Project Context

## Architecture

- The root strict-TypeScript Express server owns composable memory, retrieval, context, evaluation, and public application APIs; PostgreSQL/pgvector owns durable state and Redis supports background work.
- `database/migrations/` owns tracked schema changes. Local services default to API `5050`, web `3200`, PostgreSQL `5433`, and Redis `6380`, with Docker Compose managing database services.
- `packages/cli` owns the CLI entry point, configuration, history discovery/import, sync, and agent wiring; `packages/mcp-server/` exposes MCP tools; `packages/create/` owns installer setup; `packages/web-ui/` is the React application.
- The OSS core contains every non-paid single-user capability and neutral enterprise extension interface. Roles, RBAC, teams, billing, and permissions belong only in `answer-engine-enterprise`.

## Conventions

- Prefer established utilities and narrow, strictly typed changes. Do not use `any`; validate runtime input with Zod and use structured logging instead of `console.log`.
- Parameterize SQL, scope every persistence operation by `tenant_id`, preserve unknown history/source metadata, and record transcript origin in metadata rather than `content_type`.
- Use pnpm. The complete repository gate is `pnpm verify`; UI changes additionally require the pinned `pnpm browser:ui` flow at desktop and 375px after `pnpm browser:prepare`.
- Keep local/no-op defaults. Remote model providers and history sync are explicit opt-ins, and staging worktrees must use isolated homes, projects, ports, credentials, logs, and archives.

## Critical Rules

- Follow `AGENTS.md`: every change has an issue and plan comment, uses the prescribed branch/commit form, and reaches `master` only through a pull request.
- Never expose secrets, publish npm, run duplicate Alpha Loops, omit a processed issue learning file, or allow staging automation to touch stable memory or services.
- Database changes require tracked migrations and clean-database verification. Do not freeze clocks around wall-time validation or use fixed sleeps in browser tests.
- Do not load, invoke, update, generate, or depend on Graphify skills or artifacts.

## Active State

- Epic #40 is the active ordered Alpha Loop run. Its nine ready children are processed serially as #41 through #49 with batch size 1.
- PR #52 added a fail-closed worktree bootstrap so the run receives isolated staging resources before any worker command executes.
