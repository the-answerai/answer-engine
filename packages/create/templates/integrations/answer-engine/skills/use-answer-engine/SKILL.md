---
name: use-answer-engine
description: Use Answer Engine memory in agent work. Trigger whenever the user asks to remember something, recall a prior decision or conversation, search personal memory, ground an answer in stored evidence, or inspect where a memory came from.
---

# Use Answer Engine

Read `../../references/safety.md` and `../../references/tools.md` before calling memory tools.

1. Use `recall` with the user's distinctive terms and relevant filters.
2. Inspect promising content IDs with `inspect_memory` when provenance matters.
3. Answer from the recalled evidence, name uncertainty, and separate inference from stored content.
4. Use `remember` only when the user asks to retain information or the workflow clearly requests durable storage; summarize what will be stored.
5. Use `forget` only for an exact, user-approved target.
6. If MCP is unavailable in a supported local terminal client, first confirm that the `ae` executable is already installed and `ae auth status` can read the installer-managed configuration. Only then use the `ae search` and `ae get` fallback without exposing credentials. If the executable is absent, repair MCP instead of claiming CLI access is ready.

An empty result is a valid outcome. Refine the query or explain that the memory was not found instead of inventing one.
