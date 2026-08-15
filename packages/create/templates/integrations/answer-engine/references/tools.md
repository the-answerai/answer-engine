# Answer Engine tool guide

- `remember`: Store an explicitly requested durable memory. Confirm what was stored.
- `recall`: Search memory for relevant items. Use a distinctive phrase when verifying installation.
- `inspect_memory`: Inspect source metadata and lineage for a recalled content ID.
- `forget`: Remove memory only when the user clearly requests it and after identifying the exact target.
- `ae search`: CLI fallback for querying when MCP is unavailable in a supported local terminal client.
- `ae get`: CLI fallback for retrieving a known content ID and metadata.

Prefer MCP tools inside an agent conversation. Use CLI only for a local client that can execute commands and has the installer-managed channel configuration.
