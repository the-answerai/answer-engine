# Client capabilities

| Client surface | Localhost access | Package/access | Verification |
| --- | --- | --- | --- |
| Codex | Yes | Plugin + stdio MCP + CLI | Automated recall command |
| ChatGPT Desktop Codex on macOS | Yes | Shared Codex marketplace plugin with stdio MCP + CLI config | Restart and guided recall |
| Claude Code | Yes | Plugin + stdio MCP + CLI | Automated recall command |
| Claude Desktop on macOS | Yes | JSON stdio MCP + CLI | Restart and guided recall |
| Cursor-style adapter | Yes | JSON stdio MCP + CLI | Restart and guided recall |
| Hosted ChatGPT Chat/Work/web | No direct localhost | Remote MCP only | Unavailable without supported tunnel/relay |
| Cowork local session | Not installer-verifiable | Account-synced skills/connectors | Unavailable in this installer |
| Cowork remote session | No direct localhost | Remote MCP only | Unavailable without remote service |

The installer does not operate a public relay and does not circumvent workspace or device policy.
Inside WSL2 it supports terminal clients, but does not write Linux-home integrations for ChatGPT Desktop or Claude Desktop running on the Windows host.
