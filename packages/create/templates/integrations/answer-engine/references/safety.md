# Answer Engine safety

- Fetch setup only from the exact versioned GitHub Release. Verify the pinned bootstrap SHA-256 before execution, refuse branch or `/latest` inputs, and never fetch the installer or CLI from npm.
- Run bootstrap `--preflight` before mutation and reuse compatible prerequisites. Never install Docker Desktop, WSL2, drivers, privileged components, or model runtimes. The supported official user-scoped Node archive requires display of its source, version, checksum, destination, and operation plus explicit approval; rerun readiness afterward.
- Treat the local Answer Engine API key as a secret. Use the installed MCP or CLI configuration; never print or ask the user to paste it.
- Keep localhost access local. ChatGPT web/Work and remote Cowork cannot use this installer-managed localhost MCP without a separately operated secure tunnel or remote service.
- Inspect lineage before presenting a recalled item as evidence. Distinguish memory content from your own inference.
- Preview imports and organization changes and obtain consent before mutation. Preserve source metadata and unknown history records.
- Do not claim history import or organization mutation is available until the downstream guided workflow exposes it.
