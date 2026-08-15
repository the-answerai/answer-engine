# Client integrations

The stable installer treats a client surface and its execution mode separately.
This prevents a desktop application from being labeled “local” when a specific
chat or Cowork session actually runs in the provider cloud.

## Capability matrix

| Client surface | Execution | Localhost | Installed package/access | Verification |
| --- | --- | --- | --- | --- |
| Codex | Local | Yes | Dual-host plugin, stdio MCP, CLI | Automated real recall |
| ChatGPT Desktop Codex | Local | Yes | Shared Personal plugin with stdio MCP + CLI config | Install/restart and guided real recall |
| Hosted ChatGPT Chat/Work/web | Remote service | No direct access | Remote MCP only, subject to plan/admin policy | Unavailable for this local install |
| Claude Code | Local | Yes | Dual-host plugin, stdio MCP, CLI | Automated real recall |
| Claude Desktop | Local | Yes | JSON stdio MCP, CLI | Restart and guided real recall |
| Cowork local session | Local session, account-managed extensions | Not installer-verifiable | Account-synced skills and policy-approved connectors | Unavailable for installer verification |
| Cowork remote session | Anthropic cloud | No direct access | Remote MCP only | Unavailable for this local install |
| Cursor-style JSON adapter | Local | Yes | JSON stdio MCP, CLI | Restart and guided real recall |

OpenAI documents that the ChatGPT desktop Codex host shares the local Codex MCP
configuration, while hosted ChatGPT plugins use remote MCP. Anthropic documents
Claude Code plugins and account-synced Cowork skills as separate installation
surfaces. Sources checked 2026-08-14:

- [OpenAI: developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)
- [OpenAI: Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Anthropic: Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Anthropic: Claude skills](https://code.claude.com/docs/en/skills)
- [Anthropic: remote MCP custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Anthropic: Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)
- [Anthropic: desktop and web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)

Answer Engine does not operate a public remote MCP relay or bypass workspace
policy. Select unsupported surfaces if you want the installer to explain the
limitation; it will not write a false localhost configuration for them.

## Managed paths

Before one explicit consent prompt, the installer prints every selected path.
Depending on the client selection, these include:

- `~/.agents/plugins/marketplace.json` and
  `~/.agents/plugins/plugins/answer-engine` for Codex and ChatGPT Desktop Codex.
- The Personal plugin owns the Codex/ChatGPT Desktop MCP entry; the installer
  does not create a duplicate `~/.codex/config.toml` server entry.
- `$AE_HOME/client-plugins/claude-marketplace` for the registered Claude Code
  marketplace and plugin source.
- `~/.claude/plugins/known_marketplaces.json` and
  `~/.claude/plugins/installed_plugins.json`, plus host-managed plugin caches,
  when Claude Code performs the user-scoped marketplace and plugin install.
- `~/.codex/config.toml` and the host-managed Codex plugin cache when the Codex
  CLI installs the Personal plugin. The installer does not add a direct MCP
  server block there.
- `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
  with the platform-equivalent Claude Desktop path on Windows or Linux.
- `~/.cursor/mcp.json` for a global Cursor-style adapter, or project
  `.cursor/mcp.json` when that adapter is already project-scoped.
- `~/.config/answer-engine/config.yml` for stable CLI access.
- `$AE_HOME/integrations/ledger.json` and private backups under
  `$AE_HOME/integrations/backups`.

The ledger contains hashes, paths, client IDs, and redacted verification status;
it never stores the API key. MCP entries launch the server inside the managed
runtime and contain no API credential. The CLI handoff file remains mode `0600`.
Re-running a matching plan is byte-stable, and drift is rejected instead of
overwritten.

## Install and remove

```bash
npx @answer-engine/create@1.1.0 install \
  --channel stable \
  --clients codex,claude-code

npx @answer-engine/create@1.1.0 remove-integrations \
  --channel stable
```

`--agents` remains an alias for `--clients`. Use `--cowork-mode local` or
`--cowork-mode remote` only after confirming how Cowork will execute. Staging
must use `--clients none` and cannot write global integrations.

Removal uses the ledger in reverse order. Unchanged managed files are restored
from their original backups, while user-edited client files keep unrelated
entries and lose only the Answer Engine-owned MCP/CLI/marketplace fields. A
modified plugin directory is preserved for manual reconciliation.

## Completion semantics

The direct remember, recall, and lineage check runs first. Codex and Claude Code
then run non-interactively and must emit an Answer Engine `recall` tool event
containing the unique marker and expected content ID. GUI-only supported clients
must be restarted and confirmed through the guided challenge. A headless install
does not auto-select guided clients and cannot mark an explicitly selected one
complete; rerun interactively or remove it from the selection.
