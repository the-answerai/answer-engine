# Independent skill eval runs

Executed 2026-08-14 by three fresh read-only agents: one with the packaged
skills, one without Answer Engine skills, and one activation selector/grader.
Memory workflows used the checksum-covered synthetic fixtures; the install
workflow stopped at the consent boundary and made no global changes.

## Activation decisions

1. `install-answer-engine` — requests Answer Engine installation and client connections.
2. `use-answer-engine` — requests recall of a prior decision and its source.
3. `organize-answer-engine` — requests a non-destructive memory organization preview.
4. `none` — Docker Desktop installation is not Answer Engine setup.
5. `none` — repository search is not personal-memory recall.
6. `none` — TypeScript import organization is not memory organization.

## With skill: install-answer-engine

I have not installed anything or changed global configuration. First I would ask permission to run the read-only, version-pinned preflight: `npx @answer-engine/create@1.1.0 preflight --json --channel stable`. I would translate its results, detect applicable client surfaces, and treat Codex separately from hosted ChatGPT Chat/Work. For detected supported clients, I would present one plan covering Codex, ChatGPT Desktop Codex, Claude Code, Claude Desktop, and any detected Cursor-style adapter. The exact managed locations shown before consent would include `~/.answer-engine`, `~/.agents/plugins/marketplace.json`, `~/.agents/plugins/plugins/answer-engine`, `~/.codex/config.toml` and the Codex-managed plugin cache, `~/.answer-engine/client-plugins/claude-marketplace`, `~/.claude/plugins/known_marketplaces.json`, `~/.claude/plugins/installed_plugins.json` and Claude-managed plugin caches, `~/Library/Application Support/Claude/claude_desktop_config.json`, `~/.cursor/mcp.json` when applicable, `~/.config/answer-engine/config.yml`, `~/.answer-engine/integrations/ledger.json`, and private backups under `~/.answer-engine/integrations/backups`. I would explain that ChatGPT Desktop Codex can use the shared Personal plugin and local stdio MCP, while hosted ChatGPT Chat/Work/web cannot directly reach localhost; Cowork local is not installer-verifiable and Cowork remote requires a separately operated remote service. No public relay or policy bypass is offered. After showing detected clients, paths, backups, and limitations, I would ask exactly: “Proceed with the stable Answer Engine installation and configure all of these detected supported clients?” Only after an explicit yes would I run the stable installer with `--clients` containing those selected client IDs. I would never request or print the API key. Completion would require the direct remember/recall/lineage round trip, automated real recall verification in Codex and Claude Code, and restart plus guided recall confirmation for ChatGPT Desktop Codex, Claude Desktop, and any GUI-only adapter. History import and folder ingestion would remain separate consented handoffs.

## With skill: use-answer-engine

Tool workflow:
1. `recall({"query":"onboarding launch scope"})`
   → Found content `11111111-1111-4111-8111-111111111111` with score 0.97: “For the onboarding launch, ship the installer and supported client wiring first. Keep history import in issue #44 and the cross-chat tutorial in issue #47.”
2. Because provenance matters, `inspect_memory({"contentId":"11111111-1111-4111-8111-111111111111"})`
   → Source: `claude-code`; external source ID: `claude-code:project-answer-engine:conversation-43`; source metadata: project `answer-engine`, session `conversation-43`; no additional lineage records or current artifacts were attached.

The stored decision was to launch the installer and supported client wiring first, while leaving history import to issue #44 and the cross-chat tutorial to issue #47. This is a direct statement from the recalled Claude Code conversation, not my inference. Its provenance is the Answer Engine project’s `conversation-43` session.

## With skill: organize-answer-engine

Tool workflow: `recall({"query":"duplicated project memories"})` returned three Project Atlas records. No mutation tool was called.

Preview only:

1. Proposed group: `Project Atlas / Launch`
   Proposed tags: `project:atlas`, `phase:launch`, `type:checklist`
   Affected IDs: `22222222-2222-4222-8222-222222222222` and `33333333-3333-4333-8333-333333333333`
   Reason: both contain the exact same launch checklist text. They are suspected duplicates, but they have independent origins—`claude-code:atlas:session-1` and `codex:atlas:rollout-9`—so their source metadata must be preserved and neither should be deleted or merged merely because the text matches.

