# Answer Engine OSS Project Context

## Architecture

The repository is a pnpm TypeScript workspace. The root Express server exports
the composable application, PostgreSQL/pgvector owns durable state, and Redis
supports background work. `packages/cli` handles installation, configuration,
history discovery/import, and sync; `packages/mcp-server` exposes agent tools;
`packages/create` owns installer-managed setup; and `packages/web-ui` is the
single-user React application. Database changes are tracked in `database/migrations`.

## Conventions

Use strict TypeScript and Zod at runtime boundaries. Scope persistence by
`tenant_id`, parameterize SQL, preserve unknown source metadata, and use
structured logging. Every change starts from a GitHub issue, uses the branch and
commit forms in `AGENTS.md`, targets `master` through a PR, and is verified with
`pnpm verify`. UI work additionally requires desktop and 375px browser checks.

## Critical Rules

The complete non-paid single-user application belongs in OSS. Only roles,
RBAC, teams, billing, and permissions are private. Do not push `master`, publish
npm packages, expose secrets, weaken local/no-login defaults, or create a second
Alpha Loop runner. Stop on a wrong/skipped issue, auth or service failure,
conflict, missing dependency, repeated verification failure, or missing learning file.

## Active State

Epic #6 is the ordered delivery plan. Issue #7 manually establishes this runner
posture. After #7 merges and is checked, Alpha Loop must process exactly #8,
#9, #10, and #11 in order with batch size 1. Issue #12 remains gated until OSS
#11 and enterprise #964 merge; it is then appended last for integrated acceptance.
