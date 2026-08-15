# Client capabilities

| Client surface | Localhost access | Package/access | Verification |
| --- | --- | --- | --- |
| Codex | Yes | Plugin + stdio MCP + CLI | Automated recall command |
| Claude Code | Yes | Plugin + stdio MCP + CLI | Automated recall command |
| Claude Desktop | Yes | JSON stdio MCP + CLI | Restart and guided recall |
| Cursor-style adapter | Yes | JSON stdio MCP + CLI | Restart and guided recall |
| ChatGPT Chat/Work/web | No direct localhost | Remote MCP only | Unavailable without supported tunnel/relay |
| Cowork local session | Policy-dependent | Local plugin MCP | Restart and guided recall |
| Cowork remote session | No direct localhost | Remote MCP only | Unavailable without remote service |

The installer does not operate a public relay and does not circumvent workspace or device policy.
