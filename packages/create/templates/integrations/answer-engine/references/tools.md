# Answer Engine tool guide

- `remember`: Store an explicitly requested durable memory. Confirm what was stored.
- `recall`: Search memory for relevant items. Use a distinctive phrase when verifying installation.
- `inspect_memory`: Inspect source metadata and lineage for a recalled content ID.
- `forget`: Remove memory only when the user clearly requests it and after identifying the exact target.
- `ae search`: CLI fallback for querying when MCP is unavailable and an existing `ae` executable can read the installer-managed configuration.
- `ae get`: CLI fallback for retrieving a known content ID and metadata when that executable is available.

Prefer MCP tools inside an agent conversation. The installer writes channel configuration but does not install an `ae` executable, so use CLI only for a local client that can execute an already-installed command and successfully run `ae auth status`.
