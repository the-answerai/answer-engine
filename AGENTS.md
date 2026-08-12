# AGENTS.md

Operational guide for coding agents working in the open-source Answer Engine.

## Scope

This repository contains the complete single-user Answer Engine product: the
local-first memory engine, retrieval and context APIs, evaluation tools, sync
clients, MCP server, installer, and every non-paid application workflow and UI.
Preserve `tenant_id` scoping throughout persistence and queries so the public
core remains safe to compose without hiding useful single-user features.

Only five paid capability families belong exclusively in the separate
`answer-engine-enterprise` repository: roles, RBAC, teams, billing, and
permissions. Neutral extension interfaces belong here when the private
application needs to inject those capabilities. Local administration,
operations, audit, deployment, workspace, and all other non-paid product
surfaces remain OSS.

## GitHub workflow

Every change must have a GitHub issue.

1. Inspect the current tree and search for related issues.
2. Comment on the issue with the implementation and verification plan.
3. Work on a branch named `feat/GH-<number>-description`,
   `fix/GH-<number>-description`, or `chore/GH-<number>-description`.
4. Commit as `<type>: <description> (#<number>)`.
5. Open a pull request to `master`; never push directly to `master`.
6. Close the issue only after automated and manual verification pass.

## Verification

Run the checks relevant to the change and report the exact results:

```bash
pnpm install --frozen-lockfile
pnpm type-check
pnpm lint
pnpm test
pnpm build
```

Any UI change must also be verified in a browser at desktop and 375px mobile
width. Exercise the changed interaction, capture a screenshot, and check focus
and reduced-motion behavior.

## Engineering rules

- Explore existing code before editing and prefer established utilities.
- Keep changes simple, typed, and narrowly scoped. Do not use `any`.
- Validate runtime input with Zod.
- Use parameterized SQL and scope every persistence operation by `tenant_id`.
- Use structured logging; do not use `console.log` in application code.
- Do not log, commit, or expose API keys or other secrets.
- Use local/no-op defaults. Remote model providers are explicit opt-ins.
- Preserve unknown history records and source metadata rather than silently
  dropping them.
- Do not add source-specific values to the `content_type` vocabulary; record
  transcript origin in source metadata.
- Do not publish benchmark claims without a reproducible public scorecard.
- Do not freeze clocks in tests whose production validation reads wall time.
- Never use fixed sleeps in browser tests; wait for an observable condition.

## Local ports

- API: `http://127.0.0.1:5050`
- Web UI: `http://127.0.0.1:3200`
- PostgreSQL: `127.0.0.1:5433`
- Redis: `127.0.0.1:6380`

Use Docker Compose for PostgreSQL/pgvector and Redis. Database schema changes
must go through tracked migrations and be verified against a clean database.
