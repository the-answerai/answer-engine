<!-- managed by alpha-loop -->
# Answer Engine OSS Agent Instructions

## Overview

Build the complete local-first, single-user Answer Engine product: memory,
retrieval and context APIs, evaluation tools, sync clients, MCP server,
installer, and all non-paid application workflows and UI. All non-paid UI and
APIs belong here. Only roles, RBAC, teams, billing, and permissions belong
exclusively in the enterprise repository. Keep neutral extension interfaces in
OSS when enterprise capabilities need integration points.

## Tech Stack

Use pnpm, Node.js 22, strict TypeScript, Express, React,
PostgreSQL/pgvector, Redis, Zod, Winston, and Vitest. Remote model providers
must remain explicit opt-ins with local or no-op defaults.
Use the pinned `pnpm browser:ui` command for live UI verification after Alpha
Loop's `pnpm browser:prepare` host preflight. Do not substitute
`playwright-cli`; Playwright is only the automated E2E test framework.

## Directory Structure

- `src/` — composable server, memory, retrieval, context, evaluation, and public application APIs.
- `database/migrations/` — tracked PostgreSQL and pgvector schema ownership.
- `packages/cli/` — configuration, installation wiring, history import, and sync.
- `packages/mcp-server/` — MCP tools and resources.
- `packages/create/` — clean installer-managed setup.
- `packages/create/src/runtime-channel.ts` — stable/staging resource contract and collision validation.
- `packages/web-ui/` — complete single-user web application.
- `.alpha-loop/templates/` — canonical harness skills, agents, and instructions.
- `.alpha-loop/learnings/` — retained learnings for processed issues.

## Code Style

Prefer small, strictly typed changes and established utilities. Do not use
`any`. Validate runtime input with Zod. Use parameterized SQL and scope every
persistence operation and query by `tenant_id`. Preserve unknown history records
and source metadata instead of silently dropping them. Record transcript origin
in source metadata; do not add source-specific values to `content_type`. Use
structured Winston logging rather than `console.log`.

## Non-Negotiables

Follow `AGENTS.md`. Preserve `tenant_id` scoping throughout persistence and
queries. Keep roles, RBAC, teams, billing, and permissions out of OSS while
retaining neutral extension points needed by enterprise integrations. Never
publish npm, push directly to `master`, expose or log secrets, run duplicate
Alpha Loops, or omit a processed issue's `.alpha-loop/learnings/issue-*.md`.
Track every change in a GitHub issue, post the plan before coding, use the
required issue branch and commit formats, and merge only through a PR. Run
`pnpm verify`; visually verify every UI change at desktop and 375px with the
synced `agent-browser` skill and shared sandbox-writable browser runtime, then
close the browser session.
Do not publish benchmark claims without a reproducible public scorecard. Do not
freeze clocks when production validation reads wall time.
Do not load, invoke, use, update, or generate Graphify, its skills, or its artifacts; it is outside epic #6.
