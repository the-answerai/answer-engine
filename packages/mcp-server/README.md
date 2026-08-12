# @answer-engine/mcp-server

Model Context Protocol server for local Answer Engine memory and retrieval.

## Requirements

- Node.js 22.16 or newer
- A running local Answer Engine API (default: `http://localhost:5050`)
- A local API key

## Configure an MCP client

```json
{
  "mcpServers": {
    "answer-engine": {
      "command": "npx",
      "args": ["-y", "@answer-engine/mcp-server@1.1.0"],
      "env": {
        "ANSWER_ENGINE_API_URL": "http://localhost:5050",
        "ANSWER_ENGINE_API_KEY": "ae_live_replace_me"
      }
    }
  }
}
```

`ANSWER_ENGINE_API_URL` is optional and defaults to the local API. Set
`ANSWER_ENGINE_LIBRARY` to a library UUID or slug to provide a default scope.

## Tools

The server exposes tools only when the API schema advertises their required
capability:

| Tool | Purpose | Required capability |
|---|---|---|
| `search_content` | Search local content | any search capability |
| `get_content` | Retrieve content | `retrieve` |
| `list_tags` | List schema, tags, and capabilities | schema endpoint |
| `summarize_collection` | Summarize local content | `summarize` |
| `ask` | Answer with citations | `ask` |
| `save_content` | Save local content | `content_import` |
| `append_memory` | Append a memory | `content_import` |
| `remember` | Remember a fact or note | `content_import` |
| `recall` | Recall relevant memories | any search capability |
| `forget` | Soft-remove a memory | `content_delete` |
| `get_context_pack` | Build a cited context pack | any search capability |
| `inspect_memory` | Inspect source and lineage | `content_lineage` |

Search capabilities are `fulltext_search`, `semantic_search`, and
`hybrid_search`. If schema discovery fails, API-backed tools fail closed and
`list_tags` remains available for diagnosis.

## HTTP transport

Stdio is the default. To expose a loopback-only Streamable HTTP endpoint:

```bash
ANSWER_ENGINE_MCP_TRANSPORT=http \
ANSWER_ENGINE_MCP_HOST=127.0.0.1 \
ANSWER_ENGINE_MCP_PORT=3333 \
ANSWER_ENGINE_API_KEY=ae_live_replace_me \
npx -y @answer-engine/mcp-server@1.1.0
```

The endpoint is `http://127.0.0.1:3333/mcp` and requires the configured key via
`X-API-Key` or `Authorization: Bearer`.

## License

MIT
