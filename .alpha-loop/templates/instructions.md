<!-- managed by alpha-loop -->
# Answer Engine OSS Agent Instructions

## Overview

Build and verify the complete local-first, single-user Answer Engine product.
All non-paid UI and APIs belong here. Only roles, RBAC, teams, billing, and
permissions belong exclusively in the enterprise layer.

## Tech Stack

Use pnpm, Node.js 22, strict TypeScript, Express, React, PostgreSQL/pgvector,
Redis, Vitest, and Playwright/agent-browser where the existing package requires it.

## Directory Structure

- `src/` — composable server and public application APIs.
- `database/migrations/` — tracked schema ownership.
- `packages/cli/` — config, install wiring, history import, and sync.
- `packages/mcp-server/` — MCP tools and resources.
- `packages/create/` — clean installer-managed setup.
- `packages/web-ui/` — complete single-user web application.
- `.alpha-loop/templates/` — canonical harness skills, agents, and instructions.

## Code Style

Prefer small typed changes and existing utilities. Validate runtime input with
Zod, parameterize SQL, scope data by `tenant_id`, preserve source metadata, use
Winston rather than `console.log`, and avoid fixed sleeps in tests.

## Non-Negotiables

Follow `AGENTS.md`. Track every change in an issue, post the plan before coding,
use the required issue branch and commit formats, and merge only through a PR to
`master`. Never publish npm, push `master`, expose secrets, run duplicate loops,
or omit a processed issue's `.alpha-loop/learnings/issue-*.md`. Run `pnpm verify`;
visually verify every UI change at desktop and 375px.
Do not load, invoke, use, update, or generate Graphify, its skills, or its artifacts; it is outside epic #6.
