---
name: install-answer-engine
description: Install, repair, remove, or connect the local-first Answer Engine. Use whenever the user asks to set up Answer Engine, connect memory to Codex, Claude, ChatGPT, Cowork, or a JSON MCP client, diagnose integration wiring, or uninstall managed integrations.
---

# Install Answer Engine

Read `../../references/safety.md` and `../../references/capabilities.md` before changing client configuration.

1. Run the version-pinned installer preflight and translate its result before mutation.
2. Detect every applicable client surface and ask the user which ones to select. Treat Codex separately from ChatGPT Chat/Work even when they share a desktop application.
3. Show the exact home, client config, plugin/skill, marketplace, and CLI paths plus every unsupported limitation.
4. Obtain one explicit confirmation, then run the stable installer with `--clients`. Keep `--agents` only as a compatibility alias.
5. Never request or print the local API key. Let the installer populate private MCP and CLI configuration.
6. Require the direct memory round trip and every selected supported client verification. Unsupported remote-only surfaces receive an explanation, not localhost wiring.
7. For removal, use the installer-managed removal action so only ledger-owned entries are removed and unrelated configuration survives.

History import and folder ingestion are separate guided handoffs. Do not silently perform them during integration setup.