2. Proposed group: `Project Atlas / Post-launch support`
   Proposed tags: `project:atlas`, `phase:post-launch`, `type:support-checklist`
   Affected ID: `44444444-4444-4444-8444-444444444444`
   Reason: this record concerns post-launch support and a rollback owner. It is related to the launch records but is not a duplicate. Preserve its `local_dir` source and `file:atlas/support.md` origin.

Before any approved handoff, I would inspect all three content IDs with `inspect_memory` to confirm their full lineage; the supplied recall result exposes their origins but no separate inspection results. Nothing has been changed. Please approve or revise this exact grouping and tag proposal. Even after approval, the current skill would hand the preview to the separate reversible organization workflow rather than claiming that changes were applied.

## Baseline: install-answer-engine

I haven’t run anything or changed this Mac.

First consent question: “May I run the read-only preflight `npx @answer-engine/create@1.1.0 preflight --json --channel stable`? It will check Node.js, Docker Compose, hardware/model suitability, required ports, and any existing managed installation. It will not install prerequisites or alter configuration.”

If approved, I would explain every pass, warning, and unsupported result, then ask one short interview covering the install folder (default `~/.answer-engine`), local versus explicitly opted-in cloud models, the client surfaces to connect, and whether any Claude Cowork sessions are local or remote.

The proposed supported local-client selection is Codex, ChatGPT Desktop Codex, Claude Code, Claude Desktop, and Cursor’s JSON MCP adapter where installed. ChatGPT Desktop shares the Personal Codex plugin and needs an install/restart plus guided recall check. Claude Desktop needs its MCP configuration merged, a restart, and a guided recall check. Hosted ChatGPT web/Work cannot reach localhost, remote Cowork cannot reach localhost, and local Cowork is account/policy managed and cannot be installed or verified by this installer; I would report those limitations rather than create a false connection.

Before installation I would verify the immutable v1.1.0 tag, bundled release manifest, and SHA-256 checksums, then show the complete write plan. With the default folder, expected managed locations include `~/.answer-engine`, `~/.agents/plugins/marketplace.json`, `~/.agents/plugins/plugins/answer-engine` (including its skills and MCP configuration), `~/.codex/config.toml` and host-managed cache, `~/.answer-engine/client-plugins/claude-marketplace`, `~/.claude/plugins/known_marketplaces.json`, `~/.claude/plugins/installed_plugins.json` and host-managed cache, `~/Library/Application Support/Claude/claude_desktop_config.json`, `~/.cursor/mcp.json`, `~/.config/answer-engine/config.yml`, `~/.answer-engine/integrations/ledger.json`, and `~/.answer-engine/integrations/backups`. Existing data and unrelated client settings would be preserved, and no API key would be requested in chat.

I would then ask one final confirmation before running the interactive stable installer with `--clients codex,chatgpt-desktop,claude-code,claude-desktop,cursor`. If confirmed, completion would require runtime health, the local UI, remember → recall → inspect-memory lineage, automated real recalls in Codex and Claude Code, and guided real recalls in the selected desktop clients. If declined, nothing would be changed.

## Baseline: use-answer-engine

The onboarding launch decision was: “For the onboarding launch, ship the installer and supported client wiring first. Keep history import in issue #44 and the cross-chat tutorial in issue #47.” I found one matching memory with score 0.97 and inspected its provenance. It came from Claude Code, specifically the `answer-engine` project session `conversation-43` (`claude-code:project-answer-engine:conversation-43`). Memory ID: `11111111-1111-4111-8111-111111111111`. The inspection returned no lineage records or current artifacts, so I can identify the originating conversation but cannot honestly attribute it to a derived document or later artifact.

## Baseline: organize-answer-engine

Preview only—no memories were changed, merged, moved, or deleted.

Safer proposed organization:

- `Project Atlas / Launch checklist` — an exact-duplicate cluster containing memories `22222222-2222-4222-8222-222222222222` and `33333333-3333-4333-8333-333333333333`. Both say “Project Atlas launch checklist: installer, client wiring, verification.” Preserve both originals and their distinct provenance: Claude Code session `claude-code:atlas:session-1` and Codex session `codex:atlas:rollout-9`. Link them as duplicates rather than deleting either one; the available results provide no timestamps or authority signal for safely choosing a canonical source.
- `Project Atlas / Post-launch support` — keep memory `44444444-4444-4444-8444-444444444444` as a separate related item. It covers support and rollback ownership, so it is not a duplicate of the launch checklist. Preserve its file provenance: `file:atlas/support.md`.

If approved later, I would apply only reversible grouping/duplicate links and retain every source record and external ID.
