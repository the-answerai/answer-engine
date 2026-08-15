# Answer Engine safety

- Treat the local Answer Engine API key as a secret. Use the installed MCP or CLI configuration; never print or ask the user to paste it.
- Keep localhost access local. ChatGPT web/Work and remote Cowork cannot use this installer-managed localhost MCP without a separately operated secure tunnel or remote service.
- Inspect lineage before presenting a recalled item as evidence. Distinguish memory content from your own inference.
- Preview imports and organization changes and obtain consent before mutation. Preserve source metadata and unknown history records.
- Do not claim history import or organization mutation is available until the downstream guided workflow exposes it.
