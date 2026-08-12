# Answer Engine OSS Vision

## Product goal

Deliver a complete, local-first, single-user memory product for AI work. A clean
installer-managed setup must ingest real Claude Code, Codex, Cowork, and local
document history; preserve raw evidence and lineage; and make that memory useful
through the web application, REST API, CLI, and MCP without requiring login or
manual API-key entry.

## Users

- Individual developers and knowledge workers who want durable local AI memory.
- Open-source contributors building retrieval, ingestion, evaluation, and UI workflows.
- Enterprise integrators who compose paid multi-user policy onto the same public core.

## Product boundary

All non-paid product UI and APIs belong in OSS. Only roles, RBAC, teams,
billing, and permissions remain private enterprise capabilities. OSS exposes
neutral extension contracts for those capabilities but never duplicates or
degrades the single-user product to protect the private layer.

## Constraints and non-goals

- Local/no-op behavior is the default; remote model providers are explicit opt-ins.
- No Auth0, paid billing implementation, customer identifiers, or private deployment code.
- Preserve `tenant_id` scoping, parameterized SQL, runtime validation, and raw source metadata.
- Never publish packages or push directly to `master`; all changes use issues and PRs.
- Graphify and generated graph artifacts are outside this epic.

## Success measures

- Clean setup opens the full application without login or a manually entered API key.
- Content, import, tags, libraries, answers, recipes, artifacts, reports, dashboards,
  batch, settings, tokens, and local audit workflows work on desktop and mobile.
- REST and MCP query, ask, and lineage work over preserved real histories.
- Every processed Alpha Loop issue has a merged PR, checked epic item, passing
  verification, and a tracked per-issue learning file.

## Near-term milestones

1. Establish safe project-owned Alpha Loop orchestration and the corrected OSS boundary.
2. Complete the neutral data model, APIs, full shared application, and advanced workflows.
3. Add enterprise composition contracts and prove the private application consumes OSS.
4. Run clean-install, real-history, desktop/mobile, API/MCP, archive-integrity, and
   background-sync acceptance before closing epic #6.
