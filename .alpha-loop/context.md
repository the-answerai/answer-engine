# Answer Engine OSS Project Context

## Architecture

The repository is a pnpm TypeScript workspace. The root Express server exports
the composable application, PostgreSQL/pgvector owns durable state, and Redis
supports background work. `packages/cli` owns the CLI entry point, installation,
configuration, history discovery/import, and sync; `packages/mcp-server` exposes
agent tools; `packages/create` owns installer-managed setup; and
`packages/web-ui` is the complete single-user React application. Database
changes are tracked in `database/migrations`.

## Conventions

Use strict TypeScript and Zod at runtime boundaries. Scope persistence by
`tenant_id`, parameterize SQL, preserve unknown source metadata, and use
structured logging. Every change starts from a GitHub issue, uses the branch and
commit forms in `AGENTS.md`, targets `master` through a PR, and is verified with
`pnpm verify`. UI work additionally requires the pinned `pnpm browser:ui`
workflow at desktop and 375px.

## Critical Rules

The complete non-paid single-user application belongs in OSS. Only roles,
RBAC, teams, billing, and permissions are private. Do not push `master`, publish
npm packages, expose secrets, weaken local/no-login defaults, or create a second
Alpha Loop runner. Stop on a wrong/skipped issue, auth or service failure,
conflict, missing dependency, repeated verification failure, or missing learning
file. Do not load, invoke, update, generate, or depend on Graphify skills or
artifacts.

## Active State

Epic #6 children #7 through #11 are merged. Enterprise #964 is merged and
composes the reviewed OSS core through the five private capability families.
Issue #12 is the final ready and unchecked ordered child; its acceptance run
must prove the clean installer, real-history integrity and retrieval, background
sync/local models, all product workflows, desktop/mobile UI, both repository
verifiers, and the epic verify-only gate.
